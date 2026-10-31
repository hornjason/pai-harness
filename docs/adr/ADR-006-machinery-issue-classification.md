---
doc-type: adr
status: accepted
created: 2026-10-29
updated: 2026-10-29
---

# ADR-006: The six Convergence Machinery issues, classified

## Status

**Accepted on 2026-10-31** — the adjudication is correct and is the decision
of record.

**Its decision has NOT been applied to the tracker, and accepting it does not
make that true.** Measured on 2026-10-31 against the table below, all six
rows, not a sample:

| Issue | What the table assigns | On the tracker today |
|---|---|---|
| #1495 | `CRC-C2` | open, body does not cite CRC-C2 |
| #1497 | `CRC-C2` | open, body does not cite CRC-C2 |
| #1571 | `CRC-C2` | open, body does not cite CRC-C2 |
| #1257 | `(b)` none — machinery | open, body does not say machinery |
| #1173 | `(b)` none — machinery | open, body does not say machinery |
| #1157 | `(b)` none — machinery | open, body does not say machinery |

Six of six unrepaired. Every one of these issues still renders on the board
exactly as it did before this ADR was written — a blank Criteria cell that
reads the same whether nobody looked or somebody decided — which is the
condition the ADR exists to remove.

Recorded here rather than silently ticked. Accepting the reading and applying
it are two acts, and only the first has happened.

## The question this answers

Not *"do these name a criterion"* — measured, and none of them does. The
question is **should they**, which is an adjudication and belongs in a
reviewed table rather than in a tool.

Answered by reading all six bodies in full on 2026-10-29, against the Phase
placement table in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`.

## The reading

**Three of the six serve CRC-C2.** They are the three issues about the
`ai-review` waiver disarm step (#1242) — the mechanism that stops a pull
request whose review was waived by `ai-review-override` from merging unread.
CRC-C2 is *"A PR cannot merge while any bug-review or security-review finding
is open"*, and #1495 names the connection itself: *"SUCCESS.md claim 3 — bad
ships are stopped."*

**Three serve nothing, and that is the correct answer for them.** Two are
about this repository's own test suite — a duration regression detector and a
flaky case — and one is about re-deriving a tuning parameter. None of them
makes a criterion true or false. They are maintenance, and an issue that is
maintenance should say so rather than leave a blank cell that reads the same
as an oversight.

| Issue | Repair | Criteria | Confidence | Why |
|---|---|---|---|---|
| #1495 | (a) | `CRC-C2` | HIGH | The disarm is one-shot: `auto_merge_enabled` is not in `AI_REVIEW_PULL_REQUEST_TYPES`, so re-arming after the final run leaves a waived PR armed with no later run to disarm it. A waived review that merges itself is C2 failing. The issue states the claim it moves. |
| #1497 | (a) | `CRC-C2` | MEDIUM | Same step, different route in: bare `gh` off `PATH` with the reviewer's inherited environment, and `$GITHUB_ENV` carries into it. A `GH_HOST` or `GH_CONFIG_DIR` planted by an earlier step points the disarm's two `gh` calls at config the reviewer chose — and the job's tree-modification guard subtracts the path `$GITHUB_ENV` lives under, so it cannot see it. The outcome is the same as #1495's: armed, waived, unread. |
| #1571 | (a) | `CRC-C2` | MEDIUM | **The contested row.** Its failure direction is the opposite of the other two: a labelled PR with auto-merge armed is red *by construction* (0 of 65 executed attempts took the armed-and-disarmed branch), so the check blocks merges rather than permitting them. The case for C2 is second-order — a required check that can only be red is one operators route around, and the route around is the bypass C2 forbids. Read it before accepting it; the honest alternative is (b). |
| #1257 | (b) | — | MEDIUM | Re-derive `AI_REVIEW_MAX_TURNS` once the post-#1243 distribution is large enough. Calibrating a parameter so reviews finish is upkeep of an instrument, not a criterion being proved. The nearest criterion is CRC-M12's `diff_truncated`, and it is not the same thing: M12 asks that an unreadable round *name its mode*, which a turn budget neither records nor affects. |
| #1173 | (b) | — | HIGH | Raising the per-test ceiling to 120 s removed the accidental duration-regression detector for six `ai-review-*` suites. A proposal for a duration ratchet over this repository's own test suite. No criterion in the spec is about how long our tests take. |
| #1157 | (b) | — | HIGH | `AC-10` drift-step cases fail locally and a different case fails each run — timing sensitivity, not a wrong assertion, and not a regression from the change it was found under. A flaky local test. No criterion. |

## `(b)` means something different here than it did in ADR-005

In ADR-005, `(b)` was **demote** — remove the issue from a `Convergence Phase
N` milestone it did not belong in, because a stray card in a phase keeps that
phase open after every criterion in it is true, and blocks the whole next
phase through `plan-deps`.

`Convergence Machinery` is not a phase. `plan-deps` derives edges over
`Convergence Phase N` milestones only, so nothing in this milestone carries
order or appears in the frontier, and demoting these three would change
nothing. The repair they need is **an explicit `none — machinery` written into
the body**, so the board's Criteria column distinguishes *deliberately serves
no criterion* from *nobody has looked*. Those render identically today, and
that is the whole defect: a blank cell is unactionable.

## The three `(a)` rows need a repair kind that does not exist yet

They serve CRC-C2, and CRC-C2 is placed in **Phase 6**. They sit in
`Convergence Machinery`, which is outside the derivation entirely — so three
issues on the critical path to a Phase 6 criterion carry no dependency edges,
never block anything, and never surface as *what is next*.

Annotating them is necessary and not sufficient. `plan-issues --repair` has
two kinds, `annotate` and `demote`, and neither **promotes** an issue into a
phase milestone. Options, in the order I would take them:

1. **Add a `(c) promote` kind** taking a target phase, which sets the
   milestone and then leaves `plan-deps --write` to derive the edges. This is
   the one that keeps the pipeline whole — the milestone becomes a derived
   consequence of a reviewed table, like every other step.
2. Set the three milestones by hand and re-run `plan-deps`. Faster, and it
   puts a decision back in somebody's head, which is the thing this whole
   workstream exists to stop.

Promotion is deferred to its own change rather than bundled here, because it
adds a write that can move an issue *into* the order — and an edge derived
from a wrong promotion is worse than a missing one.

## What this does not claim

That the six were misfiled. `Convergence Machinery` is a reasonable home for
#1257, #1173 and #1157 and they should stay in it. What was wrong is that the
milestone's meaning was never written down, so it absorbed three issues that
belong in Phase 6 without anything being able to notice.
