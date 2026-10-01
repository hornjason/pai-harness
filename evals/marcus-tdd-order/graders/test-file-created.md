---
type: llm
weight: 2
focus: trace
---

PASS if the agent wrote a test file (containing expect/test/describe) BEFORE editing lib/conformity.ts to add the multiply function.
FAIL if the agent edited lib/conformity.ts first and wrote the test second, or if no test was written at all.
