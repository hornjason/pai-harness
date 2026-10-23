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

This table covers the hooks this repository owns. A second tree, `~/.pai/hooks`,
supplies 45 further registrations on Jason's machine and shares eight names with
this one. Which of those belong in the shipped package, which stay personal, and
which copy wins for each duplicate is classified in
`docs/research/hook-tree-classification.md` (#713). Read it before moving a hook
between trees — it also records that `hooks/` is absent from `package.json`'s
`files` array and that no entry here sets `deployToConsumers`, so SC-472's
deployment path currently reaches zero hooks.

| Hook | File | Lines | Governing SCs | Assessment |
|------|------|-------|---------------|-----------|
| AgentBriefGuard | AgentBriefGuard.hook.ts | 589 | SC-367, SC-370 | Deep logic in hook — extract to lib/ |
| GateEnforcement | GateEnforcement.hook.ts | 92 | SC-369, SC-370 | Thin trigger — signal shaping and the doc-hygiene sweep live in lib/gate-enforcement.ts |
| AgentVerdictCapture | AgentVerdictCapture.hook.ts | 182 | SC-370, SC-371 | Acceptable |
| HookCurrency | HookCurrency.hook.ts | 146 | SC-370, SC-371 | Acceptable — two readings, both thin triggers: `scripts/check-installed-hook-currency.ts` for `.git/hooks` (#879) and `lib/hook-tree-currency.ts` for how old the tree a Claude Code registration resolves to is (#1216). Its git runner is `spawnGitRunner`, which is `lib/git-isolation.ts` in both projections — the directories it reads are by definition unsupervised, and git executes its own config |
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
| WorkflowStateGuard | WorkflowStateGuard.hook.ts | 64 | SC-370, SC-371 | Ideal thin trigger |
| TestSuiteGuard | TestSuiteGuard.hook.ts | 45 | SC-473, SC-370, SC-625 | Ideal thin trigger — logic in lib/test-suite-lock.ts |
| TestSuiteRelease | TestSuiteRelease.hook.ts | 42 | SC-370, SC-516, SC-517, SC-518, SC-625 | Ideal thin trigger — logic in lib/test-suite-lock.ts. **Registered nowhere (#910)** |
| BashToolGuard | BashToolGuard.hook.ts | 82 | SC-457, SC-370 | Thin trigger — COMP-7 enforcement. Row added by #898's census, which is what first noticed it had none |
| ProjectStateSync | ProjectStateSync.hook.ts | 43 | SC-370, SC-371 | Thin trigger — delegates to update-project-state.ts. **Registered nowhere (#910)** |
| TopLevelCdGuard | TopLevelCdGuard.hook.ts | 108 | SC-370, SC-371 | Thin trigger — the parse and the rung both live in lib/top-level-cd.ts. **Registered as a HARD REFUSAL at project scope (#992)**, Jason's decision, taken with the measurement in hand rather than against it: 32.7% of 31,577 recorded commands carry a top-level `cd`, every one of them real, so it fires often by design. `#1040` built the WARN→FAIL ladder and took no rung; this takes `block` by moving `CD_GUARD_DEFAULT_MODE`, so `RUNGATE_CD_GUARD=warn\|off` still reverses it without code. Scoped to harnessed projects via lib/harness-project.ts. `.claude/settings.json` holds the `Bash` matcher; machine-wide registration would be `~/.claude/settings.json`, which no PR carries. The refusal exits through `CD_GUARD_DECISION`, the single mutable site |
| SkillGuard | SkillGuard.hook.ts | 69 | SC-370, SC-371 | Good — migrated from `~/.pai/hooks` by #713. `BLOCKED_SKILLS` is the whole configuration; the keybindings-help position bias is a Claude Code platform defect, not a PAI one |
| HarnessAFKGate | HarnessAFKGate.hook.ts | 85 | SC-370, SC-371 | Good — migrated by #713. Reads `WORK_DIR` from hooks/lib/paths (`RUNGATE_WORK_DIR`, else `~/.rungate`), so it is rungate-owned. The `.pai` docstring claimed `MEMORY/WORK/`; corrected here |
| TeamInit | TeamInit.hook.ts | 85 | SC-370, SC-371 | Good — migrated by #713. Writes under Claude Code's own config dir, not a PAI one; idempotent, exits 0 on every error path |
| ActionVerificationGate | ActionVerificationGate.hook.ts | 89 | SC-370, SC-371 | Good — migrated by #713. No file I/O and no path resolution at all; the most portable of the nine PRODUCT hooks |
| GateResultProtection | GateResultProtection.hook.ts | 95 | SC-370, SC-371 | Good — migrated by #713, thinned 93→69 lines onto `lib/gate-result-protection.ts` by #1137, which found it failing open three ways: a literal-`includes` detector a space defeated, an unparseable Write ALLOWED by a bare `catch`, and the protected gate set enumerated a second time in `lib/gate-enforcement.ts`. Both enumerations now read `lib/gate-names.ts`. Pure rungate gate integrity; reads no path the tool call did not already name |
| BashWriteGuard | BashWriteGuard.hook.ts | 60 | SC-370, SC-371 | Good — migrated by #713, rewritten by #1120 as a thin trigger over `lib/bash-write-guard.ts`, which holds the decision and is swept over a 5,060-command corpus by `test/bash-write-guard.test.ts`. #1120 found it failing in BOTH directions at once: a read-only prefix allowlist consulted before the write target let an allowlisted prefix carry a protected redirect past it, while whole-string substring matching refused read-only commands for quoting the words they searched for. One cause — a substring test over a command line cannot tell code from data — so the allowlist is gone and every check is structural and per-segment. #1175 settled the scoping question this row used to defer for the `*.hook.ts` arm, and settled it for every arm at once: a protected NAME is a protected ARTIFACT only outside a scratch tree. Scoping to the project root — the reading #1175's acceptance asked for — was implemented and swept, and is MEASURED WRONG: of 3,240 absolute artifact references in 5,531 real commands, 16 are inside a repository tree, because a live `workflow-state.json` lives in the run store. That reading newly allows 169 of the 502 refusals, 133 of them naming a real artifact, which is `pai-config#473` C1 reopened. The scratch-tree reading clears 37 and newly allows nothing. A consumer authoring their own hooks is still refused when they write one in their own tree, which is the intended behaviour and no longer an open question. The exemption roots are FIXED: `TMPDIR` selects among them and cannot extend them, because the agent being judged sets it; a protected tree can never sit inside an exemption root; and a command that creates a symlink voids the exemption, since linking a scratch name at the run store and writing through it is one command, not a race. The run store and the trees `PAI_HOOKS_DIR`/`RUNGATE_HOOKS_DIR` resolve to are subtracted from the exemption wherever they are — a `.hook.ts` in a worktree nothing registers is a fixture, one in the tree that is actually wired is not, and `lib/hook-target-tree.ts` records a case where those were different directories. #1240 closed a bypass older than all of that: a heredoc or herestring handed to an INTERPRETER is a program and is now decided as one, where before the body was stripped before every arm and only a `-c`/`-e` body was read back — so `bash <<'EOF'` and `python3 <<'PY'` reached a live artifact with the guard deciding on one word. Ten spellings, all ALLOWed on `origin/main`, all refused now; the same sweep newly blocks 15 real commands and every one of them rewrites a live `workflow-state.json` in the run store. A body fed to anything that is not an interpreter is still a DOCUMENT and still stripped, which is the 1,860-command over-blocking that stripping exists to prevent. The interpreter list is `lib/interpreters.ts`, read by `lib/bash-file-read.ts` too; `lib/hook-trees.ts` keeps its own package-runner set, which answers a different question. #1249 is #1203's twin inside the other quote: `\\` in a double-quoted span is an escaped BACKSLASH, so the `"` after it CLOSES the span, and a one-character lookbehind that mistook it for an escaped quote held the span open and merged the separator and the write verb into one segment whose command word is `echo`. Only the arms gated on the command word — copy, `chmod`, interpreter — are bypassable that way, which is why a battery built from the issue's own `rm` example reports BLOCK on every row and the hole stays invisible: the in-place, redirect and `tee` arms match over the segment TEXT and survive the merge. The corpus cannot see this one at all — 0 of 127,925 unique Bash commands segment differently under the fix — so the witnesses are the whole of the evidence, which is what a guard against a spelling nobody has typed yet looks like |
| DocHygiene | DocHygiene.hook.ts | 148 | SC-370, SC-371 | Acceptable — migrated by #713, thinned 220→135 lines onto `lib/frontmatter.ts`, which its own `.pai` header already named as the tested binding. Stamped `owner: jason` as a literal until #1119, which **omits the key** rather than sourcing it from config: nothing downstream reads it, so a config field would transport a value with no consumer. The three keys it still stamps are all inferable from the document or the clock |

The seven rows above are #713's migration of the PRODUCT-classified hooks in
`docs/research/hook-tree-classification.md`. Two of that classification's nine
were deliberately NOT migrated: `ForceBypassPermissions`, which forces
permission bypass onto every Agent spawn and is a decision about a consumer's
machine rather than a file move, and `HookIntegrity`, which hard-codes
`~/.pai/hooks` and `~/.claude` and duplicates `HookCurrency.hook.ts` — the
classification itself asks for those two to be reconciled rather than both
shipped.

## Which hooks a consumer receives (#1047)

Before #1047 the answer was **none**, in two independent ways and by nobody's
decision: `hooks/` was absent from `package.json`'s `files` array, so the
tarball carried no hook files; and **0 of 20** entries in
`.claude/rungate/hooks.json` set `deployToConsumers`, so SC-472's deployment
path — built, and wired into `lib/scaffold/defaults.ts`,
`lib/scaffold/rehearsal.ts` and `lib/scaffold/steps.ts` — reached zero hooks
on every run it has ever had. It reported success each time, because a
scaffold that installs no hooks is indistinguishable from a correct run on a
project that wanted none.

Both halves are fixed, and the second is the one that lasts. **Adding
`hooks/` to `files[]` alone would have closed the gap on paper and changed
nothing a consumer could observe** — `CLOSURE-1` asks whether a published
file's imports resolve, never whether anything runs, so it would have gone
green over a directory no consumer ever registers.

### The field is required

`HookRegistration.deployToConsumers` is a required `boolean`, for the reason
`scope` is (#479): optional makes *decided no* and *nobody looked* the same
value. `deployHooksToConsumers` reads it with `!== true`, so an omission
silently means no.

A `false` entry carries `notDeployedReason`, mirroring `disabledReason`. The
reason is also the only place the two kinds of *no* are told apart:

- **HARNESS-ONLY** — about this repository's own shared checkout, its
  worktree pool, or its swarm. A consumer should never receive it.
- **OPT-IN** — ships inside the tarball, registered by the project once it
  has the thing the hook guards (specs, an issue tracker, a gate salt).
  Deploying it by default would install a guard that declines on every call,
  which reads exactly like a guard that is not installed.

`test/hook-traceability.test.ts` AC-11 refuses an entry that omits the field,
AC-12 one that is `false` without a reason, AC-13 one marked to ship whose
file `files[]` does not publish, and AC-14 drives the classifier over all
three verdicts so a clean census cannot be a census of nothing.

### The deployment step can no longer report success over an empty set

`deployHooksToConsumers` had four silent `return`s and an `else` branch that
printed `SKIP: All hooks already deployed` when **nothing had been eligible**.
Each exit now leaves a reading, and an empty eligible set is `UNMEASURED`
naming how many entries were read and how many opted in — `0 deployed because
the project wanted none` and `0 deployed because nobody set the flag` are
different facts and only one of them is fine. A `DEPLOYED` line names the
hooks, because a count cannot be checked against a registry and a list can.

### A deployed entry is one Claude Code executes, pointing at a file the consumer has (#1088)

Until #1088 the **SHIPS** rows below were a claim the code did not deliver, in
two independent ways, while the run reported `DEPLOYED: 12 hooks`.

**The shape.** Claude Code nests event → matcher group → `hooks[]` →
`{ type: "command", command }`. The deployment pushed a bare `{ command }`
straight into the event array, which Claude Code does not recognise as a hook.
No test caught it because every reading went through `settingsCommands` in
`lib/hook-trees.ts`, which collects a `command` string at any depth — a
tolerance that is correct for a census and fatal as an acceptance test. The
repository's own reader and the authoritative one disagreed, and the one under
test was not the one that decides whether a guard runs.

**The path.** `${RUNGATE_HOOKS_DIR}` was expanded against the **harness**
root, so a consumer that installed rungate from npm received commands naming a
directory on the harness author's machine, and nothing checked that any file
was there. It is now resolved against the **consumer** —
`${CLAUDE_PROJECT_DIR}/node_modules/rungate/hooks`, or
`${CLAUDE_PROJECT_DIR}/hooks` when the consumer is the harness itself, decided
by `isHarnessItself` — and a hook whose file is not at the path being written
is `UNMEASURED` naming the hook and the path, with no entry written.

Three further readings the step did not have: a consumer entry that names one
of our hooks but executes a different file is a `CONFLICT` and is left alone,
not overwritten and not counted as deployed; an inert entry left by the old
shape is `REPAIRED` — removed and replaced, because reading it as "already
deployed" would strand every consumer that already received one; and a
**relative** consumer path that resolves outside the repository is refused
(an absolute one is the owner naming another tree on purpose, which stays
supported).

The acceptance evidence is a round trip through `executingHookCommands`, which
reads the schema strictly. It is deliberately a second binding beside
`settingsCommands` and the two must be able to disagree: their disagreement on
a bare `{ command }` is the whole defect, and a single tolerant reader cannot
witness it.

### Verdicts

**12 SHIP, 4 OPT-IN, 4 HARNESS-ONLY.** `StaleTTLCleanup` was classified SHIP in the
first pass and corrected on review: the classification had been made from the
hook's header and first screen, and the destructive arm is behind an
`await import` sixty lines down. AC-15 in `test/hook-traceability.test.ts` is
the mechanical form of that correction — it walks what a shipping hook
reaches, through `await import` as well as `import … from`, and refuses a
remote-destructive git call. **Reading a hook's header is not classifying it.**

| Hook | Consumer | Why |
|---|---|---|
| BashToolGuard | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| TopLevelCdGuard | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| TestSuiteGuard | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| TestSuiteRelease | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| AgentBriefGuard | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| AgentVerdictCapture | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| AutoVerifyGate | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| CommitEnforcement | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| GateEnforcement | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| PostCompact | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| HookCurrency | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| WorkflowStateGuard | **SHIPS** | Registered in a scaffolded consumer's `.claude/settings.local.json` by `deployHooksToConsumers`. |
| IssueCloseGuard | OPT-IN | Couples to two things a fresh consumer does not have: a GitHub issue tracker wired to ship-gate, and the HMAC `.gate-salt` it validates PASS provenance against. With neither present it declines on every call, and a guard that declines on every call is indistinguishable from one that is not installed. It ships in the tarball; a project registers it once ship-gate runs against its tracker. |
| MergeGuard | OPT-IN | Reads `.ship-active` markers under WORK_DIR and a verify-gate PASS out of workflow-state.json; a project that has not run the ship loop has neither, so it warns about nothing. Ships in the tarball; register it once the ship loop runs. |
| StaleTTLCleanup | HARNESS-ONLY | Deletes remote branches at every SessionStart. Sixty lines below a header promising a file sweep, `await import('../lib/branch-cleanup.ts')` runs `cleanupStaleBranches({maxAgeDays: 7})`, which issues `git push origin --delete` per stale branch; the open-PR guard that is meant to spare one defaults its slug to `hornjason/pai-harness`, so on a consumer it answers about THIS repository and can never say stop. It fails OPEN for the consumer who HAS a token, since this repository is public. See the registry entry for what would have to change first. |
| SpecConformityTrigger | HARNESS-ONLY | A disabled entry that also claimed consumer deployment would be two answers to one question. Re-classify if and when it is re-enabled. |
| SpecSCGuard | OPT-IN | Validates new SC lines against `config/matcher-registry.json`, which means it has nothing to say until the project has specs carrying SCs. Ships in the tarball; register it once `specs/` exists. |
| TaskCompleted | HARNESS-ONLY | It spawns a CONCURRENT full suite, which is the thing lib/test-suite-lock.ts exists to prevent, so deploying it to a consumer would export the defect that disabled it here. Re-classify if and when it is re-enabled. |
| VerifyPhaseLock | OPT-IN | Blocks `gh issue create` during the VERIFY phase, so it presumes both a GitHub tracker and an active rungate workflow. Ships in the tarball; register it once the project ships through phases against a tracker. |
| ProjectStateSync | HARNESS-ONLY | It execs `<projectRoot>/scripts/update-project-state.ts`, which `package.json` `files[]` does not publish, so on a consumer `projectStateTarget` returns `declined-no-generator` on every write — zero reading as success, the shape #1047 is about. And #910's #296 blast-radius question is open: it is registered on BOTH Write and Edit at user scope, so it would fire on every agent edit in a consumer's worktree, and PROJECT-STATE.md is DA-owned. Deploying it is blocked on publishing the generator AND closing #910; revisit on either, not on neither. |

## The workflow-state.json write contract (#1152)

Two hooks decide every `Write` or `Edit` whose `file_path` is
`workflow-state.json`, they match on the same matcher, and until #1152 nothing
in the repository said which answers what. This section is that statement. It
is **not** the contract — `test/workflow-state-write-contract.test.ts` is, and
it holds the same table as executed rows. Prose here and a table there is
deliberate: the one that can go stale is this one, and the other one goes red
when it does.

### Which tree the table was measured against (#713, #1216)

A decision table that does not name its tree has the defect it describes:
right about some bytes, silent about which. The contract measures
`<this tree>/hooks/` — the copies this repository owns and publishes — and the
test asserts that provenance rather than stating it, by resolving the paths it
spawned and refusing any that land outside the tree the suite runs from.

Which copy a *session* executes is a different question and cannot be answered
from a path, because every registration is spelled through a variable.
`registrationTree` in `lib/hook-trees.ts` answers which root a command is
*spelled* with; `lib/hook-target-tree.ts` answers which directory that root
names on the machine reading it. #999 is the cost of conflating them — the
spelling was right and the executing bytes were another tree's.

Resolved with `registeredTreeCensus` on 2026-10-22, `repoRoot` as the shared
primary checkout, reading `MEASURED` over four registrations with no
unresolved variables:

| hook | scope | spelled through | target |
|---|---|---|---|
| `WorkflowStateGuard` | project-settings | `CLAUDE_PROJECT_DIR` | in-repo |
| `WorkflowStateGuard` | repo-registry | `RUNGATE_HOOKS_DIR` | in-repo |
| `GateResultProtection` | user-settings, ×2 | `PAI_HOOKS_DIR` | **foreign** |

So the blanket guard's rows describe bytes that run. The specific guard's rows
describe bytes this repository owns that a session on this machine **does
not** execute — which is #713, and it means a merged fix to the repo copy does
not reach a live session. Nothing here claims anything about that other tree's
contents; it was not read, and the resolution is from the registration strings
and `env` blocks alone.

Two cautions for anyone repeating the reading:

- `RUNGATE_HOOKS_DIR` names the shared primary checkout, so the same
  registration reads `in-repo` from there and `foreign` from every agent
  worktree. A `foreign` verdict means nothing until you know which root
  produced it.
- An `in-repo` resolution does not make the bytes current. That checkout was
  measured 180 commits behind `origin/main` — #1216. `hook-target-tree`
  answers *which directory*, never *which commit*.

### Which commit the resolved directory is on (#1216)

`lib/hook-tree-currency.ts` answers the second caution above, and
`hooks/HookCurrency.hook.ts` prints it once per session beside #879's
installed-git-hook reading. It is a READING and repairs nothing: every git
invocation is a query, asserted as such, because silently moving code
somebody is executing removes the one moment they could have noticed.

Three states, and the third never degrades to the first:

| state | means |
|---|---|
| `current` | the directory's HEAD contains every commit on the base |
| `behind` | N commits on the base are not in that HEAD — N, HEAD and the base SHA are all named |
| `unmeasured` | not a working tree, absent, the base ref does not resolve there, or uncommitted bytes under it |

Uncommitted changes can only block a `current` reading, never mask a
`behind` one. The base is the **target** directory's own `origin/main`, since
nothing fetches, which is why every line carries the base SHA: two rows
disagreeing about `origin/main` is then visible at a glance.

Read on this machine, 2026-10-23, from a worktree:

```
Hook tree currency: 0 current, 2 BEHIND, 0 UNMEASURED — of 2 director(ies) hook registrations execute from
  BEHIND 16:  /Users/jhorn/Projects/rg-hooks-live/hooks is at 7817f1df … [30 registration(s)]
  BEHIND 241: /Users/jhorn/Projects/rungate/hooks  is at bc56a7c2 … [4 registration(s)]
```

That is the same shared primary checkout the row above measured at 180, sixty
commits later, still executing four registrations. The live tree went stale
three times in one day on 2026-10-23 (`62536bd3` → `9f2080d6` → `7817f1df`),
which is the argument for a per-session reading rather than a one-off audit.

### Reading a directory nobody supervises means isolating git's config

Every invocation goes through `spawnGitRunner`, the one binding that applies
both projections of `lib/git-isolation.ts` and a per-call timeout. This is the
sharpest instance of #1001's lesson in the tree, and it comes from the
feature's own premise: the directories being read are the ones nothing is
watching — that is *why* they go stale — and the reading runs at SessionStart
in every session on the machine.

Measured 2026-10-23 with the key planted in the target's **own**
`.git/config`, which the env half of the isolation cannot reach:

| poisoned key | unisolated | isolated |
|---|---|---|
| `core.fsmonitor` → a script writing a marker | **marker written twice — git ran it** | not run |
| `core.excludesFile` → a list naming the edited hook | **`current`** | `unmeasured` |

The second row is specific to this reading: poisoning `core.excludesFile`
blinds the uncommitted-bytes check, so a hand-edited hook certifies as
matching a merged commit. The directory gets to lie about its own cleanliness
to the reading whose job is to catch exactly that.

`test/unit/hook-tree-currency.test.ts` holds both halves. HC-18 asserts the
**population** of invocations — every call the runner makes carries all four
`-c` pairs, all three env vars and a timeout — because a subcommand allowlist
alone stays green against an unisolated call for ever. HC-19 performs the
`core.excludesFile` exploit against real git with an unisolated control that
must reproduce it.

This is also `registeredTreeCensus`'s first caller outside `test/`.

### Who is authoritative for what

| hook | authoritative for | matcher | reach |
|---|---|---|---|
| `WorkflowStateGuard` | **whether a tool call may write the artifact at all.** The sanctioned writer is `writeWorkflowState()`, which Zod-validates; the Write and Edit tools bypass that, so every such call is refused regardless of content | `path.includes('workflow-state.json')` — case-SENSITIVE substring | **SHIPS.** `deployToConsumers: true` |
| `GateResultProtection` | **what a permitted write may contain.** It refuses a write that forges, erases or changes a `gates.<name>.result`, that advances `phase` to `DONE`, or that the guard could not model | `filePath.toLowerCase().endsWith('workflow-state.json')` — case-FOLDED suffix, per #1184 | **OPT-IN.** `deployToConsumers: false` |

Neither subsumes the other, and this is asserted rather than asserted-about:
there are inputs each one refuses and the other permits, in both directions.
If that ever stops being true the pair has collapsed into one decider — the
fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` — and the
contract test goes red saying so.

### #1152's body has the deployment backwards

The issue reasons that the specific guard "travels with the package" while the
blanket guard "may not be wired in a consumer's tree", and concludes the
overlap is defensible on those grounds. Measured on `origin/main` at
`dbf10445`, `.claude/rungate/hooks.json` says the reverse:
`WorkflowStateGuard` carries `deployToConsumers: true` and
`GateResultProtection` carries `deployToConsumers: false` with an explicit
`notDeployedReason`. `deployHooksToConsumers` filters on
`deployToConsumers === true`, so a scaffolded consumer receives the blanket
guard and not the specific one.

The conclusion survives — both should stay, and deleting either without a
decision is still wrong — but the reason inverts, and so does which gap is
consumer-reachable. **It is the blanket guard, the one that ships, whose
allow-path nothing was exercising.**

### Where they disagree, and which disagreements are intended

Six of the contract's fourteen rows diverge. Three are the split above working
as designed: a legitimate Write, a legitimate Edit, and an edit to a run whose
phase is already `DONE` are all refused by the blanket guard and permitted by
the specific one. That set **is** the specific guard's allow-path, and running
each hook alone is what makes it observable — #1152's resolution item 3.

The other three are accidents of two independently written path predicates and
are filed, not fixed here:

- **A forged gate result written to `WORKFLOW-STATE.JSON` is permitted by the
  blanket guard.** `String.includes` is case-sensitive; #1184 measured that the
  two spellings resolve to the same inode on a case-insensitive filesystem and
  case-folded the specific guard, and the fix was never carried across. The
  guard that still has it is the one that ships, so on a consumer tree this
  input reaches disk with no guard at all.
- A sibling path such as `workflow-state.json.bak` is refused by the blanket
  guard's substring match and permitted by the specific guard's suffix match.
  Over-blocking a backup file costs a rename; this is the direction to be
  wrong in.
- The blanket guard falls back to a `path` key that neither tool sends. Dead
  today; a tool-schema change makes it live without either hook being touched.

### If you change either hook

Update the row in `test/workflow-state-write-contract.test.ts` and the table
here in the same commit, and say which hook moved. A row deleted to make the
suite green deletes the only record that the two were ever compared.

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
- [x] SC-1658: test/hook-registration-reconciler.test.ts contains [a project-scoped hook declared enabled and absent from the repo settings is reported] — the half of the reconciliation CI can run- over `.claude/settings.json`- which the repo owns and commits
- [x] SC-1659: test/hook-registration-reconciler.test.ts contains [a user-scoped hook is UNMEASURED from the repo - never clean] — a user-scoped entry reports on every run even when it IS registered- because the repo cannot tell those two apart and saying nothing would claim it could
- [x] SC-1660: test/hook-registration-reconciler.test.ts contains [registered but unresolvable is a different finding from unregistered] — #199's SC-651- as three arms through one reconciler: an unset path variable- a resolved file that is missing- and no registration at all have three different fixes
- [x] SC-1661: lib/scaffold/defaults.ts contains [disabledReason] — the inventory is generated- so a decision recorded only in `.claude/rungate/hooks.json` is a decision the next scaffold repair overwrites
- [x] SC-1662: test/hook-registration-reconciler.test.ts contains [an entry that is off must say why] — off and never-registered look identical in a file- and the fastest way to resolve that ambiguity is to turn it back on

### An inventory with no reconciler, half-fixed (#199, #479)

`.claude/rungate/hooks.json` declared sixteen hooks `enabled: true`. Five were
registered in no settings file and had never fired. #199 filed it, shipped
`test/hook-registration-reconciler.test.ts`, and closed — with the five still
inert four weeks later, because the live check its own SC-650 asked for was
judged impossible and the per-hook decision its AC-3 asked for was never made.

The judgement was half right, and the half that was wrong is the interesting
one. Reading `~/.claude/settings.json` from a repo test passes on one laptop
and fails in CI; SC-518 above *requires* machine-wide hooks to live there; so
registration is machine state and the repo cannot assert it. All true — of the
eleven. Every one of the five acts on the **current project**: this project's
agent spawns, this project's `specs/*.md`, this project's
`workflow-state.json`, `runAllCompletionChecks(process.cwd())`. SC-518 does not
reach them, project `.claude/settings.json` is committed, and for a
project-scoped hook "is it registered" is an ordinary repo fact.

What the inventory never recorded is which kind an entry is. With `scope` on
each one the reconciliation splits, and neither half pretends to be the other:

| scope | measured | reported |
|---|---|---|
| `project` | registration in `.claude/settings.json`, and the resolved command's file | enforced — a finding fails the suite |
| `user` | only whether the repo ALSO registers it (SC-518's double-fire) | UNMEASURED on every run, never counted as checked |

The UNMEASURED row is the rule from `.claude/rules/config-access.md` applied to
a check rather than to config: `0`, `{}`, `null` and `SKIP` are
indistinguishable from success. An entry the repo cannot see must say so out
loud, every run, or the next reader counts sixteen entries as sixteen checks.

**The decision per hook, which is what AC-3 asked for and the measurement
behind each one.** Three on, two off:

| hook | | why |
|---|---|---|
| `AgentBriefGuard` | ON | the only mechanical enforcement of "never spawn Marcus, Quinn or Rook directly". It blocks nothing outside a recognised agent definition, and the two blocking paths are the two the rule names |
| `WorkflowStateGuard` | ON | `workflow-state.json` is what every gate reads. Twenty modules write it through `writeWorkflowState()` for Zod validation and none of them uses the Write or Edit tool, so the guard's entire blast radius is the hand-edit it exists to stop |
| `SpecSCGuard` | ON | read-only, in-process, and it enforces a rule the repo already has. PostToolUse cannot undo an edit, only report one |
| `SpecConformityTrigger` | OFF | `package.json` already runs `scripts/sync-sc-status.ts` as `posttest`. A second trigger is two deciders answering one question — the fourth shape — and it is the worse of the two: it ticks coverage on a text edit, with no suite having run |
| `TaskCompleted` | OFF | `checkTests` spawns a full `bun test` with a 120 000 ms timeout against a suite that measures ~400 s, so it can never complete; and it spawns a CONCURRENT full suite, which is what DIR-L29 and SC-516 exist to prevent |

Two findings fell out of the files this touched, both measured:

- **`BashToolGuard` was registered twice** — `~/.claude/settings.json` and
  `.claude/settings.json` — which SC-518 says in as many words fires the hook
  twice. The project copy is removed; it was a hard-coded absolute path into
  one developer's home directory, so it had never provided portable coverage
  to lose. The reconciler now reports this shape as `dual-scope`, which is the
  one thing about a user-scoped entry the repo *can* check.
- **`RUNGATE_HOOKS_DIR` resolves to the primary checkout.** A session working
  in a linked worktree runs `main`'s hook code, not the branch's, so a hook
  change cannot be exercised by the branch that makes it. The three project
  registrations use `${CLAUDE_PROJECT_DIR}` instead, which Claude Code binds to
  the session's own project root. Filed rather than fixed for the eleven.

What was broken to prove it, predicted before the battery ran and measured
after, over `test/hook-registration-reconciler.test.ts` (24 tests):

| Mutation | Predicted | Red |
|---|---|---|
| `reconcile` short-circuited to `return []` | 6 | 6 |
| `resolveCommandPath` stops expanding, returning the command unchanged | 4 | 4 |
| the absent-scope branch deleted, so a missing scope falls through | 1 | 1 |
| the three project entries re-tagged `scope: "user"` | 2 | 2 |
| `unexplainedDisabled` short-circuited to `return []` | 1 | 1 |
| `AgentBriefGuard`'s registration removed from `.claude/settings.json` | 1 | 1 |
| `disabledReason` dropped from the `TaskCompleted` entry | 2 | 2 |

None is left in the tree; all were run and reverted. Every row matched its
prediction, so no pair of deciders is covering for the other.

Two of the rows are worth reading rather than counting. The fourth —
re-tagging the three back to `user` — is the cheapest way to make a red
reconciliation green, and it is caught by the vacuity arm rather than by the
enforcement arm, which would go quiet. And the fifth is only 1 red because
SC-1662's own assertion **passes vacuously** under it: a reconciler that
reports nothing satisfies "nothing is unexplained". The unit case over a
planted reasonless entry is what makes that criterion mean anything, and it is
the only reason that row is not 0.

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
- WorkflowStateGuard (64 lines, 23 of them the #1152 contract statement) is the reference pattern for what a thin hook looks like
