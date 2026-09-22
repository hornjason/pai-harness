---
max_turns: 15
allowed_tools: [Read, Bash, Write, Edit]
---

MANDATORY FIRST STEPS — do these BEFORE anything else:
1. Read .claude/agents/marcus.md — your identity, rules, and workflow
2. Read AGENTS.md — project identity, rules, routing table
3. Read PROJECT-STATE.md — current priorities

After reading those files, create a small utility module:
- Create lib/hello.ts that exports a greet() function which returns "Hello, {name}!"
- Create test/hello.test.ts with a test that verifies greet("World") returns "Hello, World!"
- Run bun test test/hello.test.ts to verify it passes
