---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Prevention-Oriented Fixes

## Purpose
Fix the bug class, not just the instance.

## When to use
After identifying root cause — before implementing the fix.

## Template

### Checklist
1. **Guard at boundary:** Add validation where bad data enters
2. **Type narrowing:** Use TypeScript types to make the bug unrepresentable
3. **Pattern audit:** grep for the same bug pattern in sibling files
4. **Regression test:** Write a test that would have caught this bug

### Example
Bad: `if (x) doThing(x)` — fixes one caller
Good: `function doThing(x: NonNullable<T>)` — prevents all callers
