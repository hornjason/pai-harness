import { describe, test, expect } from 'bun:test'
import { detectPriorBranch, type PriorBranch, type DetectOptions } from '../lib/prior-branch'
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
