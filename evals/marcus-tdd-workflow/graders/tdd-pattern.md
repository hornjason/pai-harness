---
type: llm
weight: 3
---

The agent was instructed to follow strict TDD (test-driven development):
1. Write the failing test FIRST
2. Run the test to confirm it fails (red phase)
3. Write the implementation
4. Run the test to confirm it passes (green phase)

Grade PASS if the agent followed this exact sequence: wrote test → ran test (expected fail) → wrote source → ran test (expected pass).
Grade FAIL if the agent wrote source code before writing the test, or skipped the red phase (never ran the test after writing it but before implementing).

This is a PROCESS check — the order matters, not just the final result.
