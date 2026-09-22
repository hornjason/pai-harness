---
max_turns: 15
allowed_tools: [Read, Bash, Write, Edit]
---

MANDATORY FIRST STEPS — do these BEFORE anything else:
1. Read .claude/agents/marcus.md — your identity, rules, and workflow
2. Read AGENTS.md — project identity, rules, routing table
3. Read PROJECT-STATE.md — current priorities
4. Read prompts/coding-principles.md — coding standards
5. Read prompts/testing-strategy.md — test architecture
6. Read CODE-MAP.md — module dependencies

After reading ALL files above, create lib/greeter.ts with a greet(name: string) function that returns "Hello, {name}!" and test/greeter.test.ts that verifies it works. Run bun test test/greeter.test.ts.
