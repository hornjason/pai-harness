---
doc-type: council
status: accepted
owner: jason
updated: 2026-09-23
---

# Observability Council — 2026-09-23

## Problem

Six implementation files and three specs doing scattered parts of observability. None talk to each other. GRADE only audits Marcus. Ship-and-heal ignores compliance scores. The human keeps catching bugs (hardcoded URLs, nonexistent files, timeout flailing) that automation misses.

## Research Inputs

- AgentLTL (arXiv:2607.02599): temporal logic over traces, deterministic compliance
- Braintrust Loop AI / DSPy: automated prompt improvement from eval results
- AgentOps: retry detection, tool call monitoring
- Novel contribution: prompt health validation and cross-agent pattern detection

## Council Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-1 | No new spec — add SCs to DA-COMPLIANCE-SPEC | Composition layer is ~150 lines of code, not a governance domain |
| D-2 | Replace LLM grading with deterministic evaluateCriteria() | All 3 agree. Removes variance, cuts cost, code exists |
| D-3 | Skip infrastructure agent grading entirely | env-check/commit pass or fail. No compliance signal worth measuring |
| D-4 | Static prompt-health lint as pre-ship gate, not runtime | grep-equivalent checks catch all known prompt bugs |
| D-5 | Validate scorer against 5 historical transcripts before auto-healing | No ground truth means hill-climb amplifies wrong signal |
| D-6 | Cap inline hill-climb at ONE iteration during ship | Prevents oscillation. Max 4 spawns total |
| D-7 | TraceSignal type in code, routing config in code, no spec-level schema | Type definition prevents JSON drift without governance overhead |

## Build Order

1. **Phase 0** — Scorer validation: run evaluateCriteria() on 5 transcripts, compare to human judgment
2. **Phase 1** — lib/grade-agents.ts: deterministic grading replacing LLM prompt in GRADE
3. **Phase 2** — COMPLIANCE_LOW in ship-and-heal, single hill-climb iteration
4. **Phase 3** — gates/prompt-health.ts: static lint for file refs, hardcoded paths
5. **Phase 4** — TraceSignal type + routing config

## Draft SCs (for DA-COMPLIANCE-SPEC)

- SC-A: lib/grade-agents.ts exists
- SC-B: lib/grade-agents.ts contains evaluateCriteria() and parseToolCalls()
- SC-C: workflows/ship.js GRADE phase does not contain LLM grading prompt
- SC-D: workflows/ship-and-heal.js contains COMPLIANCE_LOW
- SC-E: lib/observability-types.ts contains TraceSignal and fixableBy
- SC-F: gates/prompt-health.ts exists (static lint, no transcript)
- SC-G: tests/grade-agents.test.ts exists

## MVP Scope

Phase 0 + Phase 1 only. Deterministic grading replaces LLM grading. No auto-healing until scorer is validated.

## What Catches What

| Bug | Agent Quality | Harness Health (prompt lint) |
|-----|--------------|----------------------------|
| DDB hardcoded URLs | No | Yes — greps for hardcoded paths |
| Timeout flailing | Yes — retry count | Yes — ambiguous instruction |
| DOCS.md doesn't exist | No | Yes — referenced files must exist |
