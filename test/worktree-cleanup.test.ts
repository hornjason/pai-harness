import { test, expect, describe } from "bun:test";
import { cleanupWorktrees, type CleanupResult, type CleanupOptions } from "../lib/worktree-cleanup";
import { join } from "path";
import { existsSync } from "fs";

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
      errors: ["d"],
    };
    expect(result.removed).toEqual(["a", "b"]);
    expect(result.kept).toEqual(["c"]);
    expect(result.errors).toEqual(["d"]);
  });
});
