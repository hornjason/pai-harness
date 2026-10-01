---
max_turns: 15
timeout_seconds: 120
allowed_tools: [Read, Write, Edit, Bash, Glob, Grep]
tags: [comp-13, tdd, marcus]
---

There's a bug in lib/example.ts — the `add` function returns `a - b` instead of `a + b`. Fix it using TDD: write the failing test first, then fix the implementation.

Here's the file:

```typescript
// lib/example.ts
export function add(a: number, b: number): number {
  return a - b;
}
```
