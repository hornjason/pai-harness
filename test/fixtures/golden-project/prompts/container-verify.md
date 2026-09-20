---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Container Verification

## Purpose
Verify the container is running correctly after a rebuild.

## When to use
After container-rebuild completes — before declaring deploy success.

## Template

### Verification steps
1. Container status: running
2. Health endpoint: `curl ${prod.apiBase}/api/health`
3. Version check: container HEAD matches expected commit SHA
4. Smoke test: hit 2-3 critical endpoints

### Report
- Status: verified / failed
- Container HEAD: {sha}
- Health: {response}
- Failures: [list or "none"]
