---
doc-type: adr
status: accepted
created: 2026-10-30
updated: 2026-10-30
---

# ADR-009 — the engine, the payload, and the order they are built in

## Status

Accepted, 2026-10-30. Jason's call, in a session that took about an hour of
question-and-answer to reach. **This document exists so that hour is never
spent again**, which is also the argument it makes about everything else:
knowledge that lives only in a conversation is knowledge the next session
does not have.

## Context

### The chain has a broken first link

The project's intended flow is *goal → spec → criteria → milestones → issues
→ board → work*. Measured on `origin/main` at `eae12e11`:

- `SUCCESS.md` holds **six** falsifiable claims. **None of them is about the
  board, the backlog or the tracker.** A grep for all three returns nothing in
  any claim. So the goal that drives the current work was written down
  nowhere, and no spec could name which claim it serves.
- `FLEET-STATE.md` — the file `/goal` reads — carried a goal set
  **2026-10-25** about making `COMMENT_INSTEAD` unwaivable. Five days stale and
  about a different subject. By that file's measure, every hour of this work
  was off-goal, and nothing reported it.

That is the same defect the spec-to-board pipeline exists to fix, one level
up. Issues did not name a criterion, so the pipeline was built. **Specs do not
name a goal, and nothing was built.**

### Most "done" ticks prove only that a name exists

Measured across `specs/` on 2026-10-30:

```
1131 of 1485 ticked criteria are the form `<file> contains [<symbol>]`
  15 of   15 criteria in SPEC-TO-BOARD-PIPELINE-SPEC.md are that form
```

They are satisfied by a name being present in a file, not by the behaviour
working. The live proof is SC-2609, which requires `lib/board-mirror.ts` to
contain `NAMES_NONE`. It does, and its declaration reads
`export const NAMES_NONE = ""` — an empty string, returned whenever an issue
names no criterion. The criterion is satisfiable. The thing it exists to guarantee — that *this
issue serves no criterion* is spelled out rather than left blank — is false.
This is the mechanism by which a plan reads as implemented when it is a
collection of parts.

### A fresh session cannot address the board

A grep across every `.md`, `.json` and `.ts` in the repository for the project
board's node id returns **nothing**. `board-mirror` requires
`--project <node-id>` on the command line, and `config.project` is the string
`"rungate"` — a slug, not a board. Every board command run on 2026-10-29 and
2026-10-30 worked because the id was in an agent's prompt, which does not
outlive the session.

### Two kinds of work were being treated as one

The machinery that turns a spec into a board, and the specs that are shipped
*through* that machinery, are different work with different review rules. They
had no stated boundary, and ADR-008 ran the pipeline against the pipeline's own
spec — a legitimate self-test that also blurred the distinction.

## The decision

### 1. The engine and the payload are two sites

| | What it is | Who reviews it |
|---|---|---|
| **Engine** | The tooling that turns a spec into milestones, issues, blocked-by edges and board state | Nobody by hand. It is checked by a command |
| **Payload** | A spec shipped *through* the engine. `CODE-REVIEW-CONVERGENCE-SPEC.md` is the first real one | Jason |

Human judgement belongs on the payload and in human-authored artefacts in git
— a phase placement table, an issue plan. It does not belong in the engine's
operation. **The engine's acceptance test is that the convergence spec ships
through it with no agent touching anything.**

### 2. Nothing in the engine is hand-run

Every step takes its input from the repository or from the live API. No step
reads a file an agent assembled. One command reports whether the board is
right, and that command runs on main.

This is narrower than "no human input". A placement table is written by a
person in a reviewed diff and that is the design — *a human-authored artefact
in git → a deterministic transform → live state*, per
`specs/SPEC-TO-BOARD-PIPELINE-SPEC.md`. What is forbidden is an **agent** being
the transform, or an agent assembling the input, or an agent being the thing
that decides the result is good.

### 3. Three goals in sequence, not one

`/goal` holds exactly one current goal; a new one demotes the previous. A goal
spanning all the work below stays technically "served" by almost any commit for
weeks, which makes the drift test useless — and the drift test is the only
instrument that catches partial work being reported as whole.

| | Goal | Done when |
|---|---|---|
| **1** | The engine's own work is on the board and measurable | The conformance command runs, and the engine backlog can be worked off the board without asking an agent what is next |
| **2** | The engine works | The conformance command exits 0 |
| **3** | It generalises | The convergence spec ships through the engine untouched |

Goal 1 is first because it proves the method in days rather than weeks. If the
board does not read the way it is meant to after Goal 1, little has been spent.

### 4. Each artefact has one role, and work comes off the board

You do not build from an ADR. `AGENTS.md` rule 1 already says a spec is never
the to-do list either. Four artefacts, four roles:

| Artefact | Holds | Read when |
|---|---|---|
| **ADR** (this file) | Why we decided | When the reasoning is in question |
| **Spec** | What must be true — criteria | Before changing that area |
| **Board** | The work: milestones, issues, blocked-by edges | Every session, to pick up work |
| **`project-state.json`** | Where we are now, and the measured baselines | Session start |

The plan's durable form is **the board**. A plan in a document goes stale and
nobody notices — `FLEET-STATE.md` proved that over five days, and four of the
six ADRs preceding this one are `Proposed` and drive nothing.

### 5. The build order — six stages

Stage A is documents and must be reviewed by Jason, because its output is
specs. Everything after is engine machinery and by rule 2 above should not
need him.

| | Stage | In one line |
|---|---|---|
| **A** | Write it down | The goal and the engine spec exist and say the right things |
| **B** | Build the engine's own board | The engine spec becomes milestones, issues and edges — a real backlog to work from |
| **C** | Build the missing behaviour | The things the engine spec names that do not exist or are false |
| **D** | Remove the agent from the loop | One command, runnable by Jason, that says whether the board is right |
| **E** | Place the rest of the specs | The other specs get placement tables and reach the board |
| **F** | Ship the payload | Convergence goes through the engine untouched |

**The engine's own board is built in Stage B, not at the end.** Doing it last
means the engine work itself has no backlog, and an agent builds it from
memory — which is the defect this whole document is about.

**The conformance command's skeleton is built in Stage B, not Stage D.** It
reports the readings and exits non-zero while any is short, long before the
behaviour it measures exists. Without it `/loop` has no terminal condition but
an agent's opinion, and that is the thing being removed.

## Baselines — measured 2026-10-30 on `origin/main` at `eae12e11`

Recorded so a later reading can tell whether anything moved. Every number came
from a command run that day, not from recall.

| Reading | Value |
|---|---|
| Criteria in `SPEC-TO-BOARD-PIPELINE-SPEC.md` | 15 |
| …proved by a test naming the id | 1 |
| …satisfied by a symbol being present | 15 |
| Top-level specs in `specs/` | 27 |
| …carrying a Phase placement table | 2 |
| Open issues on `hornjason/rungate` | 71 |
| …naming a criterion | 46 |
| …carrying a blocked-by edge | 0 |
| Ticked criteria repo-wide | 1485 |
| …satisfied by a symbol being present | 1131 |
| Claims in `SUCCESS.md` naming the board, backlog or tracker | 0 |
| Repository locations recording the project board's node id | 0 |

## Consequences

- **`SUCCESS.md` gains a claim for this goal.** Without it, no spec can name
  what it serves, and the first link stays broken.
- **The board's identifiers move into `.claude/rungate/config.json`**, so any
  session or tool can address the board without being told. This is also what
  makes the engine portable to a repository that is not this one —
  `SUCCESS.md` claim 5, never attempted.
- **New criteria in this area may not be satisfied by a symbol's presence.**
  Each names a behaviour and carries a test that goes red when the behaviour is
  removed. This does not retroactively condemn the other 1131; it stops the
  count growing where we are looking.
- **`/goal` gains an establish-from-evidence mode.** Today it reports drift
  against a goal that already exists and its measurement commands are hardcoded
  to the convergence goal and to `hornjason/pai-harness`, the pre-rename name.
  Pointing it at the conformance command makes it generic and stops it going
  stale whenever the target changes.
- **A blocker gets three attempts, then a change of method** — research, a
  second opinion, a different route — before it is logged and left. Recorded as
  a standing rule in `AGENTS.md`, because it governs every agent and is not
  specific to this plan.
- **This ADR is `accepted`, not `proposed`.** Six of the eight before it are
  `proposed` — ADR-001 through ADR-006; only 007 and 008 are accepted — and
  nothing acts on any of them. A proposed ADR is this
  repository's documented way of writing something down and having nothing
  happen.

## What this does not decide

- **What a good criterion says** — `specs/SPEC-AUTHORING-SPEC.md`.
- **Whether a review finding is real** — `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`.
- **The filing cap** — `docs/adr/ADR-007-filing-cap-plan-route.md`.
- **Whether an issue with no criterion is a defect** —
  `docs/adr/ADR-006-machinery-issue-classification.md` says some legitimately
  serve none, and that the repair they need is for *serves none* to be sayable.
  That is SC-2609, and it is false today.
