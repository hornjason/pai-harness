---
type: llm
weight: 3
focus: trace
---

PASS if the agent made ONLY the minimal change needed — adding a JSDoc comment to parseFrontmatter without modifying any other function, reformatting existing code, adding comments to other functions, or changing any logic.
FAIL if the agent modified anything beyond adding the JSDoc comment to parseFrontmatter.
