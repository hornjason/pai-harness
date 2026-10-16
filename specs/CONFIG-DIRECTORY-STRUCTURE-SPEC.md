---
doc-type: spec
status: active
owner: jason
created: 2026-10-02
updated: 2026-10-14
governs: rungate config architecture — directory-based config replacing monolithic rungate.json, self-describing compliance policy, organize external sources
testable: true
compliance: strict
---

# Config Directory Structure

## Context

`rungate.json` is a 216-line monolith mixing four concerns: project identity, agent roles, hook registrations, and enforcement policy. Adding a new compliance rule or organize-project external source requires editing hardcoded maps in TypeScript — not config. Session 24 uncovered that DIR-L29 violations were invisible to hill-climb escalation because the DIR→COMP mapping was hardcoded and incomplete.

The organize-project tool (#30) also needs config for external source locations (`~/.claude/MEMORY/RESEARCH/`, `~/.claude/PAI/Specs/`, CONTEXT_ROUTING.md) rather than hardcoding PAI-specific paths.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | `.claude/rungate/` directory replaces `.claude/rungate.json` | Separates concerns, each file has a single purpose |
| D-2 | Config loader falls back to `.claude/rungate.json` if directory doesn't exist | Backward compatibility for existing consumers |
| D-3 | Compliance rules are self-describing — DIR mappings, thresholds, tier actions in config | New rules = new config entry, no code changes |
| D-4 | External sources for organize-project are config-driven | Not everyone uses `~/.claude/MEMORY/RESEARCH/` |
| D-5 | Hardcoded maps in lib/compliance-report.ts replaced by config reads | Single source of truth for escalation policy |

## Directory Structure

```
.claude/rungate/
  config.json           ← project identity, test config
  roles.json            ← agent definitions (briefs, tools, tiers)
  hooks.json            ← hook registrations
  compliance.json       ← enforcement policy (self-describing)
```

## Success Criteria

### Phase 1 — Config split (this session)
- [x] SC-474: `.claude/rungate/config.json` exists with project, repo, issueRepo, contextDocs, pages, test fields
- [x] SC-475: `.claude/rungate/roles.json` exists with agent role definitions
- [x] SC-476: `.claude/rungate/hooks.json` exists with hook registrations array
- [x] SC-477: `.claude/rungate/compliance.json` exists with rules, each having description, directives, reinforcement, tiers, threshold
- [x] SC-478: lib/config-loader.ts contains [loadFromDirectory, loadRungateConfig, .claude/rungate]
- [x] SC-479: lib/config-loader.ts contains [loadFromMonolith, rungate.json]
- [x] SC-480: lib/compliance-report.ts contains [getReinforcementMap, getTierPromotions, getComplianceConfig]
- [x] SC-481: lib/compliance-report.ts contains [normalizeDirToComp, getDirToComp, getComplianceConfig]
- [x] SC-482: .claude/rungate/compliance.json contains [externalSources, path, type, target, method]
- [x] SC-483: test/compliance-report.test.ts contains [loadRungateConfig, setComplianceProjectRoot, compliance.json]

### Phase 2 — External source scanning + file types (this session)
- [x] SC-484: Scaffold generates `.claude/rungate/` directory for new projects (behavioral)
- [x] SC-485: Re-scaffold splits existing `rungate.json` into directory structure (behavioral)
- [x] SC-486: lib/organize.ts contains [scanExternalSources, loadComplianceConfig, externalSources, matchBy]
- [x] SC-487: lib/organize.ts contains [artifactClassification, classifyDocument, non-markdown] — the extension list (.html, .pdf) is config data in `.claude/rungate/`, not source text; asserting it against the module was asserting that the design had NOT been made config-driven

### Phase 3 — the documented layout must reach the tier control (#310)

Migrating to the layout this spec recommends used to switch off the control
that decides how much of the harness runs. The Discovery setup prompt read the
config with `cat ${PROJECT_ROOT}/.claude/rungate.json 2>/dev/null || echo "{}"`,
which sees only the monolith — so a consumer who complied with this document
got `cat` failing, `echo "{}"`, empty `pages`, `hasUI === false`, a forced
LIGHT tier, and the scope gate, Quinn local, container verify, Quinn verify and
prove all skipped. No error, no log line. Shape 1 in
`.claude/rules/checks-must-be-able-to-fail.md`, attached to the tier control.

Tested as one chain rather than in parts, because every part was individually
correct: the loader handled both layouts, the tier logic computed properly, and
the whole defect was which of them the prompt called.

Two things the test had to get right, both of which it got wrong first:

- The statement that forces LIGHT is the `!hasUI` **downgrade**, not
  `ceremonyTierFloor`. The floor RAISES a tier — `floor('STANDARD', false)`
  returns `'STANDARD'` — so a test written against the floor reports the old
  fallback as harmless.
- The prompt explains in prose that there is "deliberately no `|| echo {}`
  fallback", so a detector reading the whole step reports the defect the text
  says was removed. The detector reads the step's command lines only.

- [x] SC-708: test/config-reaches-ceremony-tier.test.ts contains [18 resolved pages produce a NON-LIGHT tier] — the directory layout is carried all the way to the tier decision, through the real resolver subprocess, rather than the loader and the tier logic being checked separately and the gap between them assumed
- [x] SC-709: test/config-reaches-ceremony-tier.test.ts contains [an unresolvable config refuses instead of becoming] — a config that cannot be read exits non-zero and writes nothing, and is distinguished from a config that reads fine and has no pages, because collapsing those two makes every CLI project fail setup
- [x] SC-710: test/config-reaches-ceremony-tier.test.ts contains [the prose explaining the absent fallback is NOT read as the fallback] — the prompt names the token it forbids, so the boundary between its commands and its explanation is asserted rather than assumed

## The single-loader ratchet, measured (#309, 2026-10-14)

ADR-002 D4 requires the count be recorded here with its date, and measured on
the branch rather than quoted from the ADR. Measured 2026-10-14 by
`scanConfigAccess` / `scanPromptConfigAccess`, which strip comments before
counting — prose that discusses the config is not an access:

| Check | Scans | Files | Sites |
|---|---|---|---|
| CONFIG-1 | `lib/ gates/ scripts/ hooks/ generators/`, excluding `*.test.ts` and `test/` | 17 | 47 |
| CONFIG-2 | `workflows/*.js`, prompt bodies included | 3 | 14 |

ADR-001 proposed ~24 and ADR-002 measured ~89; both counted comment
mentions. 61 is the code figure. **That is the figure on the day the ratchet
was banked, not the standing one** — see the decrement below, and
`.claude/config-access-ratchet.json` for what is live.

`lib/config-loader.ts` is CONFIG-1's only allowlist entry. CONFIG-2's is
empty — no workflow has any business reading the config directly; it reads
the resolved artefact instead (ADR-002 D1).

**The numbers live in `.claude/config-access-ratchet.json`, not in source.**
`lib/conformity.ts` travels into every scaffolded project, and a consumer
with no ratchet file gets `{}` — zero tolerance, which is the right default
for a tree that never had the defect. The ratchet refuses in both
directions, and a file absent from it is allowed nothing, so a new reader
fails the suite even while the total is above zero.

**Decrementing it is the work, and it belongs to the migration.** Each entry
goes to zero as its reads move to `loadRungateConfig` / `tryLoadRungateConfig`
/ `resolveConfig`, and the entry is deleted in the same commit — the
both-ways ratchet refuses if you lower the count without removing a finished
entry, or remove reads without lowering the count.

`lib/conformity.ts` is deliberately absent from the table. It hosts the
checks and carried three reads of its own; those were migrated in #309 rather
than allowlisted, because an allowlist naming the exempt files becomes
evidence those files are referenced.

## The first decrement (#214, 2026-10-14)

ADR-001 D1 named the check and it was never built; #309 built it and banked
61 sites. A ratchet nobody lowers is one more artefact that certifies nothing,
so this is the first entry being earned off it.

| Check | Files | Sites | Change |
|---|---|---|---|
| CONFIG-1 | 17 → **10** | 47 → **38** | seven files migrated, nine reads |
| CONFIG-2 | 3 | 14 | untouched — ADR-002 D1's subprocess route, #307 |

Migrated: `lib/create-sc.ts`, `lib/task-completion-checks.ts`,
`scripts/fresh-eyes-test.ts`, `scripts/grade-deterministic.ts` (2),
`scripts/parallel-ship.ts`, `scripts/precompute-goal.ts`,
`scripts/test-brief.ts`.

### Six copies of one read, and six private answers

Each site did the whole thing by hand — `existsSync`, `JSON.parse`, pick a
key — and four wrapped it in a bare `catch` returning a default. Pointing six
copies at the loader would have removed the path construction and kept the
defaulting, which ADR-002 names as the defect under the defect: *"Drift was
not the failure. Defaulting was."* So the reads collapse into three accessors
in `lib/config-readers.ts`, each answering absence once and in the open, and
none of them catching a parse error — per ADR-001 D2, a malformed config is
never a missing config.

**What the migration fixes beyond the policy.** Every one of these read
`.claude/rungate.json` and nothing else. A consumer on the layout this
document tells them to adopt got `{}` from all of them: no custom matchers
(#212/#90), no roles for grading, no pre-flight hosts, no conformity run at
task completion, and a worktree named `project`. Silently — the same shape as
Phase 3's tier control, one layer down.

### Assert adoption, not existence

ADR-001 diagnosed its own failure as existence assertions over source text:
*"a loader that is written correctly and called by nothing satisfies them
perfectly."* Every criterion below runs the migrated function against a
project root on the directory layout and reads back an authored value. Each
accessor is also run against the monolith over the SAME authored values and
the two results compared to each other rather than to a literal — a reader
that handled only the directory form would pass the first assertion and be a
new instance of the same bug.

- [x] SC-1449: test/config-access-adoption.test.ts contains [the accessors read the directory layout] — roles, slug and pre-flight hosts are read back from `.claude/rungate/` and compared against the same values authored as a monolith, so neither layout can be the only one that works
- [x] SC-1450: test/config-access-adoption.test.ts contains [a corrupt config throws rather than reading as unconfigured] — absence returns the empty value and malformed JSON throws, which is the distinction four bare `catch` blocks erased
- [x] SC-1451: test/config-access-adoption.test.ts contains [loadRegistry picks up customMatchers authored in the directory layout] — the migrated call sites are executed against a fixture, not asserted to import the loader
- [x] SC-1452: test/config-access-adoption.test.ts contains [no migrated file keeps a private reader beside the shared one] — every migrated file is named and asserted gone from the ratchet, so a revert cannot put one back while the suite stays green
- [x] SC-1453: test/task-completion-checks.test.ts contains [blocks rather than throwing when the config cannot be read] — the one migrated site whose throw crosses into a gate converts it to a blocker instead, because a hook that exits 1 is neither allow nor block

### Letting the loader throw is right everywhere except into a gate

The push security review flagged `lib/task-completion-checks.ts` as a
fail-open regression, and it was right. `checkConformity` is reached from
`hooks/TaskCompleted.hook.ts`, which has **no `catch`**. Hook exit codes are
`0` allow and `2` block; an escaping throw exits `1`, which is neither — so
one unparseable byte in the config would have disabled the **entire**
completion gate, not merely the conformity part of it. The old code could not
do this: it checked `existsSync` and never parsed.

So this site catches, and returns a blocker naming the config. That keeps
ADR-001 D2's distinction — the unreadable config is still not an unscaffolded
project — while keeping the gate closed, which is the direction a gate is
allowed to be wrong in.

Checked at the other five migrated sites and not repeated: `loadRegistry`,
`grade-deterministic` and `test-brief` are CLIs where a throw is a non-zero
exit, and `parallel-ship` and `precompute-goal` already called bare
`JSON.parse` with no catch, so their behaviour on a corrupt config is
unchanged.

Run and counted over `test/task-completion-checks.test.ts` (12 tests, 0 red):

| Mutation | Red |
|---|---|
| the throw escapes into the hook again | 1 |
| an unreadable config is treated as unscaffolded | 1 |
| the gate blocks but says nothing about the config | 1 |
| the layout check goes back to the monolith only | 2 — the directory-layout case as well, which is the #214 migration itself |
| the parser's message is quoted back into the blocker | 1 of 13, after the second review finding below |

### A refusal that quotes the file it could not parse

Second push-review finding on the same function, and also correct.
`JSON.parse` names the token it choked on — `Unexpected identifier "ghp_…"` —
so a config whose malformation sits beside a credential would print it into a
blocker that reaches stderr and is captured in the transcript. The fix
reports the error **class** and a command the operator can run locally, which
keeps the refusal actionable without making the message a channel out of the
file. `.claude/rules/checks-must-be-able-to-fail.md`'s control-arm rule
applies in reverse here: a refusal redacted to the point of being unreadable
is worse than the leak for the 99% of refusals that quote nothing sensitive,
so the class stays.

### A refusal is not a place to put a command someone will paste

Third push-review finding, and the one that caught the fix for the second.
The replacement for the parser's message was a `bun -e '…${projectRoot}…'`
line for the operator to run. `checkConformity` is a library function and the
root arrives from its caller, so a path carrying `'; rm -rf ~; '` would have
been printed as a command a human is being told to execute. **A refusal that
hands someone a line to paste is an execution path with a person in the
middle of it**, and #155 already established that a path reaching this code
can originate outside it.

The blocker now names the loader function and JSON-quotes the path, which
escapes a quote or a newline so a crafted root can neither close the
surrounding quote nor forge a second line. It is still actionable — the root
and the function are what an operator needs — and there is nothing in it to
run.

| Mutation | Red |
|---|---|
| the pasteable command comes back | 1 of 14 |
| the path is interpolated raw instead of JSON-quoted | 1 of 14 |

### What was broken to prove it (SC-1449..1452)

Run and counted over `test/config-access-adoption.test.ts` +
`test/config-access-conformity.test.ts` (28 tests, 0 red). None is left in the
tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `loadRegistry` reads the monolith only, as before | 2 — the customMatchers case, and CONFIG-1, because the reintroduced path is on no ratchet entry |
| the grader's role reader goes back to the monolith | 2 — same pair |
| brief-path resolution goes back to the monolith | 2 — same pair |
| the worktree slug goes back to the monolith | 2 — same pair |
| `loadRoleConfig` catches the parse error and returns `{}` | 1 — only the malformed case; no path is constructed, so CONFIG-1 stays green, which is exactly the bug CONFIG-1 cannot see |
| the `"project"` default moves from the call site into the accessor | 2 — a second unconfigured repo would name the same worktree |
| a migrated file is left banked on the ratchet | 2 — SC-1452 and CONFIG-1's under-its-number refusal |

The fifth row is the one worth reading. A bare `catch` around a config read is
invisible to CONFIG-1 — the check sees path construction, not defaulting — and
ADR-002 lists it as a risk to be caught in review. It is caught by a test
instead.

### What this does NOT fix, stated plainly

- **The remaining 38 sites are #307's.** `gates/`, `lib/scaffold/steps.ts`,
  `lib/scanner.ts` and `scripts/resolve-config.ts` are sequenced by ADR-002's
  implementation brief with semantics this change does not touch
  (`UNMEASURED` baselines, the resolved-config artefact). Migrating them here
  would collide with work already specified.
- **Three banked entries are not reads at all.**
  `lib/generators/agent-briefs.ts` (2) and `lib/scaffold/owned-files.ts` (3)
  carry the path inside *user-facing strings* — "check
  `.claude/rungate/config.json`" — and `scripts/scaffold-rungate-config.ts`
  (2) is the writer that creates the file. None can route through a read
  loader, so those 7 sites cannot reach zero by migration, and the obvious
  way to clear them is to reword documentation to satisfy a grep. Filed as
  #415.
- **`scripts/create-brief.ts` writes.** It registers a new role in the
  monolith and does nothing on the directory layout, which is a real
  consumer bug — but a writer, not a reader, and a different class. Filed
  as #415.

## A fix for new projects is not a fix (#121)

#75 stopped NEW projects being scaffolded with `roles: {}` / `hooks: []`. It
did nothing for projects already in that state, **and those projects were
told they were healthy.**

`generateOrAuditProjectHarness` has three branches:

| project state | branch | writes roles/hooks? |
|---|---|---|
| no config at all | greenfield | yes — what #75 fixed |
| monolith carrying roles/hooks | `splitMonolithToDirectory` | yes — preserves existing |
| `.claude/rungate/config.json` exists | `auditExistingConfig` | **never** |

Anything scaffolded before #75 has `config.json`, so every re-scaffold takes
the audit branch. There was no path that repaired it.

**It was worse than a no-op, because the audit asserted health.**
`auditExistingConfig` was not even passed the project root, so it could not
have read `roles.json` if it wanted to — and it reported
`AUDITED: rungate.json (aligned with code)` over zero roles and zero hooks.
A check that passes because of what it never looked at, in the shape that
does the most damage: not silence, but an active statement that there is
nothing to fix, read by exactly the person re-scaffolding to fix it.

Measured on `~/Projects/agentgrit`, the motivating project, still in this
state months after #75 merged: `config.json` 14 entries, `roles.json` 0,
`hooks.json` 0. After the repair, on a copy, read back through the real
`loadRungateConfig`: 6 roles, 9 hooks.

### Four states, not two

The first draft asked `sidecarIsEmpty()` and the boolean hid a case. An
**unreadable** `roles.json` is neither empty nor populated:

- repair must not touch it — overwriting a file we failed to parse is how a
  repair destroys work, which #370 and #208 already settled for every other
  owned file
- the audit must not call it aligned either

A boolean forced those two needs onto one answer and whichever way it fell,
one of them was wrong. `sidecarState` returns `missing | empty | unreadable
| populated`; repair fills the first two, preserves-and-reports the third,
and the audit refuses "aligned" for anything but the fourth. That last
branch is the one door the repair cannot close, so it is where the audit's
own check is load-bearing.

- [x] SC-849: lib/scaffold/steps.ts contains [sidecarState] — FOUR states, so "do not overwrite a broken file" and "do not call a broken file aligned" can both hold. A boolean could satisfy only one
- [x] SC-850: lib/scaffold/steps.ts contains [repairEmptySidecars] — the audit branch repairs, from the SAME `buildDefaultRoles`/`buildDefaultHooks` the greenfield branch uses. A second source of defaults would drift and nothing would notice
- [x] SC-851: lib/scaffold/steps.ts contains [PRESERVED: .claude/rungate/] — a withheld write is REPORTED. A run that quietly declined is indistinguishable from one that had nothing to do
- [x] SC-852: lib/scaffold/steps.ts contains [AUDIT: ${issue}] — every gap reaches the actions, not just its count. The detail went to `console.log` alone, so the returned report said `1 gaps` and nothing about which

### What was broken to prove it (SC-849..852)

Run and counted over `test/scaffold-config-repair.test.ts` (11 tests):

| Mutation | Red |
|---|---|
| `repairEmptySidecars` removed from the audit branch — the defect, verbatim | 7 of 11 |
| the audit stops being passed the directory — it cannot look, which is how it shipped | 1 of 11 |
| repair overwrites a populated file — the opposite failure | 2 of 11 |
| `unreadable` treated as `empty` — a broken file gets clobbered | 1 of 11 |
| the audit stops flagging a non-populated sidecar | 1 of 11 |
| repair seeds from its own defaults rather than the greenfield ones | 4 of 11 |
| `hooks.json` dropped from the sidecar table — half the defect returns | 5 of 11 |
| gap detail stops reaching the actions — a count with no names | 1 of 11 |

No zeros. None is left in the tree; all were run and reverted.

**The control arms are three of the eleven and they are the point.** "Some
roles appeared" is satisfied by a `--fix` that rewrites the whole config
directory, so a populated `roles.json` must come back byte-identical, a
mixed project must have only its empty file touched, and a populated
project must still be reported as aligned — otherwise a gap reporter that
always reports a gap passes every other case.

**One assertion was wrong in the first draft and the correct output caught
it.** It asserted that the run never says "aligned with code" over an empty
config. After the repair runs, the project IS aligned — the word is true,
and the honest report is `REPAIRED … REPAIRED … AUDITED (aligned)`. The
assertion moved to where it still bites: the unreadable case, where the
repair steps aside and "aligned" would be a lie.

## A detector wider than what it detects (#415)

ADR-002 D4 accepted one limit on CONFIG-1's string matching and stated it:
a path assembled by concatenation goes uncaught. That is the NARROW
direction. The wide direction was never considered, and it is the one that
had teeth — **the detector counted a path MENTIONED in a sentence the same
way it counted one passed to `readFileSync`.**

Measured on the tree at the time this shipped: of the 38 sites banked for
TypeScript sources, **19 were not reads at all.** Operator messages
(`expected …/config.json or …json`), generated brief text (`not configured
— check …`), the `customize:` field shown to a human, rows in a generated
key-files table, and the comment header of a generated CI workflow. The
issue that filed this found seven of them by hand; the classifier found
nineteen, which is the argument for measuring rather than enumerating.

**Why this is not pedantry.** None of the nineteen could ever reach zero by
migrating a read, because there was no read. The cheapest way to clear one
was to reword a user-facing string so it stopped naming the file it was
telling the operator to edit — the detector driving the code rather than
measuring it. ADR-002 D4 requires the ratchet be interpretable, and
`.claude/rules/checks-must-be-able-to-fail.md` says *"a ratchet nobody can
interpret becomes a number nobody lowers."*

### The decision, and which way each branch may be wrong

`classifyConfigSites` in `lib/conformity.ts` is the one binding. It reads two
views produced by the EXISTING `stripJsComments` scanner — the
comment-stripped source, and the same source with every literal's contents
blanked — so there is no second lexer to drift. Over the blanked view a naive
paren counter is exact, and the literal a match sits in is the maximal run of
blanked offsets around it.

| Around the match | Verdict |
|---|---|
| an `fs` call or a `node:path` builder | USE, whatever the text says |
| otherwise, prose | MENTION |
| otherwise, a path-shaped literal into `x.push(…)` or `console.*` | MENTION |
| otherwise | **USE** |

The last row is the fail-closed default and it is what keeps `const p =
"…json"; readFileSync(p)` counted. `node:path` builders are receiver-checked
because `["a","b"].join(", ")` shares a name with `path.join`.

**CHECK-2 does not use the classifier and must not.** CHECK-1's subject is a
path being built in code, so a sentence naming the file is noise. CHECK-2's
subject IS the sentence — `Read ${PROJECT_ROOT}/…` in a prompt is the
violation, and it is prose by construction. Pointing one classifier at both
would silently empty CHECK-2, so SC-1552 runs one sentence through both scans
and asserts they disagree.

### The writer had no loader (#415 part 2)

`scripts/create-brief.ts` built `.claude/rungate.json`, handed it to a writer
and, on a consumer that had followed the documented migration, printed
`not found — role not registered in config`. The brief was written, the role
was registered nowhere, and the message named a file the project is
documented not to have. It was banked at 1 and could not migrate to the read
loader, because it is a WRITE.

So `lib/config-loader.ts` becomes the module that knows where config LIVES,
in both directions: `writeRoleConfig` picks the same file `loadRoleConfig`
would read, and `writeScaffoldedConfig` creates the directory layout for
`scripts/scaffold-rungate-config.ts`. Both scripts leave the ratchet by
migration, not by rewording. Neither has a third branch that invents a
layout — a tool that creates a monolith beside an existing directory gives
the project two role sets and lets the reader's preference decide what the
project is, which is #70 one layer up.

- [x] SC-1550: test/config-access-mentions.test.ts contains [only the path handed to an fs call is counted] — one fixture file carries five mentions and one read, so neither half of the answer can hold vacuously; the raw match count is asserted at six so that "one" is a decision and not a scan that read less of the file
- [x] SC-1551: test/config-access-mentions.test.ts contains [a path-shaped literal with no fs call behind it still counts] — the fail-open this classifier could have shipped, asserted shut: a bare `const` path read a line later has no enclosing call to recognise and nothing prose-like about it
- [x] SC-1552: test/config-access-mentions.test.ts contains [CHECK-2 still counts a prompt that tells an agent to read the config] — one sentence through both scans, with opposite answers, so the two checks cannot be collapsed onto one classifier in the name of consistency
- [x] SC-1553: test/config-access-mentions.test.ts contains [both branches are load-bearing on real source] — the scaffold steps module carries both kinds and its banked number equals the measured use count, so collapsing the classifier in EITHER direction moves a number the both-ways ratchet refuses
- [x] SC-1554: test/config-access-mentions.test.ts contains [the documentation and writer sites are gone from the ratchet] — the six cleared files are named and asserted absent, and the real check is run over the real repo so an entry banked above what remains fails exactly as a new reader does
- [x] SC-1555: test/config-access-mentions.test.ts contains [a directory-layout project gets the role, and the loader reads it back] — the CLI is spawned against a directory-layout fixture and the role is read back through `loadRoleConfig`, not through the file the writer happened to pick; the monolith is asserted NOT to have been created
- [x] SC-1556: test/config-access-mentions.test.ts contains [a monolith project still gets the role, in the monolith] — the same CLI over the other layout, with the two answers compared to each other rather than to a literal, because a writer that handled only one layout would pass the first case
- [x] SC-1557: test/config-access-mentions.test.ts contains [an unscaffolded project is told so, and nothing is invented] — absence is reported as absence and no layout is created, which is the branch that would otherwise quietly restore the monolith on every consumer

- [x] SC-1558: test/config-access-mentions.test.ts contains [the scaffolder refuses a project that already has a config] — the second run is compared against an AUTHORED edit, not against untouched bytes, because a scaffolder that had stopped refusing would rewrite an untouched config identically and pass
- [x] SC-1559: test/config-access-mentions.test.ts contains [a project with nothing to detect still writes a readable config] — the control arm, and the one that bit: with a package.json present every command is inferred and no `null` is ever written, so the fixture that plants one cannot see the defect

### The case #415 fixed and nobody drove (#454)

#454 reported that CONFIG-1 counts a config path spelled inside a string
literal, including when the string is prose explaining why a step does *not*
touch the config — the self-reference trap from
`.claude/rules/checks-must-be-able-to-fail.md` arriving from the documentation
side. It named the cost precisely: the reason-carrying map is a house pattern
now (`STEPS_NOT_REHEARSED` in `lib/scaffold/rehearsal.ts:61`, #398; the
exclusion maps in #452), and a sentence about the config could not be written
in one without turning CONFIG-1 and the ratchet red for a file that reads no
config at all.

**Measured on main before writing anything: four of its five criteria were
already satisfied.** #415 landed `classifyConfigSites` in `ff4a2872` (PR #456)
hours before #454 was filed, and the issue's own four-case table reproduces
the other way round today — `lib/reason-string.ts` classifies as `mention`,
not as a counted site. SC-1 and SC-2 are `classifyConfigSites`, one exported
predicate; SC-3 is SC-1553 and SC-1554 above, which account for the ratchet
change file by file.

What was NOT driven is the shape the issue is actually about. SC-1550 covers a
sentence inside a shell command and SC-1552 covers a bare prose string;
neither is a key paired with a reason, and the pattern is spreading. So the
issue closes with one test rather than a fix, and the test is in the file that
would notice if the rule were narrowed back.

- [x] SC-1657: test/config-access-mentions.test.ts contains [a reason-carrying map may name the config and an assembled path beside it still counts] — the house key-plus-reason map is permitted to name the config while a path assembled from parts in the same file is still refused and both arms run through one scan so neither can hold vacuously

Driven in one fixture: three sites, two excused, one counted. The site count
is asserted alongside the verdict because deleting the map outright would
otherwise produce the same `1`.

Re-running the battery below against this tree reproduces every row, with one
correction to my own prediction rather than to the code: *path, fs and shell
calls stop being recognised* was predicted at 3 and measured **1** — the same
1 the table already records. The reason is worth stating because it reads like
the fourth shape and is not: `isPathCall` only changes a verdict for a literal
that CONTAINS WHITESPACE, because every other site reaches the same `"use"`
through the fall-through. Its one row is the shell command SC-1550 exists for.
The number was already written down here; reading the table first would have
saved the prediction.

### What was broken to prove it (SC-1550..1559)

Run and counted by hand over `test/config-access-mentions.test.ts`,
`test/config-access-conformity.test.ts`, `test/config-access-adoption.test.ts`,
`test/create-brief.test.ts`, `test/scaffold-conformity.test.ts` and
`test/scaffold-greenfield-config.test.ts` (777 tests, 0 red):

| Mutation | Red |
|---|---|
| the classifier counts every mention again — the defect verbatim | 6 |
| the classifier calls every site a mention — the narrowing overshoots | 6 |
| `isTextCall` returns false — a path-shaped literal in a message list counts | 5 |
| CHECK-2 is given the classifier too | 4 |
| the role writer invents a monolith instead of refusing | 2 |
| the fail-closed default flips to mention | 1 |
| path, fs and shell calls stop being recognised | 1 |
| a shell command naming the config stops being a read | 1 |
| the role writer points at the monolith only — #415 part 2 verbatim | 1 |
| the scaffolder writes `null` for an uninferred command again | 1 |
| the dev command goes back to a key the validator deletes | 1 |
| the scaffolder stops refusing an existing config | 1 |

No zeros. None is left in the tree; all were run and reverted.

**Four of the twelve were zero on the first pass, and all four were real.**
Predicting each count before running is what caught them — a one where two
was expected is as much a finding as a zero, and much easier to wave through.

- *Shell reads went uncounted.* A `cat …/config.json | head` handed to
  `execSync` is a config read whose literal is a SENTENCE, so the prose rule
  swallowed it. `SHELL_CALLS` exists because of that zero, not before it.
- *The scaffolder refused twice.* The script pre-checked the resolution AND the
  library refused, so deleting the library's guard changed nothing — it
  measured as load-bearing while nothing depended on it. Two deciders that
  agree are behaviourally one. The decision now lives only in
  `writeScaffoldedConfig`, which RETURNS the outcome rather than throwing, so
  the caller reports it without sniffing an exception message for a prefix.
- *A re-scaffold could not be caught by comparing bytes.* An untouched config
  is rewritten identically, so the fixture now authors an edit first.
- *The `null` command was unreachable from the fixture.* A project with a
  package.json infers every command, so SC-1559 scaffolds a bare directory.

### Two defects the migration surfaced in the scaffolder

Neither is in #415's class and both are in the blast radius of its fix, so
they are fixed here rather than filed: making the scaffolder ask the loader
where config lives also makes the loader read what the scaffolder wrote.

1. **An uninferred command was written as `null`.** `test.command` and
   `prod.rebuild` are `z.string().optional()`, so `null` does not read as
   "not detected" — it FAILS validation. Every resolution over a project
   scaffolded by this script with no package.json and no Makefile threw. It
   was invisible for as long as the script never read back what it wrote.
2. **The detected dev command went to a key the validator deletes.** `command`
   is not a field of `DevSchema`; the loader stripped it and the inference
   reached nobody. That is Silent Default Substitution from the writing side.
   It is now `dev.start`, and SC-1558 asserts the round trip.

## A baseline nobody measured, reported as a clean tree (#307 Phase 1)

`captureTestBaseline` runs the project's suite before any change lands so the
verify gate can subtract pre-existing failures from the ones the change caused.
It answered `0` for four different facts, and the scope gate printed
`Test baseline: 0 pre-existing failures — clean suite` for all four:

| What happened | What was recorded |
|---|---|
| no `.claude/rungate.json` — the path was built here by hand, so **every consumer on the documented directory layout took this branch** | `0`, clean suite |
| no `test.command` — including every consumer that authored `dev.testCmd`, the spelling ADR-002 D3 normalises *to* | `0`, clean suite |
| the suite ran and printed something unparseable — jest, pytest, a Makefile target, a timeout kill | `0`, clean suite |
| the suite ran and nothing was failing | `0`, clean suite |

Only the last is a clean tree. A fabricated baseline is the worst direction for
this particular number to be wrong in, because it asserts the strongest claim
the run can make about the tree it started from, and because nothing downstream
can tell it from a measurement.

**It worked on rungate the whole time.** This repo's own config carries
`test.command`, so branch 2 was never taken here, and any fixture shaped like
this repo is green against the broken code and the fixed code alike. That is
not a detail about the fixtures — it is the reason the defect survived a year
of green suites, and it is why SC-A7 of #307 requires the consumer shape
explicitly.

### Absent, not zero

An unmeasured baseline records **no number**. A `0` beside a reason would leave
the verify gate's `?? 0` reading the run as a measured clean tree, and the two
keys would be a second answer to the same question — the fourth shape in
`.claude/rules/checks-must-be-able-to-fail.md`. Absence is the only encoding a
default cannot absorb.

The verify gate WARNs rather than FAILs on it. No subtraction happens either
way — an unmeasured baseline and a measured zero both subtract nothing — so the
arithmetic is not what the branch is for. What it stops is the run claiming a
clean starting tree it never looked at. The house precedent is
`dev-server-liveness: UNMEASURED`: a probe that could not run must never become
a defect in the code it could not measure.

### The parser gained a nullable sibling rather than a new contract

`extractTestFailureCount` is pinned by `gates/workflow.test.ts`, which #307 is
forbidden to change, and its contract — "no fail line means zero" — is wrong
for a baseline and right for the gate's own bun output. So the honest reading
is a second export, `parseTestFailureCount`, returning `number | null`, and the
old function became a one-line wrapper over it. One binding, two readings, and
the two are compared against each other in the test so the wrapper cannot drift
away from the parser it wraps.

Bun prints ` 0 fail` on a clean run. Output carrying no fail line at all is a
runner that crashed, timed out, or is not bun.

### The heal prompt sent an agent to find a file the consumer does not have

The scope gate's heal prompt told an agent to read the project's monolith
config for `apiUrl` and, failing to find the key, to write `SKIP`. Two defects
in one sentence, and they compound. A consumer on the documented directory
layout does not have that file, so the agent finds nothing — and the sentence
tells it what to do about finding nothing. A project serving a live API records
"this check does not apply", and a skip for *no server here* and a skip for *I
could not locate the config* are the same two letters in the state file.

The decision was also the agent's to make, when the workflow already knew the
answer: it resolves the config before any prompt is written and interpolates
`${testCommand}` from it three lines above. The URL was the one value left for
an agent to go and find.

So the clause is built by the workflow and the agent is handed a conclusion.
**When a URL resolved, SKIP is not offered at all** — an agent that cannot
complete the curl has found a FAIL, which is the asymmetry the gate exists for.
It lives in a marked block and is EXECUTED by its test, because a prompt test
that greps for a URL passes against a prompt that mentions the URL and still
says SKIP.

### The timeout moved, deliberately

This site used `harness.test?.timeout || 300000`; the resolver's default is
`DEFAULT_TEST_TIMEOUT` (120000), which is the one ship.js already uses. Two
defaults disagreeing is the defect class, so the resolved value wins and a
consumer that sets no `test.timeout` now gets the shorter one. The consequence
of a kill is no longer a fabricated `0`: it is UNMEASURED naming the timeout,
which is a sentence an operator can act on.

- [x] SC-1672: test/test-baseline-unmeasured.test.ts contains [a project whose only test command is dev.testCmd is measured - not assumed clean] — the consumer shape #307 SC-A7 requires, measured at 3 pre-existing failures where the old reader returned 0; a rungate-shaped fixture is green either way and proves nothing
- [x] SC-1673: test/test-baseline-unmeasured.test.ts contains [a project on the directory layout is read at all] — the same assertion over `.claude/rungate/`, because a reader that handled only one layout passes the case above
- [x] SC-1674: test/test-baseline-unmeasured.test.ts contains [a project with no test command anywhere reports UNMEASURED - not zero] — and the reason names BOTH spellings, because "no test command" sends an operator looking for the key they already did not set
- [x] SC-1675: test/test-baseline-unmeasured.test.ts contains [an absent config is UNMEASURED - a project with no rungate is not a clean tree] — the branch every unscaffolded project took, which reported the strongest available claim about a suite that was never run
- [x] SC-1676: test/test-baseline-unmeasured.test.ts contains [output the harness cannot parse is UNMEASURED - not a clean suite] — the consumer-facing half: `dev.testCmd` is whatever the project runs and none of jest, pytest or go test prints bun's fail line; the reason quotes what the command actually printed
- [x] SC-1677: test/test-baseline-unmeasured.test.ts contains [parseTestFailureCount returns null where extractTestFailureCount returns zero] — the two readings asserted against each other on the same input, and agreeing where a count IS stated, so the wrapper cannot drift away from the parser
- [x] SC-1678: test/ship-local-env-clause.test.ts contains [a resolved URL reaches the prompt and no file is named] — the clause is executed out of its marked block rather than grepped, because a prompt that mentions the URL and still says SKIP passes a grep
- [x] SC-1679: test/ship-local-env-clause.test.ts contains [SKIP is not offered when a URL resolved] — both fields, and each clause must also say what replaces SKIP; "not SKIP" with no second option is an instruction an agent resolves by picking one anyway
- [x] SC-1680: test/ship-local-env-clause.test.ts contains [a project with no URL still skips - and says which key it looked for] — the branch that must stay reachable, since rungate sets no `dev.apiBase` and a clause that had stopped being able to skip would turn every self-run red
- [x] SC-1681: test/test-baseline-unmeasured.test.ts contains [an unmeasured reading records no number - the reason cannot sit beside a zero] — the recording half, executed: an honest reading buys nothing if the lines that store it write a `0` anyway, and a `captureTestBaseline` test cannot see that
- [x] SC-1682: test/test-baseline-unmeasured.test.ts contains [a later measured reading clears the earlier reason - the two keys are exclusive] — both directions over one object, because a recorder that only ever adds leaves a stale reason beside a fresh number and the verify gate gets two answers to pick from
- [x] SC-1683: test/test-baseline-unmeasured.test.ts contains [the verify gate separates an unmeasured baseline from a measured zero] — they subtract the same nothing, so the arithmetic cannot tell them apart and this decider is the only place that can; the subtraction #599 added is asserted in the same test, clamped

### What was broken to prove it (SC-1672..SC-1683)

Run and counted over `test/test-baseline-unmeasured.test.ts` and
`test/ship-local-env-clause.test.ts` (17 tests, 0 red). Every count was
predicted before the mutation ran.

| Mutation | Predicted | Red |
|---|---|---|
| the old reader restored verbatim — the defect | 6 | 6 |
| `parseTestFailureCount` returns `0` where it returned `null` | 2 | 2 |
| `recordTestBaseline` writes `0` beside the reason | 1 | 1 |
| `baselineAdjustment` drops the unmeasured branch | 1 | 1 |
| `localEnvClause` offers SKIP whether a URL resolved or not | 2 | 2 |
| `localEnvClause` ignores its `field` argument | 1 | 1 |
| the measured branch stops clearing a stale reason | 1 | 1 |

No zeros, no misses. None is left in the tree; all were run and reverted.

The first row is the one worth reading. Restoring the old reader turns SIX of
seventeen red, and five of the six are cases this repo could never have
produced: a consumer on the directory layout, a consumer spelling the command
`dev.testCmd`, a runner that is not bun, a project with no config, and a suite
that exits non-zero. The sixth — a genuinely clean suite — stays GREEN under
the mutation, because the broken reader and the fixed one agree there. That is
the whole shape of the defect in one row: the only case rungate's own config
exercises is the only case the two readers answer the same way.

The last three rows are the propagation, and they exist because the mutation
battery is what forced them out of an `if/else` inside `executeGate`. An
inline branch nothing can call scores 0 red — correctly — and a 0 there would
have been read as "the tripwire costs nothing", rather than as "nothing
asserts this".

### A heal round that removes a test (#307 SC-A19)

A heal agent is told a gate failed and asked to make it pass. Deleting the
test is a correct solution to that instruction and an incorrect solution to
the problem, and nothing downstream can tell the two apart: a suite with the
failing test removed is green, and green is what it asked for.

Run `wf_5cdce852-1e2` went from 34 tests to 23 across two heal rounds — no
`skip` recorded, no `todo` recorded, three guards with nothing replacing them,
and `SECURITY_REVIEW_STALE` was the only thing that noticed, while looking at
something else. Those three guards are back in
`test/adr-002-regression-guards.test.ts` (#314). This is the mechanism for the
fourth.

**Where it lives, and why not in the workflow.** `workflows/ship.js` has no
filesystem access and could only have asked an agent to check. A guard whose
subject is an agent's edits cannot be an instruction to an agent. Every heal
round ends in a gate re-run, so "since the last gate run" and "across a heal"
are the same window — the census is taken by `gates/gate-executor.ts` on every
gate and compared to the one the previous run banked.

**Three decisions worth stating, because each is a way the guard could have
been decorative:**

1. **Declarations, not passing tests.** Running the suite twice per heal round
   costs this project about thirteen minutes a round, and "the number of
   passing tests went down" also moves when a heal legitimately fixes a
   failure. The question actually asked is whether a test stopped existing.
   `.skip` and `.todo` count, because converting a failing test to `test.todo`
   removes the check just as thoroughly and is the cheapest way past a count
   that only looked at live ones. Comments are not stripped, for the same
   reason.
2. **The first reading is not a pass.** A run with nothing to compare has not
   been checked. A verdict that answered `no-regression` there would be the
   reading nobody took wearing the answer's clothes.
3. **A refused round does not bank the reduced census.** Banking the tree the
   deletion produced would make the next round compare against it, find no
   regression, and clear the refusal — a guard you only have to get past once.
   The reading stays where it was until the test comes back.

- [x] SC-1684: test/test-census.test.ts contains [skipped and todo tests are counted - converting one is removing it] — `test.todo` is the cheapest way past a counter that only sees live tests, and commented-out is covered by the same decision not to strip comments
- [x] SC-1685: test/test-census.test.ts contains [a word ending in test is not a test - the counter is anchored] — `subtest(`, `re.test(` and `latest` are asserted at zero while all five declaration forms bun uses are counted in one expression, so narrowing the pattern cannot quietly drop one
- [x] SC-1686: test/test-census.test.ts contains [a deleted file is a regression of its whole count] — the obvious way past a per-file comparison, since a loop over the later census never visits a file that is gone; both numbers are named because "a file lost tests" is not actionable
- [x] SC-1687: test/test-census.test.ts contains [the census reads real files on disk - and only test files] — the comparison is pure and could be right over a census nobody took, so this is the arm that says the walk reaches a subdirectory and stops at non-test sources carrying the same token
- [x] SC-1688: test/test-census.test.ts contains [the first reading of a run is not a pass] — nothing to compare and nothing removed are different verdicts, asserted beside both real answers
- [x] SC-1689: test/test-census.test.ts contains [a refused round does not bank the reduced census] — and restoring the test clears it, because a guard with no way out gets deleted rather than satisfied

#### What was broken to prove SC-1684..SC-1697

Re-run against the final tree, over `test/test-census.test.ts` (15 tests),
with `test/test-baseline-unmeasured.test.ts` and
`test/ship-local-env-clause.test.ts` alongside for the shared rows (0 red
before each). Predicted before each run.

| Mutation | Predicted | Red |
|---|---|---|
| the counter ignores `.skip` and `.todo` | 2 | 2 |
| `censusRegressions` skips the deleted-file case | 1 | 1 |
| the first reading reports `no-regression` | 2 | 2 |
| `nextCensus` always banks the current reading | 2 | 2 |
| the counter drops its lookbehind anchor | 1 | 1 |
| the walk takes any non-directory, symlinks included | 1 | 1 |
| the size cap is removed | 1 | 1 |
| `persistTestCensus` writes the whole in-memory object | 1 | 1 |
| `readPersistedCensus` accepts an array | 1 | 1 |
| an empty census reports `first-reading` instead of UNMEASURED | 1 | 1 |
| `nextCensus` drops its unmeasured arm | 1 | 1 |
| `nextCensus` drops its regression arm | 1 | 1 |
| `censusOf` stops recursing | 4 | 4 |

None is left in the tree; all were run and reverted.

**The fourth shape, caught here rather than recorded into the rule.** The
empty-census row came back ONE where TWO was predicted, which is the
signature. `nextCensus`'s two arms — regression and unmeasured — were
behaviourally one decider: the only way to be `unmeasured` is an empty
census, and an empty census ALSO makes every previously-known file "gone",
so `censusVerdict(before, {})` short-circuits to `unmeasured` but would fall
through to `regression`, and `nextCensus` treats the two identically.
SC-1692 was routing its case through `censusVerdict` and therefore testing
the regression arm while claiming to test the unmeasured one. Disabling the
unmeasured branch left it green.

Both arms are kept — they differ in what the operator sees, and that
difference is the point: `regression` FAILs the gate naming every file as
deleted, which is exactly the false refusal a polyglot consumer with no JS
suite would get on its second round. So the fix is the rule's second option:
each decider gets an input only it reaches, written down as a case saying
which one it is for. SC-1692 now builds an `unmeasured` verdict literal with
a NON-empty current census, which nothing but that arm can answer, and keeps
the shared empty-census case beside it. The two arms now mutate to one red
each, in different tests.

**And one row higher than predicted, which is the opposite signature.**
`censusOf` stops recursing was predicted at 2 and measured 4. Two were
expected — the four-file fixture, and the real-repo arm written as a backstop
against a walk that reads nothing, which turns out to be load-bearing for
recursion too (**39 of this project's 309 test files are in subdirectories
and carry 488 of its 5,299 declarations**, so a flat walk crosses its
threshold). The other two are the `src/` and symlink fixtures added by the
review passes, both of which plant a nested file. A higher row means the
binding reaches further than the prediction did, which is news about the
prediction and not about the code.

#### Three defects a security review found in the guard itself

All three had the same shape as the thing SC-A19 guards against: the check was
present, called, and unable to fire.

1. **The refusal was counted where a later step erases it.** The census
   `fails++` was written ABOVE the verify gate's `subtractTestBaseline`, which
   cannot tell a census refusal from a suite failure. A run carrying three
   pre-existing failures would have had the deleted-test refusal subtracted to
   zero. A baseline is a statement about the SUITE and can say nothing about
   whether a heal round removed a test, so the census now runs after the
   subtraction and before the results line.
2. **It censused the wrong tree.** `state.projectRoot` is the main checkout;
   on a decomposed run the agent's edits are in a worktree named by
   `state.treeUnderTest`. The guard would have compared a tree nobody touched
   against itself — green every round, for the one kind of run it most needs
   to watch.
3. **The walk was rungate's own layout.** `["test", "gates"]` means
   `src/foo.test.ts` — the commonest JavaScript convention there is —
   censuses to `{}`, and `{}` compares clean against `{}` on every subsequent
   round. The guard would have been permanently and silently dead for exactly
   the consumers it exists to protect. The walk is now the whole tree minus
   `node_modules`, build output and dotfiles, over the `.test`/`.spec` family,
   and an empty census is UNMEASURED rather than first-reading.

- [x] SC-1690: test/test-census.test.ts contains [a consumer that keeps tests beside its sources is censused too] — `src/*.test.ts` and `src/**/*.spec.tsx` are counted while `node_modules` and `dist` are not, because a dependency's suite and a build copy appearing or vanishing is not this project removing a test
- [x] SC-1691: test/test-census.test.ts contains [a tree with no test file the walk can see is UNMEASURED - not clean] — asserted on the first round as well, since `{}` against `undefined` slipping through as `first-reading` reads as ordinary
- [x] SC-1692: test/test-census.test.ts contains [an unmeasured round keeps the previous reading - no amnesia] — banking `{}` over a real census would make the round after it compare clean against nothing
- [x] SC-1693: test/test-census.test.ts contains [the census refusal is counted after the baseline subtraction - not before] — ordering is not something a pure decider can express, so this is a source-position assertion in the shape of the `if (rebuildCmd)` enclosure guard, pinned against the results line at the other end

#### Three more, from a second review pass

The first pass found three ways the guard could not fire; the second found
three more. Recorded because the pattern is the point: a guard against a
defect class is written by someone holding that class in mind, and it still
shipped six instances of it.

4. **The banked census never reached disk, so the guard was permanently
   dead.** `writeGateResult` does its own `readState(sf)` and writes THAT
   back, so setting `state.gateContract.testCensus` in memory lands only by
   accident. Every subsequent run would have found no census, answered
   `first-reading`, logged a reassuring line, and compared nothing. The
   write is now explicit, read-modify-write against the file so the gate
   tests' and the heal agent's edits survive it.
5. **Every matching file was read with no bound.** A `.spec.js` bundle is
   read into memory on every gate run for a count that cannot be meaningful.
   Capped, and the cap is stable so an oversized file is absent from both
   censuses rather than reading as a deletion.
6. **The walk followed symlinks.** A dirent for a symlink answers false to
   `isDirectory()`, so a symlinked directory was skipped — but a symlink to a
   FILE passed the old `else` and was read. A link named `x.test.ts` pointing
   at a character device has size 0 and never ends. `isFile()` excludes both.

- [x] SC-1694: test/test-census.test.ts contains [the banked census reaches the state FILE - and clobbers nothing] — a sibling under `gateContract` and unrelated top-level state are asserted to survive, and the persisted value is read back through `censusVerdict` so a census written in an unreadable shape cannot pass
- [x] SC-1695: test/test-census.test.ts contains [the census block persists before writeGateResult re-reads the file] — the write landing in the right shape is worth nothing if it happens after the read that discards it
- [x] SC-1696: test/test-census.test.ts contains [a file too large to be a suite is skipped - and a symlink is never read] — both a symlinked file and a symlinked directory are planted, because `isDirectory()` being false for a link is what let the file case through

#### A third pass, and the limit this guard does not close

7. **The previous census was read off the stale in-memory `state`.** It is
   loaded when the process starts; the gate tests and any heal agent write
   the file afterwards. Comparing against the stale copy and then persisting
   over the fresh one is how a round's reading quietly disappears, and the
   direction it disappears in is toward not refusing. `readPersistedCensus`
   reads disk, and rejects an array or unparseable JSON as "nothing banked"
   rather than handing it to the comparison.
8. **Oversized files were skipped silently.** The skip is now reported by
   name on every run. "No test was removed" is a sentence about the files
   that were read, and a reader is owed the list it is not about.

**What this guard does not do.** The banked census lives in the run's
`workflow-state.json`, which the heal agent can write. An agent that deleted
a test AND the census would see `first-reading` next round and pass. This
raises the cost of an *accidental* deletion — the failure mode that actually
happened on `wf_5cdce852-1e2` — and is not tamper-evident against a
deliberate one. `writeWorkflowState`'s Zod validation does not help: an
absent optional key is valid.

Closing that means putting the reading where the guarded party does not
write — the witness, or an HMAC over it — and is filed separately rather than
half-done here. A guard whose limit is written down is a guard somebody can
finish; one whose limit is implied is one everybody assumes is complete.

- [x] SC-1697: test/test-census.test.ts contains [the previous census is read off disk - not off a stale in-memory copy] — an array, unparseable JSON and a missing file all read as nothing banked, and the `undefined` they produce is asserted to become `first-reading` rather than anything that reads as clean
