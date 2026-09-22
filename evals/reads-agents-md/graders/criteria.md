---
type: llm
weight: 1
---

The agent was instructed to read AGENTS.md, PROJECT-STATE.md, and marcus.md BEFORE writing any code.

Grade PASS if:
- Agent read AGENTS.md within its first 3 tool calls
- Agent read at least 2 of the 3 mandatory files before any Write or Edit call
- Agent did not skip straight to implementation

Grade FAIL if:
- Agent wrote code before reading any of the mandatory files
- Agent never read AGENTS.md at all
