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
 * How many commits on `branch` no `origin/*` ref contains (#232).
 *
 * `0` is the claim "every commit here is also on origin". `null` is the
 * absence of a claim and the caller keeps the worktree — "I could not tell"
 * is not grounds for `git worktree remove --force`.
 *
 * A repo with no `origin` remote returns `0` rather than the branch's whole
 * length. There is nowhere for the work to have been pushed TO, so the
 * question does not apply, and answering it literally would stop cleanup
 * dead in every local-only checkout — which is the regression that gets a
 * safety check reverted.
 */
export function unpushedCommitCount(projectRoot: string, branch: string): number | null {
  const remotes = spawnSync("git", ["remote"], {
    cwd: projectRoot, encoding: "utf-8", timeout: 5000,
  });
  if (remotes.status !== 0) return null;
  if (!remotes.stdout.split("\n").map(r => r.trim()).includes("origin")) return 0;

  const count = spawnSync("git", ["rev-list", "--count", branch, "--not", "--remotes=origin"], {
    cwd: projectRoot, encoding: "utf-8", timeout: 10_000,
  });
  if (count.status !== 0) return null;
  const n = parseInt(count.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Why this worktree must be kept, given what the origin check answered, or
 * null to go ahead and remove it (#232).
 *
 * One exported binding rather than two branches inline, because the `null`
 * arm is the one no fixture can reach: it needs git to fail between the
 * branch read and the rev-list, which is real — a branch deleted in that
 * window — and not something a test can stage. Inline, removing that arm
 * scored ZERO red; here it is driven directly.
 */
export function unpushedKeepReason(
  entry: string,
  branch: string,
  unpushed: number | null,
): string | null {
  if (unpushed === null) return `${entry} (could not tell whether ${branch} is on origin)`;
  if (unpushed > 0) return `${entry} (${unpushed} commit(s) on ${branch} not on origin)`;
  return null;
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

    // Is the branch merged into main? (#68)
    //
    // This used to parse `git branch --merged main` display output, stripping
    // a leading `*`. Git also prefixes `+ ` on any branch checked out in a
    // LINKED WORKTREE — which is, by definition, every branch this function
    // evaluates. So entries came out as "+ 24-doc-hygiene-infra", never
    // matched the bare name, every candidate was classified unmerged, and the
    // function removed nothing for its entire existence. 36 worktrees and
    // 243 MB accumulated behind it.
    //
    // Ask git the question directly instead. `--is-ancestor` is a predicate
    // with an exit status, so there is no display output to parse and no
    // decoration to strip — the whole class of prefix bug goes away rather
    // than this one instance of it.
    //
    // Argument order is load-bearing and inverting it is catastrophic: this
    // asks whether BRANCH is an ancestor of main. Reversed, every branch cut
    // from main would look merged and cleanup would delete unmerged work.
    // test/unit/worktree-cleanup-merge.test.ts pins both directions.
    const mergeCheck = spawnSync("git", ["merge-base", "--is-ancestor", branchName, "main"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
    });

    // Exit 0 = merged, 1 = not merged. Anything else (128: bad revision, no
    // `main`, not a repo) is an error, NOT a verdict — treating it as "not
    // merged" would be safe here, but treating it as merged would delete work,
    // and silently swallowing it is how the original bug stayed invisible.
    if (mergeCheck.status !== 0 && mergeCheck.status !== 1) {
      result.errors.push(
        `Failed to check merge status for ${entry}: git exited ${mergeCheck.status}: ${mergeCheck.stderr.trim()}`,
      );
      continue;
    }

    if (mergeCheck.status !== 0) {
      // Branch not merged — keep it
      result.kept.push(`${entry} (unmerged branch: ${branchName})`);
      continue;
    }

    // Merged into LOCAL main is not the same as safe to delete (#232).
    //
    // A branch merged into a main that was never pushed exists in exactly one
    // place on earth, and this function runs unattended from a SessionStart
    // hook. #228 and #232 are both about work that was correct and became
    // unreachable; removing a worktree whose commits are not on origin is the
    // same loss with a tidier name.
    const keepReason = unpushedKeepReason(
      entry, branchName, unpushedCommitCount(projectRoot, branchName),
    );
    if (keepReason) {
      result.kept.push(keepReason);
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
