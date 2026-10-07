import { spawnSync } from 'child_process'
import { createGitHubClient, listPRs, type GitHubClient } from './github'

export interface PriorBranch {
  /**
   * Bare branch name, with no remote prefix — what a push target is written
   * against (`HEAD:<branch>`). NOT guaranteed to resolve locally.
   */
  branch: string;
  /**
   * Fully-qualified ref the detection actually matched, e.g.
   * `refs/heads/164-x` or `refs/remotes/origin/164-x`. This is what
   * `git merge` / `git worktree add` / `git rev-parse` must be handed: for an
   * origin-only branch the bare name resolves to nothing (#164).
   */
  refName: string;
  /**
   * Commits on the branch that are not on `main`, or `null` when that could
   * not be determined. Null is NOT zero — "fully merged" and "no idea" lead
   * callers to opposite decisions.
   */
  commitCount: number | null;
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
 * The only two ref namespaces that belong to THIS repository.
 *
 * A checkout can have any number of remotes — this one has `asacc` pointing
 * at a different project — and a sibling project's branch named for the same
 * issue number is not this issue's prior work (#164).
 */
const LOCAL_PREFIX = 'refs/heads/'
const ORIGIN_PREFIX = 'refs/remotes/origin/'

interface Candidate {
  branch: string;
  refName: string;
  ts: number;
  local: boolean;
}

/**
 * Branches in this repository whose name references `issueNumber`, newest
 * first, with a resolvable ref attached to each.
 *
 * One `for-each-ref` supplies both the candidate set and the timestamps the
 * old two-command version needed `git log --all` for — and `--all` was the
 * other way foreign remotes got in.
 */
function listCandidates(projectRoot: string, issueNumber: number): Candidate[] {
  const listed = git(
    ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)', LOCAL_PREFIX, ORIGIN_PREFIX],
    projectRoot
  )
  if (listed.status !== 0) return []

  const pattern = new RegExp(`(^|[^\\d])${issueNumber}([^\\d]|$)`)
  // Keyed by bare name so a branch present both locally and on origin is one
  // candidate, not two — and the local head wins, because that is the ref a
  // merge should move onto.
  const byBranch = new Map<string, Candidate>()

  for (const line of listed.stdout.split('\n')) {
    const [refName, rawTs] = line.split('\t')
    if (!refName) continue

    const local = refName.startsWith(LOCAL_PREFIX)
    const branch = local
      ? refName.slice(LOCAL_PREFIX.length)
      : refName.slice(ORIGIN_PREFIX.length)

    if (!branch) continue
    if (branch === 'main' || branch === 'master' || branch === 'HEAD') continue
    if (branch.startsWith('worktree-')) continue
    if (!pattern.test(branch)) continue

    const parsedTs = parseInt(rawTs ?? '', 10)
    const candidate: Candidate = {
      branch,
      refName,
      ts: Number.isFinite(parsedTs) ? parsedTs : 0,
      local,
    }
    const existing = byBranch.get(branch)
    if (!existing || (local && !existing.local)) byBranch.set(branch, candidate)
  }

  return [...byBranch.values()].sort(
    (a, b) => b.ts - a.ts || Number(b.local) - Number(a.local) || a.branch.localeCompare(b.branch)
  )
}

export async function detectPriorBranch(opts: DetectOptions): Promise<PriorBranch | null> {
  const { issueNumber, projectRoot, runTests = true } = opts

  const selected = listCandidates(projectRoot, issueNumber)[0]
  if (!selected) return null

  // Read the ref, not the bare name: for an origin-only branch the bare name
  // resolves to nothing and this exits non-zero.
  const revList = git(['rev-list', `main..${selected.refName}`, '--count'], projectRoot)
  const parsedCount = revList.status === 0 ? parseInt(revList.stdout.trim(), 10) : NaN
  const commitCount = Number.isFinite(parsedCount) ? parsedCount : null

  let testsPass = false
  if (runTests) {
    const tmpDir = `/tmp/rungate-prior-test-${issueNumber}-${Date.now()}`
    const add = git(['worktree', 'add', tmpDir, selected.refName], projectRoot, 30_000)
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

  return { branch: selected.branch, refName: selected.refName, commitCount, testsPass }
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
