---
doc-type: spec
status: active
owner: jason
created: 2026-10-02
updated: 2026-10-11
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

## Is a consumer's test-environment gate expressible in this config? (#274)

**Verdict: NOT-EXPRESSIBLE.**

The question, asked by a real consumer rather than in the abstract:
DailyBriefDashboard runs its test container on **7776** and its production
deploy on **7777**, and its rule is that the test environment must be validated
before the production one is rebuilt. Can that rule be written down in rungate
config — `.claude/rungate/config.json`, or the `.claude/rungate.json` monolith
D-2 falls back to — so that a DDB run is refused when it is violated?

No. Nothing in the config surface takes a port, an ordering, or an environment
precedence. `container.port`, `container.hosts`, `container.rebuildCommand`,
`dev.apiBase`, `dev.uiBase`, `dev.testCmd` and `test.command` are the whole of
what the gates read, and none of them expresses "this environment first".

This is recorded here, in the config spec, rather than left to be discovered
during a DDB run — which is the way it would otherwise be found, because every
mechanism below fails quietly. Line numbers are as of `2c220e5e`; the names are
the durable part.

### What stands in for the rule today, and why none of it is the rule

| Mechanism | What it actually does |
|---|---|
| `local-before-prod` (`gates/workflow.test.ts:384`) | The closest check there is. Reads `environments.prod.rebuild` and refuses unless `local.api` or `local.tests` is PASS. It names no ports, reads no config, and cannot distinguish 7776 from anything else |
| `quinn-container-port` (`gates/workflow.test.ts:697`) | The only place a gate knows the number 7776, and it is **hardcoded**, not read from `container.port`. It `console.warn`s on a mismatch and never fails — a check that cannot go red |
| `container.port` / `container.rebuildCommand` | Config the SHIP phase substitutes into agent prompts. Nothing compares them to anything |

### The three mechanisms the gap is made of

**1. The config-key split — same fact, two key names (#294).** `tests-pass` is
gated on `dev.testCmd` (`gates/workflow.test.ts:532`), while the test baseline
in `captureTestBaseline` reads `test.command` (`gates/gate-executor.ts:92`).
Both mean "the command that runs this project's suite". This repo's own
`.claude/rungate.json` sets `test.command` and no `dev.testCmd`, so `tests-pass`
early-returns on every run of rungate against itself. A consumer writing the
rule under either name has a 50% chance of writing it where nothing reads.

**2. 10 gate checks sit behind `loadProjectHarness`, and it only reads the
monolith.** `loadProjectHarness()` (`gates/workflow.test.ts:40`, and a second
copy in `gates/brief-assembler.ts:115`) reads `.claude/rungate.json` directly —
not `.claude/rungate/`, and not through `lib/config-loader.ts`, which is the
loader D-1 and D-2 describe. A consumer that took the directory split and
deleted the monolith gets `null` from it, and all ten of those checks return
without measuring anything. The split this spec specifies is therefore not yet
true of the gates: `lib/config-loader.ts` honours it and the gate suite does
not. Any port rule added to config inherits that gap on day one.

**3. The rebuild verdict is a string an agent writes.** The `record-env` prompt
in `workflows/ship.js` (PHASE 8: SHIP, `label: 'record-env'`, line 4566) tells
the agent: curl the container health path, and if it returns 200, run a `bun -e`
that sets `environments.prod.rebuild = 'PASS'`. So "the rebuild happened" is
satisfied by "something answered on the port" — and `local-before-prod`, the one
check that looks like an ordering rule, keys on exactly that field. On a DDB run
this is worse than imprecise: DDB's own CLAUDE.md forbids the agent from running
its rebuild target, and its Makefile has a worktree guard that exits 1. The honest
value there is `SKIP` with a reason; `PASS` asserts a rebuild nobody is allowed
to perform.

### What expressing it would take

Three things, none of which exist: a config key for environment precedence
(a `prod` that may not be recorded before a named `test` environment is PASS); a
gate check that reads it instead of hardcoding a port; and a measured source for
`environments.prod.rebuild` to replace the agent prompt. Until then the honest
statement for a consumer is that rungate can run a container on a configured
port and cannot enforce an order between two of them.
