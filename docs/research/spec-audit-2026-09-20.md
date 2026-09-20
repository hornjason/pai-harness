---
doc-type: research
status: active
owner: jason
updated: 2026-09-20
---

# Spec Audit Results (2026-09-20)

Full audit of all 9 spec files against actual RunGate repo state.

## Summary

| Severity | Count | Meaning |
|---|---|---|
| WRONG | 9 | Spec says X, reality is Y — actively misleading |
| DDB-SPECIFIC | 40 | DailyBriefDashboard content leaked into RunGate specs |
| MISSING | 20 | References files/functions that don't exist |
| ASPIRATIONAL | 14 | Describes future state but not marked as such |
| STALE | 2 | Was true once, no longer |
| **Total** | **85** | |

## Worst Offenders

| Spec | Issues | Primary Problem |
|---|---|---|
| HARNESS-SKILL-CHAIN.md | 28 | DDB contamination — make commands, ports, containers |
| BOOTSTRAP-DATA-FLOW-SPEC.md | 28 | Wrong rungate.json schema, Makefile assumptions |
| HARNESS-GATES.md | 7 | All 4 gate scripts reference nonexistent files |
| BOOTSTRAP-TEST-PLAN.md | 6 | Example tests presented as real, none implemented |
| harness-automation-matrix.md | 4 | References hooks that don't exist |

## Root Cause

Specs were written for DailyBriefDashboard and copied into RunGate without adaptation. RunGate is a CLI tool (TypeScript gates, no containers, no Makefile). DDB is a web app (containers, Makefiles, ports 7776-7778).

## Top 5 Critical Discrepancies

1. rungate.json field table describes 30+ fields — actual has 5
2. All references to Makefile (RunGate has none)
3. CODE-MAP.md frontmatter fields don't match actual generated format
4. Gate scripts at skills/ship/*.sh don't exist — gates run via gates/run-gate.ts
5. 25 "consumer" references — concept doesn't apply to RunGate

## Repair Status

- HARNESS-SKILL-CHAIN.md: DDB content removed (2026-09-20)
- BOOTSTRAP-DATA-FLOW-SPEC.md: Partially cleaned, then split into specs/bootstrap-data-flow/
- HARNESS-GATES.md: Updated to reference TypeScript gates
- harness-automation-matrix.md: Hook references corrected
- HARNESS-STANDARD.md: File paths corrected

## Pattern for Prevention

Layer 4 conformity checks needed — tests that verify repo state matches spec claims. Current tests verify code logic but don't catch "spec references file that doesn't exist."
