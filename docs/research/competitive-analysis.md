---
doc-type: research
status: active
owner: jason
created: 2026-09-19
updated: 2026-09-20
governs: Build-vs-wrap decisions, integration strategy, unique value proposition
---

# RunGate Competitive Research

## Bottom Line

No tool does the full RunGate pipeline: scaffold + conformity tests on every `bun test` + findings JSON with fix commands + constraint extraction + drift detection + context budgets. The "conformity test" paradigm (embedded in test suite, not separate linter) is genuinely novel.

## Closest Competitors

- **Factory.ai Agent Readiness** — 8 pillars, 60+ criteria, readiness scoring. SaaS one-shot, not continuous. Open source clone: `kodustech/agent-readiness` (39 checks).
- **Microsoft AgentRC** — Measure → Generate → Maintain with CI `--fail-level`. Closest to RunGate's vision but readiness scoring, not test suite.
- **AgentLint (agentlint-ai)** — 51 checks, auto-fix, CI-ready. Linter paradigm, not test paradigm.

## Real Tools Evaluated (8 found, 2 cited tools don't exist)

| Tool | npm Package | Rules | Unique Value | Integrate? |
|---|---|---|---|---|
| ctxlint | @yawlabs/ctxlint | 37 | Paths, tokens, enforcement gaps, MCP, SARIF | Yes — primary |
| ccinspect | ccinspect | 56 | Tiktoken counting, scope/precedence, contradictions, session analytics | Yes — richest |
| agentsmd | @daichunghy/agentsmd | 11 | Score 0-100, wiring, dead commands, GitHub Action | Yes — scoring |
| unrot | unrot | 7 | Zero-dep, fleet/org scan, machine-path detection | Maybe |
| cclint (felixgeelhaar) | @felixgeelhaar/cclint | 19 | LSP/MCP, karpathy rule, monorepo hierarchy | Watch |
| agentlinter | agentlinter | scored | Security scanning for external skills, graded scoring | Watch |
| cclint (carlrannaberg) | @carlrannaberg/cclint | ~10 | Shallow, no JSON | Skip |
| agent-config-lint | N/A | N/A | **Does not exist** (research hallucinated) | N/A |

## DDB Results Across Tools

- **agentsmd:** 44/100 score, 24 errors (21 dead paths, 1 dead command)
- **ctxlint:** 12 errors, 29 warnings (token budget, broken paths, dead hooks, 6 enforcement gaps, 5 undocumented CI secrets)
- **ccinspect:** 2 errors (token budget exceeded), 26+ warnings
- **unrot:** 1 error (CLAUDE.md 261 lines > 200 threshold)
- **agentlinter:** 25 errors, 229 warnings, 71/100 (C+)

## Integration Strategy

RunGate = orchestration layer. Wrap ctxlint + ccinspect + agentsmd for context quality checks. Build unique value: spec-driven conformity, fallow, constraint extraction, structured findings with fixCommands, drift detection. All output unified into one conformity-findings.json.

## Market Gap Analysis

1. Problem is genuinely new — agent coding mainstream only since late 2025
2. Existing tools solve adjacent problems (lint OR scaffold OR score — never all three)
3. "Conformity test" paradigm is novel — ESLint-to-TypeScript leap

## Standards

- AGENTS.md: 60K+ repos, 30+ agents, Linux Foundation AAIF (170+ member orgs)
- No certification programs for "AI-ready repositories"
- Factory.ai's 5 maturity levels closest to a scoring standard

## How This Governs RunGate

Wrap ctxlint/ccinspect/agentsmd in conformity suite. Focus engineering on unique differentiators (spec conformity, findings pipeline, constraint extraction). Don't rebuild token counting, path validation, or contradiction detection.
