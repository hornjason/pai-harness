---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Hook architecture — hooks as thin triggers delegating to lib/ modules, not deep logic in hook files
testable: true
compliance: permissive
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

| Hook | Lines | Assessment |
|------|-------|-----------|
| AgentBriefGuard | 586 | Deep logic in hook — extract to lib/ |
| GateEnforcement | 273 | Borderline — review what's logic vs trigger |
| CommitEnforcement | 143 | Acceptable |
| AgentVerdictCapture | 134 | Acceptable |
| StaleTTLCleanup | 133 | Acceptable |
| IssueCloseGuard | 116 | Acceptable |
| VerifyPhaseLock | 81 | Good |
| AutoVerifyGate | 76 | Good |
| MergeGuard | 55 | Good |
| WorkflowStateGuard | 37 | Ideal thin trigger |

## Success Criteria

- [ ] SC-367: AgentBriefGuard.hook.ts is under 50 lines — validation logic in `lib/brief-validator.ts`
- [ ] SC-368: Brief validation logic extracted to lib/brief-validator.ts with independent tests
- [ ] SC-369: GateEnforcement.hook.ts is under 100 lines — enforcement logic in lib/
- [ ] SC-370: Every hook file traces to at least one SC in a testable spec
- [ ] SC-371: No hook file exceeds 150 lines
- [ ] SC-372: Hook logic in lib/ has unit tests independent of hook trigger mechanism
- [ ] SC-391: Active hooks listed in config, not determined by file existence alone
- [ ] SC-392: Consumers can enable/disable hooks via config without deleting files

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
