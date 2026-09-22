/**
 * Worktree isolation — creates and cleans up git worktrees
 * for test-brief agent spawning.
 *
 * Agent runs in a git worktree with throwaway writes.
 * Transcript file persists outside the worktree for auditing.
 *
 * SC-407: Worktree isolation mechanism
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface WorktreeConfig {
  projectRoot: string;
  branchPrefix?: string;
  transcriptDir?: string;
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
  transcriptDir: string;
  cleanup: () => void;
}

/**
 * Create an isolated git worktree for agent testing.
 * Transcript directory is created outside the worktree so it persists after cleanup.
 */
export function createWorktree(config: WorktreeConfig): WorktreeResult {
  const { projectRoot, branchPrefix = "test-brief" } = config;

  const id = `${branchPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const branchName = id;
  const worktreePath = join(projectRoot, ".claude", "worktrees", id);

  // Transcript dir persists outside worktree
  const transcriptDir = config.transcriptDir || join(projectRoot, ".rungate", "test-brief-transcripts", id);
  if (!existsSync(transcriptDir)) {
    mkdirSync(transcriptDir, { recursive: true });
  }

  // Create worktree
  const result = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    cwd: projectRoot,
    timeout: 30_000,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  return {
    worktreePath,
    branchName,
    transcriptDir,
    cleanup() {
      removeWorktree(projectRoot, worktreePath, branchName);
    },
  };
}

/**
 * Remove a git worktree and its branch.
 * Internal — use WorktreeResult.cleanup() instead.
 */
function removeWorktree(projectRoot: string, worktreePath: string, branchName: string): void {
  spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: projectRoot,
    timeout: 15_000,
    encoding: "utf-8",
  });

  spawnSync("git", ["branch", "-D", branchName], {
    cwd: projectRoot,
    timeout: 5_000,
    encoding: "utf-8",
  });
}
