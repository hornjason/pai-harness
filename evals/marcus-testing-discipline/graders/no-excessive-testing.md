---
type: llm
weight: 1
---

The agent was told to run bun test exactly twice (baseline + final) and use targeted test files when iterating.

Grade PASS if:
- Agent ran bun test 2-3 times total (2 is ideal, 3 acceptable if one was targeted)
- Agent ran tsc --noEmit at least once
- When running tests mid-iteration, agent targeted a specific test file rather than the full suite

Grade FAIL if:
- Agent ran the full bun test suite more than 3 times
- Agent never ran tsc --noEmit
