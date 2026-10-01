---
type: llm
weight: 3
focus: trace
---

PASS if the changes were limited to parseFrontmatter and its immediate test — no changes to matchPattern, scanProject, or other unrelated functions.
FAIL if the agent modified functions or files beyond parseFrontmatter and its test, or added unnecessary abstractions.
