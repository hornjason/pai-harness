---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Read-Before-Write Protocol

## Purpose
Ensure agents understand code before changing it.

## When to use
Every implementation task — enforced at gate.

## Template

### Rule
Read-to-write ratio >= 3:1 (measured in tokens).

### Protocol
1. Read AGENTS.md and CODE-MAP.md
2. Read every file listed in the brief's Files section
3. Read the governing spec if cited
4. Read every file you plan to change
5. Read files that import/depend on files you'll change
6. Only then: write code

### Gate check
`readTokens / writeTokens >= 3.0` — FAIL if under.

### Never
- Never write code before reading at least 3x the tokens you plan to write — the gate enforces this mechanically
- Never skip reading dependency files that import the files you'll change — downstream breakage from unread dependents is the top failure mode
