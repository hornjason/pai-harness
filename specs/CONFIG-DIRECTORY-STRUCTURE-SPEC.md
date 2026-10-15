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
