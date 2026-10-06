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
    // Was `slice(commitPhaseStart, +3000)` — a byte distance standing in for
    // "the commit agent's prompt". Inserting anything into the commit phase
    // pushed the instruction past the window and failed the test while the
    // property it checks was still true (#81 did exactly that). Anchor on the
    // agent instead: the claim is about the commit agent's prompt, so find the
    // commit agent and read its prompt.
    const commitPhaseStart = shipContent.indexOf("phase('Commit')")
    expect(commitPhaseStart).toBeGreaterThan(-1)

    const labelIdx = shipContent.indexOf("label: 'commit'", commitPhaseStart)
    expect(labelIdx, "no agent labelled 'commit' after phase('Commit')").toBeGreaterThan(-1)

    // The prompt is the template literal immediately preceding the options
    // object that carries the label.
    const promptEnd = shipContent.lastIndexOf('`', labelIdx)
    const promptStart = shipContent.lastIndexOf('await agent(`', Math.max(0, promptEnd - 1))
    expect(promptStart).toBeGreaterThan(-1)

    const commitPrompt = shipContent.slice(promptStart, promptEnd)
    expect(commitPrompt).toContain('Do NOT run tests')
  })

  test('AC-6: ac-completion-check agent label is removed', () => {
    // There should be zero occurrences of ac-completion-check
    const acCompletionCount = (shipContent.match(/ac-completion-check/g) || []).length
    expect(acCompletionCount).toBe(0)
  })
})
