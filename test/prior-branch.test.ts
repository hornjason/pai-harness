import { describe, test, expect } from 'bun:test'
import { detectPriorBranch, detectExistingPR, type PriorBranch, type DetectOptions, type ExistingPR, type PRCommandExecutor } from '../lib/prior-branch'
import { resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..')

describe('prior-branch', () => {
  test('detectPriorBranch function exists and is importable', () => {
    expect(typeof detectPriorBranch).toBe('function')
  })

  test('returns null when no matching branch exists', async () => {
    // Use a very high issue number that definitely doesn't have a branch
    const result = await detectPriorBranch({
      issueNumber: 999999,
      projectRoot: PROJECT_ROOT,
      runTests: false,
    })
    expect(result).toBeNull()
  })

  test('word-boundary matching: issue 550 matches "550-matcher-registry"', async () => {
    // This branch exists in the repo
    const result = await detectPriorBranch({
      issueNumber: 550,
      projectRoot: PROJECT_ROOT,
      runTests: false,
    })
    expect(result).not.toBeNull()
    expect(result?.branch).toMatch(/550/)
  })

  test('word-boundary matching: issue 55 does NOT match "550-matcher-registry"', async () => {
    // Issue 55 should not match branches with "550" in them
    const result = await detectPriorBranch({
      issueNumber: 55,
      projectRoot: PROJECT_ROOT,
      runTests: false,
    })
    // If there's no actual "55" branch, this should be null
    // But it definitely should NOT match "550-*" branches
    if (result !== null) {
      expect(result.branch).not.toMatch(/550/)
    }
  })

  test('returns correct PriorBranch shape when branch found', async () => {
    const result = await detectPriorBranch({
      issueNumber: 550,
      projectRoot: PROJECT_ROOT,
      runTests: false,
    })

    if (result !== null) {
      expect(result).toHaveProperty('branch')
      expect(result).toHaveProperty('commitCount')
      expect(result).toHaveProperty('testsPass')
      expect(typeof result.branch).toBe('string')
      expect(typeof result.commitCount).toBe('number')
      expect(typeof result.testsPass).toBe('boolean')
    }
  })

  test('commitCount is a number', async () => {
    const result = await detectPriorBranch({
      issueNumber: 550,
      projectRoot: PROJECT_ROOT,
      runTests: false,
    })

    if (result !== null) {
      expect(typeof result.commitCount).toBe('number')
      expect(result.commitCount).toBeGreaterThanOrEqual(0)
    }
  })

  test('runTests flag controls test execution', async () => {
    const result = await detectPriorBranch({
      issueNumber: 550,
      projectRoot: PROJECT_ROOT,
      runTests: false, // Explicitly false to avoid slow test execution
    })

    if (result !== null) {
      // When runTests is false, testsPass should be false
      expect(result.testsPass).toBe(false)
    }
  })
})

describe('detectExistingPR', () => {
  function mockExecutor(stdout: string, status = 0): PRCommandExecutor {
    return (_cmd: string, _args: readonly string[]) => ({
      stdout,
      stderr: '',
      status,
    })
  }

  test('detectExistingPR function exists and is importable', () => {
    expect(typeof detectExistingPR).toBe('function')
  })

  test('returns null when no open PR exists for issue', () => {
    const exec = mockExecutor('[]')
    const result = detectExistingPR({ issueNumber: 999999, repo: 'owner/repo', executor: exec })
    expect(result).toBeNull()
  })

  test('returns PR number and branch when open PR found', () => {
    const exec = mockExecutor(JSON.stringify([
      { number: 42, headRefName: '515-deep-modules' }
    ]))
    const result = detectExistingPR({ issueNumber: 515, repo: 'owner/repo', executor: exec })
    expect(result).not.toBeNull()
    expect(result?.prNumber).toBe(42)
    expect(result?.branch).toBe('515-deep-modules')
  })

  test('returns null when gh command fails', () => {
    const exec = mockExecutor('', 1)
    const result = detectExistingPR({ issueNumber: 515, repo: 'owner/repo', executor: exec })
    expect(result).toBeNull()
  })

  test('returns first matching PR when multiple exist', () => {
    const exec = mockExecutor(JSON.stringify([
      { number: 42, headRefName: '515-deep-modules' },
      { number: 43, headRefName: '515-fix' }
    ]))
    const result = detectExistingPR({ issueNumber: 515, repo: 'owner/repo', executor: exec })
    expect(result).not.toBeNull()
    expect(result?.prNumber).toBe(42)
  })

  test('returns correct ExistingPR shape', () => {
    const exec = mockExecutor(JSON.stringify([
      { number: 99, headRefName: '123-feature' }
    ]))
    const result = detectExistingPR({ issueNumber: 123, repo: 'owner/repo', executor: exec })
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('prNumber')
    expect(result).toHaveProperty('branch')
    expect(typeof result!.prNumber).toBe('number')
    expect(typeof result!.branch).toBe('string')
  })

  test('returns null for empty stdout', () => {
    const exec = mockExecutor('')
    const result = detectExistingPR({ issueNumber: 515, repo: 'owner/repo', executor: exec })
    expect(result).toBeNull()
  })

  test('passes correct search argument to gh pr list', () => {
    let capturedArgs: readonly string[] = []
    const exec: PRCommandExecutor = (_cmd: string, args: readonly string[]) => {
      capturedArgs = args
      return { stdout: '[]', stderr: '', status: 0 }
    }
    detectExistingPR({ issueNumber: 515, repo: 'owner/repo', executor: exec })
    // Should search for the issue number in PR titles/branches
    expect(capturedArgs).toContain('--repo')
    expect(capturedArgs).toContain('owner/repo')
    expect(capturedArgs).toContain('--state')
    expect(capturedArgs).toContain('open')
  })
})
