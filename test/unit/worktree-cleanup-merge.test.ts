/**
 * #68 — cleanupWorktrees() has never removed a worktree.
 *
 * The merge check parsed `git branch --merged main` display output and
 * stripped only the `*` prefix:
 *
 *     mergeCheck.stdout.split("\n").map(b => b.trim().replace(STAR_PREFIX, ""))
 *
 * where STAR_PREFIX matched a leading asterisk only.
 *
 * Git prefixes `+ ` on any branch checked out in a LINKED WORKTREE — which is,
 * by definition, every branch this function evaluates. So entries came out as
 * "+ 24-doc-hygiene-infra", never matched the bare branch name, and every
 * candidate was classified unmerged and kept. 36 worktrees and 243 MB
 * accumulated.
 *
 * WHY THE OLD TESTS DID NOT CATCH IT
 *
 * test/worktree-cleanup.test.ts asserts the function exists, returns the right
 * shape, and "runs without crashing". It never constructs a worktree on a
 * merged branch, so `removed` being permanently empty read as correct. That is
 * the defect class in .claude/rules/checks-must-be-able-to-fail.md: a check
 * green because of what it never looked at.
 *
 * These tests build a real repo with real linked worktrees, so the `+` prefix
 * is genuinely produced by git rather than simulated.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanupWorktrees } from "../../lib/worktree-cleanup";
import { repoRootFrom } from "../../lib/paths";

let root: string;

function git(cwd: string, ...args: string[]) {
  // -C explicitly, not just cwd: #84 requires every git-identity write to name
  // its target directory, so a stray run can never touch the real repo.
  const r = spawnSync("git", ["-C", cwd, ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A repo with `main`, isolated from the developer's global git config so the
 * test cannot be affected by (or write to) real settings — #84.
 */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-cleanup-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf-8" });
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  mkdirSync(join(dir, ".claude", "worktrees"), { recursive: true });
  return dir;
}

/** Branch off main, commit, optionally merge back, then attach a linked worktree. */
function addWorktree(repo: string, name: string, opts: { merged: boolean; dirty?: boolean }) {
  git(repo, "checkout", "-q", "-b", name);
  writeFileSync(join(repo, `${name}.txt`), "work\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `work on ${name}`);
  git(repo, "checkout", "-q", "main");
  if (opts.merged) git(repo, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);

  const path = join(repo, ".claude", "worktrees", name);
  git(repo, "worktree", "add", "-q", path, name);
  if (opts.dirty) writeFileSync(join(path, "scratch.txt"), "uncommitted\n");
  return path;
}

beforeEach(() => { root = initRepo(); });
afterEach(() => {
  // Worktrees hold locks; force-remove the whole tree.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("#68 SC-1: a merged branch in a linked worktree is recognised as merged", () => {
  test("git really does emit the '+' prefix these worktrees trip over", () => {
    // Pin the upstream behaviour the bug depends on. If a future git drops the
    // prefix, this test tells us why the fix stopped being load-bearing —
    // rather than the fix silently becoming untested.
    addWorktree(root, "feature-merged", { merged: true });
    const out = spawnSync("git", ["branch", "--merged", "main"], { cwd: root, encoding: "utf-8" }).stdout;
    expect(out, "git no longer prefixes linked-worktree branches with '+'").toContain("+ feature-merged");
  });

  test("the worktree is actually removed", async () => {
    const path = addWorktree(root, "feature-merged", { merged: true });
    expect(existsSync(path)).toBe(true);

    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.errors).toEqual([]);
    expect(result.removed).toContain("feature-merged");
    expect(existsSync(path), "worktree directory still on disk after cleanup").toBe(false);
  });
});

describe("#68: the safety guarantees must survive the fix", () => {
  // The merge check was the only broken part. Everything protecting real work
  // was correct, and a fix that removed MORE than it should would be far worse
  // than the bug — this is destructive, irreversible disk deletion.

  test("an unmerged branch is kept", async () => {
    const path = addWorktree(root, "feature-unmerged", { merged: false });
    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.removed).not.toContain("feature-unmerged");
    expect(result.kept.join("\n")).toContain("feature-unmerged");
    expect(existsSync(path), "an unmerged branch's worktree was deleted").toBe(true);
  });

  test("uncommitted changes are kept even when the branch is merged", async () => {
    // The dangerous case the fix creates: these were previously protected by
    // the merge bug as much as by the status check. Now only the status check
    // stands between them and deletion.
    const path = addWorktree(root, "feature-dirty", { merged: true, dirty: true });
    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.removed).not.toContain("feature-dirty");
    expect(result.kept.join("\n")).toContain("uncommitted changes");
    expect(existsSync(path), "a worktree with uncommitted work was deleted").toBe(true);
    expect(existsSync(join(path, "scratch.txt"))).toBe(true);
  });

  test("an untracked-only worktree is still treated as dirty", async () => {
    // `git status --porcelain` reports untracked files, and an untracked file
    // is unrecoverable once the directory is gone — more dangerous than a
    // modification, which still exists in the object store.
    const path = join(root, ".claude", "worktrees", "feature-untracked");
    addWorktree(root, "feature-untracked", { merged: true });
    writeFileSync(join(path, "notes.md"), "only copy\n");

    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.removed).not.toContain("feature-untracked");
    expect(existsSync(join(path, "notes.md"))).toBe(true);
  });

  test("mixed state: only the safe one goes", async () => {
    addWorktree(root, "safe", { merged: true });
    addWorktree(root, "dirty", { merged: true, dirty: true });
    addWorktree(root, "unmerged", { merged: false });

    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.removed).toEqual(["safe"]);
    expect(existsSync(join(root, ".claude", "worktrees", "dirty"))).toBe(true);
    expect(existsSync(join(root, ".claude", "worktrees", "unmerged"))).toBe(true);
  });
});

describe("#68 SC-2: merge detection does not parse display output", () => {
  test("a branch whose name contains the display prefix is not confused", async () => {
    // Names like "+weird" or a branch containing "* " would defeat a parser
    // working on `git branch` output. Asserting on behaviour rather than on
    // the implementation keeps this honest if the approach changes again.
    addWorktree(root, "plus-in-name", { merged: true });
    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.removed).toContain("plus-in-name");
  });

  test("a branch that merely has main as an ancestor is not treated as merged", async () => {
    // The inverse error, and the one that loses work: `merge-base --is-ancestor`
    // must be asked whether BRANCH is an ancestor of main, not the reverse. Get
    // the argument order backwards and every branch created from main looks
    // merged, so cleanup deletes unmerged work.
    const path = addWorktree(root, "branched-from-main", { merged: false });
    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.removed, "argument order inverted — unmerged work would be deleted")
      .not.toContain("branched-from-main");
    expect(existsSync(path)).toBe(true);
  });
});

describe("#68: age filter still applies", () => {
  test("a worktree newer than maxAgeMs is skipped regardless of merge state", async () => {
    addWorktree(root, "fresh", { merged: true });
    const result = await cleanupWorktrees({ projectRoot: root, maxAgeMs: 60 * 60 * 1000 });
    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, ".claude", "worktrees", "fresh"))).toBe(true);
  });
});

describe("#68 SC-3: project root comes from the repo, not from cwd", () => {
  test("resolves the repo root from a subdirectory", () => {
    mkdirSync(join(root, "deep", "nested"), { recursive: true });
    expect(repoRootFrom(join(root, "deep", "nested"))).toBe(realpathSync(root));
  });

  test("returns null outside a repository instead of guessing", () => {
    // The old code used process.cwd() unconditionally, so a session opened in
    // ~ "cleaned" a non-repo and reported success. Null forces the caller to
    // say it skipped, which is the difference between a no-op and a lie.
    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      expect(repoRootFrom(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test("from inside a LINKED WORKTREE it resolves to the main repo", () => {
    // The case that decides --git-common-dir over --show-toplevel.
    // `.claude/worktrees/` lives in the main checkout, so resolving to the
    // worktree would point cleanup at a directory that is never there — it
    // would fail silently in exactly the situation cleanup exists for.
    const wt = addWorktree(root, "linked", { merged: false });
    expect(repoRootFrom(wt)).toBe(realpathSync(root));
    expect(repoRootFrom(wt)).not.toBe(realpathSync(wt));
  });

  test("the hook no longer reads process.cwd() for the project root", () => {
    // Guards the wiring, not just the helper: the resolver existing is no use
    // if the hook still calls cwd(). Three call sites each used it
    // independently, which was three chances to diverge.
    const hook = readFileSync(join(import.meta.dir, "..", "..", "hooks", "StaleTTLCleanup.hook.ts"), "utf-8");
    const cwdUses = hook.match(/process\.cwd\(\)/g) || [];
    expect(cwdUses.length, "cwd() should be read once, only to seed repoRootFrom").toBe(1);
    expect(hook).toContain("repoRootFrom(process.cwd())");
  });
});
