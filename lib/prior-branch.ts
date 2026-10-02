import { spawnSync } from 'child_process'
import { createGitHubClient, listPRs, type GitHubClient } from './github'

export interface PriorBranch {
  branch: string;
  commitCount: number;
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

export async function detectPriorBranch(opts: DetectOptions): Promise<PriorBranch | null> {
  const { issueNumber, projectRoot, runTests = true } = opts

  const branchList = git(['branch', '-a', '--list'], projectRoot)
  if (branchList.status !== 0) return null

  const pattern = new RegExp(`(^|[^\\d])${issueNumber}([^\\d]|$)`)
  const branches = branchList.stdout
    .split('\n')
    .map(line => line.trim().replace(/^[*+]\s+/, '').replace(/^remotes\/[^/]+\//, ''))
    .filter(b => b.length > 0)
    .filter((b, i, a) => a.indexOf(b) === i)
    .filter(b => pattern.test(b) && !b.startsWith('worktree-') && b !== 'main' && b !== 'HEAD')

  if (branches.length === 0) return null

  // Pick most recent branch — single git command for all timestamps
  let selectedBranch = branches[0]
  if (branches.length > 1) {
    const sortResult = git(
      ['log', '--format=%ct %D', '--all', '--simplify-by-decoration', '-n', '200'],
      projectRoot
    )
    if (sortResult.status === 0) {
      const branchSet = new Set(branches)
      let best = { branch: branches[0], ts: 0 }
      for (const line of sortResult.stdout.split('\n')) {
        const [ts, ...refs] = line.split(' ')
        const timestamp = parseInt(ts, 10)
        if (!timestamp) continue
        for (const ref of refs.join(' ').split(',').map(r => r.trim().replace(/^.*\//, ''))) {
          if (branchSet.has(ref) && timestamp > best.ts) {
            best = { branch: ref, ts: timestamp }
          }
        }
      }
      selectedBranch = best.branch
    }
  }

  const revList = git(['rev-list', `main..${selectedBranch}`, '--count'], projectRoot)
  const commitCount = revList.status === 0 ? parseInt(revList.stdout.trim(), 10) : 0

  let testsPass = false
  if (runTests) {
    const tmpDir = `/tmp/rungate-prior-test-${issueNumber}-${Date.now()}`
    const add = git(['worktree', 'add', tmpDir, selectedBranch], projectRoot, 30_000)
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

  return { branch: selectedBranch, commitCount, testsPass }
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
