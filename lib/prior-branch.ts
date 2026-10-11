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
   * Commits the base branch has that the candidate does not, or `null` when
   * git could not answer (#185).
   *
   * Without this a branch 64 ahead and 4 behind reads exactly like one sitting
   * on the tip, and the only consumer that matters — ship.js's push target —
   * cannot tell them apart. The measured case: `run/254-wf19f7def7-rescue`,
   * 1 ahead and 8 behind main, became `git push origin HEAD:run/254-…`, which
   * the remote can only reject.
   *
   * Same contract as commitCount: `0` is the claim "level with the base",
   * `null` is the absence of a claim.
   */
  behindCount: number | null;
  /** `behindCount > 0`. `null` when the count could not be taken. */
  isBehind: boolean | null;
  /**
   * The base branch already contains everything the candidate has, measured by
   * merging it into the base in memory and seeing whether the base's tree
   * moves (#185).
   *
   * Tree comparison rather than `git cherry`, which compares patch-ids: this
   * repository merges PRs by squash, and a squash commit's patch-id matches
   * none of the commits it replaced, so patch-id comparison reports a fully
   * landed branch as unmerged. `null` when the question could not be asked.
   */
  isMerged: boolean | null;
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
 * Refs the harness creates for its own bookkeeping (#185).
 *
 * None of these is a resumable implementation, and two of them are the
 * opposite: `scripts/preserve-worktree-work.ts` exists to name work a run
 * REFUSED to collect, so that it survives `git worktree remove --force`. The
 * branch this repository carries for issue 254 says it in its own tip message
 * — "rescued output of run wf_19f7def7-1bf — NOT reviewed, do not merge" — and
 * detection nominated it anyway, because the only thing it read was whether
 * the digits 254 appeared in the name.
 *
 * Matched on the namespace rather than on the message, because the names are
 * assigned by the harness and the messages are written by whoever rescued the
 * work.
 */
export function isHarnessScratchRef(branch: string): boolean {
  return (
    // lib/worktree-isolation.ts and the agent worktrees under .claude/.
    branch.startsWith('worktree-') ||
    // scripts/preserve-worktree-work.ts, detached-HEAD naming scheme.
    branch.startsWith('rungate-preserved/') ||
    // Per-run scratch namespace, where rescued output is parked by hand.
    branch.startsWith('run/') ||
    // A rescue branch filed outside either namespace.
    /(^|[-/])rescue$/.test(branch)
  )
}

/** Commits each side has that the other does not, or nulls when unanswerable. */
interface Divergence {
  ahead: number | null;
  behind: number | null;
}

/**
 * How far the candidate has moved from the base, in both directions, from one
 * symmetric rev-list (#185).
 *
 * One call rather than two: a pair of separate counts can disagree about which
 * merge base they were taken from if a ref moves between them, and two call
 * sites are two places for the `null` contract to be forgotten.
 */
function divergenceFromBase(projectRoot: string, refName: string): Divergence {
  const result = git(
    ['rev-list', '--count', '--left-right', `${BASE_BRANCH}...${refName}`],
    projectRoot
  )
  // A rev-list that cannot run has not told us the branch is current, and it
  // has not told us it is fully merged either.
  if (result.status !== 0) return { ahead: null, behind: null }

  const [left, right] = result.stdout.trim().split(/\s+/)
  const behind = parseInt(left, 10)
  const ahead = parseInt(right, 10)
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  }
}

/** A tree object id, as git prints it on the first line of merge-tree. */
const TREE_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * Whether the base already contains everything the candidate has (#185).
 *
 * `git merge-tree --write-tree` merges in memory and prints the resulting
 * tree. If that tree is the base's own tree, the merge would change nothing,
 * which is what "already merged" means however the work landed — including a
 * squash merge, where no commit on either side shares a patch-id with the
 * other. The base is free to have moved on since; only the MERGE adding
 * nothing is read, never the two trees happening to be equal.
 *
 * Exit codes: 0 clean, 1 either a conflict (a real tree is printed, and a
 * candidate that conflicts is certainly not contained) or an unusable ref (no
 * tree is printed). The first line tells the two apart, so an error is never
 * reported as an answer.
 */
export function mergedIntoBase(projectRoot: string, refName: string): boolean | null {
  const baseTree = git(['rev-parse', `${BASE_BRANCH}^{tree}`], projectRoot)
  if (baseTree.status !== 0) return null

  const merged = git(['merge-tree', '--write-tree', BASE_BRANCH, refName], projectRoot, 30_000)
  if (merged.status !== 0 && merged.status !== 1) return null

  const tree = merged.stdout.split('\n')[0].trim()
  if (!TREE_OID.test(tree)) return null
  return tree === baseTree.stdout.trim()
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
    if (isHarnessScratchRef(branch)) continue

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

  // Both directions, from one reading. Ahead alone cannot distinguish a branch
  // sitting on the tip from one 8 commits behind it (#185).
  const { ahead: commitCount, behind: behindCount } = divergenceFromBase(projectRoot, selected.refName)
  const isBehind = behindCount === null ? null : behindCount > 0
  const isMerged = mergedIntoBase(projectRoot, selected.refName)

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
    isMerged,
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
