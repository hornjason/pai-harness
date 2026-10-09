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

  test('AC-3 (superseded by #115): staging derives from git status, never from filesChanged', () => {
    // RULE REVERSAL, recorded deliberately.
    //
    // AC-3 of #53 read "commit agent uses filesChanged instead of git add -A"
    // and this test asserted zero occurrences of `git add -A`. The intent was
    // to stop indiscriminate staging, and that intent was right.
    //
    // The implementation was not. Making an LLM's file list load-bearing for
    // `git add` produced two behaviours from one formatted string, the wrong
    // way round: reporting nothing meant `git add .` (stage everything), and
    // reporting annotated paths meant SHIP_FAILED (discard the work). Run
    // wf_e750572e-153 died the second way with four files written and
    // fourteen tests green; #120 was the same defect one stage later.
    //
    // #115 supersedes AC-3 on the basis of that evidence: the worktree is
    // ground truth, so `git status --porcelain` decides and filesChanged is
    // reporting metadata. The anti-indiscriminate intent survives as the
    // assertions below — exactly one staging command, inside the one helper,
    // behind an explicit empty-worktree guard.
    // Asserted on CALL SITES, not on occurrences of `git add` in the file.
    //
    // Two earlier versions of this counted text. Both were wrong in the same
    // direction: the raw-file scan matched the helper's own explanatory
    // comments, and the comment-stripped scan still matched the body of
    // safeGitAddCommand — which #115 left with no callers but did not
    // delete. A dead function was making a live assertion fail. Counting
    // what is CALLED says what the test means and is indifferent to text
    // that nothing executes. (The dead helpers are tracked separately for
    // removal; leaving them is not the same as using them.)
    const codeLines = shipContent
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))

    const llmPathStaging = codeLines.filter(
      l => /safeGitAddCommand\(/.test(l) && !/^\s*function\s/.test(l),
    )
    expect(llmPathStaging, "an agent's file list still reaches git add").toEqual([])

    const gitDerived = codeLines.filter(
      l => /gitDerivedStaging\(/.test(l) && !/^\s*function\s/.test(l),
    )
    expect(gitDerived.length, 'a commit path lost its staging').toBe(3)

    const start = shipContent.indexOf('// ──── COMMIT-STAGING-START ────')
    const end = shipContent.indexOf('// ──── COMMIT-STAGING-END ────')
    expect(start, 'the staging helper lost its markers').toBeGreaterThan(-1)
    // Comment-stripped. The helper's own prose explains what it replaced and
    // therefore contains both "filesChanged" and "git add ." — asserting
    // against the raw block failed on the documentation, which is the third
    // time in this change that a detector matched a comment instead of code.
    const body = shipContent
      .slice(start, end)
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

    expect(body, 'staging moved outside the audited helper').toMatch(/add\s+-A/)
    expect(body, 'staging is no longer guarded by an empty-worktree check')
      .toContain('RUNGATE_NO_CHANGES')

    // filesChanged may still be reported; it must not reach a git command.
    expect(body, "the agent's file list is back inside the staging helper")
      .not.toContain('filesChanged')
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
    const promptStart = shipContent.lastIndexOf('await timedAgent(`', Math.max(0, promptEnd - 1))
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
