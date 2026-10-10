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
| GateEnforcement | GateEnforcement.hook.ts | 92 | SC-369, SC-370 | Thin trigger — signal shaping and the doc-hygiene sweep live in lib/gate-enforcement.ts |
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
| TestSuiteGuard | TestSuiteGuard.hook.ts | 45 | SC-473, SC-370, SC-621, SC-622 | Ideal thin trigger — logic in lib/test-suite-lock.ts |
| TestSuiteRelease | TestSuiteRelease.hook.ts | 46 | SC-370, SC-516, SC-517, SC-518, SC-622 | Ideal thin trigger — logic in lib/test-suite-lock.ts |

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
- [x] SC-516: TestSuiteGuard caps concurrent full suites across sessions at 2 — issue #67. The per-session cap in SC-473 does not bound the machine: N sessions obeying the CLAUDE.md pre-implementation gate means N simultaneous 5.4 GB suites, which exhausted the VM compressor and rebooted the machine on 2026-10-05. Slots are files, not a process count — the agentgrit suite leaks ~31 dangling bun processes per run, and BSD `pgrep` has no `-c` flag so the obvious count silently returns nothing. Fails open, never silent.
- [x] SC-517: A slot is one running suite, not one session — issue #67-B. Subagent Bash calls reach PreToolUse with the PARENT session's id (hook `session_id` is the same identifier as the transcript `sessionId`, and all 292 records of a live three-agent run carried the parent's). Keying ownership on the session therefore blocked Quinn's mandatory suite behind Marcus's slot and surfaced it as a test failure. Each live suite takes its own slot and releases exactly one; the cap counts suites, so no distribution across session ids can exceed it.
- [x] SC-518: Machine-wide hooks are registered in user settings, not project settings — issue #67-A. Project `.claude/settings.json` only loads for sessions started in that directory, so a cross-session cap registered there is inert for every session rooted elsewhere, including sessions working on the repo via an added working directory. Registration must appear in exactly one scope: the two are not de-duplicated, so dual registration fires the hook twice and consumes two slots per suite.
- [x] SC-621: lib/test-suite-lock.ts contains [export function budgetKey, workerId] — the DIR-L29 rate budget is keyed on a WORKER, not on a session (issue #239). Sub-agents reach PreToolUse under the PARENT session's id, the same fact SC-517 records for slots, so a ship run that fanned out to three implementers gave all of them two runs per 30 minutes between them — spent by whoever asked first. On run wf_18abb197-f03 sub-agent 235002 spent ~22 minutes in `sleep 580` loops, twenty of them after its siblings had finished. Raising maxRuns would be the wrong fix: the budget exists because concurrent full suites rebooted this machine on 2026-10-05. The budget is right; its key was wrong.
- [x] SC-622: hooks/TestSuiteGuard.hook.ts contains [workerIdFromHook, workerId] — the guard derives the worker identity from the `cwd` and `transcript_path` already present in the hook payload and now typed in hooks/lib/utils.ts, and passes it to the gate. The cap is untouched: it counts slot FILES, so no number of keys can add a suite (SC-516, SC-517 hold).
- [x] SC-625: hooks/TestSuiteRelease.hook.ts contains [workerIdFromHook, workerId] — release derives the identity the same way the guard did. Acquire and release must agree or the slot is unreleasable and leaks for the full 420s TTL, which is the wedge this hook exists to prevent.

**What was broken to prove SC-621..SC-623 can fail**, run and counted rather
than asserted, over `test/test-suite-lock.test.ts` +
`test/unit/test-suite-guard.test.ts` + `test/test-suite-lock-key-mutation.test.ts`
(125 tests):

| Mutation | Red |
|---|---|
| `budgetKey` short-circuited to `return sessionId` — the pre-#239 key | 6 of 125 — both sibling-isolation cases, the hook-level sibling case, the mutant case's real half, the filename-safety case, and the concurrency case (whose refusal changes from "already running" to DIR-L29 once siblings share a budget) |
| `budgetKey` renamed | 4 of 125 — every case in the mutation file, each throwing `could not build the mutant: the key signature appears 0 times` rather than mutating nothing |
| a refusal made to append its own timestamp to the window | 2 of 125 — the #239 re-arming case and the pre-existing "a run refused for concurrency does not burn the session budget" |

None is left in the tree; all three were run and reverted.
- [x] SC-623: test/test-suite-lock-key-mutation.test.ts contains [MUTANT: counter key reverted to the bare session id] — the key change is proved by mutation, per .claude/rules/checks-must-be-able-to-fail.md: a copy of lib/test-suite-lock.ts with `budgetKey` short-circuited to `return sessionId` runs the same sibling scenario in its own process and is watched refusing the sibling the real source allows. Both halves assert the same positive control (worker A's third run is refused in each), so a mutant that failed to load cannot pass for a mutant that was caught.

## Implementation

### Phase 1: AgentBriefGuard extraction
1. Extract validation logic from AgentBriefGuard.hook.ts into `lib/brief-validator.ts`
2. Hook becomes: detect PostToolUse → call validateBrief() → report
3. Add unit tests for brief-validator
4. Verify: hook still fires correctly, same behavior

### Phase 2: GateEnforcement review (done — #209)
1. Audit GateEnforcement.hook.ts for extractable logic
2. Extract enforcement logic to lib/ if over 100 lines remain
3. Add tests

### Phase 3: Spec coverage
1. Audit each hook for SC traceability
2. Add SCs to relevant specs for uncovered hooks

## Cautions

- Hooks fire in Claude Code's PostToolUse/PreToolUse context — test the trigger behavior, not just the extracted logic
- Don't break hook registration — the hook filename and export pattern must be preserved
- WorkflowStateGuard (37 lines) is the reference pattern for what a thin hook looks like
