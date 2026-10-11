import { spawnSync } from 'child_process'
import { createGitHubClient, listPRs, type GitHubClient } from './github'

export interface PriorBranch {
  /**
   * Bare branch name, with no namespace. This is the push target —
   * ship.js builds `HEAD:${branch}` from it — so it must stay bare even
   * when the branch was only found on origin.
   */
  branch: string;
  /**
   * A ref THIS repository resolves: `refs/heads/x` or `refs/remotes/origin/x`.
   * Anything that merges, diffs or checks out the prior work uses this.
   */
  refName: string;
  /**
   * Commits ahead of the base branch, or `null` when git could not answer.
   * `0` is a claim ("nothing to resume"); `null` is the absence of one.
   */
  commitCount: number | null;
  /**
   * Commits on the base that this branch does not have, or `null` when git
   * could not answer (#185). Same rule as `commitCount`: `0` is a claim
   * ("this branch is current"), `null` is the absence of one. Without it a
   * candidate 64 ahead and 4 behind reads exactly like one sitting on the
   * base's tip, and only one of those two is cheap to resume.
   */
  behindCount: number | null;
  /**
   * True only when a behind count was actually taken AND it was non-zero.
   * An unmeasured branch is not evidence of staleness.
   */
  isBehind: boolean;
  /**
   * The work this branch carries is already contained in the base — either
   * because it is an ancestor of it, or because the tree it produced appears
   * in the base's history, which is what a squash merge leaves behind (#185).
   * Fails closed: when the check cannot be made, the branch is kept.
   */
  mergedIntoBase: boolean;
  testsPass: boolean;
}

export interface DetectOptions {
  issueNumber: number;
  projectRoot: string;
  runTests?: boolean;
}

export interface PRCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export type PRCommandExecutor = (
  cmd: string,
  args: readonly string[]
) => PRCommandResult;

export interface ExistingPR {
  prNumber: number;
  branch: string;
}

export interface DetectExistingPROptions {
  issueNumber: number;
  repo: string;
  executor?: PRCommandExecutor;
}

function git(args: string[], cwd: string, timeout = 15_000) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', timeout })
}

/**
 * The only ref namespaces a prior branch may come from (#164).
 *
 * `git branch -a --list` enumerates EVERY configured remote and the old code
 * then stripped `remotes/<anything>/` off the result, so a sibling project
 * added as a second remote donated its branch names to this repo's issues.
 * for-each-ref over an explicit namespace list cannot do that: a ref outside
 * these two is never returned in the first place.
 */
const CANDIDATE_REF_NAMESPACES = [
  'refs/heads',
  'refs/remotes/origin',
] as const

/** The base the prior branch's commits are counted against. */
const BASE_BRANCH = 'main'

/**
 * Branch namespaces that carry an issue number without being work to resume (#185).
 *
 * `worktree-*` is a harness scratch branch. `rungate-preserved/*` is written
 * by scripts/preserve-worktree-work.ts at the moment a worktree is about to be
 * removed with unreachable work on it — a rescue snapshot of a run that went
 * wrong, named after the worktree directory, which carries the issue number.
 * Both are written LAST, so without this list they win the recency tie-break
 * against the branch the run was actually meant to produce.
 */
const EXCLUDED_BRANCH_PREFIXES = ['worktree-', 'rungate-preserved/'] as const

interface Divergence {
  /** Commits on the branch and not on the base. */
  ahead: number | null;
  /** Commits on the base and not on the branch. */
  behind: number | null;
}

/**
 * Both sides of the base/branch divergence, in one git call.
 *
 * `rev-list --left-right --count base...ref` prints "<behind>\t<ahead>": the
 * left side is reachable from the base only, the right side from the ref only.
 * A call that cannot run has not told us either number, so both are `null` —
 * `0` would be a measurement nobody took.
 */
function countDivergence(refName: string, projectRoot: string): Divergence {
  const res = git(['rev-list', '--left-right', '--count', `${BASE_BRANCH}...${refName}`], projectRoot)
  if (res.status !== 0) return { ahead: null, behind: null }
  const [left, right] = res.stdout.trim().split(/\s+/)
  const behind = parseInt(left ?? '', 10)
  const ahead = parseInt(right ?? '', 10)
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return { ahead: null, behind: null }
  return { ahead, behind }
}

/**
 * Is this branch's work already on the base?
 *
 * Two shapes, because the second one is the one that actually happens here:
 *
 *   1. The ref is an ancestor of the base — a fast-forward or merge-commit
 *      merge. `merge-base --is-ancestor` answers this directly.
 *   2. The base squash-merged it. Then the ref is an ancestor of nothing and
 *      `rev-list base..ref` still reports every commit the branch ever had,
 *      so the commit graph cannot see it. The TREE can: a squash commit
 *      reproduces the branch tip's tree exactly, so the question becomes
 *      "does the tree this branch produced appear anywhere in the base's
 *      history", which stays true after the base moves on.
 *
 * Deliberately not patch-id comparison (`git cherry`): that asks whether each
 * patch was applied individually, which is a different question, and it is
 * linear in the branch length against linear in the base's.
 *
 * Fails closed. Every unanswerable step returns `false`, because "I could not
 * check" must not become "it already landed" — that direction discards work.
 */
function isContainedInBase(refName: string, projectRoot: string): boolean {
  if (git(['merge-base', '--is-ancestor', refName, BASE_BRANCH], projectRoot).status === 0) return true

  const tree = git(['rev-parse', '--verify', `${refName}^{tree}`], projectRoot)
  if (tree.status !== 0) return false
  const wanted = tree.stdout.trim()
  if (!wanted) return false

  const history = git(['log', '--format=%T', BASE_BRANCH], projectRoot, 30_000)
  if (history.status !== 0) return false
  return history.stdout.split('\n').some(line => line.trim() === wanted)
}

interface RefCandidate {
  branch: string;
  refName: string;
  ts: number;
  local: boolean;
}

/**
 * Every local or origin branch, as a bare name paired with a ref that
 * resolves. Returns [] when git cannot be asked at all.
 */
function listCandidateRefs(projectRoot: string): RefCandidate[] {
  const result = git(
    ['for-each-ref', '--format=%(refname) %(committerdate:unix)', ...CANDIDATE_REF_NAMESPACES],
    projectRoot
  )
  if (result.status !== 0) return []

  // Local heads win over the origin copy of the same name: both resolve, but
  // the local one is what a worktree can check out without detaching.
  const byName = new Map<string, RefCandidate>()
  for (const line of result.stdout.split('\n')) {
    const sep = line.lastIndexOf(' ')
    if (sep <= 0) continue
    const refName = line.slice(0, sep)
    const ts = parseInt(line.slice(sep + 1), 10)

    const namespace = CANDIDATE_REF_NAMESPACES.find(ns => refName.startsWith(`${ns}/`))
    if (!namespace) continue
    const branch = refName.slice(namespace.length + 1)

    // `refs/remotes/origin/HEAD` is a symref to the default branch, not work.
    if (!branch || branch === 'HEAD' || branch === 'main' || branch === 'master') continue
    if (EXCLUDED_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix))) continue

    const candidate: RefCandidate = {
      branch,
      refName,
      ts: Number.isFinite(ts) ? ts : 0,
      local: namespace === 'refs/heads',
    }
    const existing = byName.get(branch)
    if (!existing || (candidate.local && !existing.local)) byName.set(branch, candidate)
  }
  return [...byName.values()]
}

export async function detectPriorBranch(opts: DetectOptions): Promise<PriorBranch | null> {
  const { issueNumber, projectRoot, runTests = true } = opts

  const pattern = new RegExp(`(^|[^\\d])${issueNumber}([^\\d]|$)`)
  const matches = listCandidateRefs(projectRoot).filter(c => pattern.test(c.branch))
  if (matches.length === 0) return null

  // Most recent wins; a local head breaks a tie with its origin twin.
  const selected = matches.reduce((best, c) =>
    c.ts > best.ts || (c.ts === best.ts && c.local && !best.local) ? c : best
  )

  // A rev-list that cannot run has not told us the branch is fully merged,
  // nor that it is current (#164, #185).
  const { ahead, behind } = countDivergence(selected.refName, projectRoot)
  const commitCount = ahead
  const behindCount = behind
  const isBehind = behindCount !== null && behindCount > 0
  const mergedIntoBase = isContainedInBase(selected.refName, projectRoot)

  let testsPass = false
  if (runTests) {
    const tmpDir = `/tmp/rungate-prior-test-${issueNumber}-${Date.now()}`
    const add = git(['worktree', 'add', '--detach', tmpDir, selected.refName], projectRoot, 30_000)
    if (add.status === 0) {
      try {
        const testResult = spawnSync('bun', ['test'], {
          cwd: tmpDir, encoding: 'utf-8', timeout: 300_000,
        })
        testsPass = testResult.status === 0
      } finally {
        git(['worktree', 'remove', tmpDir, '--force'], projectRoot, 30_000)
      }
    }
  }

  return {
    branch: selected.branch,
    refName: selected.refName,
    commitCount,
    behindCount,
    isBehind,
    mergedIntoBase,
    testsPass,
  }
}

// ── detectExistingPR ────────────────────────────────────────

export interface DetectExistingPROctokitOptions {
  issueNumber: number;
  repo: string;
  client?: GitHubClient;
}

/**
 * Find an open PR for the given issue number.
 *
 * Uses Octokit listPRs to search for PRs referencing the issue.
 * Returns the PR number and head branch name, or null if none found.
 */
export async function detectExistingPR(opts: DetectExistingPROptions | DetectExistingPROctokitOptions): Promise<ExistingPR | null> {
  const { issueNumber, repo } = opts

  try {
    const client = ('client' in opts && opts.client) ? opts.client : createGitHubClient();
    const prs = await listPRs(client, repo, { state: 'open', per_page: 10 });

    if (!Array.isArray(prs) || prs.length === 0) return null

    // Filter to PRs whose title/branch actually references this issue number
    // (not a superset like 5150 matching search for 515)
    const issuePattern = new RegExp(`(^|[^\\d])${issueNumber}([^\\d]|$)`)
    const match = prs.find((pr: any) => {
      const headRef = pr.head?.ref || pr.headRefName || ''
      return issuePattern.test(headRef) || issuePattern.test(String(pr.number))
    })

    if (!match) return null

    return {
      prNumber: match.number,
      branch: match.head?.ref || match.headRefName || '',
    }
  } catch {
    return null
  }
}
