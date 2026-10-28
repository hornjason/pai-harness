---
doc-type: spec
status: draft
owner: jason
created: 2026-10-28
updated: 2026-10-28
governs: Spec authoring — the frame a new spec is born with, and the rule that a ticked criterion must name what proved it
testable: true
compliance: strict
evidence: required
---

# Spec Authoring

## Why this exists

A tick in a spec in this repository means somebody merged something. It does
not mean anything was run, and nothing in the tree has ever recorded what was.
Measured on 2026-10-28: **1,477 of 1,736 criteria across 22 specs are ticked,
and 0 of them name what proved them** (`bun scripts/audit-spec-evidence.ts`).

That is not a bookkeeping complaint. On `CODE-REVIEW-CONVERGENCE-SPEC.md` two
ticked criteria name nothing at all, and two more are contradicted by issues
that are still open — a criterion saying a finding clears when a later commit
fixes it, ticked, while an open issue documents the required check going clean
over an unfixed blocker. Read in good faith, the document says work is done
that is not done.

The second half of the problem is where it gets fixed. Every element that
makes a criterion checkable — which outcome it moves, what the measurement was
before, which increment it belongs to, what would prove it, when to stop — had
to be retrofitted onto finished documents by hand. `scripts/create-spec.ts`
emitted a title, a `## Context` placeholder and one `SC-TODO` line, so the
frame was always late and always somebody's memory. **This spec moves it to
authoring time and puts a checker behind it**, because the surveyed tooling is
unanimous that a template with nothing behind it decays.

### This is a category, not our bug

Surveyed 2026-10-28. Four tools gate on a boolean a human or an agent sets:
OpenSpec's `validate --archived` exits non-zero unless every `tasks.md` box is
ticked, never that it was earned; GitHub Spec Kit gates on checkbox state an
LLM wrote; Doorstop's `review` stamps a fingerprint with no evidence required;
Jama and DOORS make "clear suspect links" a workflow action with an optional
comment. The rule behind all four: **wherever a human-or-agent-settable
boolean is the gate's input, the gate measures compliance with the ritual.**

The tools that escape it — BMW lobster, OpenFastTrace, NIST OSCAL, SLSA — all
take as input a link the tool itself resolved. lobster is the model copied
here: anything not `OK` or `JUSTIFIED` is a non-zero exit, so a blank cell is a
build failure and not a warning. Its one hole is closed deliberately —
lobster's justification is free text and `len(self.just_up) > 0` tests list
length, never content, so an **empty** justification clears its gate. Here a
waiver needs a reason, an owner and an expiry, and all three are checked for
content.

## Outcomes

| Outcome | Baseline today | Command that produced the baseline | Target |
|---|---|---|---|
| A ticked criterion names what proved it | 0 of 1,477 ticked criteria | `bun scripts/audit-spec-evidence.ts` | every ticked criterion in a **bound** spec, enforced |
| A new spec is born with the frame already in it | 0 of 27 specs carry outcomes, increments or exit criteria | `bun scripts/audit-spec-evidence.ts --json` | every spec created after 2026-10-28 |
| A reworded criterion loses its old proof | UNMEASURED — nothing in the tree relates a criterion's text to its evidence | — | rewording a bound criterion turns it red |

The third row has no baseline and says so. That makes its first increment
*instrument it*, which is what `criterionFingerprint` is, and not *improve
it*.

## Increment 1 — the rule, the checker and the generator, shipped together

**Moves:** rows one and two.

**Appetite:** one pull request. If the suite cannot be made green inside it,
this increment is **cancelled and re-scoped, not extended** — most likely by
dropping the generator half and shipping the checker alone.

**Exit criteria — how we know it is done:**

- [ ] A spec that declares `evidence: required` and ticks a criterion with no
      evidence fails the suite, and the failure has been observed rather than
      argued.
- [ ] A spec created by `bun bin/rungate.ts create-spec` carries the outcome
      table, the increment frame, the exit criteria, the decision-criteria
      table and the deviations record.
- [ ] Every document that predates the `evidence: required` key is unaffected,
      and that is shown by running the identical broken content both ways.

**Pre-specified decision criteria — written BEFORE the measurement:**

The measurement is the next ten specs authored through the new generator, read
with `bun scripts/audit-spec-evidence.ts --json`.

| Reading | Selects | Next increment |
|---|---|---|
| **≥ 8 of 10** new specs keep a filled outcome table at merge | H1 — the frame is usable as written | retrofit the four in-flight specs onto it |
| **≤ 4 of 10** keep it | H2 — the frame is too heavy | cut the template to outcomes plus evidence and re-measure |
| 5–7 of 10 | both | H2 first, because deleting is cheaper than persuading |
| fewer than **10** specs authored before 2026-12-31 | neither — **futility** | cancel; the generator is not on anyone's path and the checker is the whole value |

**Deviations record — written after the measurement, and empty until then.**

## Increment 2 — the retrofit, deliberately unscoped until Increment 1 measures

Measured 2026-10-28: 1,683 criteria, 1,466 ticked, and **174 of the 217 open
criteria sit in four documents** — CODE-REVIEW-CONVERGENCE (47),
bootstrap-data-flow/success-criteria (104), RULE-LIFECYCLE (12),
SESSION-LIFECYCLE (11). Seven specs are 100% complete and are **not** candidates:
retrofitting a finished document produces evidence nobody will read for work
nobody will revisit.

Not started, and not to be started before Increment 1's decision criteria fire.

## Success Criteria

Each criterion carries two lines. `needs:` says at authoring time what kind of
proof it takes — one of `test`, `measurement`, `run`, `review`. `proved-by:`
names what actually ran, and **a ticked criterion with it blank fails the
build** (`lib/spec-evidence.ts`). A criterion deliberately not being proved
says so out loud instead, with `waived-reason`, `waived-by` and
`waived-until`. `fingerprint:` binds the evidence to the wording, so rewording
the criterion later invalidates what proved it.

- [x] SC-2560: a ticked criterion with no proved-by line is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2560: a ticked criterion with no proved-by line at all is a violation"
      fingerprint: b73c6a2e
- [x] SC-2561: a ticked criterion whose proved-by is blank is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2561: a ticked criterion whose proved-by is BLANK is a violation, not a pass"
      fingerprint: d2c67601
- [x] SC-2562: a criterion that never declares what would prove it is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2562: a criterion that never says what would prove it is a violation"
      fingerprint: 33d48939
- [x] SC-2563: an evidence kind outside the closed set is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2563: an evidence kind outside the closed set is a violation, not a pass"
      fingerprint: 465cebd3
- [x] SC-2564: a waiver with an empty reason is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2564: a waiver with an empty reason is a violation — lobster's hole, closed"
      fingerprint: 2ebeb40e
- [x] SC-2565: a waiver with no expiry date is a violation
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2565: a waiver with no expiry is a violation"
      fingerprint: a17e7ea6
- [x] SC-2566: a waiver whose expiry has passed is a violation again
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2566: a waiver whose expiry has passed is a violation again"
      fingerprint: 5f97edb7
- [x] SC-2567: evidence recorded against a different wording is stale
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2567: evidence recorded against a different wording is stale"
      fingerprint: 9eb5b8f6
- [x] SC-2568: a fully populated criterion produces zero violations
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2568: a fully populated criterion produces zero violations"
      fingerprint: e6b06338
- [x] SC-2569: identical content is clean in a spec that has not opted in
      needs: test
      proved-by: test/spec-evidence.test.ts "SC-2569: the SAME broken content is clean when the spec has not opted in"
      fingerprint: abe36b56
- [x] SC-2570: a newly created spec declares evidence required in its frontmatter
      needs: test
      proved-by: test/spec-template.test.ts "SC-2570: a generated spec is bound by the evidence rule"
      fingerprint: 91063e88
- [x] SC-2571: a newly created spec carries outcomes, an increment and exit criteria
      needs: test
      proved-by: test/spec-template.test.ts "SC-2571: the generated frame carries every section the rule depends on"
      fingerprint: a52497b2
- [x] SC-2572: a freshly generated spec is not born in violation
      needs: test
      proved-by: test/spec-template.test.ts "SC-2572: the placeholder criterion is not parsed as a criterion"
      fingerprint: 8b475db7
- [x] SC-2573: the spec template has exactly one emitter
      needs: test
      proved-by: test/spec-template.test.ts "SC-2573: create-spec.ts does not emit a second template"
      fingerprint: 3428ff61
- [x] SC-2574: the decider refuses nothing when short-circuited, and that is observed
      needs: test
      proved-by: test/spec-evidence.test.ts "the mutant and the real module differ on a named input"
      fingerprint: 7a1e7a71
