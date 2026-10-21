#!/usr/bin/env bun
/**
 * Commit an agent worktree's uncollected work onto its own branch (#228).
 *
 * When a collection is refused, ship.js returns SHIP_FAILED and the run ends.
 * Before this existed, the implementation it refused to collect stayed loose
 * in the agent worktree: reachable from no ref, invisible to `git log`, and
 * destroyed by the next `git worktree remove --force`. Run wf_74366574-136 is
 * the recorded case — correct work, refused collection, only copy left in a
 * directory nobody was going to look in.
 *
 * Preserving is not collecting. Nothing is merged, copied into the project
 * root, or staged for the ship commit; the refusal still stands. All this does
 * is give the work a NAME — the worktree's own current branch — so the
 * operator can reach it from the refusal message alone.
 *
 * Why a script and not inline in ship.js: the workflow sandbox has no module
 * loading and no filesystem access (#69), so everything that touches disk runs
 * out here and is reached through an agent step. Same pattern as
 * scripts/collect-worktree-files.ts.
 *
 * Usage:
 *   bun scripts/preserve-worktree-work.ts <worktreePath> [<worktreePath>...]
 *
 * stdout: one JSON line — [{ worktreePath, branch, sha, status, detail? }] —
 *         followed by `PRESERVED <n>`, n being the number committed.
 * stderr: diagnostics.
 * exit:   0 when every path was handled (committed or already clean),
 *         FAIL_EXIT when any was not.
 */

import { execFileSync } from "child_process";
import { basename } from "path";

/**
 * The single refusal exit code. One declaration, and every `process.exit` goes
 * through it, so a test can build a mutant with it set to 0 and tell a genuine
 * refusal from a crash — .claude/rules/checks-must-be-able-to-fail.md.
 */
export const FAIL_EXIT = 1;

export type PreserveStatus = "committed" | "clean" | "failed";

export interface PreserveEntry {
  worktreePath: string;
  branch: string | null;
  sha: string | null;
  status: PreserveStatus;
  detail?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * A linked worktree, or an explanation of why not.
 *
 * The main checkout is refused deliberately. `git add -A && git commit` there
 * would sweep up whatever the developer has in progress — strictly worse than
 * the bug this fixes. Git distinguishes the two for us: in a linked worktree
 * the per-worktree git dir (`.git/worktrees/<name>`) differs from the common
 * dir (`.git`); in the main checkout they are the same path.
 */
function linkedWorktreeCheck(dir: string): string | null {
  let gitDir: string;
  let commonDir: string;
  try {
    gitDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    commonDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch (e) {
    const msg = String((e as Error).message || "").split("\n")[0];
    return `not a git working tree: ${msg}`;
  }
  if (!gitDir || !commonDir) return "git did not report a git dir for this path";
  if (gitDir === commonDir) {
    return "this is the main checkout, not a linked worktree — refusing to commit it";
  }
  return null;
}

/**
 * The branch the commit will land on.
 *
 * READ, never reconstructed. Harness worktrees get their branch from
 * `git worktree add -b` and the names come from several different schemes
 * (lib/worktree-isolation.ts uses `test-brief-<ts>-<rand>`, ship.js uses its
 * own); guessing would commit to the wrong ref or fail on the right one.
 *
 * A detached HEAD gets a branch created for it, because a commit reachable
 * from no ref is exactly the loss this script exists to prevent — it would
 * report "committed" and still lose the work to `git gc`.
 */
function ensureBranch(dir: string): string {
  const head = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head && head !== "HEAD") return head;
  const sha = git(dir, ["rev-parse", "--short", "HEAD"]);
  const name = `rungate-preserved/${basename(dir)}-${sha}`;
  git(dir, ["checkout", "-q", "-b", name]);
  return name;
}

export function preserveWorktree(worktreePath: string): PreserveEntry {
  const dir = String(worktreePath || "").trim();
  const fail = (detail: string): PreserveEntry => ({
    worktreePath: dir,
    branch: null,
    sha: null,
    status: "failed",
    detail,
  });

  if (!dir) return fail("empty worktree path");

  const problem = linkedWorktreeCheck(dir);
  if (problem) return fail(problem);

  try {
    const dirty = git(dir, ["status", "--porcelain"]);
    const branch = ensureBranch(dir);
    if (!dirty) {
      // Nothing uncommitted. An empty commit here would be noise, and the
      // branch already holds whatever there is to reach.
      return { worktreePath: dir, branch, sha: git(dir, ["rev-parse", "HEAD"]), status: "clean" };
    }
    git(dir, ["add", "-A"]);
    git(dir, [
      "commit",
      "-q",
      "-m",
      `preserve: uncollected agent work from ${basename(dir)} (#228)\n\n` +
        `The ship run refused to collect this worktree. Committed here so the\n` +
        `work survives worktree cleanup and is reachable from ${branch}.`,
    ]);
    return { worktreePath: dir, branch, sha: git(dir, ["rev-parse", "HEAD"]), status: "committed" };
  } catch (e) {
    return fail(String((e as Error).message || e).split("\n")[0]);
  }
}

export function preserveAll(paths: string[]): PreserveEntry[] {
  // Every path is attempted. Stopping at the first failure would discard the
  // very work the later entries are there to save.
  return paths.map(preserveWorktree);
}

/** One preserved commit's answer about one refused path. */
export interface BlobReading {
  worktreePath: string;
  branch: string | null;
  sha: string | null;
  /** The git blob OID, or null when the read did not happen. */
  blob: string | null;
  /** Why it did not happen. Present iff `blob` is null. */
  reason?: string;
}

export interface OverlapReading {
  path: string;
  /**
   * EVERY preserved commit's answer, always, in input order — never a count
   * and never a diff against another path (#892). "Identical to the one
   * above" is a conclusion the reader draws; a refusal that draws it emits
   * output that cannot be re-analysed when the question changes.
   */
  readings: BlobReading[];
  /** How many of the preserved commits answered. `read N/M`. */
  read: number;
  of: number;
  reading: "IDENTICAL" | "DIFFERS" | "UNMEASURED";
}

/**
 * Whether the worktrees that touched a refused path agree about its BYTES.
 *
 * This changes no decision (#892). `auditWorktreeClaims` refuses exactly what
 * it refused before and the run still fails; all that is added is whether the
 * copies the operator is now holding are the same file. On
 * `wf_161c4e96-f01` the 35 minutes were not lost because the run refused —
 * they were lost because nothing said the three preserved branches were a
 * superset chain with identical overlaps, which is a one-line recovery once
 * somebody says it.
 *
 * Three properties, each because of a rule this repo has already paid for:
 *
 * - **A content digest, not a stat.** Two files one character apart have the
 *   same length, so size or mtime is the proxy that is satisfiable without
 *   answering the question. The blob OID IS the content hash, and git has
 *   already computed it.
 * - **Coverage travels with the verdict.** `read 2/3` and `read 3/3` are
 *   otherwise the same IDENTICAL and no reader can tell them apart —
 *   `.claude/rules/checks-must-be-able-to-fail.md`. A path present in two
 *   commits and unreadable in a third really is identical in the two that
 *   answered; saying so while naming the third is more useful than refusing
 *   to say anything.
 * - **Fewer than two answers is UNMEASURED, not agreement.** One blob
 *   compares with nothing, and zero blobs trivially all match. Both would
 *   print IDENTICAL under a naive `new Set(...).size <= 1`, which is the
 *   "zero strings are perfect agreement" shape (#621). One discriminator:
 *   `reading === "UNMEASURED"` is the whole answer, derived here and nowhere
 *   else.
 *
 * A path absent from a commit is a real reading and NOT an error — it means
 * that worktree did not have the file. It is reported with its own reason so
 * the operator can tell "absent there" from "git could not be asked".
 */
export function overlapReadings(entries: PreserveEntry[], paths: string[]): OverlapReading[] {
  const usable = (Array.isArray(entries) ? entries : []).filter(e => e && e.sha && e.status !== "failed");
  const wanted = [...new Set((Array.isArray(paths) ? paths : []).map(p => String(p || "").trim()).filter(Boolean))];

  return wanted.map(path => {
    const readings: BlobReading[] = usable.map(e => {
      const base: BlobReading = {
        worktreePath: e.worktreePath,
        branch: e.branch,
        sha: e.sha,
        blob: null,
      };
      try {
        // `rev-parse <sha>:<path>` resolves to the blob OID git recorded for
        // that path in that commit. Reading the OID rather than the bytes
        // keeps this O(1) per pair and compares exactly what git compares.
        const blob = git(e.worktreePath, ["rev-parse", `${e.sha}:${path}`]);
        return blob ? { ...base, blob } : { ...base, reason: "git returned no object id" };
      } catch (err) {
        // git's own explanation is on STDERR; `message` is only
        // "Command failed: git -C … rev-parse …", which names no cause and is
        // the same string for every failure. Classifying off it would report
        // an absent path and an unreadable repository identically — the two
        // states this reading exists to keep apart.
        const e = err as Error & { stderr?: Buffer | string };
        const stderr = String(e.stderr ?? "").trim();
        const msg = (stderr || String(e.message || err)).split("\n")[0].replace(/^fatal:\s*/, "");
        return {
          ...base,
          reason: /does not exist|unknown revision|not in the working tree/i.test(msg)
            ? "the path is not in that commit"
            : msg,
        };
      }
    });

    const blobs = readings.map(r => r.blob).filter((b): b is string => Boolean(b));
    const reading: OverlapReading["reading"] =
      blobs.length < 2 ? "UNMEASURED" : new Set(blobs).size === 1 ? "IDENTICAL" : "DIFFERS";

    return { path, readings, read: blobs.length, of: readings.length, reading };
  });
}

/**
 * The operator-facing line per refused path.
 *
 * Every branch is named on every line, with its own blob or its own reason —
 * the whole set, not a summary. A run's refusals are dated by the branch they
 * name and the sha beside it, because "it happened once" was an argument only
 * because nothing recorded when.
 */
export function overlapLines(overlaps: OverlapReading[]): string[] {
  return overlaps.map(o => {
    const per = o.readings
      .map(r => `${r.branch ?? r.worktreePath}@${(r.sha ?? "").slice(0, 8)}=${r.blob ? r.blob.slice(0, 12) : `UNREAD(${r.reason ?? "no reason given"})`}`)
      .join(" ");
    return `${o.path}: ${o.reading} (read ${o.read}/${o.of}) ${per}`;
  });
}

if (import.meta.main) {
  // Worktrees before `--`, refused paths after it. A separator rather than a
  // flag because both sides are lists and an agent composes this command line
  // from two arrays; `--path a --path b` is the spelling that gets one of the
  // two wrong.
  const argv = process.argv.slice(2).filter(Boolean);
  const sep = argv.indexOf("--");
  const paths = (sep === -1 ? argv : argv.slice(0, sep));
  const refused = sep === -1 ? [] : argv.slice(sep + 1);
  if (paths.length === 0) {
    console.error(
      "usage: bun scripts/preserve-worktree-work.ts <worktreePath> [<worktreePath>...] [-- <refusedPath>...]",
    );
    process.exit(FAIL_EXIT);
  }

  const entries = preserveAll(paths);
  console.log(JSON.stringify(entries));
  // Emitted on its own line, and only when paths were asked for. An empty
  // array printed unconditionally would be indistinguishable from "asked and
  // found nothing", which is the state this whole reading exists to separate.
  if (refused.length > 0) {
    const overlaps = overlapReadings(entries, refused);
    const lines = overlapLines(overlaps);
    // The LINES travel in the JSON, not just the structured readings.
    // `workflows/ship.js` cannot import (#69), so a ship.js that re-rendered
    // these would be a second formatter for one reading — two renderings that
    // agree today and drift the first time either is edited. It relays these
    // strings instead, which is `lib/launch-base.ts`'s arrangement: one
    // binding decides, ship.js restates.
    console.log(JSON.stringify({ overlaps, lines }));
    for (const line of lines) console.error(`overlap: ${line}`);
  }
  const committed = entries.filter(e => e.status === "committed");
  console.log(`PRESERVED ${committed.length}`);
  for (const e of entries) {
    if (e.status === "failed") console.error(`preserve: FAILED ${e.worktreePath}: ${e.detail}`);
    else console.error(`preserve: ${e.status} ${e.worktreePath} -> ${e.branch} ${e.sha}`);
  }
  if (entries.some(e => e.status === "failed")) process.exit(FAIL_EXIT);
}
