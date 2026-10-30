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
1 says a spec states what must be true and is never the to-do list, so the
first step was to ask, per criterion, whether the thing it names exists —
measured on `origin/main` at `521d4661`, not inferred:

| Criterion | File and symbol it names | Reading |
|---|---|---|
| SC-2600 | `lib/spec-placement.ts` `NON_PHASE_PLACEMENTS` | declared |
| SC-2601 | `lib/issue-decomposition.ts` `unmeasuredReasons` | declared |
| SC-2602 | `test/issue-decomposition.test.ts` *a bad row skipped instead of rejected* | **missing** |
| SC-2603 | `lib/issue-decomposition.ts` `planDecomposition` | declared |
| SC-2604 | `lib/issue-decomposition.ts` `MIN_OUTCOME` | declared |
| SC-2605 | `test/issue-decomposition.test.ts` *RE-RUN…* | declared |
| SC-2606 | `lib/spec-deps.ts` `adjacent` | **comment only** |
| SC-2607 | `test/issue-decomposition.test.ts` *an edge…wired, not dropped* | declared |
| SC-2608 | `lib/issue-repair.ts` `CRITERIA_HEADING` | declared |
| SC-2609 | `lib/board-mirror.ts` `NAMES_NONE` | declared |
| SC-2610 | `lib/board-mirror.ts` *every spec* | **missing** |
| SC-2611 | `lib/spec-placement.ts` `coverage` | **comment only** |
| SC-2612 | `lib/finding-promotion.ts` `promote` | **file absent** |
| SC-2613 | `lib/github.ts` `filingGate` | **missing** |
| SC-2614 | `lib/finding-arbiter.ts` `STALE_CITATION` | declared |

### Two rows the first version of this ADR got wrong

SC-2606 and SC-2611 were written here as *present*, and they are not. The AI
review of PR #1674 checked them and was right both times:

```
lib/spec-deps.ts:24       * chains adjacent members of that list. A spec whose placement table skips a
lib/spec-placement.ts:302 * OVER-reports coverage's absence being fixed and never invents it.
```

One occurrence each, both inside a prose comment, neither a declared
identifier. **The reading was taken with `grep` and reported as if it were a
symbol table.** That is the failure the row below SC-2609 warns about,
arriving one level earlier: not "a symbol present is not a behaviour proved"
but a symbol that was never present at all.

It matters because `contains [adjacent]` is satisfied by a text match, so
these two criteria could be TICKED by a conformity run while nothing named
`adjacent` or `coverage` exists — the shape `test/ticked-sc-absent-symbol.test.ts`
exists to catch. Both become issues below, and each issue's first job is to
decide whether the criterion should name the real symbol or the real symbol
should be named after the criterion.

Nine of fifteen name something that already exists. Those need a test that
claims them and evidence that proves them — a **binding**, which is a
different kind of work from building, and which does not become an issue per
criterion. Six name something genuinely absent, and those are the rows below.

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
| SC-2606 | Name the function that chains adjacent phases so the criterion points at a symbol | lib/spec-deps.ts, specs/SPEC-TO-BOARD-PIPELINE-SPEC.md, test/spec-deps.test.ts | Pipeline Phase 2 — the order is data | — |
| SC-2611 | Report a spec with no placement table as unplanned rather than as nothing | lib/spec-placement.ts, scripts/plan-spec.ts, test/spec-placement.test.ts | Pipeline Phase 4 — every spec is planned | — |

### The one edge, and why there is only one

Ordering is data (AGENTS.md rule 4), but inventing order is worse than
recording none. Five of these six are independent and are written that way.

The fourth is a real dependency: a tool that promotes findings into criteria
is a tool that creates issues, so it must not land before `createIssue` is
metered. Shipping them the other way round adds an ungated issue-creating
path to the repository whose backlog ratio this whole spec exists to protect.

## Consequences

The nine already-true criteria stay unticked and stay off the tracker. That
is deliberate and it is the direction this is allowed to be wrong in: an
unticked criterion that is actually true costs a later binding, while a ticked
one that nothing proves is the failure `.claude/rules/checks-must-be-able-to-fail.md`
is about.

**And the gap was wider than the first draft said.** Two readings here were
wrong in the direction that shrinks the backlog, which is the direction a
plan is most likely to be wrong in and the one nobody notices, because a
smaller plan and a smaller problem produce the same document. The correction
cost one review round and two issues; not making it would have left Phase 2
and Phase 4 looking finished.

SC-2613's outcome is worded to match the row ADR-007 already carries, so the
two plans name one piece of work rather than two.
