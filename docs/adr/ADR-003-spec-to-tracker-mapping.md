---
doc-type: adr
status: superseded
created: 2026-10-28
updated: 2026-10-31
owner: jason
governs: how a spec's criteria reach the tracker — phase placement, milestones, and the issue-to-criterion citation
---

# ADR-003: How a spec becomes trackable work

## Status

**Superseded by `specs/SPEC-TO-BOARD-PIPELINE-SPEC.md` on 2026-10-31.** This
ADR states 0 criteria of its own; the pipeline spec states 25 covering the
same subject — how a spec's criteria reach the tracker as milestones, issues
and blocked-by edges. The content moved, so this is superseded rather than
accepted, per the A7 rule recorded in project-state Priority 2.

ADR-009 names the pipeline spec as the engine's governing document.

**Deciders:** Jason (owner), Rayford (DA)
**Trigger:** The board could not say what was done, in progress or next, and the
reason was structural: 251 criteria were unticked across 23 specs and **six**
were named by an open issue. The tracker and the specs were two disconnected
systems, and no board configuration can join them.

## The question this answers

*How do we map out a spec, break it into milestones, and know which criteria a
milestone's issues serve?*

Not for convergence alone. There are 23 specs and this will happen 22 more
times.

## Decision

**A criterion is placed in the spec. A milestone is derived from that placement.
An issue carries the milestone and names its criteria.** Three steps, each with
exactly one decider.

### 1. Place every criterion, in the spec, in exactly one home

A table in the spec itself, one row per placement, listing the criteria in it.
The value set is closed and **not every value is a phase** — forcing work that
cannot start into a numbered phase states a plan that is a lie:

| Kind of value | Example | What it means |
|---|---|---|
| a phase | `Phase 1 — stop the repeats` | ordered work |
| `Done` | | ticked and bound |
| `Blocked — <what is missing>` | `needs a second person` | cannot start, and why |
| `Not observable here` | | this repository cannot read the answer |
| `Not adopted — deliberate` | | we decided against it, and the spec says when to revisit |

**The non-phase values are where this goes wrong, and it did.** The first
draft of the convergence table put CRC-M8 in Phase 5, which reads as *pending
work*. The document elsewhere says its order is inverted **on purpose**, with
an unrelated revisit condition — so the placement invented a second condition
for when the criterion is satisfied. A reviewer caught it on #1647. When a
criterion is tempting to file under a phase, check what the rest of the
document already says about it before writing the row.

**A test refuses any criterion that is missing from the table, listed twice, or
listed under a value outside that set.** Without it the table is prose and
drifts; `test/code-review-convergence-spec.test.ts` is the worked example, and
it was proved able to fail in both directions before it was trusted.

### 2. One milestone per phase, named from the phase heading

Milestones are created only for the values that are phases. Not for `Done`,
`Blocked` or `Not observable here` — those are states, and giving them a
milestone would put work that cannot start into a lane that looks like a queue.

The name is `<Spec> <phase heading>`, so the mapping needs no second table.

**Why a milestone and not a label or a project field** — all three were tried on
2026-10-28 and the other two were measured to fail:

- **A Projects custom field is invisible to the agents that do the work.**
  `gh issue list --json projectItems` returned Status and nothing else for
  #1592, which had two custom fields set. Agents read the tracker through `gh`;
  anything they must act on cannot live in a project field.
- **A label cannot be a board swimlane.** It is absent from the Group by menu.
  Worse, nothing stops an issue carrying two phase labels, and three issues
  did within minutes of the migration, because one of the labels already
  existed as a priority flag.
- **A milestone is a single value in GitHub's schema, not a list.** *One phase
  per issue* becomes impossible to violate rather than something a check has to
  police. It is also groupable, agent-readable via `--milestone`, and carries
  open/closed counts for free.

### 3. The issue names the criteria it serves — downstream to upstream

The issue body declares which criteria the work is for. The spec does **not**
list issue numbers.

This direction is not a preference. A list of issue numbers inside a spec is
updated by nobody when an issue closes, and the requirements-engineering
literature has a name for the result — *traceability decay*, where unmaintained
links come to represent false dependencies. The upstream artefact declares what
coverage it **needs**; downstream artefacts declare what they **provide**.

`.claude/rules/claiming-sc-coverage.md` already draws the line between a
declaring position and a mid-sentence mention, for tests. The same rule applies
to an issue body, one layer up.

**A tick still comes from a test naming the id, never from an issue.** An issue
says what is being attempted; only a test says what is true.

### Cardinality — many to many, with one hard constraint

Criteria and issues do **not** pair off, and neither direction is one:

- **A criterion usually needs several issues.** Measured on the convergence
  spec: CRC-M11 is named by 7, CRC-B4 by 6, CRC-N4 by 5. A criterion is a
  statement about the finished system; getting there is several pieces of work.
- **An issue usually serves several criteria.** #1507 names six, #1509 five.
  This is the direction that keeps the backlog finite — 41 uncovered criteria
  is roughly 15 issues, not 41. One issue per criterion is a named
  anti-pattern (chunking a requirements document into tickets) and would push
  the opened-against-closed ratio past 1.

**The constraint many-to-many creates: a milestone is single-valued, so an
issue must serve criteria from ONE phase.** If a piece of work genuinely spans
two phases it is two issues — which is also what rule 3 of `AGENTS.md` wants,
since cross-phase work is the shape that spreads across many files.

## What this gives you

```bash
# every open issue in a phase
gh issue list --label spec:convergence --milestone "Convergence Phase 1 — stop the repeats" --state open

# every criterion, with the tests, issues and PRs that touch it
bun scripts/criterion-inventory.ts --snapshot <dir> --spec specs/<SPEC>.md
```

## Status, honestly

Steps 1 and 2 are done for `CODE-REVIEW-CONVERGENCE-SPEC.md`: 61 criteria
placed, zero unplaced and zero double-placed.

**Milestones: seven derived, one not.** The placement table has exactly seven
phase values, Phase 0 through Phase 6, so the rule above produces seven
milestones and `rungate plan-spec` creates seven. The repository holds an
eighth, `Convergence Machinery`, which no phase row derives; `plan-spec`
reports it as **unmanaged** and does not touch it. An earlier draft of this
section said "8 milestones" and was caught by a reviewer on #1647 across three
rounds — the count was right about the repository and wrong about the rule, and
a number that cannot be derived from the rule it illustrates is the drift this
whole ADR is about.

**Step 3 is the gap and it is the largest one.** Measured 2026-10-29 with
`bun bin/rungate.ts plan-spec specs/CODE-REVIEW-CONVERGENCE-SPEC.md --repo
hornjason/rungate --prefix Convergence`: of the 44 criteria the table places in
a phase, **36 are named by no open issue**. Against the whole tracker,
`gh issue list --state open` returns 49 and **14 name any criterion id**. Until
that closes, the inventory above is a report about a sparse graph rather than a
trace.

## What is deliberately not decided here

- **Whether to enforce step 3 with a gate.** Plenty of real work is machinery
  that serves no criterion, and a gate that refuses it would be wrong most of
  the time it fired. Recorded as open.
- **Sub-issue parents as the phase layer.** The mechanism fits — `gh` exposes
  `parent` and `subIssuesSummary`, children inherit the parent's project, the
  cap is 100 per parent. It needs one new issue per phase, which the finding
  arbiter's one-per-24-hours cap refuses, so it is blocked behind a separate
  decision rather than rejected.
- **Whether `criterion-inventory.ts` output gets committed.** It is wired into
  nothing today: no gate, no board, no CI. A command nobody runs is the failure
  mode this repository keeps writing rules about, and that is an argument for
  committing a dated artefact — but it is not made here.
