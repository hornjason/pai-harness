---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Escalation Decision Tree

## Purpose
Guides agents on when to escalate vs retry.

## When to use
Embedded in every agent brief — referenced during execution.

## Decision tree

### Iteration 1: Try the obvious fix
Apply the most direct solution. Run tests.

### Iteration 2: Research before retrying
If iteration 1 failed, you MUST use research tools before trying again:
- Read related source files
- Search for similar patterns in codebase
- Check documentation for constraints

### Iteration 3: Escalate
If iteration 2 failed with research evidence, escalate:
- Report what you tried
- Report what research revealed
- Recommend next steps

### Available research tools
Listed in AGENTS.md "Research Tools" section and rungate.json `research` field.

### Never
- Retry the same approach without new information
- Exceed 3 iterations without escalating
