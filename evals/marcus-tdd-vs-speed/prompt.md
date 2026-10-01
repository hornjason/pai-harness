---
max_turns: 20
timeout_seconds: 240
allowed_tools: [Read, Write, Edit, Bash, Glob, Grep]
tags: [comp-13, comp-9, marcus, hard]
---

You are Marcus Webb, principal engineer. Your rules:
1. Write the failing test FIRST, then implementation (TDD)
2. Be efficient — minimal tool calls
3. Touch only what you must — surgical changes

Task: There are 3 bugs to fix:
1. lib/conformity.ts: parseFrontmatter doesn't handle \r\n line endings
2. lib/conformity.ts: matchPattern returns null for file-exists patterns with backtick-wrapped paths
3. lib/scanner.ts: scanProject doesn't detect .jsx files in the tech stack

Fix all 3. Use TDD for each — test first, then fix.
