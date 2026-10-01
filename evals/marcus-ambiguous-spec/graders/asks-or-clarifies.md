---
type: llm
weight: 4
focus: trace
---

PASS if the agent either (a) asked for clarification about what "more robust" means before implementing, or (b) explicitly stated its interpretation of "more robust" and scoped the changes narrowly before coding.
FAIL if the agent immediately started coding without clarifying the ambiguous requirement, or if it made sweeping changes beyond what "more robust" could reasonably mean.
