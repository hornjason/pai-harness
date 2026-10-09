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

if (import.meta.main) {
  const paths = process.argv.slice(2).filter(Boolean);
  if (paths.length === 0) {
    console.error("usage: bun scripts/preserve-worktree-work.ts <worktreePath> [<worktreePath>...]");
    process.exit(FAIL_EXIT);
  }

  const entries = preserveAll(paths);
  console.log(JSON.stringify(entries));
  const committed = entries.filter(e => e.status === "committed");
  console.log(`PRESERVED ${committed.length}`);
  for (const e of entries) {
    if (e.status === "failed") console.error(`preserve: FAILED ${e.worktreePath}: ${e.detail}`);
    else console.error(`preserve: ${e.status} ${e.worktreePath} -> ${e.branch} ${e.sha}`);
  }
  if (entries.some(e => e.status === "failed")) process.exit(FAIL_EXIT);
}
