---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Hook architecture — hooks as thin triggers delegating to lib/ modules, not deep logic in hook files
testable: true
compliance: strict
---

# Hook Architecture

## Problem Statement

RunGate has 10 hooks (1,634 lines total). Most are reasonably sized (37–143 lines), but `AgentBriefGuard.hook.ts` is 586 lines — more code than most lib/ modules. It contains validation logic, template comparison, brief assembly, and error reporting that should live in `lib/` where it's testable, reusable, and not coupled to the hook trigger mechanism.

Hooks should follow the same deep module / thin consumer pattern that the migration just proved works for tests: the hook is a thin trigger (detect event → call lib function → report result), the logic lives in a deep module.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Hooks are thin triggers — under 50 lines each | Hooks detect an event and call a lib function. Logic in hooks is untestable without simulating the hook trigger |
| D-2 | Hook logic extracted to `lib/` modules | Validation, assembly, and reporting logic moves to lib/ where it's importable and testable |
| D-3 | AgentBriefGuard split: validation in lib/, trigger in hook | 586 lines → ~50 line hook + ~400 line `lib/brief-validator.ts` |
| D-4 | Every hook has a governing spec | Currently hooks have no spec coverage. Each hook should trace to an SC |

## Current State

| Hook | File | Lines | Governing SCs | Assessment |
|------|------|-------|---------------|-----------|
| AgentBriefGuard | AgentBriefGuard.hook.ts | 589 | SC-367, SC-370 | Deep logic in hook — extract to lib/ |
| GateEnforcement | GateEnforcement.hook.ts | 275 | SC-369, SC-370 | Borderline — review what's logic vs trigger |
| AgentVerdictCapture | AgentVerdictCapture.hook.ts | 182 | SC-370, SC-371 | Acceptable |
| StaleTTLCleanup | StaleTTLCleanup.hook.ts | 170 | SC-370, SC-371 | Acceptable |
| CommitEnforcement | CommitEnforcement.hook.ts | 146 | SC-304, SC-370 | Acceptable |
| SpecSCGuard | SpecSCGuard.hook.ts | 123 | SC-370, SC-371 | Acceptable |
| IssueCloseGuard | IssueCloseGuard.hook.ts | 119 | SC-370, SC-371 | Acceptable |
| VerifyPhaseLock | VerifyPhaseLock.hook.ts | 84 | SC-370, SC-371 | Good |
| AutoVerifyGate | AutoVerifyGate.hook.ts | 79 | SC-370, SC-371 | Good |
| PostCompact | PostCompact.hook.ts | 60 | SC-370, SC-371 | Good |
| MergeGuard | MergeGuard.hook.ts | 58 | SC-370, SC-371 | Good |
| TaskCompleted | TaskCompleted.hook.ts | 51 | SC-370, SC-372 | Good — logic in lib/task-completion-checks.ts |
| SpecConformityTrigger | SpecConformityTrigger.hook.ts | 43 | SC-370, SC-371 | Good — thin trigger pattern |
| WorkflowStateGuard | WorkflowStateGuard.hook.ts | 40 | SC-370, SC-371 | Ideal thin trigger |
| TestSuiteGuard | TestSuiteGuard.hook.ts | 55 | SC-473, SC-370 | Tier 3 for DIR-L29 |

## Success Criteria

- [x] SC-367: hooks/AgentBriefGuard.hook.ts is under [50] lines
- [x] SC-368: lib/agent-brief-validation.ts exists (extracted from hook)
- [x] SC-369: hooks/GateEnforcement.hook.ts is under [100] lines
- [x] SC-370: Every hook file traces to at least one SC in a testable spec (behavioral)
- [x] SC-371: No hook file exceeds 150 lines (behavioral)
- [x] SC-372: Hook logic in lib/ has unit tests independent of hook trigger mechanism (behavioral)
- [x] SC-391: Hook registrations in settings.json contain hookFor and command fields (behavioral)
- [x] SC-392: Hook activation controlled by config enabled field (behavioral)
- [x] SC-472: Scaffold deploys consumer-facing hooks to .claude/settings.local.json driven by rungate.json hooks[].deployToConsumers (behavioral)
- [x] SC-473: TestSuiteGuard blocks full test suite (bun test) after 2 runs per session — Tier 3 enforcement for DIR-L29

## Implementation

### Phase 1: AgentBriefGuard extraction
1. Extract validation logic from AgentBriefGuard.hook.ts into `lib/brief-validator.ts`
2. Hook becomes: detect PostToolUse → call validateBrief() → report
3. Add unit tests for brief-validator
4. Verify: hook still fires correctly, same behavior

### Phase 2: GateEnforcement review
1. Audit GateEnforcement.hook.ts (273 lines) for extractable logic
2. Extract enforcement logic to lib/ if over 100 lines remain
3. Add tests

### Phase 3: Spec coverage
1. Audit each hook for SC traceability
2. Add SCs to relevant specs for uncovered hooks

## Cautions

- Hooks fire in Claude Code's PostToolUse/PreToolUse context — test the trigger behavior, not just the extracted logic
- Don't break hook registration — the hook filename and export pattern must be preserved
- WorkflowStateGuard (37 lines) is the reference pattern for what a thin hook looks like
