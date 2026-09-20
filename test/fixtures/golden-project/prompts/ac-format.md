---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# AC Format Requirements

## Purpose
Standardize acceptance criteria format for mechanical verification.

## When to use
Goal and ship phases — writing and validating ACs.

## Format

### Required fields
1. **Trigger:** What action causes the behavior
2. **Output:** What the system produces
3. **Verify command:** Executable command that proves it works
4. **Exclusions:** What this AC does NOT cover

### Example
```
AC-1 [CODE]: API returns 200 on valid input
  Trigger: POST /api/data with valid JSON body
  Output: 200 response with { success: true }
  Verify: curl -X POST localhost:3000/api/data -d '{"key":"val"}' | jq .success
  Exclusions: Error handling, auth, rate limiting
```

### Garbage test
"Could garbage data pass this AC?" If yes, tighten it.
