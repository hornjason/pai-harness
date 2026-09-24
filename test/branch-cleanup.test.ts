/**
 * Branch cleanup tests — verifies automatic cleanup of abandoned ship branches.
 *
 * AC-1: prove UNPROVEN verdict triggers branch deletion via lib/branch-cleanup.ts
 *       when no open PR exists for the ship branch
 * AC-2: StaleTTLCleanup hook identifies and deletes remote branches older than
 *       7 days that have no open PR on session start
 * AC-A1: branch deletion function checks for open pull requests via gh pr list
 *        and skips deletion when a PR is open
 */
import { test, expect, describe } from "bun:test";
import type {
  CleanupBranchResult,
  CleanupStaleBranchesResult,
  CommandExecutor,
} from "../lib/branch-cleanup";
import { cleanupBranch, cleanupStaleBranches } from "../lib/branch-cleanup";

// ── Test helpers ────────────────────────────────────────────

/** Build a mock executor that returns canned results per command pattern. */
function mockExecutor(
  responses: Array<{
    match: RegExp;
    stdout: string;
    status: number;
    stderr?: string;
  }>
): CommandExecutor {
  return (cmd: string, args: readonly string[]) => {
    const full = `${cmd} ${args.join(" ")}`;
    for (const r of responses) {
      if (r.match.test(full)) {
        return {
          stdout: r.stdout,
          stderr: r.stderr ?? "",
          status: r.status,
        };
      }
    }
    // Unmatched command — return success with empty output
    return { stdout: "", stderr: "", status: 0 };
  };
}

// ── AC-A1: branch deletion checks for open PRs ─────────────

describe("AC-A1: cleanupBranch checks for open PRs", () => {
  test("skips deletion when an open PR exists for the branch", () => {
    const exec = mockExecutor([
      {
        match: /gh pr list/,
        stdout: "123\tFix something\tOPEN\t516-deep-modules\n",
        status: 0,
      },
    ]);

    const result: CleanupBranchResult = cleanupBranch({
      branch: "516-deep-modules",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("open PR");
  });

  test("deletes branch when no open PR exists", () => {
    const exec = mockExecutor([
      {
        match: /gh pr list/,
        stdout: "",
        status: 0,
      },
      {
        match: /branch -D/,
        stdout: "Deleted branch 516-deep-modules",
        status: 0,
      },
      {
        match: /push origin --delete/,
        stdout: "",
        status: 0,
      },
    ]);

    const result: CleanupBranchResult = cleanupBranch({
      branch: "516-deep-modules",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    expect(result.deleted).toBe(true);
  });

  test("uses gh pr list to check for open PRs", () => {
    const calledCommands: string[] = [];
    const exec: CommandExecutor = (cmd, args) => {
      const full = `${cmd} ${args.join(" ")}`;
      calledCommands.push(full);
      return { stdout: "", stderr: "", status: 0 };
    };

    cleanupBranch({
      branch: "test-branch",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    const ghCall = calledCommands.find((c) => c.includes("gh pr list"));
    expect(ghCall).toBeDefined();
    expect(ghCall).toContain("test-branch");
  });

  test("returns error when gh pr list fails", () => {
    const exec = mockExecutor([
      {
        match: /gh pr list/,
        stdout: "",
        status: 1,
        stderr: "gh: not found",
      },
    ]);

    const result: CleanupBranchResult = cleanupBranch({
      branch: "test-branch",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    // Should NOT delete when we can't verify PR status — safety first
    expect(result.deleted).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── AC-1: prove UNPROVEN triggers branch deletion ───────────

describe("AC-1: cleanupBranch for prove UNPROVEN flow", () => {
  test("deletes local and remote branch when no PR exists", () => {
    const deletedBranches: string[] = [];
    const exec: CommandExecutor = (cmd, args) => {
      const full = `${cmd} ${args.join(" ")}`;
      if (/gh pr list/.test(full)) {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (/branch -D/.test(full)) {
        const branch = args[args.length - 1];
        deletedBranches.push(`local:${branch}`);
        return { stdout: `Deleted branch ${branch}`, stderr: "", status: 0 };
      }
      if (/push origin --delete/.test(full)) {
        const branch = args[args.length - 1];
        deletedBranches.push(`remote:${branch}`);
        return { stdout: "", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };

    const result = cleanupBranch({
      branch: "ship-123-feature",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    expect(result.deleted).toBe(true);
    expect(deletedBranches).toContain("local:ship-123-feature");
    expect(deletedBranches).toContain("remote:ship-123-feature");
  });

  test("succeeds even if remote branch does not exist", () => {
    const exec = mockExecutor([
      {
        match: /gh pr list/,
        stdout: "",
        status: 0,
      },
      {
        match: /branch -D/,
        stdout: "Deleted branch test-branch",
        status: 0,
      },
      {
        match: /push origin --delete/,
        stdout: "",
        status: 1,
        stderr: "error: unable to delete: remote ref does not exist",
      },
    ]);

    const result = cleanupBranch({
      branch: "test-branch",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    // Should still count as deleted — local was cleaned up
    expect(result.deleted).toBe(true);
  });

  test("never deletes main branch", () => {
    const exec = mockExecutor([
      {
        match: /gh pr list/,
        stdout: "",
        status: 0,
      },
    ]);

    const result = cleanupBranch({
      branch: "main",
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("protected");
  });
});

// ── AC-2: StaleTTLCleanup deletes remote branches > 7 days ──

describe("AC-2: cleanupStaleBranches for remote branch cleanup", () => {
  test("identifies remote branches older than 7 days", () => {
    // Simulate branches with dates — two old, one recent
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;

    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: [
          `${eightDaysAgo}\trefs/remotes/origin/old-branch-1`,
          `${eightDaysAgo}\trefs/remotes/origin/old-branch-2`,
          `${twoDaysAgo}\trefs/remotes/origin/recent-branch`,
        ].join("\n"),
        status: 0,
      },
      // gh pr list for old-branch-1 — no PR
      {
        match: /gh pr list.*old-branch-1/,
        stdout: "",
        status: 0,
      },
      // gh pr list for old-branch-2 — has open PR
      {
        match: /gh pr list.*old-branch-2/,
        stdout: "456\tSome PR\tOPEN\told-branch-2\n",
        status: 0,
      },
      // git push --delete for old-branch-1 (may have -C flag)
      {
        match: /push origin --delete.*old-branch-1/,
        stdout: "",
        status: 0,
      },
    ]);

    const result: CleanupStaleBranchesResult = cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      maxAgeDays: 7,
      executor: exec,
    });

    expect(result.deleted).toContain("old-branch-1");
    expect(result.deleted).not.toContain("old-branch-2"); // has PR
    expect(result.deleted).not.toContain("recent-branch"); // too new
    expect(result.skipped.some((s) => s.includes("old-branch-2"))).toBe(true);
  });

  test("never deletes main or master remote branches", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: [
          `${oldTs}\trefs/remotes/origin/main`,
          `${oldTs}\trefs/remotes/origin/master`,
          `${oldTs}\trefs/remotes/origin/stale-feature`,
        ].join("\n"),
        status: 0,
      },
      {
        match: /gh pr list.*stale-feature/,
        stdout: "",
        status: 0,
      },
      {
        match: /push origin --delete.*stale-feature/,
        stdout: "",
        status: 0,
      },
    ]);

    const result = cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      maxAgeDays: 7,
      executor: exec,
    });

    expect(result.deleted).not.toContain("main");
    expect(result.deleted).not.toContain("master");
    expect(result.deleted).toContain("stale-feature");
  });

  test("defaults to 7-day max age when not specified", () => {
    const sixDaysAgo = Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60;

    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: `${sixDaysAgo}\trefs/remotes/origin/almost-stale`,
        status: 0,
      },
    ]);

    const result = cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    // 6 days old < 7 day default — should not be deleted
    expect(result.deleted).not.toContain("almost-stale");
  });

  test("returns empty result when no remote branches exist", () => {
    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: "",
        status: 0,
      },
    ]);

    const result = cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      executor: exec,
    });

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
