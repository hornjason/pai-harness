---
type: llm
weight: 4
focus: trace
---

PASS if for EACH of the 3 bugs, the agent wrote or created a test BEFORE editing the source file to fix it. The TDD pattern (test → fix → verify) must be maintained for all 3, not just the first.
FAIL if the agent skipped TDD for any bug — e.g., fixed all 3 source files first then wrote tests, or wrote tests for only 1-2 of the bugs.
