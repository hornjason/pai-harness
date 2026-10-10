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
| TestSuiteGuard | TestSuiteGuard.hook.ts | 45 | SC-473, SC-370, SC-625 | Ideal thin trigger — logic in lib/test-suite-lock.ts |
| TestSuiteRelease | TestSuiteRelease.hook.ts | 42 | SC-370, SC-516, SC-517, SC-518, SC-625 | Ideal thin trigger — logic in lib/test-suite-lock.ts |

## The full-suite budget is keyed on a worker, not a session (#239)

SC-517 fixed the unit for CONCURRENCY — one slot is one running suite — and
left it wrong for the RATE window. `counterPath` still built
`rungate-test-suite-count-${sessionId}`, and sub-agent Bash calls reach
PreToolUse carrying the parent session's id, so a ship run that fans out to
three implementers gave three agents two runs per 30 minutes *between them*,
spent by whoever asked first.

Measured on run `wf_18abb197-f03`: both units went to sub-agents 235001 and
235003, and 235002 spent roughly 22 minutes in `sleep 580` loops waiting for
the window to age out while its siblings had been finished for twenty.

Raising `maxRuns` is the wrong fix. The budget exists because concurrent full
suites exhausted the VM compressor and rebooted this machine on 2026-10-05.
The budget is right; its key is wrong.

A **worker** is the session id plus the working directory — the fact that
distinguishes sibling agents, each of which runs in its own worktree —
reduced to ONE filename-safe segment. The reduction is not cosmetic: the key
is concatenated into `join(lockDir, ...)`, so a cwd carrying `/` or `..`
would steer the counter file out of the lock directory, and two workers whose
traversals pointed at the same place would share a budget again. Sanitising
alone would collapse `/a/b` and `-a-b` into one key, so a digest of the raw
input is appended to keep distinct directories distinct.

Three properties the change must not break, each asserted by a test that was
watched failing:

- **The cap is untouched.** No spread of worker ids across one session can put
  more than `capacity` suites in flight (SC-516, SC-517).
- **Acquire and release agree.** Both hooks derive the identity the same way;
  if they disagreed, a finished suite would free a sibling's slot — or none —
  and the slot would be held for a full 420s TTL.
- **A refusal costs nothing.** A refused run neither appends its attempt nor
  moves the window's oldest entry, so a worker polling the gate cannot push
  back the moment its budget frees up.

What was broken to prove those are checks and not lines in a report, run and
counted rather than asserted, over `test/test-suite-lock.test.ts` +
`test/test-suite-lock-key-mutation.test.ts` (121 tests):

| Mutation | Red |
|---|---|
| `counterKey` short-circuited to `return sessionId` | 5 |
| `counterKey` renamed | both files abort — the import fails to resolve and the mutant builder throws "the binding signature appears 0 times" |
| the guard hook stops passing `{ workerId }` | 2 |
| the release hook stops passing `{ workerId }` | 2 |
| a refused run appends its attempt to the window | 2 |

None is left in the tree; all were run and reverted. The two hook mutations
are the ones a grep cannot make: the hook still derives a `workerId` and the
word is still in the file — it just never reaches the lock. That is why the
hooks are driven as subprocesses rather than matched as text.

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
- [x] SC-473: TestSuiteGuard blocks full test suite (bun test) once a worker has spent its rate — Tier 3 enforcement for DIR-L29. The rate is `DEFAULT_MAX_RUNS_PER_WORKER` in `lib/test-suite-lock.ts` (2 → 4 on 2026-10-10, overridable per session with `RUNGATE_MAX_FULL_SUITE_RUNS`) and is stated there and nowhere else; `transcript-checker.ts` COMP-2 reads the same function rather than restating the number.
- [x] SC-516: TestSuiteGuard caps concurrent full suites across sessions at 2 — issue #67. The per-session cap in SC-473 does not bound the machine: N sessions obeying the CLAUDE.md pre-implementation gate means N simultaneous 5.4 GB suites, which exhausted the VM compressor and rebooted the machine on 2026-10-05. Slots are files, not a process count — the agentgrit suite leaks ~31 dangling bun processes per run, and BSD `pgrep` has no `-c` flag so the obvious count silently returns nothing. Fails open, never silent.
- [x] SC-517: A slot is one running suite, not one session — issue #67-B. Subagent Bash calls reach PreToolUse with the PARENT session's id (hook `session_id` is the same identifier as the transcript `sessionId`, and all 292 records of a live three-agent run carried the parent's). Keying ownership on the session therefore blocked Quinn's mandatory suite behind Marcus's slot and surfaced it as a test failure. Each live suite takes its own slot and releases exactly one; the cap counts suites, so no distribution across session ids can exceed it.
- [x] SC-625: lib/test-suite-lock.ts contains [export function counterKey, export function deriveWorkerId] — the rate budget's key is ONE named site and the worker identity is derived in ONE place, so the mutation below has something to remove and no second path can survive it (#239)
- [x] SC-626: test/test-suite-lock.test.ts contains [sibling workers sharing one session id spend separate rate budgets, a refused run neither consumes nor re-arms the budget window, the hooks derive and pass a worker identity] — the sibling case, the refusal case and the two hooks are all asserted by running them; the hooks are driven as subprocesses rather than grepped (#239)
- [x] SC-627: test/test-suite-lock-key-mutation.test.ts contains [could not build the mutant, MUTANT: #239 counter key reverted to the bare session id] — the key change is proved by removing it from a copy of the source every run, and a renamed or duplicated binding aborts the file instead of passing it (#239)
- [x] SC-518: Machine-wide hooks are registered in user settings, not project settings — issue #67-A. Project `.claude/settings.json` only loads for sessions started in that directory, so a cross-session cap registered there is inert for every session rooted elsewhere, including sessions working on the repo via an added working directory. Registration must appear in exactly one scope: the two are not de-duplicated, so dual registration fires the hook twice and consumes two slots per suite.

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
