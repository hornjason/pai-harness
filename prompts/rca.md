---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Root Cause Analysis

## Purpose
Structured protocol for diagnosing bug root causes before fixing.

## When to use
Marcus brief for bug-fix issues — required RCA section.

## Template

### Fields
- **rootCause:** [one sentence — what specifically is wrong]
- **prediction:** [what will happen if we apply the fix]
- **predictionVerified:** [true/false — did the prediction hold after fix]

### Protocol
1. Reproduce the bug with a minimal case
2. Trace the data flow from input to incorrect output
3. Identify the exact line where behavior diverges from expected
4. State root cause as "X happens because Y at file:line"
5. Predict the fix outcome before implementing
