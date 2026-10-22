---
doc-type: research
status: active
owner: jason
updated: 2026-10-21
---

# Hook Tree Classification — product vs personal (#713)

Two hook trees exist on this machine. `~/.pai/hooks` holds 60 files and supplies
45 registrations to `~/.claude/settings.json`; `<repo>/hooks` holds 19 and
supplies 14. Eight names appear in both and all eight have diverged. Nothing in
either tree declares which copy wins, and no registration check in this repo can
tell them apart — `test/hook-tree-divergence.test.ts` records that
`registeredIn` matches the bare filename, so a registration pointed at the
superseded `.pai` copy keeps the suite green.

This document is the classification that makes the migration decidable. It is
not the migration. Nothing here moves, deletes or re-registers a file.

The dividing line is Jason's: a hook rungate needs **to work as a shipped
product on a consumer's machine** belongs in the package; a hook that serves the
personal PAI setup stays in `~/.pai`. The operational test applied to each file
below is *would this do anything meaningful on a fresh consumer repo that has
never heard of PAI?* A hook that reads `~/.pai/…`, writes to the learning store
under `MEMORY/LEARNING` or `MEMORY/RELATIONSHIP`, or drives the Kitty terminal
is personal by that test regardless of what its name suggests.

Every verdict below was taken by reading the file. Names were treated as a
hypothesis and several did not survive it — see *Where the names misled*.

## The premise that has to be fixed first

> **BOTH PREMISES BELOW WERE TRUE WHEN WRITTEN AND ARE NOW FALSE.** Corrected
> by #713's migration PR on 2026-10-21. Both were load-bearing: together they
> said consumer deployment was dormant, and a brief written from them put a
> constraint on a window that was already open. The original text is kept
> struck through rather than deleted, because what this document got wrong is
> the more useful half of it.
>
> Re-derive rather than inherit — every reading below was taken from
> `origin/main` at `3b5770e7`:
>
> ```
> git show origin/main:package.json                      # files[] contains hooks/
> git show origin/main:.claude/rungate/hooks.json        # 20 entries
> ```

~~Jason's framing — "we ship everything in rungate as a product to consumers and
needs to have it all in the package" — is not true of hooks today, in two
independent ways, and neither is fixed by moving files:~~

1. ~~**`hooks/` is not in the npm package.**~~ **SUPERSEDED.** `hooks/` **is**
   in the `files` array on `origin/main`, between `lib/` and `prompts/`. A
   consumer who installs rungate now receives every hook file in the
   directory. Part 2 of the three-part migration below has landed.
2. ~~**No hook opts in to consumer deployment.** … All 19 entries leave the
   field unset.~~ **SUPERSEDED, and wrong in both halves.** There are **20**
   entries, not 19, and **12 of them set `deployToConsumers: true`** — not
   zero. Counted 2026-10-21:

   | reading | count |
   |---|---|
   | entries | 20 |
   | `deployToConsumers: true` | 12 |
   | `deployToConsumers: false` | 8 |
   | field absent | 0 |

   `true`: BashToolGuard, TopLevelCdGuard, TestSuiteGuard, TestSuiteRelease,
   AgentBriefGuard, AgentVerdictCapture, AutoVerifyGate, CommitEnforcement,
   GateEnforcement, PostCompact, HookCurrency, WorkflowStateGuard.
   `false` with a reason: IssueCloseGuard, MergeGuard, SpecConformityTrigger,
   SpecSCGuard, StaleTTLCleanup, TaskCompleted, VerifyPhaseLock,
   ProjectStateSync.

   The field is now mandatory: #1047's AC-11 refuses an entry that leaves it
   unset, which is why the absent count is 0 and cannot drift back up.

**The same stale claim survives in code.** `deployHooksToConsumers`'s own
docblock in `lib/scaffold/steps.ts` still reads *"Measured on this repository
on 2026-10-21: zero of twenty registry entries set `deployToConsumers`"*. It
is a comment, not behaviour — the function reads the live config — but it is
the identical error in a second position, and a reader who finds it will
re-derive the wrong conclusion. Not corrected by #713's PR, which touched no
file under `lib/`; worth a one-line follow-up.

So the migration this table feeds has three parts, not one: move the PRODUCT
hooks into `hooks/`, add `hooks/` to the package `files` array, and set
`deployToConsumers: true` on the entries a consumer actually needs. **Parts 2
and 3 have both landed in substance**; #713's PR is part 1. Moving files alone
changes nothing a consumer can observe — but the other two parts, which have,
now do.

### What the three parts add up to for a consumer

Nobody has written this sentence down, and it is an emergent property of three
separate PRs rather than a decision anybody took:

`hooks/` ships in the package, 12 entries are marked for deployment, and
#1095 pointed the generated command at
`${CLAUDE_PROJECT_DIR}/node_modules/rungate/hooks` — a path that now resolves,
because of part 2. Those three facts together mean **consumer hook deployment
is fully live**, where before any one of them it was not.

Two qualifications, both measured, because the alarming version of that
sentence is not the accurate one:

- **Publishing deploys nothing by itself.** `deployHooksToConsumers` runs from
  the scaffold's write-steps, not from `npm install`. The trigger is a
  scaffold run, and what it writes is `.claude/settings.local.json` inside
  each declared consumer.
- **`consumers` is `[]` on `origin/main` today**, so the function returns
  early and writes nothing to anyone. The first scaffold run after a consumer
  is declared is when 12 hook registrations appear in that consumer's
  settings.

So this is not "the next release writes to somebody's machine". It is "the
mechanism is armed, and the first declared consumer receives twelve hooks."
That may be exactly what was wanted — the framing at the top of this document
asks for rungate to ship as a product — but it should be a sentence somebody
decided to write rather than a property that emerged.

## Verdicts

45 registrations classified: **9 PRODUCT, 35 PERSONAL, 1 UNMEASURED.**

### PRODUCT — belongs in the rungate package

| Hook | Why |
|---|---|
| ActionVerificationGate | Zero dependencies beyond `lib/parseStdin`. Regex-matches state-changing Bash (`git push`, `npm publish`, `gh release`, `docker push`) and injects a verify-before-reporting reminder. No file I/O at all; functions identically on a repo that has never heard of PAI. |
| BashWriteGuard | Blocks Bash writes to `workflow-state.json`, `.gate-salt`, `witnesses/` and `*.hook.ts`. Every protected artifact is a rungate gate artifact. Only `lib/parseStdin` imported. |
| DocHygiene | Its own header states "Mirror of `lib/frontmatter.ts` in rungate, which is where this is tested", and `SKIP_PATTERNS` already excludes `/.rungate/`. The file self-identifies as rungate code living in the wrong tree. |
| ForceBypassPermissions | Injects `mode: bypassPermissions` into every Agent spawn so AFK runs are not stalled by permission prompts. Imports `fs` only. AFK agent spawning is rungate's core loop. |
| GateResultProtection | Blocks Write/Edit that would set `gates.*.result` or `phase = "DONE"` in `workflow-state.json` directly rather than through the gate runner. Pure rungate gate integrity; only `lib/parseStdin` imported. |
| HarnessAFKGate | Blocks `AskUserQuestion` when the most recent PRD under the work dir is in a post-approval phase. The PRD-driven ship lifecycle is rungate's. |
| HookIntegrity | Reads the settings file, extracts hook paths, and restores the executable bit when it has been lost. Tree-neutral — it repairs whichever hooks are registered. Overlaps rungate's own `HookCurrency.hook.ts`; the migration should reconcile the two rather than ship both. |
| SkillGuard | Blocks the `keybindings-help` position-bias false positive. A Claude Code platform defect affecting every consumer equally; `BLOCKED_SKILLS` is the whole configuration and imports stop at `lib/parseStdin`. |
| TeamInit | Creates the missing `teams/session-<id>/config.json` that makes typed agent spawns fail after compaction. `teams/` is Claude Code's own directory, not a PAI one; any agent-spawning product hits this bug. |

### PERSONAL — stays in `~/.pai/hooks`

Grouped by what makes them personal. All 35 were read individually.

**Writes to Jason's learning store** (`MEMORY/LEARNING/**`, `MEMORY/RELATIONSHIP/**` under `PAI_DIR`):

| Hook | Why |
|---|---|
| AutoDebrief | Appends to `correction-captures.jsonl` in the signals directory. |
| EnforcementAudit | Logs `--no-verify` bypasses to `enforcement-audit.jsonl`. The subject is rungate-relevant; the sink is not. Portable only if the sink moves. |
| GraphContext | Reads work state and ratings, queries the knowledge graph, writes `GRAPH-CONTEXT.md`. Calls agentgrit for rule selection. |
| HarnessFailureSurfacing | Injects failure patterns from `patterns.json` in the learning store when `Skill("ship")` is called. Subject is the harness, data source is Jason's history. |
| IncidentMonitor | Appends detected Bash failures to `incidents.jsonl`. |
| IncidentPatternAnalyzer | Groups those incidents and proposes rules into `PENDING-RULES.md`. |
| NegativeAssertionAudit | Appends unverified negative claims to `assertion-violations.jsonl`. Built for a 36-instance behavioural pattern of Jason's. |
| RatingCapture | Appends to `ratings.jsonl`; its inference prompt hard-codes "This is a personal AI system" and the principal's name. |
| RelationshipMemory | Writes dated relationship notes and may update the user profile doc. |
| SentimentScorer | Auto-scores sessions into `ratings.jsonl` and `sessions.jsonl`. |
| SkillEnforcement | Writes `skill-router-pending.json` and `skillrouter-events.jsonl`; closes the loop on SkillRouter, which is PAI's. |
| SkillInvocation | Appends to `skill-invocations.jsonl`. |
| SkillSequenceLogger | Appends to the skill sequences log for co-occurrence analysis. |
| ToolAudit | Appends every tool call to `tool-audit.jsonl`. |
| WorkCompletionLearning | Bridges the WORK tree to the LEARNING tree at session end. |

**Drives the terminal or voice:**

| Hook | Why |
|---|---|
| KittyEnvPersist | Persists `KITTY_LISTEN_ON` / `KITTY_WINDOW_ID` and resets the tab. |
| QuestionAnswered | Resets tab colour after an answer, via `lib/tab-setter`. |
| SetQuestionTab | Turns the tab teal while a question is pending. |
| UpdateTabTitle | Generates and sets a gerund tab title; imports `lib/identity` and `lib/tab-setter`. |
| VoiceCompletion | Extracts the spoken line and sends it to the ElevenLabs server via `handlers/VoiceNotification`; gated on a Kitty session file. |
| NeedsInput | Pushes to the `pai-rayford-dashboard` ntfy topic through `lib/notifications`. A personal delivery channel, named in the hook. |

**PAI session, context and skill machinery:**

| Hook | Why |
|---|---|
| AutoChainTrigger | Reads `skills/skill-registry.json` under `PAI_DIR` to pick a successor skill. |
| ContextRefresh | Keeps PAI context state under `PAI_DIR/state` and refreshes on topic change. |
| DocIntegrity | Runs PAI doc cross-reference checks over PAI docs, skills and components. |
| IntegrityCheck | Dynamically imports `PAI/Tools/TranscriptParser` from `PAI_DIR`. |
| LastResponseCache | Caches the last response for the RatingCapture bridge. |
| LoadContext | Injects PAI relationship, learning and work context at session start. |
| PRDSync | Syncs PRD frontmatter to `work.json` for the PAI dashboard; imports `lib/tab-setter`. |
| SessionAutoName | Generates the four-word session title for the PAI status line. |
| SessionCleanup | Finalises the work directory, clears PAI state, resets the Kitty tab. |
| SkillRouter | Keyword-routes PAI's skill taxonomy; its prompt text is templated on the principal's name. |
| SkillLifecyclePre | Runs `scripts/skill-runner.sh` under `PAI_DIR` for ADR-007's six-phase lifecycle. ADR-007 is PAI's — this repo's `docs/adr` holds only ADR-001 and ADR-002. **The runner it invokes does not exist on disk**, so this hook is inert today. |
| UpdateCounts | Updates PAI banner/statusline counts and refreshes the usage cache. |

**Decided against the name:**

| Hook | Why |
|---|---|
| SecurityValidator | Sounds product-ish and is not. Its pattern store is `PAI/USER/PAISECURITYSYSTEM/patterns.yaml` with a fallback to `PAI/PAISECURITYSYSTEM/patterns.example.yaml`, both resolved through `paiPath`, and it writes findings to `MEMORY/SECURITY/<year>/<month>/`. Its hard-coded read-only list names `~/.claude/` paths directly. The *validator* is portable; the subsystem it reads is not. If a consumer needs command validation, the pattern store has to move first — that is a port, not a file move. |
| AgentExecutionGuard | Sounds product-ish and is not. It nags when `Task` is called without `run_in_background`, and the only justification it states is "the Algorithm's background execution rule" — ALGORITHM mode is PAI's. Nothing in rungate requires background spawns. Zero file dependencies, so it is cheap to port later if rungate ever adopts the rule. |

### UNMEASURED — could not determine

| Hook | Why |
|---|---|
| PolicyEnforcement | It loads `enforcement-policies.json` from its own directory and `process.exit(0)` immediately when the file is absent. **The file is absent from `~/.pai/hooks`.** So the hook is registered against every `PreToolUse` and does nothing on every call. What it *would* enforce is written in a file that exists in neither tree, and classifying it would mean guessing at policy content I cannot read. It also imports `lib/findWorkflow`, which suggests rungate machinery, but a suggestive import is not evidence of behaviour. **Resolve by finding or recreating the policy file, then re-classify.** |

## The eight duplicates

For each name present in both trees, the live copy follows
`~/.claude/settings.json` and — for project-scoped hooks — the repo's own
`.claude/settings.json`.

**The rungate copy is live in all eight cases, and the rungate copy should win
in all eight. No swap is recommended.**

The divergence is not eight unrelated drifts. It is one event: the rungate
copies were refactored to the thin-trigger pattern that
`specs/HOOK-ARCHITECTURE-SPEC.md` mandates (D-1 under 50 lines, D-2 logic in
`lib/`, SC-367, SC-369, SC-370, SC-371), and each carries its governing SC
numbers in its header. The `.pai` copies are the pre-refactor monoliths, almost
all last touched 2026-09-09/10, with the logic still inline and no SC
traceability. Preferring a `.pai` copy would mean reverting that refactor and
breaking the SCs that assert it.

| Hook | Live copy | `.pai` | rungate | How they diverged |
|---|---|---|---|---|
| AgentBriefGuard | **rungate**, project scope | 586 L / 20,605 b | 38 L / 1,372 b | Pre-refactor monolith vs thin trigger delegating to `lib/agent-brief-validation`. This is SC-367's 586→50 line extraction, with the old copy left behind. |
| AgentVerdictCapture | **rungate** | 134 L / 4,466 b | 87 L / 3,154 b | rungate adds `lib/agent-audit` and `lib/verdict-capture`; `.pai` keeps verdict parsing inline. |
| AutoVerifyGate | **rungate** | 138 L / 4,929 b | 79 L / 3,102 b | `.pai` carries a duplicated `import … from 'fs'` statement and inline workflow lookup; rungate routes through `lib/utils`. |
| GateEnforcement | **rungate** | 273 L / 8,467 b | 58 L / 1,948 b | SC-369's extraction: strike counting and signal shaping moved to `lib/gate-enforcement`. The 8,467 vs 1,948 byte gap is that move, not lost behaviour. |
| IssueCloseGuard | **rungate** | 554 L / 21,462 b | 149 L / 6,922 b | rungate delegates to `lib/github` and `lib/comment-template`; `.pai` inlines HMAC validation and gate-file discovery. |
| MergeGuard | **rungate** | 119 L / 3,310 b | 58 L / 2,267 b | `.pai` resolves paths through `lib/paths`; rungate through `lib/utils`. Same warn-on-merge behaviour. |
| StaleTTLCleanup | **rungate** | 133 L / 3,979 b | 108 L / 4,479 b | The one pair where the rungate copy is larger in bytes while smaller in lines: cleanup logic moved to `lib/stale-cleanup` and the hook gained documentation. |
| VerifyPhaseLock | **rungate** | 81 L / 2,653 b | 84 L / 2,939 b | Closest pair. rungate adds `lib/issue-create-override`, which is the follow-up-label escape hatch `.pai` hard-codes. |

### A correction to the issue's own premise

#713 states that `AgentBriefGuard` is "dead in both trees… wired nowhere". That
is false, and the same trap caught this classification's first pass: reading
`~/.claude/settings.json` alone returns zero hits, because the hook is
registered at **project** scope in the repo's `.claude/settings.json` as
`bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts` — the rungate copy.
`test/hook-tree-divergence.test.ts` already asserts this and already explains
why the negative reading was wrong. A hook is not unregistered until both
settings files have been read.

## What this classification does not cover

- **The three `.pai` files registered from neither tree**: `CompactRecovery`,
  `MarcusCommitCheck` and `OrphanProcessCleanup` are present in `~/.pai/hooks`
  and appear in no registration in either settings file. They are out of scope
  here because the brief scopes this to the 45 live registrations, but they are
  candidates for the same deletion pass as the eight superseded duplicates.
- **`handlers/BuildCLAUDE.ts`**, the 46th `PAI_HOOKS_DIR` entry point, is a
  handler rather than a `.hook.ts`. It builds Jason's `CLAUDE.md` — personal by
  inspection, listed here so the count of entry points reconciles.
- **Removal of the superseded copies is still blocked.** 53 of the 60 files in
  `~/.pai/hooks` carry the `uchg` immutable flag, and the two stale `.tmp` files
  that carry no flag are protected instead by the `PreToolUse` guard that
  refuses any Bash write to a hook path. Both blockers need Jason, and
  `test/hook-tree-divergence.test.ts` holds the ratchet in the meantime.
