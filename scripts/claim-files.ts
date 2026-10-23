#!/usr/bin/env bun
/**
 * Ask whether a file has a live writer, and declare that you are one (#1413).
 *
 * ```
 * bun scripts/claim-files.ts --check lib/scaffold/ai-review-step.ts
 * bun scripts/claim-files.ts --claim lib/scaffold/ai-review-step.ts --owner rg/my-branch --issue 1405
 * bun scripts/claim-files.ts --release --owner rg/my-branch
 * bun scripts/claim-files.ts --list
 * ```
 *
 * **Exit 0 from `--check` means nobody live holds those paths.** Any other
 * exit means do not branch yet, and the reason is on stdout. A refusal is
 * never a silence: an unreadable registry exits non-zero saying so, because a
 * registry that fails to parse reporting "free" is the one fail-open this
 * mechanism must not have.
 *
 * `--check` reads `origin/<default>`'s copy, not the working tree's, because
 * a claim only exists for other sessions once it is pushed. It fetches first
 * unless `--no-fetch` is passed, so the answer is about now rather than about
 * whenever this worktree last synced. `lib/file-claims.ts` holds the whole
 * decision; this file holds none of it, and is the part a library cannot be —
 * a place to ask the question from a shell, before any code exists to import
 * anything from.
 *
 * Liveness is resolved rather than trusted from the registry: an owner is
 * live while its branch has an open pull request, or while the branch is on
 * the remote with no pull request yet. A claim whose pull request merged or
 * closed is reported DEAD and holds nothing, so an entry nobody pruned costs
 * a line of output rather than a file nobody may ever work on again.
 *
 * That answer comes from the tracker and not from the commit graph, which
 * squash-merging has already destroyed the evidence in. Two git-only rules
 * were tried and both reported merged branches live forever; the second was
 * measured wrong on 11 of 12 recently merged branches. `lib/file-claims.ts`
 * carries the measurement. The practical consequence here is that `--check`
 * and `--list` need `gh` to be working: if it is not, the owners it covers
 * are UNMEASURED and the tool refuses rather than reporting free.
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  FILE_CLAIMS_CONTROL_KEY,
  FILE_CLAIMS_PATH,
  allClaims,
  contention,
  ownerState,
  readFileClaims,
  type FileClaim,
  type PullState,
} from "../lib/file-claims.ts";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

const FLAGS = new Set([
  "check",
  "claim",
  "release",
  "list",
  "owner",
  "issue",
  "note",
  "project",
  "no-fetch",
  // The ref the registry is read from. Defaults to the remote's default
  // branch, which is the only answer that is true for every other session.
  // Overridable because a registry on a branch that has not merged yet
  // cannot otherwise be exercised at all — including by this repository's
  // own tests, which is how the HELD path gets a witness before it ships.
  "ref",
]);

export interface Args {
  check: string[];
  claim: string[];
  release: boolean;
  list: boolean;
  owner?: string;
  issue?: number;
  note?: string;
  project: string;
  fetch: boolean;
  /** Ref the registry is read from; empty means the remote default branch. */
  ref?: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { check: [], claim: [], release: false, list: false, project: ".", fetch: true };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !FLAGS.has(m[1])) throw new Error(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    const flag = m[1];
    if (flag === "release") { out.release = true; continue; }
    if (flag === "list") { out.list = true; continue; }
    if (flag === "no-fetch") { out.fetch = false; continue; }
    // A repeated `--check a --check b` and a run of values after one flag are
    // the same claim; both are accepted because a caller assembling paths in
    // a shell loop naturally produces the first and a person types the second.
    const values: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) values.push(argv[++i]);
    if (values.length === 0) throw new Error(`--${flag} needs a value`);
    if (flag === "check" || flag === "claim") out[flag].push(...values);
    else if (flag === "issue") {
      const n = Number(values[0]);
      if (!Number.isSafeInteger(n)) throw new Error(`--issue must be an integer, got "${values[0]}"`);
      out.issue = n;
    } else if (flag === "owner") out.owner = values[0];
    else if (flag === "note") out.note = values.join(" ");
    else if (flag === "project") out.project = values[0];
    else if (flag === "ref") out.ref = values[0];
  }
  return out;
}

function git(project: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** The remote's default branch, read rather than assumed to be `main`. */
function defaultBranch(project: string): string {
  const r = git(project, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (r.ok && r.out) return r.out.replace("refs/remotes/origin/", "");
  return "main";
}

/**
 * The `owner/repo` this project pushes to, parsed from `origin`.
 *
 * Read rather than configured, and `null` rather than a guess: every owner
 * is UNMEASURED if this cannot be resolved, because a `gh` call against the
 * wrong repository would answer "no pull request" with total confidence.
 */
export function repoSlug(originUrl: string): string | null {
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(originUrl.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

/**
 * Pull requests whose head is `branch`, or `null` if the tracker was not read.
 *
 * `--state all` because a CLOSED pull request answers the question as well as
 * a merged one: either way nobody is writing under that name. The `null`
 * return is the whole reason this is not typed `PullState[]` — an empty array
 * means "the tracker says there are none", and those must not be one value.
 */
function pullsForBranch(slug: string, branch: string): PullState[] | null {
  const r = spawnSync(
    "gh",
    ["pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--json", "number,state"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as PullState[];
  } catch {
    return null;
  }
}

/**
 * Which of `owners` are still being worked on.
 *
 * Asked per declared owner rather than by listing every branch or every open
 * pull request, because the registry has a handful of entries and the remote
 * has hundreds — and because a bounded `--limit` listing would answer "no
 * pull request" for anything older than the page, which is the fail-open
 * direction. A `--head` query is exact and unbounded.
 *
 * {@link ownerState} holds the decision and the evidence for it, including
 * the two git-only rules that were tried first and the measurement that
 * killed the second. Nothing here decides anything; it gathers three inputs
 * per owner and hands them over.
 *
 * ## `fetched` is load-bearing, and the first version of this was a fail-open
 *
 * Raised as CRITICAL by the AI review on this pull request. `origin/<owner>`
 * is a local remote-tracking ref, and the earlier code fetched only the
 * default branch — so a peer's branch this worktree had never fetched failed
 * `rev-parse` and fell through to "ref gone: holds nothing". A fresh worktree
 * has fetched almost nothing, which is exactly the state an agent is in when
 * it asks this question, so the common case silently reported FREE on a file
 * somebody was writing. That is the whole defect this tool exists to prevent,
 * arriving inside the tool.
 *
 * The ref reading still matters even with the tracker in play: it is what
 * separates "pushed, no pull request yet" from "nothing there at all", and
 * those are opposite answers.
 */
function ownerLiveness(
  project: string,
  owners: readonly string[],
  fetched: boolean,
): { live: Set<string>; unmeasured: Map<string, string> } {
  const live = new Set<string>();
  const unmeasured = new Map<string, string>();
  if (owners.length === 0) return { live, unmeasured };

  const origin = git(project, "remote", "get-url", "origin");
  const slug = origin.ok ? repoSlug(origin.out) : null;
  if (slug === null) {
    for (const o of owners) {
      unmeasured.set(o, "could not resolve the GitHub repository from origin, so no pull request state was read");
    }
    return { live, unmeasured };
  }

  for (const owner of owners) {
    const refExists = git(project, "rev-parse", "--verify", "--quiet", `origin/${owner}`).ok;
    const { state, why } = ownerState(pullsForBranch(slug, owner), refExists, fetched);
    if (state === "live") live.add(owner);
    else if (state === "unmeasured") unmeasured.set(owner, why);
  }
  return { live, unmeasured };
}

/**
 * Refresh every remote-tracking ref, and say whether it worked.
 *
 * All branches, not just the base: {@link ownerLiveness} resolves each
 * declared owner through `origin/<owner>`, and a ref this worktree has never
 * seen is indistinguishable from one that was deleted. `--prune` so a branch
 * that really went away stops reading live.
 */
function refreshRefs(project: string): boolean {
  return git(project, "fetch", "--quiet", "--prune", "origin").ok;
}

/**
 * The registry as `ref` carries it. `ref` is a full name, e.g. `origin/main`.
 *
 * Takes no fetch argument: {@link refreshRefs} runs once for the whole
 * invocation, before this, because the liveness answers need every owner's
 * ref and not only the base's. A second fetch here would be a second place
 * that decides how current the reading is.
 */
export function readFromRemote(project: string, ref: string) {
  const r = spawnSync("git", ["-C", project, "show", `${ref}:${FILE_CLAIMS_PATH}`], {
    encoding: "utf-8",
  });
  // A path that does not exist on that ref and a `git show` that could not run
  // are different facts: the first is an absent registry, the second is a
  // reading nobody took. Only the first may read as "nobody has declared".
  if (r.status !== 0) {
    const why = (r.stderr ?? "").trim().split("\n")[0];
    if (/does not exist|exists on disk, but not in|unknown revision|invalid object name/i.test(why)) {
      return readFileClaims(null);
    }
    return { status: "unreadable" as const, path: FILE_CLAIMS_PATH, claims: [], reason: `git show failed: ${why}` };
  }
  return readFileClaims(r.stdout);
}

/**
 * Serialise the store, and refuse to write one the reader would reject.
 *
 * Raised by the AI review on this pull request and it was right. Without
 * this, `--claim /etc/passwd` writes an absolute path that `readFileClaims`
 * refuses — and because one bad entry refuses the WHOLE store, a single
 * careless claim makes every path read UNMEASURED for every other session.
 * The writer could brick the registry for everyone, which is a worse version
 * of exactly the fail-open this file exists to prevent.
 *
 * The check is a ROUND TRIP rather than a second call to the validator: it
 * serialises the bytes that are about to be written and reads them back
 * through the real reader. A re-validation would be a second implementation
 * of the rules and would agree with the first by construction — the fourth
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`. This agrees with
 * nothing; it asks the only question that matters, which is whether the next
 * reader can read the file.
 */
function writeStore(project: string, claims: FileClaim[]): void {
  const path = join(project, FILE_CLAIMS_PATH);
  const bytes = `${JSON.stringify({ [FILE_CLAIMS_CONTROL_KEY]: claims }, null, 2)}\n`;
  const back = readFileClaims(bytes, path);
  if (back.status !== "read") {
    throw new Error(
      `refusing to write a registry the reader cannot read — ${back.reason ?? back.status}. ` +
        "Nothing was written; one bad entry would make every path UNMEASURED for every session.",
    );
  }
  writeFileSync(path, bytes);
}

function readLocal(project: string) {
  const path = join(project, FILE_CLAIMS_PATH);
  let raw: string | null;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") raw = null;
    else throw e;
  }
  return readFileClaims(raw, path);
}

if (import.meta.main) {
  let exit = 0;
  try {
    const args = parseArgs(process.argv.slice(2));
    const base = args.ref ?? `origin/${defaultBranch(args.project)}`;
    // One refresh for the whole run, and whether it worked is an input to
    // every liveness answer below. See `ownerLiveness`.
    const fetched = args.fetch ? refreshRefs(args.project) : false;

    if (args.check.length > 0) {
      const reading = readFromRemote(args.project, base);
      if (reading.status === "unreadable") {
        console.log(`UNMEASURED: the claim registry on ${base} could not be read — ${reading.reason}`);
        console.log("Not reporting these paths free: an unreadable registry is not an empty one.");
        process.exit(REFUSE_EXIT);
      }
      const { live, unmeasured } = ownerLiveness(args.project, reading.claims.map(c => c.owner), fetched);
      // An owner whose liveness could not be established must not fall through
      // to "dead". Only the claims on the paths being asked about matter — an
      // unreadable branch elsewhere in the registry is not this caller's
      // problem, and refusing on it would make the tool unusable.
      const blind = args.check
        .flatMap(p => allClaims(reading.claims, p))
        .filter(c => unmeasured.has(c.owner));
      if (blind.length > 0) {
        console.log(`UNMEASURED: ${blind.length} claim(s) on these paths have an owner this tree cannot resolve.`);
        for (const c of blind) console.log(`  ${c.owner} — ${unmeasured.get(c.owner)}`);
        console.log("Not reporting free: an owner that could not be read is not an owner that let go.");
        process.exit(REFUSE_EXIT);
      }
      const hits = contention(reading.claims, args.check, live);
      if (hits.size === 0) {
        // Say what was read, so "free" is distinguishable from "read nothing".
        const dead = args.check.flatMap(p => allClaims(reading.claims, p));
        // Say which of the two "free"s this is. A registry that is not there
        // and a registry that says nobody holds these paths are both safe to
        // branch on, and they are not the same reading — the first means the
        // mechanism has not reached this ref yet.
        console.log(
          reading.status === "absent"
            ? `free: there is no registry at ${FILE_CLAIMS_PATH} on ${base} yet, so nothing is declared`
            : `free: no live writer among ${reading.claims.length} claim(s) on ${base}` +
                (dead.length > 0 ? ` (${dead.length} DEAD claim(s) here, owner branch merged or gone)` : ""),
        );
        for (const c of dead) console.log(`  DEAD  ${c.owner}${c.issue ? ` (#${c.issue})` : ""}`);
      } else {
        console.log(`HELD: ${hits.size} of ${args.check.length} path(s) have a live writer.`);
        for (const [p, cs] of hits) {
          for (const c of cs) {
            console.log(`  ${p} <- ${c.owner}${c.issue ? ` (#${c.issue})` : ""}${c.note ? ` — ${c.note}` : ""}`);
          }
        }
        console.log("Branch on something else, or message that owner. Do not start here.");
        exit = REFUSE_EXIT;
      }
    } else if (args.claim.length > 0) {
      if (!args.owner) throw new Error("--claim needs --owner <branch>");
      const reading = readLocal(args.project);
      if (reading.status === "unreadable") throw new Error(`the local registry is unreadable: ${reading.reason}`);
      const kept = reading.claims.filter(c => c.owner !== args.owner);
      const entry: FileClaim = { owner: args.owner, paths: args.claim };
      if (args.issue !== undefined) entry.issue = args.issue;
      if (args.note !== undefined) entry.note = args.note;
      writeStore(args.project, [...kept, entry]);
      console.log(`claimed ${args.claim.length} path(s) for ${args.owner}.`);
      console.log(`Commit and PUSH ${FILE_CLAIMS_PATH} now — an unpushed claim is invisible, which is the whole defect.`);
    } else if (args.release) {
      if (!args.owner) throw new Error("--release needs --owner <branch>");
      const reading = readLocal(args.project);
      if (reading.status === "unreadable") throw new Error(`the local registry is unreadable: ${reading.reason}`);
      const kept = reading.claims.filter(c => c.owner !== args.owner);
      writeStore(args.project, kept);
      console.log(`released ${reading.claims.length - kept.length} claim(s) for ${args.owner}.`);
    } else if (args.list) {
      const reading = readFromRemote(args.project, base);
      if (reading.status === "unreadable") {
        console.log(`UNMEASURED: ${reading.reason}`);
        process.exit(REFUSE_EXIT);
      }
      const { live, unmeasured } = ownerLiveness(args.project, reading.claims.map(c => c.owner), fetched);
      // ABSENT and READ-EMPTY print differently on purpose. "Nobody has
      // declared anything" and "there is no registry on this ref yet" lead to
      // different next actions, and one line for both is how a reader stops
      // being able to tell.
      if (reading.status === "absent") {
        console.log(`no registry at ${FILE_CLAIMS_PATH} on ${base} — nothing has been declared yet`);
      } else if (reading.claims.length === 0) {
        console.log("the registry is present and declares no claims");
      }
      for (const c of reading.claims) {
        // Three states in the listing too. A `?` is a claim whose owner this
        // tree could not resolve, and printing it as DEAD would invite
        // someone to prune a live lock.
        const state = unmeasured.has(c.owner) ? "?   " : live.has(c.owner) ? "LIVE" : "DEAD";
        console.log(`${state}  ${c.owner}${c.issue ? ` (#${c.issue})` : ""}  ${c.paths.join(" ")}`);
        if (unmeasured.has(c.owner)) console.log(`        ${unmeasured.get(c.owner)}`);
      }
    } else {
      throw new Error("one of --check, --claim, --release or --list is required");
    }
  } catch (e) {
    console.log(`claim-files: ${e instanceof Error ? e.message : String(e)}`);
    exit = REFUSE_EXIT;
  }
  process.exit(exit);
}
