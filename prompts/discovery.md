---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Discovery

## Purpose
Read project docs in order to build context before implementation.

## When to use
DISCOVERY phase of ship cycle — before writing any code.

## Template

### Read order
1. AGENTS.md — project identity, constraints, commands
2. CODE-MAP.md — modules, routes, dependencies
3. Governing spec (if cited in issue)
4. Related files from issue context

### Output
- Key constraints discovered
- Files that will be touched
- Risks or unknowns to flag

### Never
- Never write code before completing the discovery read list — implementation without context produces scope violations
- Never skip reading AGENTS.md — it contains project identity, constraints, and commands that govern all work
