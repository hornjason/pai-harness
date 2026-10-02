/**
 * Branch cleanup tests — verifies automatic cleanup of abandoned ship branches.
 *
 * AC-1: prove UNPROVEN verdict triggers branch deletion via lib/branch-cleanup.ts
 *       when no open PR exists for the ship branch
 * AC-2: StaleTTLCleanup hook identifies and deletes remote branches older than
 *       7 days that have no open PR on session start
 * AC-A1: branch deletion function checks for open pull requests via Octokit listPRs
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

/** Build a mock GitHub client for testing. Filters PRs by head branch like real Octokit. */
function mockGitHubClient(openPRs: Array<{ number: number; head: { ref: string } }> = []) {
  return {
    rest: {
      issues: {
        get: async () => ({ data: {} }),
        createComment: async () => ({ data: {} }),
        addLabels: async () => ({ data: [] }),
        update: async () => ({ data: {} }),
      },
      pulls: {
        create: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
        list: async (params: any) => {
          // Simulate server-side head filter like real GitHub API
          let filtered = openPRs;
          if (params?.head) {
            filtered = openPRs.filter(pr => pr.head.ref === params.head);
          }
          return { data: filtered };
        },
      },
    },
  } as any;
}

// ── AC-A1: branch deletion checks for open PRs ─────────────

describe("AC-A1: cleanupBranch checks for open PRs", () => {
  test("skips deletion when an open PR exists for the branch", async () => {
    const exec = mockExecutor([]);
    const client = mockGitHubClient([
      { number: 123, head: { ref: "516-deep-modules" } },
    ]);

    const result: CleanupBranchResult = await cleanupBranch({
      branch: "516-deep-modules",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("open PR");
  });

  test("deletes branch when no open PR exists", async () => {
    const exec = mockExecutor([
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
    const client = mockGitHubClient([]);

    const result: CleanupBranchResult = await cleanupBranch({
      branch: "516-deep-modules",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toBe(true);
  });

  test("returns error when listPRs fails", async () => {
    const exec = mockExecutor([]);
    // Client that throws on list
    const client = {
      rest: {
        issues: { get: async () => ({ data: {} }), createComment: async () => ({ data: {} }), addLabels: async () => ({ data: [] }), update: async () => ({ data: {} }) },
        pulls: {
          create: async () => ({ data: {} }),
          update: async () => ({ data: {} }),
          list: async () => { throw new Error("API error"); },
        },
      },
    } as any;

    const result: CleanupBranchResult = await cleanupBranch({
      branch: "test-branch",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    // Should NOT delete when we can't verify PR status — safety first
    expect(result.deleted).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── AC-1: prove UNPROVEN triggers branch deletion ───────────

describe("AC-1: cleanupBranch for prove UNPROVEN flow", () => {
  test("deletes local and remote branch when no PR exists", async () => {
    const deletedBranches: string[] = [];
    const exec: CommandExecutor = (cmd, args) => {
      const full = `${cmd} ${args.join(" ")}`;
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
    const client = mockGitHubClient([]);

    const result = await cleanupBranch({
      branch: "ship-123-feature",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toBe(true);
    expect(deletedBranches).toContain("local:ship-123-feature");
    expect(deletedBranches).toContain("remote:ship-123-feature");
  });

  test("succeeds even if remote branch does not exist", async () => {
    const exec = mockExecutor([
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
    const client = mockGitHubClient([]);

    const result = await cleanupBranch({
      branch: "test-branch",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    // Should still count as deleted — local was cleaned up
    expect(result.deleted).toBe(true);
  });

  test("never deletes main branch", async () => {
    const exec = mockExecutor([]);
    const client = mockGitHubClient([]);

    const result = await cleanupBranch({
      branch: "main",
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("protected");
  });
});

// ── AC-2: StaleTTLCleanup deletes remote branches > 7 days ──

describe("AC-2: cleanupStaleBranches for remote branch cleanup", () => {
  test("identifies remote branches older than 7 days", async () => {
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
      {
        match: /push origin --delete.*old-branch-1/,
        stdout: "",
        status: 0,
      },
    ]);
    // old-branch-2 has an open PR, old-branch-1 does not
    const client = mockGitHubClient([
      { number: 456, head: { ref: "old-branch-2" } },
    ]);

    const result: CleanupStaleBranchesResult = await cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      maxAgeDays: 7,
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toContain("old-branch-1");
    expect(result.deleted).not.toContain("old-branch-2"); // has PR
    expect(result.deleted).not.toContain("recent-branch"); // too new
    expect(result.skipped.some((s) => s.includes("old-branch-2"))).toBe(true);
  });

  test("never deletes main or master remote branches", async () => {
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
        match: /push origin --delete.*stale-feature/,
        stdout: "",
        status: 0,
      },
    ]);
    const client = mockGitHubClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      maxAgeDays: 7,
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).not.toContain("main");
    expect(result.deleted).not.toContain("master");
    expect(result.deleted).toContain("stale-feature");
  });

  test("defaults to 7-day max age when not specified", async () => {
    const sixDaysAgo = Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60;

    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: `${sixDaysAgo}\trefs/remotes/origin/almost-stale`,
        status: 0,
      },
    ]);
    const client = mockGitHubClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    // 6 days old < 7 day default — should not be deleted
    expect(result.deleted).not.toContain("almost-stale");
  });

  test("returns empty result when no remote branches exist", async () => {
    const exec = mockExecutor([
      {
        match: /for-each-ref.*refs\/remotes\/origin/,
        stdout: "",
        status: 0,
      },
    ]);
    const client = mockGitHubClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/fake-project",
      executor: exec,
      githubClient: client,
      repo: "owner/repo",
    });

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
