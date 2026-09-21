---
doc-type: research
status: active
owner: jason
created: 2026-09-19
updated: 2026-09-20
governs: Tool selection for compliance layers, adapter strategy
---

# Instruction Quality Tools Research

## Three-Layer Tool Architecture

### Layer 1 — Static Quality (pre-runtime)

- **PromptLint** (promptlint.dev): 34+ rules. Clarity, vagueness, actionability, contradictions, redundancy, specificity. MCP server. SARIF output. No LLM. Auto-fix for 5 rules. Key rules: `clarity-vague-terms`, `actionability-weak-verbs`, `specificity-constraints`, `specificity-examples`, `hallucination-risk`.
- **LintLang** (lintlang.ai, PyPI `lintlang`): Static linter for agent configs. 7 structural detectors. Detects vague tool descriptions, missing stop conditions. GitHub Actions integration.
- **RepoRails CLI** (`npx @reporails/cli check`): 97 rules. Classifies directives vs scaffolding. Median file: 50 items, 12 directives (27% signal). Quality /10. 28,721 repos studied. "Instruction that names exact construct gets followed" — 10x compliance.
- **agnix** (`npm i -g agnix`): 455 rules, Rust-based, LSP server. IDE plugins. Autofixes with confidence levels.
- **agent-config-lint** (duke5am): AGL018 flags unverifiable/vague rules. "Write clean code" flagged — no observable definition.

### Layer 2 — Comparative (test-time)

- **PromptFoo** (open-source, acquired by OpenAI): Side-by-side prompt comparison. Deterministic + LLM-judge scoring. CI/CD. Claude Code skill integration.
- **Braintrust**: Merge-blocking on quality regressions. Loop AI for auto-optimization.
- **DeepEval**: ArenaGEval for head-to-head prompt variant testing.

### Layer 3 — Trace (post-runtime)

- **AgentLTL** (arXiv:2607.02599): First-order linear temporal logic over agent traces. Deterministic compliance score. +38pp accuracy and +17pp compliance with finetuning.
- **UK AISI Transcript Analysis**: 6,390 transcripts, 71 tasks. Found compliance rates from <50% to 100%.
- **Inspect Scout** (Meridian Labs + UK AISI): Log analysis with behavioral pattern scanners.

## Key Research Findings

- DETAIL Matters (arXiv:2512.02246): Rewording prompts causes 30+ point accuracy gaps
- RepoRails study: specificity produces ~10x compliance difference
- Gloaguen et al.: human-written AGENTS.md reduces bugs 35-55%
- Hamming AI: "the failure is rarely 'the prompt forgot the rule' — it's that the rule was not turned into a measurable assertion"

## Gaps Nobody Fills (RunGate's unique value)

1. **Codebase grounding** — verify instructions reference real code entities (functions, files)
2. **Inferability detection** — flag content agents can discover by reading code
3. **Continuous conformity loop** — all checks run on every `bun test`

## How This Governs RunGate

Wrap agnix + RepoRails as Layer 1 adapters (implemented in lib/compliance.ts). Build codebase grounding and inferability detection as unique Layer 2 checks (SC-122, SC-194). Use PromptFoo for A/B testing instruction variants (future). AgentLTL approach informs behavioral compliance layer (COMP tests).
