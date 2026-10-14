---
doc-type: spec
status: active
owner: jason
created: 2026-10-02
updated: 2026-10-02
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
