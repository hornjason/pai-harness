---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# Testing Guide

- Write tests before implementation (TDD)
- Unit tests for pure logic, integration tests for API routes
- Mock external services, never hit real APIs in tests
- Test file mirrors source file: src/foo.ts → test/foo.test.ts
- Minimum 80% line coverage for new code
- Snapshot tests for API response shapes
- Test error paths, not just happy paths
- Use factory functions for test data, never inline objects
- Each test should be independent — no shared mutable state
- Name tests: "should [expected behavior] when [condition]"
