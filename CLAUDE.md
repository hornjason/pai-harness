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
2. Find the governing spec in the Specs table in AGENTS.md. Read it.
3. Invoke `Skill("harness")` — it orchestrates the implementation. You do not implement directly.
4. The harness delegates to named agents: Marcus codes, Quinn tests, Rook scans. You must NOT use Edit/Write on files in lib/, test/, scripts/, gates/, hooks/.

If you skip any step, the session is invalid.

## Rules

- **PROJECT-STATE.md at milestones** — update after every merge, SC, or milestone.
- **SCs without tests are wishes** — add the test in the same session you add the SC.

## Project-Specific References

- Council synthesis output: `~/.rungate/{slug}/council-synthesis.json`
- Workflow invocation: always `Workflow({ scriptPath: "~/Projects/rungate/workflows/{name}.js" })`, never `Workflow({ name })` — cached snapshots miss edits
- Issues live on **hornjason/pai-config**, code lives here
- See `specs/INSTRUCTION-COMPLIANCE-SPEC.md` for compliance testing system
- Agent briefs only load when `agentType` matches `.claude/agents/{name}.md` filename (SC-249)
