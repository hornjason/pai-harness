---
doc-type: reference
status: active
owner: jason
updated: 2026-09-22
---

# Project Rules

@AGENTS.md

## MANDATORY GATE — do these steps IN ORDER before any implementation

STOP. Do NOT read source code, edit files, or write code until all 4 steps are done:

1. Run `bun test` — confirm 0 failures. If any fail, fix them first.
   If the guard blocks you because other sessions are running suites, wait or run
   targeted paths — do NOT treat a blocked run as a satisfied gate (#67).
2. Find the governing spec in the Specs table in `.claude/rules/specs-routing.md`. Read it.
3. Use `Skill("ship")` with the issue number — it runs the full pipeline via `workflows/ship.js`. **NEVER spawn Marcus, Quinn, or Rook directly with the Agent tool** — direct spawns bypass compliance grading, gates, and transcript capture.
4. If `Skill("ship")` is unavailable, invoke `Workflow({ scriptPath: "~/Projects/rungate/workflows/ship.js" })` with issue args. See `.claude/rules/ship-workflow.md` for details.

If you skip any step, the session is invalid.

## Rules

- **SUCCESS.md is the measure** — it states what we are building and the five
  falsifiable claims that mean it works. Before filing an issue, reviewing a PR,
  or acting on an audit finding, say which claim it moves. Something that moves
  none of them is cleanup and should say so rather than borrowing urgency.
- **PROJECT-STATE.md at milestones, and the DA writes it** — update after every
  merge, SC, or milestone, and update SUCCESS.md's standing table in the same edit.
  **`project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md` are DA-owned: an
  agent running in a worktree must never write them.** They are a single shared
  state document, so four parallel worktrees each updating their own copy produce
  four conflicting versions — and the collection guard (#178, SC-413) refuses the
  whole run when a worktree reports a file no sub-issue claimed. On 2026-10-11
  that cost run `wf_0b15a933-b2b` four worktrees and 2,565 lines of correct,
  validated work, because one agent read this line and did what it said. If you
  are an agent and think one of these files needs updating, say so in your
  findings as prose and let the DA write it. See #296.
- **SCs without tests are wishes** — add the test in the same session you add the SC.

## Project-Specific References

- Council synthesis output: `~/.rungate/{slug}/council-synthesis.json`
- Workflow invocation: always `Workflow({ scriptPath: "~/Projects/rungate/workflows/{name}.js" })`, never `Workflow({ name })` — cached snapshots miss edits
- Issues and code both live on **hornjason/pai-harness** (this repo)
- See `specs/INSTRUCTION-COMPLIANCE-SPEC.md` for compliance testing system
- Agent briefs only load when `agentType` matches `.claude/agents/{name}.md` filename (SC-249)
