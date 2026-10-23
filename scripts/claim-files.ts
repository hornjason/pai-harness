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
 * Liveness is resolved from git rather than trusted from the registry: the
 * owners counted are the branches that exist on the remote and are not
 * already merged. A claim whose branch merged is reported DEAD and holds
 * nothing, so an entry nobody pruned costs a line of output rather than a
 * file nobody may ever work on again.
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  FILE_CLAIMS_CONTROL_KEY,
  FILE_CLAIMS_PATH,
  allClaims,
  contention,
  isLandedBySubject,
  readFileClaims,
  type FileClaim,
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
 * Branches on the remote that are NOT merged into the default branch.
 *
 * `--no-merged` is the whole of the staleness answer and it is deliberately
 * not `--is-ancestor`: this repository squash-merges, so a merged branch's
 * head is never an ancestor of the default branch and an ancestry test would
 * report every merged branch as live. `git branch -r --no-merged` compares
 * tips the same way, so a squash-merged branch whose ref still exists IS
 * reported live here — which is the safe direction. It holds its claim until
 * someone deletes the ref or releases it, rather than being released while
 * the author is still pushing to it.
 */
/**
 * Which of `owners` still have work that has not landed on `ref`.
 *
 * Asked per declared owner rather than by listing every remote branch,
 * because the registry has a handful of entries and the remote has hundreds,
 * and because the question is about the branches someone declared — not
 * about the branch list.
 *
 * Three states, and the third is why this does not return a bare boolean: a
 * branch whose ref is REALLY gone is landed-or-abandoned either way and
 * holds nothing; a branch whose subjects are all in the base has landed; and
 * anything that could not be read is UNMEASURED, which must not read as
 * either. See {@link isLandedBySubject} for why ancestry is the wrong
 * instrument.
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
 * So an absent ref is only "gone" when the refs were actually refreshed.
 * Without that, absent means UNMEASURED and the caller refuses: a branch
 * nobody fetched and a branch somebody deleted look identical, and only one
 * of them is safe to treat as free.
 */
function ownerLiveness(
  project: string,
  ref: string,
  owners: readonly string[],
  fetched: boolean,
): { live: Set<string>; unmeasured: Map<string, string> } {
  const live = new Set<string>();
  const unmeasured = new Map<string, string>();
  // One read of the base's subjects, shared across every owner. Bounded
  // because a squash lands within days of the branch being cut, and an
  // unbounded log on a long history costs more than the answer is worth.
  const base = git(project, "log", "--format=%s", "-2000", ref);
  if (!base.ok) {
    for (const o of owners) unmeasured.set(o, `could not read ${ref}'s subjects`);
    return { live, unmeasured };
  }
  const baseSubjects = base.out.split("\n");
  for (const owner of owners) {
    const exists = git(project, "rev-parse", "--verify", "--quiet", `origin/${owner}`);
    if (!exists.ok) {
      if (!fetched) {
        unmeasured.set(
          owner,
          `origin/${owner} is not in this worktree and the refs were not refreshed, so "deleted" and "never fetched" cannot be told apart`,
        );
      }
      // Fetched and still absent: the branch is really gone, and holds nothing.
      continue;
    }
    const ahead = git(project, "log", "--format=%s", `${ref}..origin/${owner}`);
    if (!ahead.ok) {
      unmeasured.set(owner, `could not read ${ref}..origin/${owner}`);
      continue;
    }
    if (!isLandedBySubject(ahead.out.split("\n"), baseSubjects)) live.add(owner);
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
      const { live, unmeasured } = ownerLiveness(args.project, base, reading.claims.map(c => c.owner), fetched);
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
      const { live, unmeasured } = ownerLiveness(args.project, base, reading.claims.map(c => c.owner), fetched);
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
