import { test, expect, describe } from "bun:test";
import { cleanupWorktrees, type CleanupResult, type CleanupOptions } from "../lib/worktree-cleanup";
import { join } from "path";
import { existsSync } from "fs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { strandedBranches, rescueStrandedBranches } from "../lib/worktree-cleanup";

describe("worktree-cleanup", () => {
  test("cleanupWorktrees function exists and is importable", () => {
    expect(typeof cleanupWorktrees).toBe("function");
  });

  test("returns correct CleanupResult shape", async () => {
    const result = await cleanupWorktrees({
      projectRoot: "/nonexistent/path",
    });

    expect(result).toHaveProperty("removed");
    expect(result).toHaveProperty("kept");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("handles non-existent worktrees directory gracefully", async () => {
    const result = await cleanupWorktrees({
      projectRoot: "/nonexistent/path",
    });

    expect(result.removed.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("with real repo: verifies function runs without crashing", async () => {
    const projectRoot = join(import.meta.dir, "..");
    const worktreesDir = join(projectRoot, ".claude", "worktrees");

    // Only run this test if worktrees directory exists
    if (!existsSync(worktreesDir)) {
      expect(true).toBe(true); // Skip test
      return;
    }

    const result = await cleanupWorktrees({
      projectRoot,
      maxAgeMs: 365 * 24 * 60 * 60 * 1000, // 1 year — don't actually remove anything
    });

    // Verify result structure
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);

    // With 1-year age filter, nothing should be removed
    expect(result.removed.length).toBe(0);
  });

  test("respects maxAgeMs filter", async () => {
    const projectRoot = join(import.meta.dir, "..");
    const worktreesDir = join(projectRoot, ".claude", "worktrees");

    if (!existsSync(worktreesDir)) {
      expect(true).toBe(true); // Skip test
      return;
    }

    // With very high maxAgeMs, nothing should qualify
    const result = await cleanupWorktrees({
      projectRoot,
      maxAgeMs: 999 * 365 * 24 * 60 * 60 * 1000, // 999 years
    });

    expect(result.removed.length).toBe(0);
  });

  test("CleanupOptions interface accepts projectRoot", () => {
    const opts: CleanupOptions = {
      projectRoot: "/some/path",
    };
    expect(opts.projectRoot).toBe("/some/path");
  });

  test("CleanupOptions interface accepts optional maxAgeMs", () => {
    const opts: CleanupOptions = {
      projectRoot: "/some/path",
      maxAgeMs: 1000,
    };
    expect(opts.maxAgeMs).toBe(1000);
  });

  test("CleanupResult interface has correct shape", () => {
    const result: CleanupResult = {
      removed: ["a", "b"],
      kept: ["c"],
      skipped: ["e"],
      // #436. Required rather than optional, so a bucket cannot be added to
      // the classifier and left out of a caller's total — which is #431's
      // defect, and the reason the summary line reconciles.
      orphaned: ["f"],
      errors: ["d"],
    };
    expect(result.removed).toEqual(["a", "b"]);
    expect(result.kept).toEqual(["c"]);
    expect(result.orphaned).toEqual(["f"]);
    expect(result.errors).toEqual(["d"]);
  });
});

/**
 * Covers SC-2630, SC-2631 (PARALLEL-AGENT-COORDINATION-SPEC.md) — #1038.
 *
 * Driven against a real bare remote rather than a stub, because the fact
 * under test is what `--not --remotes=origin` answers, and a stub that
 * returns what the test already set would hold vacuously.
 */
describe("#1038: commits that exist here and nowhere else", () => {
  const git = (cwd: string, ...a: string[]) =>
    spawnSync("git", a, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  /** A repo with `origin` pointing at a real bare remote, one commit on main, pushed. */
  function plant(): { repo: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-"));
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    spawnSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf-8" });
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf-8" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    return { repo, root };
  }

  const commitOn = (repo: string, branch: string, body: string) => {
    git(repo, "checkout", "-b", branch);
    writeFileSync(join(repo, `${branch.replace(/\//g, "-")}.txt`), body);
    git(repo, "add", "-A"); git(repo, "commit", "-m", `work on ${branch}`);
    git(repo, "checkout", "main");
  };

  test("a never-pushed branch is found with its count, and a pushed one is not", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/stranded", "x\n");
      commitOn(repo, "feat/landed", "y\n");
      git(repo, "push", "origin", "feat/landed");

      const found = strandedBranches(repo)!;
      const names = found.map(f => f.branch).sort();

      // The control. Without it a finder that returns every branch passes the
      // positive case and is wrong about the only question that matters.
      expect(names, "a branch already on origin must not be reported").toEqual(["feat/stranded"]);
      expect(found[0].commits).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a repo with no origin reports nothing stranded, not every branch", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-noorigin-"));
    try {
      const repo = join(root, "repo");
      spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf-8" });
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
      // There is nowhere the work could have been pushed TO, so the question
      // does not apply. Answering it literally flags every branch forever.
      expect(strandedBranches(repo)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the rescue pushes the stranded branch, and the tree is then clean", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/stranded", "x\n");
      expect(strandedBranches(repo)!.length, "precondition: something must be stranded").toBe(1);

      const r = rescueStrandedBranches(repo);
      expect(r.unmeasured).toBeNull();
      expect(r.pushed.map(p => p.branch)).toEqual(["feat/stranded"]);
      expect(r.failed).toEqual([]);

      // The assertion that matters: ask git again, not the return value.
      // A rescue that reports success while pushing nothing is the shape
      // this whole issue is about.
      expect(strandedBranches(repo), "after the rescue nothing is local-only").toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the default branch is never pushed by the rescue", () => {
    const { repo, root } = plant();
    try {
      // main is ahead of origin/main — exactly the state that tempts a rescue.
      writeFileSync(join(repo, "b.txt"), "b\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "local main commit");

      expect(strandedBranches(repo)!.map(b => b.branch)).toContain("main");
      const r = rescueStrandedBranches(repo);
      expect(r.pushed.map(p => p.branch), "main must never be pushed unattended").not.toContain("main");
      expect(r.examined, "main is excluded before the denominator, not after").toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("examined separates a clean tree from an instrument that did not run", () => {
    const { repo, root } = plant();
    try {
      // Nothing stranded: pushed:[] and examined:0 — and that is INDISTINGUISHABLE
      // from a failed reading unless `unmeasured` carries the difference.
      const clean = rescueStrandedBranches(repo);
      expect(clean.pushed).toEqual([]);
      expect(clean.unmeasured).toBeNull();

      const broken = rescueStrandedBranches("/nonexistent/path");
      expect(broken.pushed).toEqual([]);
      expect(broken.unmeasured, "a reading that could not be taken says so").toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
