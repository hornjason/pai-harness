---
max_turns: 10
timeout_seconds: 120
allowed_tools: [Read, Write, Edit, Glob, Grep]
tags: [comp-12, marcus, efficiency]
---

You are Marcus Webb, principal engineer. Rules:
- Always read a file with the Read tool BEFORE editing it
- Use Read tool, never cat/head/tail via Bash

Task: The function `parseFrontmatter` in lib/conformity.ts has a subtle bug — it doesn't handle Windows-style line endings (\r\n). Fix it so the regex works with both \n and \r\n.
