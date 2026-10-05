import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Pipeline hardening tests for ship.js (#53)
 * Validates the 6 systemic issues found during session 27 audit are fixed.
 */

const SHIP_JS_PATH = resolve(import.meta.dir, '..', 'workflows', 'ship.js')
const shipContent = readFileSync(SHIP_JS_PATH, 'utf-8')

describe('ship.js pipeline hardening (#53)', () => {
  test('AC-1: BUILD_RESULT_SCHEMA includes testFiles property', () => {
    // BUILD_RESULT_SCHEMA should have testFiles: { type: 'array', items: { type: 'string' } }
    const schemaMatch = shipContent.match(/const BUILD_RESULT_SCHEMA\s*=\s*\{[\s\S]*?\n\}/m)
    expect(schemaMatch).not.toBeNull()
    const schemaBlock = schemaMatch![0]
    expect(schemaBlock).toContain('testFiles')
    // Verify it's typed as array of strings
    expect(schemaBlock).toMatch(/testFiles.*type.*array/)
  })

  test('AC-2: runDiscovery nullifies CACHED_CEREMONY before re-running', () => {
    // CACHED_CEREMONY should be set to null in at least 2 places:
    // 1. Inside runDiscovery itself (to clear stale context on regression)
    // 2. At least one other reset point
    const nullifyCount = (shipContent.match(/CACHED_CEREMONY\s*=\s*null/g) || []).length
    expect(nullifyCount).toBeGreaterThanOrEqual(2)
  })

  test('AC-3: commit agent uses filesChanged instead of git add -A', () => {
    // There should be zero occurrences of 'git add -A' in the file
    const gitAddAllCount = (shipContent.match(/git add -A/g) || []).length
    expect(gitAddAllCount).toBe(0)
  })

  test('AC-4: env-defaults agent label is removed', () => {
    // There should be zero occurrences of the env-defaults label
    const envDefaultsCount = (shipContent.match(/label:\s*['"]env-defaults['"]/g) || []).length
    expect(envDefaultsCount).toBe(0)
  })

  test('AC-5: commit agent prompt contains "Do NOT run tests"', () => {
    // The commit phase prompt should explicitly tell the agent not to run tests
    // Find the commit phase section and check for the instruction
    const commitPhaseStart = shipContent.indexOf("phase('Commit')")
    expect(commitPhaseStart).toBeGreaterThan(-1)
    const commitPhaseSection = shipContent.slice(commitPhaseStart, commitPhaseStart + 3000)
    expect(commitPhaseSection).toContain('Do NOT run tests')
  })

  test('AC-6: ac-completion-check agent label is removed', () => {
    // There should be zero occurrences of ac-completion-check
    const acCompletionCount = (shipContent.match(/ac-completion-check/g) || []).length
    expect(acCompletionCount).toBe(0)
  })
})
