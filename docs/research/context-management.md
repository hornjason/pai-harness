---
doc-type: research
status: active
owner: jason
created: 2026-09-19
updated: 2026-09-20
governs: Context budget enforcement, inferability filtering, three-tier architecture
---

# Agent Context Management Research

## Critical Finding — Generated Overviews Hurt

ETH Zurich (ICLR 2026, arxiv 2602.11988, 138 real repos):
- LLM-generated AGENTS.md **reduces** success by 3%, increases cost 20%+
- Human-written AGENTS.md **reduces** agent-generated bugs 35-55%
- "Repository overviews, although popular and recommended by model providers, are not helpful"
- Agents discover repo structure on their own — only **non-inferable details** help

Addy Osmani test: "Can the agent find this by reading the code? If yes, delete it."

## Context Budget Research

- **Instruction Stacking Collapse** (arXiv 2608.02639, July 2026): Follow rate drops 96% → 20% as instructions stack 1→20. **Sigmoid curve**, not linear. Format/length rules collapse hardest. Lexical rules (specific function names) survive best.
- **IFScale** (arXiv 2507.11538): Three patterns — threshold decay (reasoning models), linear decay (claude-sonnet-4), exponential decay (gpt-4o). Best frontier models: 68% accuracy at 500 instructions.
- **Practical limits:** CLAUDE.md under 200 lines (Anthropic). Windsurf: 6,000 chars/file, 12,000 total. HumanLayer: under 60 lines. ~150-200 instructions before degradation.
- **Context Rot** (arXiv 2607.17937): All 18 frontier models degrade as input length increases. Fundamental property of softmax attention.
- Anthropic rule of thumb: Only write a CLAUDE.md rule on the SECOND occurrence of the same error.

## Three-Tier Architecture (Emerging Consensus)

- **Tier 1 (Hot/Always-loaded):** ~660 lines max. Code standards, constraints, build commands. Loaded every session.
- **Tier 2 (Specialist/Per-task):** Agent briefs, domain expertise. Loaded when relevant.
- **Tier 3 (Cold/On-demand):** CODE-MAP, architecture docs. Queried via MCP or file read.

Source: "Codified Context" (arXiv 2602.20478). Also: Claude Code progressive disclosure — skills show name+description at startup, full content loaded on match. Measured: 49%→74% and 79.5%→88.1% accuracy.

## Existing Tools

| Tool | What | Type |
|---|---|---|
| ctxlint (YawLabs) | 19 rules, token budgets, staleness, contradictions | CLI/CI/MCP, zero deps |
| agentsmd (@daichunghy) | lint (11 rules), score (0-100), sync, doctor | npm CLI |
| agent-config-lint | Dead paths, contradictions, duplicates | Python CLI |
| AgentLinter | 32+ rules, prompt injection detection, MCP validation | Web service |
| cclint | CLAUDE.md validation, SARIF output | TypeScript |
| Fiberplane Drift | Tree-sitter AST fingerprinting, CI integration | Drift detection |
| Drift (dadbodgeoff) | MCP server + CLI, pattern memory, --require-fresh | Drift detection |
| Packmind | Enterprise context distribution + drift detection | Platform |
| @mongez/agent-kit | Multi-tool instruction sync from single source | CLI |

## Drift Detection Approaches

- **Fiberplane Drift:** AST fingerprinting via tree-sitter. Records signature at link time, recomputes on check. CI exits 1 if stale.
- **Hash-based:** Auterix uses hash locks. dadbodgeoff/drift uses audit hash chain.
- **Coverage test** (Zylos): Enumerate capabilities from code, assert each in agent docs. CI-checkable.
- **Git-based:** Staleness by git commit ancestry, not timestamps.

## Bloat-Drift Feedback Loop

Large context files → harder to maintain → drift faster → worse output → teams add MORE rules → MORE bloat. Intervention: **mechanical enforcement** (linters in CI), not behavioral discipline.

## AGENTS.md Standard

60,000+ projects, 30+ agents read it. Under Linux Foundation AAIF (170+ member orgs). Best practice: AGENTS.md as canonical source, tool-specific files reference it.

## How This Governs RunGate

1. Reduce generated overview content in scaffold — only non-inferable constraints
2. Focus on non-inferable constraints — Osmani test on every generated line
3. Add context budget enforcement — SC-174 through SC-177
4. Wrap ctxlint/agentsmd as adapters
5. Implement drift detection for generated files — hash-based per spec-drift guard
6. Cap always-loaded content (Tier 1) at ~150 lines per file
