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
- [x] SC-825: lib/issue-create-override.ts contains [verifyPhaseRefusal] — the VERIFY lock's decision is ONE exported function in lib/, not eight lines in the hook, so there is one binding to mutate and the hook stays the thin trigger SC-371 and SC-372 ask for
- [x] SC-826: lib/issue-create-override.ts contains [external-audit] — a second override naming an origin outside the ship loop. `follow-up` was the only one, so #362, #363 and #364 all had to claim they were follow-up work from a shipped issue, and they were not
- [x] SC-827: test/verify-phase-lock.test.ts contains [the override word is in the TITLE] — the bypass the issue named is a table row, and the hook is SPAWNED over a real VERIFY state. A decision correct in lib/ that the hook never consults is the decorative check this repo keeps finding

### A guard wider than the thing it guards (#365)

`hooks/VerifyPhaseLock.hook.ts:72` decided with:

```ts
if (cmd.includes('--label') && cmd.includes('follow-up')) process.exit(0);
```

That is not a test that a label argument equals `follow-up`. It is a test
that the string appears somewhere in the command, so

```
gh issue create --label bug --title "Fix the follow-up handler"
```

bypassed the lock entirely while applying no override label at all. Shape two
of `.claude/rules/checks-must-be-able-to-fail.md` — a detector that cannot
tell an argument from a word in a title — pointed outward rather than inward.

The same shape hid a **second bypass one line down**, which the issue did not
name. `cmd.includes('gh issue comment')` is unreachable for a plain comment,
because the create check above it has already exited; it is reachable for
`gh issue comment … && gh issue create …`, where the comment clause excuses
the create clause. Deciding per *clause* rather than per *command* closes
both with one change.

**The second defect is about the tracker, not the hook.** `follow-up` means
"follow-up work from a shipped issue" and was the only override, so anything
filed during VERIFY had to claim an origin it did not have. #362, #363 and
#364 came from an external audit of DailyBriefDashboard and project-ape and
all three wear `follow-up`; an agent filtering that label for loose ends from
recent ships gets three unrelated results. `external-audit` is accepted as a
second override and the refusal text is generated from the same map the
decision reads, so a third one cannot be accepted while the message still
names two.

#### Each fix was the same defect, narrower — three times

Three rounds of commit security review found bypasses in the replacement, and
all three rounds were right. **Round one:** the new tokenizer split on
*whitespace alone*, so a shell operator glued to a word never became an
operator and `gh` never started a token. **Round two:** with that fixed, the
parser still disagreed with the shell about what names a command. **Round
three:** with both fixed, it still disagreed about which characters are
syntax — a backslash-newline and a `#` comment.

| command | allowed by | because |
|---|---|---|
| `foo;gh issue create --label bug` | fix 1 | the token was `foo;gh` |
| `gh issue comment 1&&gh issue create --label bug` | fix 1 | the token was `1&&gh` |
| `(gh issue create --label bug)` | fix 1 | the token was `(gh` |
| two creates on two lines, the first with an override | fix 1 | a newline is not a separator, so one override covered both |
| `bash -c "gh issue create --label bug"` | fix 1 | the inner command was one quoted token |
| ```gh issue create --label bug``` in backticks | fix 2 | the token was ```gh``` |
| `/usr/bin/gh issue create --label bug` | fix 2 | compared against the literal `gh` |
| `./gh issue create --label bug` | fix 2 | the same |
| `sh -lc 'gh issue create --label bug'` | fix 2 | short flags combine; only the last letter takes the argument |
| `eval 'gh issue create --label bug'` | fix 2 | `eval`'s argument is a command |
| a create wrapped across two lines with a trailing backslash | fix 3 | a backslash-newline was read as an escaped character, so the token was a newline glued to `create` |
| `gh issue create --label bug # --label follow-up` | fix 3 | `#` was not a comment, so a commented-out override counted as one |
| `gh issue create --label bug --title "--label=follow-up"` | fix 3 | a flag-shaped *value* was read as a flag — #365 itself, through the back door |

That is the substring matcher's defect wearing the opposite sign. The
original was *wider* than a label and matched a word in a title; all three
replacements were *narrower* than a command and missed the command. Every one
is shape two of `.claude/rules/checks-must-be-able-to-fail.md`, and having
just written the fix for one was no protection against writing the next.

Round three's first two are worth separating from rounds one and two, because
they are not evasion. A long command wrapped across lines and a note after a
command are things people type for their own reasons, which puts them inside
the boundary below rather than outside it: the lock exists to catch a reflex,
and both of these are reflexes. The fixes are the shell's own rules — a
backslash-newline joins and contributes nothing, and `#` opens a comment only
at the start of a word. Both directions of the second are asserted, because
treating every `#` as a comment would silently truncate
`--title '#5 regression'`.

**Round three's third is #365 itself, reintroduced by the parser written to
fix it.** `labelValues` scanned the clause for a token beginning `--label=`,
which is a detector wider than the thing it guards in exactly the original
way: `--title "--label=follow-up"` gives `gh` a *title* and the label `bug`,
while the scan read an override and allowed it. The quoting is not what makes
it work — the shell strips it either way, and the unquoted form is the same
command.

The fix is to walk the clause tracking arity the way `gh`'s own flag parser
does: a flag consumes the next token unless it is known to be boolean. An
unknown flag is assumed to take a value, so the only error this can make is
to MISS a `--label` — and a missed label is a refusal, the direction this
guard is allowed to be wrong in. Both ends are asserted, because the opposite
default would have eaten the override in `--web --label follow-up`.

That this bypass existed at all is the strongest evidence for the rule the
whole file is an instance of. A detector narrower than what it detects and a
detector wider than it are the same defect, and fixing one of them is the
moment you are most likely to write the other.

**The shell allowlist was removed because nothing could distinguish it.**
Fix one's recursion descended only into `sh`, `bash`, `zsh`, `dash`, `ksh`
and `fish`, resolving the program name past any `VAR=value` prefix. Deleting
the check scored **0 red of 38**: a non-shell interpreter's `-c` argument is
source code, source code quotes the command it runs, and quoted text arrives
as one token while `createsIssue` needs three adjacent ones.
`python3 -c "print('gh issue create --label bug')"` is a table case and is
allowed either way. A branch no input can distinguish will be wrong
silently, so it is gone rather than kept for reassurance.

#### Where the parser stops, and why that is an answer

A third review round would find a fourth shape. So the scope is written into
the module and asserted by a test rather than left to the next reviewer's
judgement: **this is workflow discipline over `gh` invocations reaching
PreToolUse on Bash, and it is not a sandbox.** It exists to catch a reflex,
and a reflex is defeated by refusing the shapes someone actually types.

Out of scope on purpose, and not a gap to file: `curl` against the REST API
and the GitHub MCP tools, because neither is Bash and the hook never sees
them; `ssh host "gh issue create …"`, because that runs on another machine
against whatever repo it is configured for; variable indirection
(`GH=gh; $GH issue create`), because resolving it means tracking assignments
across clauses and nobody reaches for `$GH` by reflex; here-strings and
here-documents, for the same reason; and a caller who writes a script and
runs it. Each takes a decision to get around the lock, and an agent that has
made that decision is a problem no matcher fixes. Chasing them trades false
refusals — which teach people to work around a guard — for protection against
someone already doing so.

**The boundary is a measurement, not a claim.** `GH=gh; $GH issue create
--label bug` and `bash <<< 'gh issue create --label bug'` are table rows
asserting that they are *allowed*, so the scope is re-checked every run rather
than documented once and left to drift.

#### What was broken to prove it (SC-825..827)

Run and counted over `test/verify-phase-lock.test.ts` (70 tests). **Every row
was re-measured after each round's new tests**, so none is carried over from
an earlier denominator:

| Mutation | Red |
|---|---|
| the decision reverted to the old hook's two-line substring form — **the mutation the issue specified** | 40 of 70 |
| `verifyPhaseRefusal` always allows | 31 of 70 |
| `labelValues` stops skipping non-flag tokens | 24 of 70 |
| only the label test reverts to a substring, clause splitting kept | 14 of 70 |
| `tokenize` stops honouring quotes | 13 of 70 |
| operators stop being their own tokens — **review 1's finding** | 9 of 70 |
| the command-argument recursion removed entirely | 7 of 70 |
| `external-audit` removed from the override map | 6 of 70 |
| `labelValues` stops tracking flag arity — a flag-shaped value is a flag again — **review 3's finding** | 6 of 70 |
| clause splitting removed — the whole command is one clause | 3 of 70 |
| the newline dropped from the operator list | 3 of 70 |
| `#` comments are no longer stripped — **review 3's finding** | 3 of 70 |
| `createsIssue` compares the raw token, not the basename — **review 2's finding** | 2 of 70 |
| the command flag narrowed back to exactly `-c` | 2 of 70 |
| the hook stops consulting the library and inlines the old test | 2 of 70 |
| a backslash-newline goes back to being an escaped character — **review 3's finding** | 2 of 70 |
| `BOOLEAN_FLAGS` emptied — a boolean flag eats the override after it | 2 of 70 |
| the attached short-flag value branch removed (`-lfollow-up`) | 2 of 70 |
| `eval` dropped as a command sink | 1 of 70 |
| the backtick dropped from the operator list | 1 of 70 |
| `#` opens a comment anywhere, not only at a word start — **the over-correction** | 1 of 70 |
| the out-of-scope bullet list deleted | 1 of 70 |
| the "it is not a sandbox" sentence deleted | 1 of 70 |
| the recursion depth bound raised from 4 to 400 | **0 of 70** |

A twenty-fifth was run and is not listed because it is the arity row restated
(`if (false) i++` rather than deleting the line); it reproduces 6 of 70
exactly, which is the cross-check that the row measures the branch and not
the comment attached to it.

Four notes on that table.

**The top row scores higher than "always allows", and that is the finding.**
A matcher that allows everything fails 31 cases; the original substring form
fails 40 — *more* than doing nothing. It refuses `echo 'gh issue create …'`
and `python3 -c "print('gh issue create …')"`, neither of which creates
anything, while allowing the title bypass #365 is about. The same detector was
wider than a label and narrower than a command at once, which is why replacing
it with a stricter substring test was never the fix.

**Two rows scored 0 on their first attempt, both times because the MUTATION
was at fault rather than the test.** The first attempt replaced the boundary
paragraph with a note that itself contained the phrase the assertion looks
for, so `toContain` found its own epitaph — the fifth self-reference trap of
the day, this one inside a mutation. The second deleted the section *heading*
and left every asserted sentence in place. Both are recorded because a 0 that
turns out to be the mutation's fault is the same reading as a 0 that is the
test's fault, and only re-running tells them apart.

The depth-bound row is recorded rather than hidden, and unlike the allowlist
it is kept. The bound is a resource property and not a decision property: a
mutation raising it is *supposed* to leave every verdict unchanged, and the
test covering it asserts only that a twelve-deep wrapper chain does not
throw. An unverified branch that cannot change an answer is a different thing
from one that silently can.

**Both directions of the arity fix are measured, which is the point of the
last two 2s.** Emptying `BOOLEAN_FLAGS` and deleting the attached-value
branch are mutations that make the guard *refuse more*, and each turns two
cases red. A guard proved only against under-refusing drifts toward refusing
everything, and this file's whole argument is that false refusals teach
people to work around it.

None of the twenty-five is left in the tree; all were run and reverted. The
hook is 84 lines, within SC-371.

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
