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
 * - When PR check fails, refuses to delete (safety default)
 * - When the repository slug cannot be resolved, refuses to delete (#1079)
 *
 * ## The slug is an authorization input, not a convenience (#1079)
 *
 * `hasOpenPR` decides whether a branch may be deleted, and it decides it by
 * asking ONE repository. Until #1079 that repository defaulted to the literal
 * `hornjason/pai-harness` whenever a caller passed no `repo` — and the only
 * caller in the tree, `hooks/StaleTTLCleanup.hook.ts`, passes none. So on any
 * project that is not this one the guard asked about the wrong repository,
 * every branch came back "no open PR" because the branch is not in the
 * repository being asked about, and the `git push origin --delete` below ran
 * against the project's OWN origin.
 *
 * That is worse than a guard that fails. `0`, `{}`, `null` and silence are
 * indistinguishable from success; a confident wrong answer does not even look
 * like a missing reading. So the default is now a REFUSAL:
 *
 * - no `repo` → resolve it from the project's own `origin` remote, which is
 *   the same place the branch at risk lives;
 * - `origin` unreadable, absent, or not a GitHub remote → `UNMEASURED`, and
 *   UNMEASURED blocks the deletion rather than permitting it.
 *
 * **Never reintroduce a literal here.** Making `repo` a required parameter
 * would make this symptom go away and leave the next caller free to pass a
 * slug derived from a config, an env var or a cache — the guard wrong again
 * with no default to blame. What makes the fix durable is that an unresolvable
 * slug refuses the delete, not that the parameter is mandatory.
 *
 * GitHub issues #516, #1079
 */

import { spawnSync } from "child_process";
import { createGitHubClient, listPRs, type GitHubClient } from "./github";

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
  readonly githubClient?: GitHubClient;
  readonly repo?: string;
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
  readonly githubClient?: GitHubClient;
  readonly repo?: string;
}

export interface CleanupStaleBranchesResult {
  readonly deleted: string[];
  readonly skipped: string[];
  readonly errors: string[];
  /**
   * `UNMEASURED` when the open-PR question could not be asked at all — today
   * that means the repository slug could not be resolved. An empty `deleted`
   * under `MEASURED` means nothing was eligible; under `UNMEASURED` it means
   * nothing was CHECKED, and those are different facts.
   */
  readonly reading: CleanupReading;
}

export type CleanupReading = "MEASURED" | "UNMEASURED";

/** Where a resolved slug came from, or why there is none. */
export interface RepoSlugReading {
  readonly slug: string | null;
  readonly source: "caller" | "origin";
  /** Present iff `slug` is null. */
  readonly reason?: string;
}

// ── Constants ───────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * The branch-deletion arm is disarmed unless this is set (#1079).
 *
 * `hooks/StaleTTLCleanup.hook.ts` runs at EVERY SessionStart from the shared
 * checkout, so a `git push origin --delete` reached from it is unattended and
 * reaches every live session at once. `.claude/rungate/hooks.json` names this
 * arming and the slug refusal above as the two things that must BOTH hold
 * before the hook may be reconsidered for consumer deployment — "either alone
 * is insufficient" — and `lib/orphan-reaper.ts` already arms its destructive
 * arm the same way.
 */
const ARM_ENV_VAR = "RUNGATE_BRANCH_CLEANUP";
const ARM_ENV_VALUE = "1";

/**
 * Whether the caller's environment arms the branch-deletion arm.
 *
 * One exported binding so a case can drive it over the values that must NOT
 * arm it. An inline `===` in a hook is a claim nothing executes — that is what
 * #690 cost two days of, and `lib/orphan-reaper.ts` carries the same note.
 */
export function branchCleanupArmedFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ARM_ENV_VAR] === ARM_ENV_VALUE;
}

// ── Repository slug resolution ──────────────────────────────

/**
 * The `owner/repo` a GitHub remote URL names, or null if it names none.
 *
 * One binding, so there is one thing to mutate. A remote this cannot read —
 * a local path, a non-GitHub host, a URL with no two path segments — is not a
 * repository any PR question can be asked about, so it is null and not a
 * guess.
 */
export function githubSlugFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-style (git@github.com:owner/repo.git) and URL-style
  // (https://github.com/owner/repo, ssh://git@github.com/owner/repo.git).
  const m =
    /^(?:[^@/]+@)?github\.com[:/]+(.+)$/i.exec(trimmed) ??
    /^[a-z+]+:\/\/(?:[^@/]+@)?github\.com\/+(.+)$/i.exec(trimmed);
  if (!m) return null;

  const path = m[1].replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return null;
  }
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return `${owner}/${repo}`;
}

/**
 * Resolve the repository the open-PR question must be asked about.
 *
 * A caller-supplied `repo` wins. Otherwise the slug comes from the project's
 * own `origin` — the same place the branch at risk lives. There is no third
 * option and deliberately no fallback literal: an unresolvable remote is
 * `{ slug: null }`, and every caller treats that as a refusal.
 */
export function resolveRepoSlug(opts: {
  readonly projectRoot: string;
  readonly repo?: string;
  readonly executor?: CommandExecutor;
}): RepoSlugReading {
  const { projectRoot, repo, executor = defaultExecutor } = opts;

  if (repo && repo.trim()) {
    return { slug: repo.trim(), source: "caller" };
  }

  const result = executor("git", [
    "-C",
    projectRoot,
    "remote",
    "get-url",
    "origin",
  ]);

  if (result.status !== 0) {
    return {
      slug: null,
      source: "origin",
      reason:
        `cannot read the 'origin' remote of ${projectRoot}: ` +
        `${(result.stderr || "git exited non-zero").trim().slice(0, 200)}`,
    };
  }

  const slug = githubSlugFromRemoteUrl(result.stdout);
  if (!slug) {
    return {
      slug: null,
      source: "origin",
      reason:
        `the 'origin' remote of ${projectRoot} is not a GitHub repository ` +
        `this can ask about: ${result.stdout.trim().slice(0, 200) || "(empty)"}`,
    };
  }

  return { slug, source: "origin" };
}

/** The sentence every refusal uses, so there is one string to mutate. */
function unresolvedSlugRefusal(reason: string): string {
  return (
    "Cannot resolve the repository to check for open PRs — refusing to " +
    `delete (#1079): ${reason}`
  );
}

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

// ── Core: check for open PRs via Octokit ────────────────────

/**
 * `repoSlug` is REQUIRED and has no default. A caller that cannot supply one
 * has not asked the question and must not reach this function — see the
 * refusals in both entry points.
 */
async function hasOpenPR(
  branch: string,
  client: GitHubClient | undefined,
  repoSlug: string,
): Promise<{ hasPR: boolean; error?: string }> {
  try {
    const github = client || createGitHubClient();
    const prs = await listPRs(github, repoSlug, { state: "open", head: branch, per_page: 1 });
    return { hasPR: Array.isArray(prs) && prs.length > 0 };
  } catch (e: any) {
    return { hasPR: false, error: `listPRs failed: ${e.message?.slice(0, 200)}` };
  }
}

// ── cleanupBranch ───────────────────────────────────────────

/**
 * Delete a single branch (local + remote) if no open PR exists.
 *
 * Used by the prove workflow when verdict is UNPROVEN.
 */
export async function cleanupBranch(opts: CleanupBranchOptions): Promise<CleanupBranchResult> {
  const { branch, projectRoot, executor = defaultExecutor, githubClient, repo } = opts;

  // Guard: never delete protected branches
  if (PROTECTED_BRANCHES.has(branch)) {
    return { deleted: false, reason: `${branch} is a protected branch` };
  }

  // Guard: the open-PR question must be asked about the repository the branch
  // is actually in. No slug means the question cannot be asked (#1079).
  const slugReading = resolveRepoSlug({ projectRoot, repo, executor });
  if (!slugReading.slug) {
    return {
      deleted: false,
      reason: "Cannot resolve the repository — refusing to delete",
      error: unresolvedSlugRefusal(slugReading.reason!),
    };
  }

  // Check for open PRs via Octokit
  const prCheck = await hasOpenPR(branch, githubClient, slugReading.slug);
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

// ── The SessionStart arm ────────────────────────────────────

export interface BranchCleanupArmReport {
  readonly armed: boolean;
  readonly reading: CleanupReading;
  readonly deleted: number;
  readonly lines: string[];
}

/**
 * The whole branch-deletion arm of `hooks/StaleTTLCleanup.hook.ts`, decided
 * here rather than in the hook.
 *
 * `specs/HOOK-ARCHITECTURE-SPEC.md` makes hooks thin triggers that delegate
 * to `lib/`, and this arm is the one with an arming decision, an UNMEASURED
 * reading and three log shapes in it — all of which are behaviour a case can
 * drive here and cannot drive inside a hook. `reapOrphans`/`reapReportLines`
 * in `lib/orphan-reaper.ts` is the same split for the same reason.
 *
 * Silence is reserved for "armed, measured, nothing stale". A disarmed arm
 * and an UNMEASURED one both say so by name, because zero deletions has three
 * causes here and only one of them is a clean sweep.
 */
export async function runBranchCleanupArm(opts: {
  readonly projectRoot: string;
  readonly maxAgeDays?: number;
  readonly env?: Record<string, string | undefined>;
  readonly executor?: CommandExecutor;
  readonly githubClient?: GitHubClient;
  readonly repo?: string;
}): Promise<BranchCleanupArmReport> {
  const { projectRoot, maxAgeDays = DEFAULT_MAX_AGE_DAYS, env } = opts;

  if (!branchCleanupArmedFromEnv(env ?? process.env)) {
    return {
      armed: false,
      reading: "UNMEASURED",
      deleted: 0,
      lines: [
        `BRANCH cleanup [${projectRoot}]: disarmed — set ` +
          `${ARM_ENV_VAR}=${ARM_ENV_VALUE} to delete stale remote branches`,
      ],
    };
  }

  const br = await cleanupStaleBranches({
    projectRoot,
    maxAgeDays,
    executor: opts.executor,
    githubClient: opts.githubClient,
    repo: opts.repo,
  });

  if (br.reading === "UNMEASURED") {
    return {
      armed: true,
      reading: "UNMEASURED",
      deleted: 0,
      lines: [
        `BRANCH cleanup [${projectRoot}]: UNMEASURED — no branch was ` +
          `checked: ${br.errors.join("; ")}`,
      ],
    };
  }

  return {
    armed: true,
    reading: "MEASURED",
    deleted: br.deleted.length,
    lines: br.deleted.length
      ? [
          `BRANCH cleanup [${projectRoot}]: armed, deleted ` +
            `${br.deleted.length} stale remote branches`,
        ]
      : [],
  };
}

// ── cleanupStaleBranches ────────────────────────────────────

/**
 * Find and delete remote branches older than maxAgeDays with no open PR.
 *
 * Used by StaleTTLCleanup hook on session start.
 */
export async function cleanupStaleBranches(
  opts: CleanupStaleBranchesOptions
): Promise<CleanupStaleBranchesResult> {
  const {
    projectRoot,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    executor = defaultExecutor,
    githubClient,
    repo,
  } = opts;

  const result: CleanupStaleBranchesResult = {
    deleted: [],
    skipped: [],
    errors: [],
    reading: "MEASURED",
  };

  // Resolve the subject of the open-PR question BEFORE listing anything.
  // Resolved once, outside the loop: it is a property of the project, not of
  // a branch, and asking per-branch would be N chances to answer differently
  // about one repository (#1079).
  const slugReading = resolveRepoSlug({ projectRoot, repo, executor });
  if (!slugReading.slug) {
    (result.errors as string[]).push(unresolvedSlugRefusal(slugReading.reason!));
    return { ...result, reading: "UNMEASURED" };
  }
  const repoSlug = slugReading.slug;

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
    // Nothing was checked, so an empty `deleted` here must not read as
    // "nothing was eligible" either — same distinction as the slug refusal.
    return { ...result, reading: "UNMEASURED" };
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

    // Check for open PRs via Octokit
    const prCheck = await hasOpenPR(branchName, githubClient, repoSlug);
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
