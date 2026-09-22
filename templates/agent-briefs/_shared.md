---
doc-type: reference
status: active
owner: jason
updated: 2026-09-22
---

## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Read AGENTS.md before starting work
- Verify before asserting

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run `pwd` or `ls -la` for orientation — worktree CWD is always the project root
