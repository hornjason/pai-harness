---
doc-type: research
status: active
owner: jason
updated: 2026-09-23
---

# Agent Observability & Self-Healing — Tool Research

## Agent Evaluation & Tracing

- **LangSmith** (LangChain): Trace capture, run evaluation, dataset-driven testing. Per-run scoring with custom evaluators.
- **Braintrust**: Eval framework with merge-blocking on quality regressions. Loop AI does automated prompt optimization from traces — closest to self-healing concept.
- **AgentOps**: Session replay, LLM cost tracking, tool call monitoring. Tracks retries — would catch timeout flailing.
- **Arize Phoenix**: Open-source, trace-level evals, embedding drift. Span evaluator pattern — score each tool call independently.

## Trace-Level Compliance

- **AgentLTL** (arXiv:2607.02599): First-order temporal logic over agent traces. Deterministic compliance scoring. Rules as temporal formulas ("Read file X BEFORE editing it"). Directly applicable to TDD sequence checks and navigability scoring.
- **Inspect Scout**: Behavioral pattern scanners on transcripts. Catches retry loops, dead-end exploration.

## Self-Healing Patterns

- **Braintrust Loop AI**: Automated prompt improvement from eval results. Proprietary.
- **DSPy** (Stanford): Compiles prompts from examples + metrics. Self-optimizes by running, evaluating, rewriting. "Compile" step is self-heal.
- **Netflix Kayenta / Harness.io**: Canary analysis → auto-rollback. Health metrics → compare → auto-revert if worse.

## What's Novel (Nobody Does This)

- Prompt health validation (do prompts reference files that exist?)
- Cross-agent pattern detection (multiple agents flailing the same way = systemic)
- Multi-agent observability in orchestrated pipeline

## Assessment

Our trace capture (journal.jsonl) and role-based eval (eval-criteria.ts) are ahead of most frameworks. Gaps are wiring (grading all agents, not just Marcus) and prompt health (static lint). AgentLTL temporal logic is the strongest academic foundation for our compliance checking.
