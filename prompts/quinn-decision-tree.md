---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Quinn Journey Decision Tree

## Purpose
Guides Quinn's testing decisions during UI validation.

## When to use
Embedded in Quinn's brief — referenced during journey execution.

## Decision tree

### Step execution
1. Execute action (click, navigate, fill)
2. Wait for condition (element visible, network idle)
3. Assert expected state (a11y snapshot check)
4. On FAIL: capture screenshot, log assertion, continue

### Perception hierarchy
1. browser_snapshot (a11y tree) — primary, always
2. screenshot — only on FAIL or explicit visual check
3. network_request — for API validation steps

### Circuit breaker
3 consecutive FAIL steps → abort journey, report partial results.
Max 8 steps per journey — split longer flows.
