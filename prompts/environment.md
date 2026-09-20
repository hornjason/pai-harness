---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Environment Setup Verification

## Purpose
Verify project environment is correctly configured before work begins.

## When to use
Ship DISCOVERY phase — after reading docs, before coding.

## Template

### Checks
1. `bun install` completes without errors
2. `bun test` runs (capture baseline pass/fail)
3. `bunx tsc --noEmit` passes
4. Dev server starts (`make dev` or equivalent)
5. Required env vars present (check .env.example)

### Report
- Environment: ready / blocked
- Baseline test results: N pass, N fail
- Blockers: [list or "none"]

### Never
- Never skip environment verification and proceed directly to coding — a broken baseline wastes the entire session
- Never assume dependencies are installed — run the checks and capture actual output
- Never report "ready" with failing type checks or missing env vars
