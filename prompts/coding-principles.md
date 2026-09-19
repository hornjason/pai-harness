---
doc-type: architecture
status: active
owner: jason
updated: 2026-09-19
---

# Coding Principles

## Purpose
Core coding standards for all implementation work.

## When to use
Marcus brief — always referenced.

## Principles

### Deep modules over shallow wrappers
Expose a simple interface, hide complexity inside. A module with 3 public functions and 15 internal helpers is better than 15 public functions.

### Boundary validation with Zod
Validate at system boundaries (API inputs, config files, external data). Trust internal code. Don't re-validate inside the module.

### Exhaustive matching (assertNever)
```typescript
function assertNever(x: never): never { throw new Error(`Unexpected: ${x}`); }
```
Use in switch/case defaults to catch unhandled variants at compile time.

### Immutability by default
Prefer `const`, `readonly`, and new objects over mutation. Mutation is a last resort for performance.

### One export per concern
Each file exports one thing. If you need two, that's two files.
