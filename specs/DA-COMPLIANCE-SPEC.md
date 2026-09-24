---
doc-type: spec
status: active
testable: no
owner: jason
updated: 2026-09-22
---

# DA Compliance Spec

## Purpose

Formalize the DA (Digital Assistant) compliance evaluation criteria and wire them into the existing audit-transcript system. Provides role-specific grading for DA, Marcus, and Quinn agents with a scoring dashboard.

## Architecture

```
lib/eval-criteria.ts          -- shared criteria module (role registry + check functions)
scripts/audit-transcript.ts   -- refactored to use eval-criteria, exports gradeByRole()
scripts/da-compliance.ts      -- /da-compliance skill: dashboard + JSON output
specs/DA-COMPLIANCE-SPEC.md   -- this spec: criteria tables + baseline scores
```

## Evaluation Criteria

### Shared Criteria (all roles)

| ID | Rule | Weight | Source | Transcript Check |
|----|------|--------|--------|-----------------|
| SHARED-01 | Read AGENTS.md in first 5 calls | 20 | AGENTS.md Rules | First 5 tool calls contain Read with AGENTS.md path |
| SHARED-02 | No duplicate file reads | 15 | marcus.md Never Do | No file path appears in Read calls more than once |
| SHARED-03 | No cat/head via Bash (use Read) | 5 | marcus.md Never Do | No Bash commands matching /\bcat\b/ (excluding heredocs) |
| SHARED-04 | Read PROJECT-STATE early (first 10 calls) | 10 | AGENTS.md Key Files | First 10 calls contain Read of PROJECT-STATE or project-state.json |

### DA Criteria

| ID | Rule | Weight | Source | Transcript Check |
|----|------|--------|--------|-----------------|
| DA-01 | Invoke harness skill before implementation | 20 | CLAUDE.md MANDATORY GATE step 3 | Skill("harness") call exists before first Edit/Write |
| DA-02 | Run bun test before implementation | 15 | CLAUDE.md MANDATORY GATE step 1 | Bash with "bun test" before first Edit/Write |
| DA-03 | Read governing spec before implementation | 15 | CLAUDE.md MANDATORY GATE step 2 | Read of specs/ file before first Edit/Write |
| DA-04 | Delegate to named agents | 20 | CLAUDE.md MANDATORY GATE step 4 | No Edit/Write to lib/, test/, scripts/, gates/, hooks/ |
| DA-05 | Update PROJECT-STATE at milestones | 10 | CLAUDE.md Rules | Edit/Write to PROJECT-STATE or project-state.json |

### Marcus Criteria

| ID | Rule | Weight | Source | Transcript Check |
|----|------|--------|--------|-----------------|
| M-01 | Total tool calls <= 30 | 10 | marcus.md Additional Never Do | calls.length <= 30 |
| M-02 | Grep:Read ratio <= 2:1 | 10 | coding-principles.md | grep bash count / read count <= 2 |
| M-03 | <= 1 full bun test run | 10 | marcus.md Additional Never Do | bun test bash count <= 1 |
| M-04 | Read governing spec before first edit | 15 | marcus.md Before writing code | specs/ read before first Edit/Write |
| M-05 | Read prompts/ before writing code | 15 | marcus.md Context MANDATORY | prompts/ read before first Edit/Write |
| M-06 | Grep before Read for non-key files | 5 | memory: Grep Before Read | <= 50% of reads without prior grep |

### Quinn Criteria

| ID | Rule | Weight | Source | Transcript Check |
|----|------|--------|--------|-----------------|
| Q-01 | Run full test suite (bun test) | 20 | quinn.md Core Principles | Bash with "bun test" present |
| Q-02 | Run type check (tsc --noEmit) | 15 | quinn.md Before reporting done | Bash with "tsc --noEmit" present |
| Q-03 | Verify AC evidence is not self-attested | 15 | quinn.md Never Do | >= 2 verification commands (grep, bun test, tsc) |
| Q-04 | No direct code edits (validation only) | 20 | quinn.md Core Principles | No Edit/Write to .ts/.js/.json files (excluding tests) |
| Q-05 | Total tool calls <= 30 | 10 | quinn.md Efficiency | calls.length <= 30 |

## Success Criteria

- **SC-416**: DA-COMPLIANCE-SPEC.md contains eval criteria tables for DA, Marcus, and Quinn roles with criterion ID, source reference, and transcript check columns (>= 3 role tables)
- **SC-417**: audit-transcript.ts exports gradeByRole function that accepts role parameter and applies role-specific eval criteria
- **SC-418**: Transcript grading output includes per-rule FOLLOWED/IGNORED verdict with evidence string (behavioral)
- **SC-419**: da-compliance.ts skill script reads transcript directory, runs role-aware audit, produces structured JSON (behavioral)
- **SC-420**: Dashboard output shows per-rule compliance rate as percentage (behavioral)
- **SC-421**: audit-transcript.ts imports shared eval criteria from lib/eval-criteria.ts
- **SC-422**: Baseline DA compliance score documented with date and per-criterion pass rates

### Observability — Deterministic Grading + Self-Healing (Council 2026-09-23)

- [x] SC-437: lib/transcript-checker.ts contains [evaluateCriteria] (consolidated from grade-agents)
- [x] SC-438: lib/transcript-checker.ts contains [evaluateCriteria]
- [x] SC-439: lib/transcript-checker.ts contains [parseToolCalls]
- [x] SC-440: workflows/ship.js GRADE phase does not contain [Grade each agent] (LLM prompt removed)
- [x] SC-441: workflows/ship-and-heal.js contains [COMPLIANCE_LOW]
- [x] SC-442: workflows/ship-and-heal.js contains [gradeResult]
- [ ] SC-443: lib/observability-types.ts exists
- [ ] SC-444: lib/observability-types.ts contains [TraceSignal]
- [ ] SC-445: lib/observability-types.ts contains [fixableBy]
- [ ] SC-446: gates/prompt-health.ts exists
- [ ] SC-447: gates/prompt-health.ts contains [agentType]
- [ ] SC-448: gates/prompt-health.ts has no [transcript] (static only, not runtime)
- [x] SC-449: test/unit/agent-audit.test.ts exists (grading test coverage)
- [x] SC-450: workflows/ship-and-heal.js contains [MAX_HEAL_SPAWNS]

## Grading Scale

| Grade | Score Range |
|-------|------------|
| A | >= 90% |
| B | >= 75% |
| C | >= 60% |
| D | >= 40% |
| F | < 40% |

## Baseline Compliance Score

**Date:** 2026-09-22
**Sessions audited:** 3 (1 DA, 1 Marcus, 1 Quinn)
**Method:** Fixture transcripts representing compliant agent sessions

| Role | Score | Grade |
|------|-------|-------|
| DA | 100% | A |
| Marcus | 100% | A |
| Quinn | 100% | A |

### Per-Criterion Pass Rates (baseline)

| ID | Rule | Pass Rate |
|----|------|-----------|
| SHARED-01 | Read AGENTS.md in first 5 calls | 100% |
| SHARED-02 | No duplicate file reads | 100% |
| SHARED-03 | No cat/head via Bash | 100% |
| SHARED-04 | Read PROJECT-STATE early | 100% |
| DA-01 | Invoke harness skill before implementation | 100% |
| DA-02 | Run bun test before implementation | 100% |
| DA-03 | Read governing spec before implementation | 100% |
| DA-04 | Delegate to named agents | 100% |
| DA-05 | Update PROJECT-STATE at milestones | 0% |
| M-01 | Total tool calls <= 30 | 100% |
| M-02 | Grep:Read ratio <= 2:1 | 100% |
| M-03 | <= 1 full bun test run | 100% |
| M-04 | Read governing spec before first edit | 100% |
| M-05 | Read prompts/ before writing code | 100% |
| M-06 | Grep before Read for non-key files | 100% |
| Q-01 | Run full test suite | 100% |
| Q-02 | Run type check | 100% |
| Q-03 | Verify AC evidence not self-attested | 100% |
| Q-04 | No direct code edits | 100% |
| Q-05 | Total tool calls <= 30 | 100% |

> Note: Baseline uses fixture transcripts representing ideal compliant sessions. Real session baselines will be captured when the audit is run on production transcripts. DA-05 (Update PROJECT-STATE at milestones) scored 0% because the DA fixture session is a scope-only session with no milestone edits.
