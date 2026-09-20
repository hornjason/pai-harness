---
doc-type: research
status: active
owner: jason
updated: 2026-09-20
---

# Orchestrator Context Management Research

## Problem

Long-running orchestrator agents (DA/Rayford pattern) compact at 300K+ tokens. Rules loaded at session start degrade. 41 rules in global CLAUDE.md is 2x past sigmoid collapse threshold.

## Key Findings

**Sigmoid collapse (arXiv 2608.02639):** 96% → 20% compliance as rules stack 1 → 20. Not linear — sigmoid cliff. Format/length rules collapse hardest. Lexical rules (specific names) survive best.

**Context rot (arXiv 2607.17937):** All 18 frontier models degrade with input length. Softmax attention mechanism. Rules at position 0 get more attention than position 200.

**Memory interference (ETH Zurich, arXiv 2602.11988):** Retrieved memories dilute rule salience. More memory loaded = less attention per rule.

**Three-tier architecture (arXiv 2602.20478):** Hot (always-loaded, ~200 lines max), Specialist (per-task), Cold (on-demand file reads). Claude Code skills already use this: name+description at startup, full content on match (49% → 74% accuracy).

## What Works

1. Under 20 rules always-loaded (hard cap)
2. Three-tier: hot rules / project rules / on-demand docs
3. Progressive disclosure: rule names → full text on match
4. Restart every 2-4 hours when compliance degrades
5. Store knowledge in FILES, not conversation — survives restart and compaction

## Production Research (Sep 2026, training data + limited search)

**Nobody runs long-lived stateful orchestrators in production.**

- Devin, Factory.ai, Cognition, Cosine, Poolside, Magic.dev — all proprietary, zero public architecture. What's visible suggests stateless per-task.
- Customer service / sales agents — stateless, CRM is the state store.
- CrewAI, AutoGen, Agency Swarm — mostly demos, orchestrators restart per task.
- LangGraph — closest to production-ready, designed for stateless task graphs.
- MemGPT/Letta, Zep, Mem0 — store task facts, NOT behavioral rules. Assume stable system prompt.
- No framework supports mid-session rule re-injection.
- No public guidance from Anthropic on session length limits.

**Industry pattern:** avoid the problem (restart often, go stateless) rather than solve it (rule re-injection, context refresh).

## Implication for PAI

PAI's long-running DA pattern is off the beaten path. Two options:

**Option A: Go stateless (industry standard)**
- DA restarts per task or every 2-4 hours
- PROJECT-STATE.md bridges sessions
- Agent results go to files, not conversation
- Clean rules every restart

**Option B: Solve the unsolved (innovation)**
- Rule re-injection at compaction boundaries
- Agent results to files instead of conversation context
- Progressive rule disclosure (names → full text on match)
- This would be novel — nobody has published a solution

Both options need: state in files, not conversation. The difference is whether the DA stays alive or restarts.

## PAI's Own Experience

Already documented in two feedback memories:
- "Repo Carries Context" — session-to-session context loss is real. Project knowledge must be in project files.
- "No Memory-Only Documentation" — research findings only in memory files = invisible to fresh agents.

## Implications

- Trim CLAUDE.md from 41 rules to 14 (below sigmoid threshold)
- Move project-specific rules to project CLAUDE.md files (Tier 2)
- Reduce memory file count (fewer loaded = more rule attention)
- PROJECT-STATE.md bridges restarts — state in files, not conversation
- Consider rule re-injection at compaction boundaries (nobody does this yet — potential RunGate innovation)
