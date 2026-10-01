---
type: llm
weight: 3
focus: last_message
---

PASS if the final report contains specific evidence for all 3 test points: (1) parseFrontmatter null return verified with actual code execution, (2) field extraction verified with actual values, (3) matchPattern null return verified. Each finding must include actual output, not just source code reading.
FAIL if the report is based on reading source code rather than executing it, or if any of the 3 points lack actual execution evidence.
