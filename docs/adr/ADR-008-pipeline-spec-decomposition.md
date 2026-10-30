---
doc-type: adr
status: accepted
created: 2026-10-30
updated: 2026-10-30
---

# ADR-008 — decomposing SPEC-TO-BOARD-PIPELINE-SPEC.md into issues

## Status

Accepted, 2026-10-30. Jason's call: target the forward gap on the spec that
merged the night before, and make the board readable rather than complete.

## Context

`SPEC-TO-BOARD-PIPELINE-SPEC.md` merged on 2026-10-30 at `4714c388` with 15
criteria and nothing naming 14 of them. Measured the same morning, from a
snapshot of 796 issues and 877 pull requests:

```
DOCUMENT ONLY — 1 of 15   SC-2600 (PR #1673)
NOT STARTED  — 14 of 15
```

That is the forward gap this ADR closes, and it is the first time the
pipeline has been run against its own governing spec.

## The decision, and why it is four issues and not fourteen

**A criterion that is already true does not become an issue.** AGENTS.md rule
1 says a spec states what must be true and is never the to-do list, and
`.claude/rules/` says a done criterion is context rather than an acceptance
criterion. So the first step was to ask, per criterion, whether the thing it
names exists — measured on `origin/main` at `521d4661`, not inferred:

| Criterion | File and symbol it names | Reading |
|---|---|---|
| SC-2600 | `lib/spec-placement.ts` `NON_PHASE_PLACEMENTS` | present |
| SC-2601 | `lib/issue-decomposition.ts` `unmeasuredReasons` | present |
| SC-2602 | `test/issue-decomposition.test.ts` *a bad row skipped instead of rejected* | **missing** |
| SC-2603 | `lib/issue-decomposition.ts` `planDecomposition` | present |
| SC-2604 | `lib/issue-decomposition.ts` `MIN_OUTCOME` | present |
| SC-2605 | `test/issue-decomposition.test.ts` *RE-RUN…* | present |
| SC-2606 | `lib/spec-deps.ts` `adjacent` | present |
| SC-2607 | `test/issue-decomposition.test.ts` *an edge…wired, not dropped* | present |
| SC-2608 | `lib/issue-repair.ts` `CRITERIA_HEADING` | present |
| SC-2609 | `lib/board-mirror.ts` `NAMES_NONE` | present |
| SC-2610 | `lib/board-mirror.ts` *every spec* | **missing** |
| SC-2611 | `lib/spec-placement.ts` `coverage` | present |
| SC-2612 | `lib/finding-promotion.ts` `promote` | **file absent** |
| SC-2613 | `lib/github.ts` `filingGate` | **missing** |
| SC-2614 | `lib/finding-arbiter.ts` `STALE_CITATION` | present |

Eleven of fifteen name something that already exists. Those need a test that
claims them and evidence that proves them — a **binding**, which is a
different kind of work from building, and which does not become an issue per
criterion. Four name something genuinely absent, and those are the rows below.

**A symbol present is not a behaviour proved.** SC-2609 is the live example:
`NAMES_NONE` exists in `lib/board-mirror.ts` and 28 cells on the board were
still blank on 2026-10-29. The present/absent reading above decides what gets
an issue; it does not decide what gets ticked, and nothing here ticks anything.

## The plan

`bun bin/rungate.ts plan-issues --decompose docs/adr/ADR-008-pipeline-spec-decomposition.md --repo hornjason/rungate --write`

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2602 | Prove the decomposition refusals can fail with a skip mutant | test/issue-decomposition.test.ts, lib/issue-decomposition.ts | Pipeline Phase 0 — the transform refuses | — |
| SC-2610 | board-mirror reads every spec rather than one named on the command line | lib/board-mirror.ts, scripts/board-mirror.ts, test/board-mirror.test.ts | Pipeline Phase 3 — the board tells the truth | — |
| SC-2613 | Route createIssue through the filing gate so the tool path is metered too | lib/github.ts, scripts/github-op.ts, test/github-create-gated.test.ts | Pipeline Phase 5 — the loop closes | — |
| SC-2612 | Promote a review finding that names real work into a spec criterion | lib/finding-promotion.ts, scripts/finding-promotion.ts, test/finding-promotion.test.ts | Pipeline Phase 5 — the loop closes | Route createIssue through the filing gate so the tool path is metered too |

### The one edge, and why there is only one

Ordering is data (AGENTS.md rule 4), but inventing order is worse than
recording none. Three of these four are independent and are written that way.

The fourth is a real dependency: a tool that promotes findings into criteria
is a tool that creates issues, so it must not land before `createIssue` is
metered. Shipping them the other way round adds an ungated issue-creating
path to the repository whose backlog ratio this whole spec exists to protect.

## Consequences

The eleven already-true criteria stay unticked and stay off the tracker. That
is deliberate and it is the direction this is allowed to be wrong in: an
unticked criterion that is actually true costs a later binding, while a ticked
one that nothing proves is the failure `.claude/rules/checks-must-be-able-to-fail.md`
is about.

SC-2613's outcome is worded to match the row ADR-007 already carries, so the
two plans name one piece of work rather than two.
