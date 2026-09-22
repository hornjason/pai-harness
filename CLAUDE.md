---
doc-type: reference
status: active
owner: jason
updated: 2026-09-22
---

# Project Rules

@AGENTS.md

## Rules (6 — RunGate project-specific)

1. **All implementation goes through the harness** — Skill("harness") for any implementing, fixing, shipping. Never raw Agent() calls. Never ad-hoc prompts. The harness IS the quality loop. No exceptions.
2. **Delegate by name through briefedAgent()** — Marcus codes, Quinn tests, Rook scans, Serena architects, Aditi designs. DA must NOT Edit/Write files in lib/, test/, scripts/, gates/, hooks/. All agents launch through briefedAgent(), never raw Agent().
3. **Read governing spec before any work** — check the Specs table in AGENTS.md. Read the governing spec for the area you are changing. No spec found = ask Jason.
4. **Clean suite before new work** — run bun test before starting any implementation. 0 fail required. Fix failures first. Broken tests mask regressions.
5. **PROJECT-STATE.md at milestones** — update after every merge, SC completion, or milestone. Test: if I restart right now, does it tell the next session everything?
6. **SCs without tests are wishes** — add the test in the same session you add the SC.

## Project-Specific References

- Council synthesis output: `~/.rungate/{slug}/council-synthesis.json`
- Workflow invocation: always `Workflow({ scriptPath: "~/Projects/rungate/workflows/{name}.js" })`, never `Workflow({ name })` — cached snapshots miss edits
- Issues live on **hornjason/pai-config**, code lives here
- See `specs/INSTRUCTION-COMPLIANCE-SPEC.md` for compliance testing system
- Agent briefs only load when `agentType` matches `.claude/agents/{name}.md` filename (SC-249)
