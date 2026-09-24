/**
 * Branch cleanup — deletes abandoned ship branches that have no open PR.
 *
 * Two entry points:
 * - cleanupBranch(): deletes a single branch (used by prove UNPROVEN flow)
 * - cleanupStaleBranches(): bulk cleanup of remote branches older than N days
 *   (used by StaleTTLCleanup hook on session start)
 *
 * Safety:
 * - NEVER deletes protected branches (main, master)
 * - NEVER deletes branches with open PRs
 * - When gh pr list fails, refuses to delete (safety default)
 *
 * GitHub issue #516
 */

import { spawnSync } from "child_process";

// ── Types ───────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export type CommandExecutor = (
  cmd: string,
  args: readonly string[]
) => CommandResult;

export interface CleanupBranchOptions {
  readonly branch: string;
  readonly projectRoot: string;
  readonly executor?: CommandExecutor;
}

export interface CleanupBranchResult {
  readonly deleted: boolean;
  readonly reason?: string;
  readonly error?: string;
}

export interface CleanupStaleBranchesOptions {
  readonly projectRoot: string;
  readonly maxAgeDays?: number;
  readonly executor?: CommandExecutor;
}

export interface CleanupStaleBranchesResult {
  readonly deleted: string[];
  readonly skipped: string[];
  readonly errors: string[];
}

// ── Constants ───────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const DEFAULT_MAX_AGE_DAYS = 7;

// ── Default executor ────────────────────────────────────────

function defaultExecutor(cmd: string, args: readonly string[]): CommandResult {
  const result = spawnSync(cmd, [...args], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ── Core: check for open PRs ────────────────────────────────

function hasOpenPR(
  branch: string,
  exec: CommandExecutor
): { hasPR: boolean; error?: string } {
  const result = exec("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);

  if (result.status !== 0) {
    return { hasPR: false, error: `gh pr list failed: ${result.stderr}` };
  }

  // Non-empty stdout means at least one open PR exists
  const output = result.stdout.trim();
  return { hasPR: output.length > 0 && output !== "[]" };
}

// ── cleanupBranch ───────────────────────────────────────────

/**
 * Delete a single branch (local + remote) if no open PR exists.
 *
 * Used by the prove workflow when verdict is UNPROVEN.
 */
export function cleanupBranch(opts: CleanupBranchOptions): CleanupBranchResult {
  const { branch, projectRoot, executor = defaultExecutor } = opts;

  // Guard: never delete protected branches
  if (PROTECTED_BRANCHES.has(branch)) {
    return { deleted: false, reason: `${branch} is a protected branch` };
  }

  // Check for open PRs
  const prCheck = hasOpenPR(branch, executor);
  if (prCheck.error) {
    return {
      deleted: false,
      reason: "Cannot verify PR status — refusing to delete",
      error: prCheck.error,
    };
  }

  if (prCheck.hasPR) {
    return { deleted: false, reason: `open PR exists for ${branch}` };
  }

  // Delete local branch
  executor("git", ["-C", projectRoot, "branch", "-D", branch]);

  // Delete remote branch (ignore failure — remote may not exist)
  executor("git", ["-C", projectRoot, "push", "origin", "--delete", branch]);

  return { deleted: true };
}

// ── cleanupStaleBranches ────────────────────────────────────

/**
 * Find and delete remote branches older than maxAgeDays with no open PR.
 *
 * Used by StaleTTLCleanup hook on session start.
 */
export function cleanupStaleBranches(
  opts: CleanupStaleBranchesOptions
): CleanupStaleBranchesResult {
  const {
    projectRoot,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    executor = defaultExecutor,
  } = opts;

  const result: CleanupStaleBranchesResult = {
    deleted: [],
    skipped: [],
    errors: [],
  };

  // List remote branches with their committer dates
  const refList = executor("git", [
    "-C",
    projectRoot,
    "for-each-ref",
    "--format=%(committerdate:unix)\t%(refname)",
    "refs/remotes/origin",
  ]);

  if (refList.status !== 0) {
    (result.errors as string[]).push(
      `Failed to list remote branches: ${refList.stderr}`
    );
    return result;
  }

  const lines = refList.stdout.trim().split("\n").filter(Boolean);
  const nowUnix = Math.floor(Date.now() / 1000);
  const maxAgeSeconds = maxAgeDays * 24 * 60 * 60;

  for (const line of lines) {
    const [tsStr, refName] = line.split("\t");
    if (!tsStr || !refName) continue;

    const branchName = refName.replace(/^refs\/remotes\/origin\//, "");

    // Skip protected branches
    if (PROTECTED_BRANCHES.has(branchName)) continue;

    // Skip HEAD pointer
    if (branchName === "HEAD") continue;

    // Check age
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) continue;

    const ageSeconds = nowUnix - ts;
    if (ageSeconds < maxAgeSeconds) continue;

    // Check for open PRs
    const prCheck = hasOpenPR(branchName, executor);
    if (prCheck.error) {
      (result.errors as string[]).push(
        `Cannot check PRs for ${branchName}: ${prCheck.error}`
      );
      continue;
    }

    if (prCheck.hasPR) {
      (result.skipped as string[]).push(
        `${branchName} (open PR exists)`
      );
      continue;
    }

    // Delete remote branch
    const delResult = executor("git", [
      "-C",
      projectRoot,
      "push",
      "origin",
      "--delete",
      branchName,
    ]);

    if (delResult.status !== 0) {
      (result.errors as string[]).push(
        `Failed to delete ${branchName}: ${delResult.stderr}`
      );
    } else {
      (result.deleted as string[]).push(branchName);
    }
  }

  return result;
}
