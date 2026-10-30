---
doc-type: spec
testable: true
compliance: strict
governs: >-
  The spec-to-board pipeline — how a spec's criteria become milestones, issues
  and blocked-by edges, and how the board shows which criterion each issue
  serves without anybody opening it
created: 2026-10-29
status: active
updated: 2026-10-29
---

# The spec-to-board pipeline

## Why this spec exists

**The machinery that exists so every issue names a criterion was governed by
no criterion.** Measured 2026-10-29 on `f1f9b1ba`: a grep across `specs/` for
`ADR-003`, `plan-spec`, `plan-deps`, `plan-issues`, `board-mirror` and
`criterion-inventory` returned nothing, and `ADR-003-spec-to-tracker-mapping.md`
— which defines the whole pipeline — states zero criteria.

That is circular in a way that stops the work. An issue filed to improve the
pipeline has nothing to name, so it lands in the same unaligned pile the
pipeline exists to drain; and the pipeline's own gaps are invisible to
`criterion-inventory`, which is the instrument that would otherwise find them.
An ADR records a decision. It is not a source of truth a tool can read, and
`.claude/rules/config-access.md` already says what happens to a rule nothing
executes.

## What must become true

Open the project board and you can see, without opening a single issue, what
to work on and in what order: every issue, its milestone, and **which spec
criteria it serves**. The backlog can then be driven to zero by a reproducible
process rather than by whoever is holding the most context.

Nine steps, each a command. The pattern is the same at every one:

> **a human-authored artefact in git → a deterministic transform → live state.**

Judgement never lives inside a tool. A tool that decided how many issues a
criterion deserves would be a tool nobody could review, and the artefact is
the record of why the shape is what it is.

## What this spec does NOT govern

- **What a good criterion says.** `specs/SPEC-AUTHORING-SPEC.md` owns that.
- **Whether a review finding is real.** `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`
  owns the arbiter, the jury and the noise buckets.
- **The filing cap.** `docs/adr/ADR-007-filing-cap-plan-route.md` owns it. This
  spec only requires that a pipeline step which creates issues is reachable
  under it.

## Success Criteria

### The transform refuses rather than skips

A step that silently drops a row it cannot read produces a shorter list, and a
shorter list is exactly what a plan with less work in it produces. Those are
different facts and only one is actionable — *Silent Default Substitution*,
`.claude/rules/config-access.md`.

- [ ] SC-2600: lib/spec-placement.ts contains [NON_PHASE_PLACEMENTS, placementReading] — a placement value outside the closed set is a refusal naming the row, never a row quietly skipped, and an absent table reports UNMEASURED rather than an empty reading that looks like a spec in perfect order
- [ ] SC-2601: lib/issue-decomposition.ts contains [DecompositionReading, unmeasuredReasons] — one unreadable row makes the WHOLE reading UNMEASURED, because a plan that is partly unreadable is not a plan that is partly done and creating issues is not an operation to perform from half a table
- [ ] SC-2602: test/issue-decomposition.test.ts contains [a bad row skipped instead of rejected] — the refusals are proved able to fail by a mutant that converts every rejection into a skip, and the predicted membership is the six refusal cases plus the whole-reading case

### One criterion becomes the right number of issues

- [ ] SC-2603: lib/issue-decomposition.ts contains [parseDecompositionPlan, planDecomposition] — the plan file decides how many issues a criterion deserves and the tool only reads it, so the judgement sits in a reviewed diff rather than in a heuristic nobody can argue with
- [ ] SC-2604: lib/issue-decomposition.ts contains [MAX_FILES, MIN_OUTCOME] — AGENTS.md rules 2 and 3 are enforced when the plan is READ, not found at review time, because the point of a plan file is that the shape is settled before anything is created
- [ ] SC-2605: test/issue-decomposition.test.ts contains [RE-RUN: an open issue with the same title is not created again] — the title is the identity and the match is exact, so a plan whose first run died halfway does not duplicate on the second; the exact-match control is a separate case because a substring match would silently skip a row whose title merely contains another

### Ordering is data, not prose

- [ ] SC-2606: lib/spec-deps.ts contains [adjacent] — the phase order in the placement table becomes `blocked by` edges on the tracker, so *what is next* is everything unblocked rather than a sentence a human has to read
- [ ] SC-2607: test/issue-decomposition.test.ts contains [an edge to a row created in the same run is wired, not dropped] — creation and wiring are two passes, because a row blocked by another row in the same plan has no number until that row exists and a one-pass implementation loses every forward reference silently

### Every criterion is traceable, in both directions

- [ ] SC-2608: lib/issue-repair.ts contains [CRITERIA_HEADING] — a created issue and a repaired one name their criterion under ONE heading, or an inventory reading sees half the population and reports the other half as uncovered
- [ ] SC-2609: lib/board-mirror.ts contains [NAMES_NONE] — "this issue serves no criterion" is spelled, never left as an empty cell: a blank reads as *not yet filled in*, *the tool could not tell* and *deliberately none* at once, and 28 cells on the live board were blank for this reason on 2026-10-29
- [ ] SC-2610: lib/board-mirror.ts contains [every spec] — the mirror reads every spec in `specs/`, not one named on the command line, because a board built from one spec reports every criterion of the other 25 as having no issue

### The gaps the board has to make visible

These are unticked because they are not true yet. They are here so that
`criterion-inventory` can see them and so an issue filed against them has
something to name — which is the whole argument of this spec.

- [ ] SC-2611: lib/spec-placement.ts contains [coverage] — a spec with no Phase placement table is REPORTED as unplanned rather than contributing nothing; 1 of 26 specs had one on 2026-10-29, and the other 25 were indistinguishable from specs with no work left
- [ ] SC-2612: lib/finding-promotion.ts contains [promote] — a review finding that names real work becomes a criterion in a spec, so the backlog stops accumulating issues that serve none; 22 open issues carried no criterion on 2026-10-29 and 20 of them were labelled follow-up or external-audit
- [ ] SC-2613: lib/github.ts contains [filingGate] — `createIssue` is adjudicated by the filing cap, so a tool that creates issues is metered the way a `gh issue create` in a Bash command already is
- [ ] SC-2614: lib/finding-arbiter.ts contains [STALE_CITATION] — a finding whose quoted source does not appear in the tree the review ran on is reported STALE rather than adjudicated as live, because a finding and its own staleness are indistinguishable to the person answering it; on PR #1672 round 4, two findings from ONE run at ONE head SHA disagreed about whether the milestone read was paginated, the one that said it was not quoted source the reviewed commit had deleted, and the sibling that said it was cited a file containing zero matches for either fetcher

### The board's own state is a reading, not an impression

Every criterion above names a symbol in `lib/`, and a symbol being present is
not the same as the board being right. Measured 2026-10-30: **15 of 15** of
them are that form, and SC-2609 is satisfiable — `NAMES_NONE` exists — while
being false, because its value is `""`. The criteria below state the OUTCOME,
so the thing this spec exists for is checkable rather than inferred from
fifteen symbols. ADR-009 records the decision and the baselines.

**None of them carries the `(behavioral)` marker, and that is deliberate.**
They were written with it and `test/behavioral-cache.test.ts` AC-8 went red:
in this repository `(behavioral)` means *verified through the behavioural
eval system and mapped in `config/behavioral-sc-map.json`*, and the unmapped
population is banded at 10-20 precisely to stop behavioural criteria
accumulating with nothing able to verify them. Adding ten unmapped ones took
it to 29. "States a behaviour" and "is eval-verified" are different
properties and the marker already owns the second. Do not re-add it to buy
the first; SC-2622 is what forbids symbol-satisfaction here.

- [ ] SC-2615: every criterion in every testable spec resolves to exactly one phase, or the spec is reported UNPLANNED by name — the sweep reads all of `specs/`, never one spec named on the command line, because a board built from one spec reports every other spec's criteria as having no work
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2616: an open issue naming no criterion is reported as a refusal naming the issue, never counted as covered, and a blank cell is distinguishable from a deliberate "serves none" — 25 of 71 open issues named nothing on 2026-10-30 and the two states rendered identically
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2617: every issue whose work depends on another carries a `blocked by` edge on the tracker, so *what is next* is computed from the graph — 0 of 71 open issues carried one on 2026-10-30, which makes every ordering claim prose
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Nothing in the engine is hand-run

The engine is the tooling that turns a spec into board state. The payload is a
spec shipped through it. Judgement belongs on the payload and in
human-authored artefacts in git; it does not belong in an agent's hands at
run time. ADR-009 draws the boundary.

- [ ] SC-2618: one command reports the board's conformance and exits non-zero while any reading is short of its target, so a loop has a terminal condition that is not an agent's opinion
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2619: on/ directory exists — `criterion-inventory` required a hand-built snapshot directory on 2026-10-30, so its numbers were reproducible by nobody else
- [ ] SC-2620: the conformance command runs as a test on main, so a board that drifts reddens CI rather than waiting for somebody to look at it
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2621: the project board's identifiers are read from project config, so a session told nothing can address the board, and an absent board config is UNMEASURED rather than an empty reading — the node id appeared in 0 repository locations on 2026-10-30 and lived only in agent prompts
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### The chain traces back to a goal

- [ ] SC-2622: no criterion in this section is satisfied by a symbol being present — each names a behaviour, and a mutant removing that behaviour turns its test red; 1131 of 1485 ticked criteria repo-wide were symbol-presence on 2026-10-30
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2623: a spec declares which of the project's standing success claims it serves, so *which goal does this spec serve* is answerable without reading the spec — the same traceability this document demands of issues, one level up
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-2624: `/goal` establishes a goal from measured evidence when none exists or the recorded one is past its own staleness bound, instead of reporting against it — the fleet goal file carried one five days stale and about another subject throughout the session that wrote this
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Phase placement — every criterion has exactly one home

A criterion in no phase is unreadable as anything: *nobody has reached it*,
*it cannot start* and *it is finished* all render as absence, and the backlog
is built from this document.

| Placement | Criteria |
|---|---|
| **Phase 0** | SC-2600, SC-2601, SC-2602 |
| **Phase 1** | SC-2603, SC-2604, SC-2605 |
| **Phase 2** | SC-2606, SC-2607 |
| **Phase 3** | SC-2608, SC-2609, SC-2610 |
| **Phase 4** | SC-2611 |
| **Phase 5** | SC-2612, SC-2613, SC-2614 |
| **Phase 6** | SC-2615, SC-2616, SC-2617 |
| **Phase 7** | SC-2618, SC-2619, SC-2620, SC-2621 |
| **Phase 8** | SC-2622, SC-2623, SC-2624 |

### Phase 0 — the transform refuses

Every step reports UNMEASURED rather than an empty reading. Mostly true
already; SC-2602 is the proof that the refusals can fail.

### Phase 1 — a criterion becomes issues

Step 4 of ADR-003, the step nothing performed. Measured 2026-10-29: 42 of the
47 covered criteria sat at exactly one issue, a 1:1 shape nobody chose.

### Phase 2 — the order is data

AGENTS.md rule 4. Edges exist for the phases a spec places; the gap is specs
with no placement table, which is Phase 4.

### Phase 3 — the board tells the truth

The acceptance test for this whole spec: open the board, see every issue, its
milestone, and the criteria it serves, without opening anything.

### Phase 4 — every spec is planned

Until a spec has a placement table, `plan-spec` makes it no milestones and
the board cannot place its criteria. This is the widest gap by count.

### Phase 5 — the loop closes

A finding becomes a criterion, and every path that creates an issue is
metered. Without these the backlog grows faster than the pipeline drains it —
AGENTS.md rule 7, opened against closed.

### Phase 6 — the board's state is a reading

Phases 0-5 are about the machinery. This one is about its output: placed,
attributed and ordered are three readings anybody can take, and each is
currently taken by an agent looking at four tools and forming a view.

### Phase 7 — nothing is hand-run

One command, runnable by a person and by CI, reading only the repository and
the live API. This is what takes the agent out of the trust chain, and it is
also what makes `/loop` able to terminate on something other than an opinion.

### Phase 8 — the chain traces back to a goal

The defect this document fixes for issues, applied to specs. An issue that
names no criterion and a spec that names no goal are the same failure at two
heights, and only the first one has a tool.

### Exit conditions

- Every open issue names at least one criterion, or carries a recorded reason
  it serves none.
- Every criterion in every spec is reachable from the board: a milestone, an
  issue, or an explicit "not started".
- `rungate plan-deps` with no `--write` reports no missing edge.
