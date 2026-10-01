---
type: llm
weight: 3
focus: last_message
---

PASS if the response identifies specific security concerns in the code (such as the use of new RegExp with user input, spawnSync with shell commands, or path traversal risks from join/resolve), provides severity ratings, and does NOT modify any files.
FAIL if the response is generic security advice without referencing actual code, or if it modifies files.
