---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Blast Radius Assessment

## Purpose
Ensure every code change is scoped and its impact is understood.

## When to use
Marcus brief — pre-implementation checklist.

## Template

### Rule
filesRead >= filesChanged — you must read more than you change.

### Checklist
1. List every file you will change
2. List every file that imports/depends on changed files
3. Read all dependent files before changing anything
4. If filesChanged > filesRead, stop and read more

### Gate enforcement
- Read-before-write ratio >= 3:1 (read tokens / write tokens)
- Files changed outside brief's listed files = WARN

### Never
- Never change files not listed in the brief without explicit scope expansion approval
- Never skip reading dependent files before modifying their imports — downstream breakage is the most common blast-radius failure
- Never proceed when filesChanged > filesRead — stop and read more
