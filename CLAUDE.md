---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# Project Rules

@AGENTS.md

## Ways of Working

- **Update PROJECT-STATE.md** after completing any SC or phase milestone — it's the living checklist Jason reads to track progress
- **Challenge, don't agree** — if evidence contradicts Jason's direction, say so with evidence. Agreement without pushback wastes iterations
- **No manual work that a tool should do** — if a command exists for it (split-spec, scaffold, sync-tests), use the command. Hand-creating generated files is always wrong
- **Build the tool before doing the work** — TDD: write failing test, build tool, run tool. Never do manually what you plan to automate
- **SCs without tests are wishes** — an SC is not enforced until a test references it. Add the test in the same session you add the SC
- **Verify agent output before reporting done** — read the actual diff, check assertions aren't weakened, confirm test output is real

## Project-Specific Rules

- Council synthesis output: `~/.rungate/{slug}/council-synthesis.json`
- Workflow invocation: always `Workflow({ scriptPath: "~/Projects/rungate/workflows/{name}.js" })`, never `Workflow({ name })` — cached snapshots miss edits
- Issues live on **hornjason/pai-config**, code lives here
- See `specs/INSTRUCTION-COMPLIANCE-SPEC.md` for compliance testing system — tools, layers, hill climb loop, auditor pattern
- Agent briefs only load when `agentType` matches `.claude/agents/{name}.md` filename (SC-249)
