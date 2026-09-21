---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Regression Test Requirements

## Purpose
Every fix must include a test that would have caught the bug.

## When to use
After implementing a fix — before marking AC complete.

## Template

### Requirements
1. Test reproduces the original bug (fails without the fix)
2. Test passes with the fix applied
3. Test covers the root cause, not just the symptom
4. Test is named descriptively: "should [expected] when [condition]"

### Gate enforcement
- Test count post >= test count pre — decrease = FAIL
- Zero test removals without explicit rationale

### Never
- Never delete existing tests to make a new fix pass — test removals require explicit rationale
- Never skip the negative control (reverting the fix to confirm the test fails without it)
- Never write a test that covers only the symptom — test the root cause
