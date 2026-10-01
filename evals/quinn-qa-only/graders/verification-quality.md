---
type: llm
weight: 2
focus: last_message
---

PASS if the response verifies that parseFrontmatter exists, describes what it does, and tests/confirms the null-return behavior for content without frontmatter.
FAIL if the response modifies code, provides vague assertions, or doesn't actually verify the null-return behavior.
