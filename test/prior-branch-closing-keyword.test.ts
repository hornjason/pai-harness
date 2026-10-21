import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  detectExistingPR,
  issueClosingReference,
  issueSubjectReference,
  issueProseReference,
  issueReference,
} from '../lib/prior-branch'

/**
 * #887 — `detectExistingPR` treated any `#N` anywhere in any open PR body as
 * that issue's prior work, and `priorWorkRefusal` then stopped the run.
 *
 * The instance: a consumer run for issue #1624 refused after 9 agents, 716k
 * and 26 minutes, naming PR #1820 — which is #1815's PR, with zero file
 * overlap. What matched was two sentences of prose citing #1624. Four
 * separate open PRs cite it; removing one would have handed the refusal to
 * the next.
 *
 * This is the THIRD narrowing of the same predicate. #687 narrowed a bare
 * number to `#N` after a quoted `rungate/run-631` blocked issue 631; before
 * that `pr.number` was consulted, so PR #209 was issue #209's prior work
 * whatever it was about. Each fix narrowed the radius and left the shape.
 *
 * MEASURED on this repository's own 120 most recent PRs, before the change:
 *
 *   103 of 120 bodies cite issues they do not close -- 417 such citations
 *   only  33 of 120 bodies carry a closing keyword at all
 *   107 of 120 titles carry a #N;  6 carry more than one
 *
 *   false positives, old rule (120 PRs x 739 candidate numbers):  354
 *   false positives, new rule:                                      4
 *   true (PR, issue) pairs lost:                                    0
 *
 * All four remaining are genuine multi-issue closing declarations my
 * ground-truth heuristic missed -- `Fixes #500` in PR 838, `Closes #735` in
 * PR 736, `Fixes #644` and `closed #586` in PR 708 -- so the honest reading
 * of the 4 is "three correct detections and one past-tense prose sentence
 * that GitHub would also treat as closing".
 *
 * ONE LIMITATION, STATED RATHER THAN DISCOVERED LATER: that ground truth is
 * head-ref plus title-prefix, and the title-prefix half is also half the new
 * rule, so "0 lost" is partly circular for titles. The head-ref half is
 * independent and is the dominant signal -- which is why AC-6 exists.
 */

const SHIP_BODY = (n: number) => `## Summary\n\nSomething was done.\n\nFixes #${n}\n`

function pr(over: Partial<{ number: number; title: string; body: string; ref: string }>) {
  return {
    number: over.number ?? 1820,
    title: over.title ?? 'fix(#1815): bound the unit gate wait',
    body: over.body ?? '',
    head: { ref: over.ref ?? 'fix/1815-bound-the-unit-gate-wait' },
  }
}

/** The shape `listPRs` reads, matching test/prior-branch.test.ts. */
const client = (prs: unknown[]) =>
  ({ rest: { pulls: { list: async () => ({ data: prs }) } } }) as any

async function detect(issueNumber: number, prs: unknown[]) {
  return detectExistingPR({ issueNumber, repo: 'o/r', client: client(prs) } as any)
}

// ── The instance ─────────────────────────────────────────────────────────

describe('#887: a citation in a PR body is not that issue prior work', () => {
  test('AC-1: the #1624 instance, verbatim', async () => {
    // Both lines are from PR #1820's real body. Neither is a claim.
    const body =
      'reaches a test. The wrapper can, because it owns the handle. #1624 record\n' +
      'The 4 reds are all POV/Chromium under parallel load — **#1624**, not a\n' +
      'Fixes #1815\n'
    expect(await detect(1624, [pr({ body })])).toBeNull()
  })

  test('AC-2: and the PR it really belongs to is still found', async () => {
    // The control. Without it AC-1 is satisfied by a detector that finds
    // nothing at all, which is #209 reintroduced.
    const found = await detect(1815, [pr({ body: 'Fixes #1815\n' })])
    expect(found).toMatchObject({ prNumber: 1820 })
  })

  test('AC-3: four PRs citing one issue refuse none of them', async () => {
    // Removing one citation would have handed the refusal to the next, which
    // is why the measurement in the issue counted all four.
    const citers = [1820, 1817, 1809, 1771].map(n =>
      pr({ number: n, title: `fix(#${n - 5}): something`, ref: `fix/${n - 5}-x`, body: `see #1624 for the record\nFixes #${n - 5}\n` }),
    )
    expect(await detect(1624, citers)).toBeNull()
  })
})

// ── The body reading: a closing keyword, the way GitHub reads one ─────────

describe('#887: issueClosingReference matches what GitHub matches', () => {
  const VARIANTS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']

  test('AC-4: every GitHub closing keyword, in both cases', () => {
    const m = issueClosingReference(209)
    for (const v of VARIANTS) {
      expect(m(`${v} #209`), `"${v} #209" is a closing declaration GitHub honours`).toBe(true)
      expect(m(`${v.toUpperCase()} #209`), `"${v.toUpperCase()}" is the same keyword`).toBe(true)
    }
    // A hand-written PR using any of them is still detected -- the #209
    // regression the issue warns about if only ship.js's own spelling counts.
    expect(m('Resolved #209 by deleting the fallback')).toBe(true)
  })

  test('AC-5: a bare citation is not a closing declaration', () => {
    const m = issueClosingReference(209)
    expect(m('see #209 for the measurement')).toBe(false)
    expect(m('**#209**, not a flake')).toBe(false)
    expect(m('#209')).toBe(false)
    expect(m("#209's record")).toBe(false)
    // The near-misses that are not keywords.
    expect(m('reverts #209')).toBe(false)
    expect(m('supersedes #209')).toBe(false)
    expect(m('refs #209')).toBe(false)
  })

  test('AC-6: a backtick does not disarm a closing keyword', () => {
    // GitHub closes #N from a quoted `Fixes #N`, so a detector that skipped
    // code spans would disagree with GitHub about which PR closes what. Match
    // the same text GitHub does.
    expect(issueClosingReference(209)('a sample body ends `Fixes #209` like so')).toBe(true)
  })

  test('AC-6b: the forms GitHub honours that are not a bare #N', () => {
    // Found by security review of the first draft, which required `\s+#`.
    // A detector NARROWER than GitHub's grammar fails in the dangerous
    // direction: the PR really does close the issue, this does not see it,
    // and the issue is shipped twice -- #209 again.
    const m = issueClosingReference(209)
    expect(m('Fixes: #209'), 'GitHub honours a colon after the keyword').toBe(true)
    expect(m('Closes GH-209'), 'GH-N is one of the forms GitHub closes from').toBe(true)
    expect(m('Resolves https://github.com/hornjason/pai-harness/issues/209')).toBe(true)
    // And the boundaries survive the widening.
    expect(m('Fixes GH-2091')).toBe(false)
    expect(m('Resolves https://github.com/o/r/issues/2091')).toBe(false)
    expect(m('see GH-209')).toBe(false)
  })

  test('AC-6c: ship.js PR-body template is matched by this predicate', () => {
    // Two positions naming one fact, with nothing comparing them until now
    // (#621's shape). `workflows/ship.js` writes the closing line into every
    // PR it opens; this predicate is what reads it back. If the template is
    // reworded -- to defuse the keyword, say, which this repository's own
    // AFK rules ask for in hand-written bodies -- the harness silently stops
    // finding its own PRs and the issue ships twice.
    //
    // Asked of the FILE rather than of a copy of the string, so the two
    // cannot drift. Requested by security review.
    const ship = readFileSync(join(import.meta.dir, '..', 'workflows', 'ship.js'), 'utf-8')
    const line = ship.split('\n').find(l => /^(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*#\$\{ISSUE\}/i.test(l.trim()))
    expect(line, 'ship.js no longer writes a closing line into the PR bodies it opens').toBeTruthy()
    expect(
      issueClosingReference(209)(line!.replace('${ISSUE}', '209')),
      `ship.js writes ${JSON.stringify(line)} and this predicate does not match it`,
    ).toBe(true)
  })

  test('AC-7: the boundary cases the bare reading already had', () => {
    const m = issueClosingReference(209)
    expect(m('Fixes #2091')).toBe(false)
    expect(m('Fixes #1209')).toBe(false)
    expect(m('Fixes 209')).toBe(false)
  })
})

// ── The title reading: the subject prefix, not the whole sentence ─────────

describe('#887: issueSubjectReference reads the conventional-commit subject', () => {
  test('AC-8: a number after the colon is a citation, not the subject', () => {
    // A real title from this repository. It is #837's PR; #836 is cited.
    const t = 'docs(#837): record the #836 battery in HARNESS-STANDARD.md'
    expect(issueSubjectReference(837)(t)).toBe(true)
    expect(issueSubjectReference(836)(t)).toBe(false)
  })

  test('AC-9: every subject form this repository writes', () => {
    expect(issueSubjectReference(209)('fix(#209): the thing')).toBe(true)
    expect(issueSubjectReference(209)('#209: the thing')).toBe(true)
    expect(issueSubjectReference(209)('feat(#209): the thing')).toBe(true)
    // Two issues in one subject, both before the colon, both the PR's own.
    expect(issueSubjectReference(640)('#640 + #644: resolve the run branch')).toBe(true)
    expect(issueSubjectReference(644)('#640 + #644: resolve the run branch')).toBe(true)
  })

  test('AC-10b: a colon far into a prose sentence is not a subject', () => {
    // The SUBJECT_PREFIX_LIMIT, which nothing reached until the battery said
    // so: raising it to 4000 was row M7 and 0 red, because every other
    // fixture here has its colon in the first ten characters. A constant no
    // case can reach is a constant that can be anything.
    //
    // Colon at 62. Without the limit the whole clause before it is read as a
    // subject, and a sentence that merely mentions #209 becomes #209's PR.
    const prose = 'a long sentence about the runner and the measurement and #209: it says'
    expect(prose.indexOf(':'), 'the fixture no longer has a late colon').toBeGreaterThan(40)
    expect(issueSubjectReference(209)(prose)).toBe(false)
    // The control: the same number, the same colon, inside the limit.
    expect(issueSubjectReference(209)('fix(#209): it says')).toBe(true)
  })

  test('AC-10: a title with no colon declares no subject issue', () => {
    // Not a fallback to the whole string. A fallback is how the body reading
    // got this wide, and the true answer for a title that names no issue in
    // its subject is "this title does not say".
    expect(issueSubjectReference(735)('perf(ci): shard the suite #735')).toBe(false)
    expect(issueSubjectReference(209)('a title with no colon at all #209')).toBe(false)
  })
})

// ── The case the cheapest wrong fix does not survive ──────────────────────

describe('#887: the harness can still find its own PRs', () => {
  test('AC-11: a worktree-named branch with the issue only in the body', async () => {
    // THE CHEAPEST WRONG FIX is to delete the body reading outright -- one
    // line, and #1624's four citations stop matching immediately.
    //
    // This is the case that does not survive it. `detectExistingPR`'s own
    // doc comment names the hazard: ship.js opens PRs from branches called
    // `worktree-wf_5e3ed885-98c-9`, which carry the issue number nowhere,
    // and only the `Fixes #N` it writes into the body says which issue the
    // PR is for. Blind the body and the harness cannot see its own PRs, the
    // issue is shipped twice, and that is #209 -- the defect this whole
    // module exists to prevent.
    const found = await detect(209, [
      pr({ number: 777, title: 'Automated change', ref: 'worktree-wf_5e3ed885-98c-9', body: SHIP_BODY(209) }),
    ])
    expect(found, 'the harness cannot find the PR it opened itself').toMatchObject({ prNumber: 777 })
  })

  test('AC-11b: a title citation does not make a PR that issue prior work', async () => {
    // AC-8 catches the widened title reading at the PREDICATE. Nothing
    // caught it at the CALL SITE until the battery said so -- row M3,
    // widening the title back to full prose, was 0 red. A predicate case and
    // a call-site case are two claims, and only the second says the right
    // predicate is the one wired in.
    const p = pr({ number: 842, title: 'docs(#837): record the #836 battery', ref: 'docs/837-record', body: 'Fixes #837\n' })
    expect(await detect(836, [p]), 'a title citation was read as prior work').toBeNull()
    expect(await detect(837, [p])).toMatchObject({ prNumber: 842 })
  })

  test('AC-12: the head ref keeps its bare-number identifier reading', async () => {
    const found = await detect(209, [pr({ number: 778, title: 'no number here', ref: 'fix/209-deep-modules', body: 'nothing' })])
    expect(found).toMatchObject({ prNumber: 778 })
  })
})

// ── What must NOT be narrowed ─────────────────────────────────────────────

describe('#887: the commit-subject reading is untouched', () => {
  test('AC-13: issueProseReference still accepts a bare #N', () => {
    // `detectPriorBranch` reads COMMIT SUBJECTS with this, and a commit
    // subject carrying `fix(#209):` is a claim of authorship, not a citation.
    // Narrowing it to closing keywords would break detection outright,
    // because this repository's own rules keep closing keywords OUT of commit
    // messages -- a quoted one still fires on merge. Two populations, two
    // bounds; this file narrows one of them and says so.
    expect(issueProseReference(209)('fix(#209): the thing')).toBe(true)
    expect(issueProseReference(209)('see #209')).toBe(true)
    expect(issueReference(209)('fix/209-deep-modules')).toBe(true)
  })
})

// ── Totality, on the pattern the module already holds ─────────────────────

describe('#887: the new predicates are total and not interpolated', () => {
  for (const [name, make] of [
    ['issueClosingReference', issueClosingReference],
    ['issueSubjectReference', issueSubjectReference],
  ] as const) {
    test(`AC-14: ${name} is total over non-strings`, () => {
      const m = make(209)
      // GitHub returns null for the body of a PR opened without one.
      for (const v of [null, undefined, 42, {}, [], true]) expect(m(v as unknown)).toBe(false)
    })

    test(`AC-15: ${name} throws on a non-integer issue number`, () => {
      expect(() => make(1.5)).toThrow(TypeError)
      expect(() => make(-1)).toThrow(TypeError)
      expect(() => make(NaN)).toThrow(TypeError)
    })

    test(`AC-16: ${name} does not interpolate the number as a pattern`, () => {
      // A number is not a regex, and a predicate that let one through would
      // match things no issue number can name.
      const m = make(209)
      expect(m('Fixes #2.9')).toBe(false)
      expect(m('fix(#2x9): thing')).toBe(false)
    })
  }
})
