---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Testing Strategy

## Purpose
Testing standards for AI-authored code.

## When to use
Marcus brief — always referenced.

## Principles

### Inverted pyramid
More integration tests, fewer unit tests. Integration tests catch real bugs; unit tests catch refactoring noise.

### Tautological testing trap
Never test "does the code produce what the code produces." Test "does the code produce what the spec says." Auto-generated expected output is a tautology.

### Contract tests for shared interfaces
Any module with 3+ importers needs a contract test. The test verifies the interface, not the implementation.

### Boundary testing
- Horizontal: test across module boundaries (A calls B)
- Vertical: test at system boundaries (API input/output)

### Test evidence per AC type
- CODE AC: test output with assertion
- UI AC: browser snapshot with check
- BUG-FIX AC: negative control (revert + reproduce)
