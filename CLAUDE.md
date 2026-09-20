---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# Project Rules

@AGENTS.md

## Project-Specific Rules

- Council synthesis output: `~/.rungate/{slug}/council-synthesis.json`
- Workflow invocation: always `Workflow({ scriptPath: "~/Projects/rungate/workflows/{name}.js" })`, never `Workflow({ name })` — cached snapshots miss edits
- Issues live on **hornjason/pai-config**, code lives here
- See `specs/INSTRUCTION-COMPLIANCE-SPEC.md` for compliance testing system — tools, layers, hill climb loop, auditor pattern
- Agent briefs only load when `agentType` matches `.claude/agents/{name}.md` filename (SC-249)
