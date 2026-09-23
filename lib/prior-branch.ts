import { spawnSync } from 'child_process'

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
