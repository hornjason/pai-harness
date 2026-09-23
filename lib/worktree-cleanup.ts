/**
 * Worktree cleanup — removes stale git worktrees from .claude/worktrees/
 *
 * Safety-first design:
 * - NEVER removes worktrees with uncommitted changes
 * - NEVER removes worktrees with unmerged branches
 * - Optionally filters by age (maxAgeMs)
 *
 * GitHub issue #564
 */

import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface CleanupResult {
  removed: string[];
  kept: string[];
  errors: string[];
}

export interface CleanupOptions {
  projectRoot: string;
  maxAgeMs?: number;
}

/**
 * Clean up stale git worktrees from .claude/worktrees/.
 *
 * @param opts - Cleanup options with projectRoot and optional maxAgeMs filter
 * @returns CleanupResult with removed, kept, and errors arrays
 */
export async function cleanupWorktrees(opts: CleanupOptions): Promise<CleanupResult> {
  const { projectRoot, maxAgeMs } = opts;
  const result: CleanupResult = {
    removed: [],
    kept: [],
    errors: [],
  };

  const worktreesDir = join(projectRoot, ".claude", "worktrees");

  // Early exit if directory doesn't exist
  if (!existsSync(worktreesDir)) {
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch (err) {
    result.errors.push(`Failed to read worktrees directory: ${err}`);
    return result;
  }

  const now = Date.now();

  for (const entry of entries) {
    const worktreePath = join(worktreesDir, entry);

    // Skip if not a directory
    try {
      const stat = statSync(worktreePath);
      if (!stat.isDirectory()) continue;

      // Check age filter if provided
      if (maxAgeMs !== undefined) {
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) {
          // Too new, skip
          continue;
        }
      }
    } catch (err) {
      result.errors.push(`Failed to stat ${entry}: ${err}`);
      continue;
    }

    // Check for uncommitted changes
    const statusCheck = spawnSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    });

    if (statusCheck.status !== 0) {
      result.errors.push(`Failed to check git status for ${entry}: ${statusCheck.stderr}`);
      continue;
    }

    if (statusCheck.stdout.trim() !== "") {
      // Has uncommitted changes — keep it
      result.kept.push(`${entry} (uncommitted changes)`);
      continue;
    }

    // Get branch name
    const branchCheck = spawnSync("git", ["-C", worktreePath, "branch", "--show-current"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
    });

    if (branchCheck.status !== 0) {
      result.errors.push(`Failed to get branch name for ${entry}: ${branchCheck.stderr}`);
      continue;
    }

    const branchName = branchCheck.stdout.trim();
    if (!branchName) {
      // Detached HEAD or no branch — keep it
      result.kept.push(`${entry} (detached HEAD)`);
      continue;
    }

    // Check if branch is merged to main
    const mergeCheck = spawnSync("git", ["branch", "--merged", "main"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
    });

    if (mergeCheck.status !== 0) {
      result.errors.push(`Failed to check merge status for ${entry}: ${mergeCheck.stderr}`);
      continue;
    }

    const mergedBranches = mergeCheck.stdout.split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
    const isMerged = mergedBranches.includes(branchName);

    if (!isMerged) {
      // Branch not merged — keep it
      result.kept.push(`${entry} (unmerged branch: ${branchName})`);
      continue;
    }

    // All safety checks passed — remove the worktree
    const removeResult = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 15000,
    });

    if (removeResult.status !== 0) {
      result.errors.push(`Failed to remove ${entry}: ${removeResult.stderr}`);
    } else {
      result.removed.push(entry);
    }
  }

  // Prune worktree references
  const pruneResult = spawnSync("git", ["worktree", "prune"], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 5000,
  });

  if (pruneResult.status !== 0) {
    result.errors.push(`Failed to prune worktree references: ${pruneResult.stderr}`);
  }

  // Log summary
  console.log(`Worktree cleanup: ${result.removed.length} removed, ${result.kept.length} kept`);

  return result;
}
