---
doc-type: research
status: active
owner: jason
updated: 2026-09-30
---

# Anthropic Plugin Evaluation (#511)

Evaluated 6 official plugins against existing rungate capabilities.

## Decisions

| Plugin | Decision | Rationale |
|--------|----------|-----------|
| security-guidance | **ADOPT** | 3-layer security (patterns + LLM diff + commit review) complements Rook's static scan. Pre-emptive pattern warnings catch issues before Rook runs. |
| code-review | SKIP | 4 parallel PR review agents overlap with Quinn verification in ship workflow. Would add cost without new signal. |
| feature-dev | SKIP | 7-phase feature workflow conflicts with our 9-phase ship harness. Different mental models. |
| frontend-design | SKIP for now | No UI work in rungate. Adopt when working on DDB/AgentGrit frontend. |
| hookify | SKIP | We have 14 specialized hooks already. Hookify is for simple pattern matching — our hooks are TypeScript with full logic. |
| session-report | SKIP | PROJECT-STATE.md + compliance-report.ts already provide session tracking and agent grading. |

## Already Installed

| Plugin | Status | Action |
|--------|--------|--------|
| context7 | Enabled | KEEP — provides library docs |
| langfuse-observability | Enabled | DISABLE — Langfuse not used anymore |
| pyright-lsp | Disabled | KEEP disabled — no Python in rungate |

## Next Steps

1. Install security-guidance: `/plugin install security-guidance@claude-plugins-official`
2. Disable langfuse-observability: `/plugin disable langfuse-observability`
3. Re-evaluate frontend-design when doing UI work
