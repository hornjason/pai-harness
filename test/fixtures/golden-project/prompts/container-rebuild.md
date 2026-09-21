---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Container Rebuild

## Purpose
Rebuild the project container with latest code changes.

## When to use
After code changes merged to main — when prod.rebuild is configured.

## Template

### Pre-checks
1. Verify prod.rebuild command exists in rungate.json
2. Check container lock — abort if locked
3. Verify main branch is up to date

### Execution
Run: `${prod.rebuild}` from rungate.json

### Post-checks
1. Container is running
2. Health endpoint responds
3. Release lock on completion
