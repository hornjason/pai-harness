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
import { gitIsolatedArgs, gitIsolatedEnv, gitCredentialEnv } from "./git-isolation";

/**
 * The ONE place this module runs `git` (#1097).
 *
 * ## Why isolation matters more here than anywhere it has been applied yet
 *
 * Every other consumer of `lib/git-isolation.ts` reads. This one deletes.
 * The chain is three steps and it was live on `origin/main`:
 *
 *   1. `core.excludesFile` makes an untracked file invisible to
 *      `git status --porcelain`. Measured on git 2.50.1 by #1048/#1090.
 *   2. The dirty check below reads clean, so the worktree falls through
 *      every remaining check.
 *   3. `git worktree remove --force` takes the tree, and the file that
 *      existed in exactly one place is gone.
 *
 * **The guard meant to spare the work is the reading that was tampered
 * with**, which is why no amount of care in the checks downstream of it
 * helps. #1090 isolated the census — the module that REPORTS the same
 * reading — and did not touch this one.
 *
 * Latent rather than active when this shipped: none of
 * `core.excludesFile`, `core.hooksPath` or `core.fsmonitor` was set in any
 * scope on the machine (measured 2026-10-22). What makes it worth fixing
 * is that a global gitignore is ordinary advice, setting one silently arms
 * this, and the failure is silent — the summary prints `N removed` and
 * nothing says what was in them.
 *
 * ## One seam, not the flags at each site
 *
 * There are eight `git` invocations in this module. `lib/git-isolation.ts`
 * is the single declaring position for WHAT isolation is; this is the
 * single declaring position for WHERE this module applies it. Pasting the
 * `-c` flags at eight call sites is the cheaper change and is measured as
 * the cheapest WRONG fix in #1090's battery: it works, and it reinstates
 * the drifting spellings #1001 removed.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * `rmSync` on an orphaned checkout, in the `removeOrphans` arm below. Git
 * has no registration for that directory — that is the definition of the
 * bucket — so there is no git invocation there to isolate and no config
 * that could steer it. It is a recursive delete of content nothing has
 * classified, which is why it is off by default; that is #436's argument
 * and this change does not touch it.
 */
/**
 * The ONE place this module reaches git (#1097).
 *
 * `reach` picks which environment lib/git-isolation.ts hands back, and that
 * is the only thing a caller may vary. A `"remote"` call keeps command-scope
 * isolation and drops the env half, because `credential.helper` lives in the
 * global and system config that the env half nulls — see `gitCredentialEnv`.
 *
 * A second `spawnSync` here would be a second door that can drift, which is
 * what #1097 is about and what `test/worktree-cleanup-isolation.test.ts`
 * refuses. Adding a mode is therefore an edit to this signature, never a new
 * call site.
 */
type GitReach = "local" | "remote";

function cleanupGit(args: readonly string[], cwd: string, timeout: number, reach: GitReach = "local") {
  const env = reach === "remote" ? gitCredentialEnv() : gitIsolatedEnv();
  return spawnSync("git", gitIsolatedArgs(args), {
    cwd,
    encoding: "utf-8",
    timeout,
    env,
  });
}


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
  const remotes = cleanupGit(["remote"], projectRoot, 5000);
  if (remotes.status !== 0) return null;
  if (!remotes.stdout.split("\n").map(r => r.trim()).includes("origin")) return 0;

  const count = cleanupGit(["rev-list", "--count", branch, "--not", "--remotes=origin"], projectRoot, 10_000);
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
  const remotes = cleanupGit(["remote"], projectRoot, 5000);
  if (remotes.status !== 0) return { kind: "unknown" };
  if (!remotes.stdout.split("\n").map(r => r.trim()).includes("origin")) return { kind: "no-origin" };

  const count = cleanupGit(["rev-list", "--count", branch, "--not", "--remotes=origin"], projectRoot, 10_000);
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
  const list = cleanupGit(["worktree", "list", "--porcelain"], projectRoot, 15_000);
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
    const statusCheck = cleanupGit(["status", "--porcelain"], worktreePath, 5000);

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
    const branchCheck = cleanupGit(["-C", worktreePath, "branch", "--show-current"], projectRoot, 5000);

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
    const mergeCheck = cleanupGit(["merge-base", "--is-ancestor", branchName, "main"], projectRoot, 5000);

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
    const removeResult = cleanupGit(["worktree", "remove", "--force", worktreePath], projectRoot, 15000);

    if (removeResult.status !== 0) {
      result.errors.push(`Failed to remove ${entry}: ${removeResult.stderr}`);
    } else {
      result.removed.push(entry);
    }
  }

  // Prune worktree references
  const pruneResult = cleanupGit(["worktree", "prune"], projectRoot, 5000);

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

/* ------------------------------------------------------------------ *
 * Stranded work: commits that exist on this machine and nowhere else
 * ------------------------------------------------------------------ */

/** A local branch holding commits no `origin/*` ref contains. */
export interface StrandedBranch {
  branch: string;
  commits: number;
}

/**
 * What a sweep for stranded branches found, including what it could not read.
 *
 * `unreadable` exists because the first version of this `continue`d past a
 * branch whose `rev-list` failed, which spells "could not tell" exactly like
 * "nothing stranded" — the same conflation `examined` was added to prevent,
 * one level further down. A branch nobody could measure is the single most
 * likely place for stranded work to be hiding, so it is the last thing that
 * should fall out of the reading silently.
 */
export interface StrandedReading {
  stranded: StrandedBranch[];
  /** Branches whose own count failed. Neither stranded nor known-clean. */
  unreadable: string[];
}

/**
 * Every branch checked out in this repository — the main checkout and every
 * linked worktree — or `null` if the listing could not be taken.
 *
 * `null` rather than an empty set, because the two mean opposite things to
 * the caller: an empty set declines nothing and a failed read must decline
 * everything. Returning `new Set()` on failure is what made the first two
 * versions of this guard publish live work.
 *
 * Reads `git worktree list --porcelain`, whose `branch refs/heads/<name>`
 * lines name exactly the branches git considers occupied. Git will not let
 * the same branch be checked out twice, so "occupied" and "somebody is
 * working on it" are the same set.
 */
export function checkedOutBranches(projectRoot: string): Set<string> | null {
  const r = cleanupGit(["worktree", "list", "--porcelain"], projectRoot, 10_000);
  if (r.status !== 0) return null;
  const out = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/**
 * The wall-clock a whole rescue sweep may spend, against 120s for any one
 * push. It runs synchronously at SessionStart, so an origin that hangs must
 * cost a bounded wait rather than 120s times the number of stranded
 * branches — this machine had 14 of them when #1038 was written, which is
 * 28 minutes of a session refusing to start.
 *
 * One exported constant so a case can read the budget it is asserting
 * against rather than restating the number.
 */
export const RESCUE_BUDGET_MS = 180_000;

export interface RescueResult {
  /**
   * Branches that reached the push loop: stranded, minus the default branch,
   * minus anything `declined`. The DENOMINATOR, and the reason it is a field
   * rather than a length somewhere: `pushed: []` with `examined: 14` is a
   * clean tree, and a bare count of rescues spells those the same way —
   * which is how "zero violations" comes to mean "nobody looked".
   *
   * **`examined: 0` is not self-describing and was never meant to be read
   * alone.** These are the readings it can mean, and the field that
   * separates each one:
   *
   * | What happened | How to tell |
   * |---|---|
   * | the reading could not be taken | `unmeasured` is non-null |
   * | the sweep ran but saw only part of the tree | `unmeasured` null, `unreadable` non-empty |
   * | everything stranded is live work somewhere | `declined` non-empty |
   * | there was nothing to rescue | `unmeasured` null, `unreadable` and `declined` both empty |
   *
   * Row one collapsing into row four is the defect this whole module is
   * about, and `unmeasured` is what keeps them apart. `declined` exists as a
   * field, rather than as silence, for row three.
   *
   * **An earlier version of this comment carried a fifth row — "only the
   * default branch was stranded" — with a "how to tell" cell identical to
   * row four's.** It was wrong twice over. It asserted a separation the
   * type does not implement, and the state it named does not produce this
   * reading at all: a default branch that is itself stranded has no ref on
   * origin, so `protectedFromRescue` cannot resolve a default and the
   * result is row ONE, `unmeasured` non-null. Measured 2026-10-31 on a
   * planted repo with an origin and an unpushed `main`. The reachable way
   * to reach row four is that nothing was stranded.
   */
  examined: number;
  /** Held commits on no origin ref, and `git push` succeeded. */
  pushed: StrandedBranch[];
  /** Held commits on no origin ref, and the push did not succeed. */
  failed: { branch: string; commits: number; reason: string }[];
  /**
   * Stranded, and deliberately NOT pushed because the checkout is on it —
   * somebody's live work rather than something left behind.
   *
   * Its own field rather than silence: a branch missing from both `pushed`
   * and `failed` would be indistinguishable from one the sweep never saw,
   * and "your work was not published, here is why" is the thing a reader of
   * the log most needs to be told.
   */
  declined: string[];
  /**
   * Branches whose own count could not be read, so they are neither in
   * `pushed` nor in `failed` nor known to be clean. Carried out of
   * `StrandedReading` so the hook's log can say a branch went unmeasured
   * instead of letting it vanish between the other three numbers.
   */
  unreadable: string[];
  /** No reading could be taken at all. Not the same as "nothing stranded". */
  unmeasured: string | null;
}

/**
 * Every local branch holding commits reachable from no `origin/*` ref.
 *
 * This asks about BRANCHES, not worktrees, and that is the whole point.
 * `unpushedKeepReason` above protects a *worktree* from deletion, so it only
 * ever sees branches that still have one — and a worktree is removed at the
 * end of an ordinary session while its branch stays in `.git` holding the
 * commits. Measured on this machine 2026-10-31: 14 branches held 25 such
 * commits and only 5 of them still had a worktree, so a worktree-shaped
 * reading misses nine of fourteen.
 *
 * `null` is "could not tell", never an empty list. A repo with no `origin`
 * returns an empty list rather than every branch: there is nowhere the work
 * could have been pushed to, so the question does not apply — the same
 * answer `unpushedCommitCount` gives, for the same reason.
 */
export function strandedBranches(projectRoot: string): StrandedReading | null {
  const remotes = cleanupGit(["remote"], projectRoot, 5000);
  if (remotes.status !== 0) return null;
  if (!remotes.stdout.split("\n").map(r => r.trim()).includes("origin")) {
    return { stranded: [], unreadable: [] };
  }

  const refs = cleanupGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], projectRoot, 10_000);
  if (refs.status !== 0) return null;

  const stranded: StrandedBranch[] = [];
  const unreadable: string[] = [];
  for (const branch of refs.stdout.split("\n").map(b => b.trim()).filter(Boolean)) {
    const count = cleanupGit(["rev-list", "--count", branch, "--not", "--remotes=origin"], projectRoot, 10_000);
    const n = count.status === 0 ? parseInt(count.stdout.trim(), 10) : NaN;
    // A failed count and an unparseable count are the same fact: this branch
    // was not measured. Recorded rather than skipped — see StrandedReading.
    if (!Number.isFinite(n)) unreadable.push(branch);
    else if (n > 0) stranded.push({ branch, commits: n });
  }
  return { stranded, unreadable };
}

/**
 * The default branch, which is never rescued — or `null` if it cannot be
 * established, which refuses the whole rescue rather than guessing.
 *
 * Pushing it is either a no-op or an attempt to move a protected ref, and a
 * hook that runs unattended at session start has no business doing either.
 *
 * This used to fall back to the literal `"main"`, which only protects the
 * default branch on repositories where that is its name. `refs/remotes/origin/HEAD`
 * is written by `git clone` and by `git remote set-head`, and it is absent in
 * plenty of ordinary checkouts — a worktree added from a bare mirror, a remote
 * added by hand. On a repository whose default is `master`, the fallback named
 * a branch that is not protected and left the one that is unprotected, which is
 * the precise inverse of the function's purpose.
 *
 * So the local symref is tried first and the REMOTE is asked second, because
 * `ls-remote --symref` is the authority rather than a cached copy of it. Only
 * when both are unreadable does this return `null`, and a `null` is a refusal:
 * see `rescueStrandedBranches`.
 */
export function protectedFromRescue(projectRoot: string): string | null {
  const local = cleanupGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], projectRoot, 5000);
  if (local.status === 0) {
    const name = local.stdout.trim().replace(/^origin\//, "");
    if (name) return name;
  }

  const remote = cleanupGit(["ls-remote", "--symref", "origin", "HEAD"], projectRoot, 30_000, "remote");
  if (remote.status === 0) {
    const m = remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (m?.[1]) return m[1];
  }

  return null;
}

/**
 * Push every branch holding commits that exist on no remote.
 *
 * Deliberately a plain `git push`, never `--force`: a branch that diverged
 * from its remote is a `failed` row for a person to look at, not something to
 * overwrite unattended. A branch already pushed costs one no-op round trip,
 * which is why this can run every session without a guard asking whether it
 * is needed.
 */
export function rescueStrandedBranches(
  projectRoot: string,
  /** Injectable so a case can drive the deadline instead of waiting it out. */
  budgetMs: number = RESCUE_BUDGET_MS,
): RescueResult {
  const found = strandedBranches(projectRoot);
  if (found === null) {
    return { examined: 0, pushed: [], failed: [], declined: [], unreadable: [], unmeasured: "could not list branches or remotes" };
  }

  // Nothing to rescue is a CLEAN reading, and it is reached without a
  // network call. `strandedBranches` already short-circuits the no-origin
  // case to an empty list — "there is nowhere the work could have been
  // pushed to, so the question does not apply" — and asking
  // `protectedFromRescue` anyway would spend an `ls-remote` to answer a
  // question nobody asked, then report UNMEASURED on a repository that has
  // no remote and no stranded work. A clean tree would have been reported
  // as an instrument failure, which is this issue's own defect inverted.
  if (found.stranded.length === 0) {
    return { examined: 0, pushed: [], failed: [], declined: [], unreadable: found.unreadable, unmeasured: null };
  }

  const skip = protectedFromRescue(projectRoot);
  if (skip === null) {
    // Refuse rather than guess. Rescuing with no idea which branch is the
    // default risks pushing the one branch this must never touch.
    return {
      examined: 0, pushed: [], failed: [], declined: [], unreadable: found.unreadable,
      unmeasured: "could not establish the default branch from origin/HEAD or ls-remote",
    };
  }

  // The branch this checkout is ON is work somebody is doing RIGHT NOW, not
  // work that was stranded. Publishing it is the one outcome a person would
  // be surprised by: commit WIP, start a session in the same checkout, and
  // an unfinished branch is on the remote with nobody having asked. The
  // delete arm is disarmed by default for the mirror-image reason, and this
  // arm stays armed only because it now declines the active branch.
  //
  // Which branches are LIVE WORK is one question, and the answer is every
  // branch checked out ANYWHERE in this repository — not the branch of the
  // checkout this happens to be called from.
  //
  // Two earlier versions got this wrong in the same place and that is why
  // this reads a set rather than a value. `rev-parse HEAD` answers for one
  // checkout, and `projectRoot` is `repoRootFrom(cwd)`, which resolves
  // `--git-common-dir` and so ALWAYS names the main checkout. An agent
  // working in `.claude/worktrees/wt-a` on `feat/live` would have its live
  // branch read as main's HEAD, not match, and be published — the guard
  // missing the exact population #1038 exists for.
  //
  // `git worktree list` is the whole class in one reading: git refuses to
  // check a branch out in two worktrees at once, so the set of checked-out
  // branches IS the set of live ones, and a worktree added later is covered
  // without another patch. A detached worktree prints `detached` instead of
  // a `branch` line and correctly contributes nothing.
  const live = checkedOutBranches(projectRoot);
  if (live === null) {
    // Fail CLOSED. An empty set matches nothing, so a failed read would
    // publish every branch including the live ones, exactly when git is in
    // the state least worth trusting — the fail-open shape named first in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    return {
      examined: 0, pushed: [], failed: [], declined: [], unreadable: found.unreadable,
      unmeasured: "could not list the checkouts of this repository, so live work could not be told from stranded work",
    };
  }
  const declined = found.stranded
    .filter(b => b.branch !== skip && live.has(b.branch))
    .map(b => b.branch);

  const candidates = found.stranded.filter(
    b => b.branch !== skip && !declined.includes(b.branch),
  );
  const pushed: StrandedBranch[] = [];
  const failed: RescueResult["failed"] = [];

  // A sweep runs synchronously from SessionStart, so an unreachable origin
  // must cost a bounded wait rather than 120s per branch. The deadline is
  // checked BEFORE each push, so the worst case is one timeout past it, and
  // every branch not reached is a `failed` row naming the budget — never a
  // silent omission, which would read as "nothing was stranded".
  const deadline = Date.now() + budgetMs;
  for (const b of candidates) {
    if (Date.now() >= deadline) {
      failed.push({
        branch: b.branch, commits: b.commits,
        reason: `not attempted — the ${budgetMs / 1000}s rescue budget for this sweep was spent`,
      });
      continue;
    }
    const res = cleanupGit(["push", "origin", b.branch], projectRoot, 120_000, "remote");
    if (res.status === 0) pushed.push(b);
    else {
      const reason = `${res.stderr || res.stdout || "push failed"}`.split("\n").filter(Boolean).slice(-1)[0] ?? "push failed";
      failed.push({ branch: b.branch, commits: b.commits, reason: reason.trim() });
    }
  }

  return { examined: candidates.length, pushed, failed, declined, unreadable: found.unreadable, unmeasured: null };
}

/**
 * The rescue, as log lines. Formatting lives here and not in the hook
 * because `specs/HOOK-ARCHITECTURE-SPEC.md` makes hooks thin triggers, and
 * because these lines are the permanent record: one appended line per
 * rescue means the count of rescues is `grep -c` over the log, with no
 * counter to keep and nothing to get out of step with the pushes.
 *
 * Silence is reserved for "nothing to say". A reading that could not be
 * taken always speaks — "0 rescued" and "could not look" are the pair this
 * whole issue is about.
 */
export function rescueReportLines(r: RescueResult): string[] {
  const lines = r.unmeasured ? [`STRANDED unmeasured: ${r.unmeasured}`] : [];
  for (const p of r.pushed) {
    lines.push(`STRANDED rescued: pushed ${p.branch} (${p.commits} commit(s) that were on no remote)`);
  }
  for (const f of r.failed) lines.push(`STRANDED failed: ${f.branch} (${f.commits} commit(s)) — ${f.reason}`);
  // Spoken even when the rescue itself was refused: a branch nobody could
  // count is the likeliest hiding place for the work this feature exists to
  // find, so it must not be swallowed by the refusal line above it.
  for (const b of r.declined) {
    lines.push(`STRANDED declined: ${b} — this checkout is on it, so it is live work and was not published`);
  }
  for (const b of r.unreadable) lines.push(`STRANDED unreadable: ${b} — could not count its commits`);
  return lines;
}
