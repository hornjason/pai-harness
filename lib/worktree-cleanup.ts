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

import { readdirSync, realpathSync, statSync, existsSync, readFileSync, rmSync } from "fs";
import { join, isAbsolute } from "path";
import { spawnSync } from "child_process";

export interface CleanupResult {
  removed: string[];
  kept: string[];
  /**
   * Entries the run never judged — too new, or not a directory (#431).
   *
   * These used to `continue` without being recorded anywhere, so
   * `removed + kept` did not add up to the number of entries and the printed
   * line said "144 kept" against 149 worktrees. A bucket that exists only as
   * the gap between two other numbers is a bucket nobody reconciles.
   */
  skipped: string[];
  /**
   * Checkouts git has no registration for (#436).
   *
   * A directory whose `.git` file names an admin directory that does not
   * exist. `git worktree remove` cannot touch it — git does not know it is a
   * worktree — so every pass pushed it to `errors` and moved on. That was the
   * conservative behaviour and it was also permanent: an error that recurs on
   * every SessionStart and can never be resolved is indistinguishable from a
   * log line, which is how a 6.2 MB leftover sat in the report for weeks.
   *
   * Its own bucket, so "git could not answer" stays distinct from "there is
   * nothing to ask git about".
   */
  orphaned: string[];
  errors: string[];
}

export interface CleanupOptions {
  projectRoot: string;
  maxAgeMs?: number;
  /**
   * Delete orphaned checkouts rather than only reporting them (#436 SC-5).
   *
   * **Default off, and that is the decision rather than an oversight.** This
   * function's governing asymmetry, already written into the merge check two
   * hundred lines below, is that treating "not merged" as unsafe costs disk
   * and treating "merged" as safe can delete work. An orphan is the case
   * where the question cannot be asked at all: the admin directory is gone,
   * so `git status` cannot run, and nothing can establish whether the
   * checkout holds work that exists nowhere else.
   *
   * Removing it would therefore be a recursive delete of content this
   * function has explicitly failed to classify, run unprompted at
   * SessionStart. So the automatic pass reports; an operator who has looked
   * passes `removeOrphans: true`. `hooks/StaleTTLCleanup.hook.ts` does not.
   */
  removeOrphans?: boolean;
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

/** What `origin` knows about a branch. `unpushedCommitCount` collapses two of these. */
export type OriginState =
  /** The repo has no `origin`, so "pushed" is not a question that applies. */
  | { kind: "no-origin" }
  /** A git invocation failed. Not a verdict. */
  | { kind: "unknown" }
  /** Commits exist here and nowhere else. */
  | { kind: "ahead"; count: number }
  /** Every commit on the branch is also on an `origin/*` ref. */
  | { kind: "on-origin" };

export function originState(projectRoot: string, branch: string): OriginState {
  const remotes = spawnSync("git", ["remote"], { cwd: projectRoot, encoding: "utf-8", timeout: 5000 });
  if (remotes.status !== 0) return { kind: "unknown" };
  if (!remotes.stdout.split("\n").map(r => r.trim()).includes("origin")) return { kind: "no-origin" };

  const count = spawnSync("git", ["rev-list", "--count", branch, "--not", "--remotes=origin"], {
    cwd: projectRoot, encoding: "utf-8", timeout: 10_000,
  });
  if (count.status !== 0) return { kind: "unknown" };
  const n = parseInt(count.stdout.trim(), 10);
  if (!Number.isFinite(n)) return { kind: "unknown" };
  return n > 0 ? { kind: "ahead", count: n } : { kind: "on-origin" };
}

/**
 * Why a clean, unlocked worktree must be kept, or null to remove it (#431).
 *
 * ## Why "unmerged" stopped being a reason on its own
 *
 * 149 worktrees had accumulated here, 71 of them clean and unmerged, the
 * oldest 13.7 days old, and the cleanup removed none of them for weeks. The
 * rule was "never remove an unmerged branch", which reads as prudence and is
 * actually the wrong question: **`git worktree remove` deletes a checkout,
 * not a branch.** The ref survives, its commits survive, and `git checkout`
 * brings it all back. Nothing is lost.
 *
 * What CAN be lost is work that exists in exactly one place: uncommitted
 * changes — checked before this is called — and commits that never reached
 * origin. So the real safety property is "is every commit on this branch
 * also somewhere else", and asking it directly both protects more (an
 * unpushed branch merged into a local-only main was removable before) and
 * permits more (an unmerged fan-out branch fully pushed is just a stale
 * directory).
 *
 * `merged` is still load-bearing in exactly one case: a repo with no
 * `origin` at all, where "also somewhere else" has no meaning and the only
 * remaining evidence is that main contains the work. Without that arm this
 * change would delete unmerged local-only work, which is the regression that
 * gets a safety check reverted — and `unpushedCommitCount` returns `0` for a
 * remote-less repo, so it would have looked exactly like a pushed branch.
 *
 * One exported binding, so there is one thing to mutate.
 */
export function removalKeepReason(
  entry: string,
  branch: string,
  merged: boolean,
  origin: OriginState,
): string | null {
  switch (origin.kind) {
    case "unknown":
      return `${entry} (could not tell whether ${branch} is on origin)`;
    case "ahead":
      return `${entry} (${origin.count} commit(s) on ${branch} not on origin)`;
    case "no-origin":
      return merged ? null : `${entry} (no origin remote, and ${branch} is not merged into main)`;
    case "on-origin":
      // Merged or not. The branch ref is not touched by `worktree remove`.
      return null;
  }
}

/**
 * The worktree paths git reports as locked, or `null` if it could not say.
 *
 * `null` is not an empty set. An unreadable listing means every claim is
 * invisible, and the caller keeps everything rather than treating silence as
 * permission — the same rule `unpushedCommitCount` follows for `null`.
 */
export function lockedWorktreePaths(projectRoot: string): Set<string> | null {
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectRoot, encoding: "utf-8", timeout: 15_000,
  });
  if (list.status !== 0) return null;

  const paths = new Set<string>();
  let current: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.startsWith("locked") && current) paths.add(realPath(current));
  }
  return paths;
}

/**
 * Why a worktree must be kept on the strength of locks alone, or null (#431).
 *
 * One exported binding for the same reason `unpushedKeepReason` is one: the
 * `null` arm — git could not list the worktrees, so every claim is
 * invisible — needs git to fail, which no fixture can stage. Inline, all
 * three lock mutations scored ZERO red, including reverting the realpath
 * comparison that makes the check work at all on macOS. Driven directly,
 * each arm is a case.
 *
 * `null` keeps everything. An empty set means "nothing is claimed" and
 * would licence removing all of it, so the two must not collapse.
 */
export function lockKeepReason(
  entry: string,
  worktreePath: string,
  locked: ReadonlySet<string> | null,
): string | null {
  if (locked === null) return `${entry} (could not read which worktrees are locked)`;
  // Resolved on BOTH sides. git reports worktree paths with symlinks
  // resolved; the caller builds this one with `join`. On macOS the temp
  // directory is under a `/var` → `/private/var` symlink, so a raw
  // comparison never matches and the check is inert on the platform it was
  // written on.
  return locked.has(realPath(worktreePath)) ? `${entry} (locked)` : null;
}

/**
 * A path with symlinks resolved, or the path itself if it cannot be read.
 *
 * git reports worktree paths resolved. On macOS the system temp directory —
 * and therefore every fixture in the suite — lives under `/var`, which is a
 * symlink to `/private/var`, so a set built from git's output and probed
 * with a `join()`ed path never matches. The lock check would have been
 * silently inert on the platform it was written on: a guard that cannot see
 * what it guards, which is the defect class this file keeps meeting.
 *
 * Falling back to the raw path on failure is deliberate. A miss here means
 * a lock is not seen, so it must not ALSO swallow the error silently — the
 * caller keeps anything it cannot classify, and an unreadable path fails
 * the `existsSync`/`statSync` above long before this matters.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The admin directory a checkout's `.git` file names, when that directory is
 * gone — otherwise `null` (#436).
 *
 * A linked worktree's `.git` is a FILE reading `gitdir: <path>`. When
 * `git worktree prune` removes the registration but leaves the checkout, that
 * path stops existing and every git command run inside the directory fails
 * with "not a git repository". Nothing else produces that state, which is why
 * the test is the gitdir rather than the status failure: a status that fails
 * for any OTHER reason is still an error, because something unexplained
 * happened and this function has no business deleting anything over it.
 *
 * Three things are deliberately NOT orphans:
 *
 *   - no `.git` at all — it was never a worktree, and whatever it is, it is
 *     not this function's to delete;
 *   - a `.git` DIRECTORY — that is a whole repository someone put here, not a
 *     linked checkout;
 *   - a gitdir that exists — the registration is intact and the ordinary
 *     path applies.
 *
 * One exported binding, so there is one thing to mutate.
 */
export function orphanedGitdir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, ".git");

  // ONE decider for "is there a readable `.git` FILE here", and it is this
  // read. The first draft asked the same question twice more — a `statSync`
  // whose catch meant "no .git", and an `isFile()` meaning "a real
  // repository" — and the mutation battery is what showed they were the same
  // question: dropping `isFile()` measured 0 of 47 red, because a directory
  // makes this read throw EISDIR and a missing path makes it throw ENOENT,
  // so the read already returned null for both. Two of the three could be
  // deleted and no test could tell. See
  // `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape.
  //
  // The direction the catch fails in is the safe one: null means "not an
  // orphan", and the only thing downstream does with an orphan is offer to
  // delete it.
  let contents: string;
  try {
    contents = readFileSync(dotGit, "utf-8");
  } catch {
    return null; // absent, a directory, or unreadable — none of them is an orphan
  }

  const m = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!m) return null; // not the shape git writes; do not guess
  const gitdir = m[1]!;
  const resolved = isAbsolute(gitdir) ? gitdir : join(worktreePath, gitdir);
  return existsSync(resolved) ? null : resolved;
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
    skipped: [],
    orphaned: [],
    errors: [],
  };

  // `git worktree lock` is the one durable claim a running job can make on a
  // worktree, and it is git's own — `worktree remove` refuses a locked tree
  // regardless of what this function decides (#431). Read once, up front,
  // because the per-entry alternative is 149 subprocesses.
  //
  // Read from the porcelain listing rather than by probing for the admin
  // file: a lock recorded in a form this function does not recognise would
  // look unlocked, and "I did not see a claim" must not be how a claim gets
  // ignored. A listing that cannot be read leaves the set null, and a null
  // set keeps everything.
  const locked = lockedWorktreePaths(projectRoot);

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
      if (!stat.isDirectory()) {
        result.skipped.push(`${entry} (not a directory)`);
        continue;
      }

      // Check age filter if provided
      if (maxAgeMs !== undefined) {
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) {
          // Too new to judge. Recorded, because an entry counted in neither
          // bucket is how the printed totals stopped adding up (#431).
          result.skipped.push(`${entry} (younger than the age filter)`);
          continue;
        }
      }
    } catch (err) {
      result.errors.push(`Failed to stat ${entry}: ${err}`);
      continue;
    }

    // A locked worktree is a claim by something still using it. git refuses
    // to remove one anyway; recording it as KEPT rather than letting the
    // removal fail into `errors` keeps "something owns this" distinct from
    // "the removal broke" (#431).
    const lockReason = lockKeepReason(entry, worktreePath, locked);
    if (lockReason) {
      result.kept.push(lockReason);
      continue;
    }

    // #436: git has no registration for this checkout, so every command run
    // inside it fails and `git worktree remove` cannot touch it. Asked BEFORE
    // the status call, because the status call is the thing that fails — and
    // classifying on the failure rather than on the cause would also swallow
    // every other reason git might refuse.
    //
    // The path deleted is the one THIS function built, two lines up, from
    // `join(worktreesDir, entry)`. Not the gitdir read out of the `.git`
    // file, which is attacker-controlled in the sense that matters: it is
    // content, and content must never steer a recursive delete.
    const missingGitdir = orphanedGitdir(worktreePath);
    if (missingGitdir !== null) {
      if (!opts.removeOrphans) {
        result.orphaned.push(
          `${entry} (git has no registration — ${missingGitdir} is gone; ` +
            `nothing can read whether this checkout holds unique work, so it is reported rather than deleted)`,
        );
        continue;
      }
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        result.orphaned.push(`${entry} (removed — git had no registration)`);
      } catch (err) {
        result.errors.push(`Failed to remove orphaned ${entry}: ${err}`);
      }
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

    // Merged into LOCAL main is not the same as safe to delete (#232), and
    // UNmerged is not the same as unsafe to delete (#431). Both questions go
    // to one decider, because they were two `if`s in a row and the first one
    // short-circuited the second — the unmerged arm returned before the
    // origin check ever ran, so the weaker proxy was deciding everything and
    // the stronger property was dead code for every branch that needed it.
    const keepReason = removalKeepReason(
      entry, branchName, mergeCheck.status === 0, originState(projectRoot, branchName),
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
  // All FIVE buckets. `removed + kept + skipped + orphaned + errors` is the
  // number of entries examined, which is the property
  // test/worktree-cleanup-orphans asserts — a summary that cannot be
  // reconciled against the directory is how 149 worktrees hid behind
  // "144 kept" (#431). #436 added `orphaned` and this line in the same
  // change, because a bucket missing from the total is that defect again.
  console.log(
    `Worktree cleanup: ${result.removed.length} removed, ${result.kept.length} kept, ` +
    `${result.skipped.length} skipped, ${result.orphaned.length} orphaned, ` +
    `${result.errors.length} error(s)`,
  );

  return result;
}
