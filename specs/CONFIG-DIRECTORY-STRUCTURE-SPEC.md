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

## Consumer Config Shape (`.claude/rungate.json`)

D-2 reads as a backward-compatibility note, and that is all anyone has treated
it as. It is not. **The monolith is the shape every consumer project uses.**
rungate is the only checkout on the directory form above; every project rungate
ships *into* writes a single `.claude/rungate.json`, and `resolveRungateConfig`
reaches it through the fallback branch. A change that treats the fallback as
dead code breaks every consumer and no self-run.

The two forms carry the same keys and are read by the same loader. They differ
in file layout only — and in one consequential default: rungate's own
`config.json` declares `"pages": {}`, a consumer's `rungate.json` does not.
`workflows/ship.js` computes `hasUI` from that map, so the empty map rewrites
every rungate self-run to `LIGHT` while a consumer with declared pages is
floored at `STANDARD`. Five tier-gated subsystems hang off that one difference.

The reference consumer is `test/fixtures/consumer-ui-project/.claude/rungate.json`.
It exists so the consumer branch is exercised by a test rather than only by a
real consumer's first run.

| Key | Status | What reads it |
|-----|--------|---------------|
| `project` | required | Display name in briefs and artefact slugs |
| `repo` | required | Code repo for branch and PR operations |
| `issueRepo` | required | Issue tracker repo — often, but not always, `repo` |
| `pages` | required | `ship.js` → `hasUI` → the ceremony-tier floor; an empty map means CLI/library and downgrades to `LIGHT` |
| `dev` | required | Flattened by `ship.js` into `apiUrl`, `uiUrl` and `test.command` (`dev.apiBase`, `dev.uiBase`, `dev.testCmd`) |
| `prod` | optional | Production base URL and rebuild command for the verify and ship phases |
| `container` | optional | Container verify — tier-gated, so it runs only once `pages` has floored the tier above `LIGHT` |
| `remoteHosts` | optional | SSH pre-flight. **Not** tier-gated: it runs before the tier is read at all, which is why it is the one subsystem a `LIGHT` consumer still enters |
| `consumers` | optional | Cascade-impact list surfaced in AGENTS.md |
| `contextDocs` | optional | Extra docs injected into agent briefs |

`test` (with `command` and `timeout`) is the directory form's key for the same
fact `dev.testCmd` carries on the consumer form. `ship.js` accepts either and
normalises to `test.command`; `gates/gate-executor.ts` reads `test.command`
only. Consumers that set neither fall back to `bun test`.

## Is a consumer's test-environment gate expressible in this config? (#274)

**The short answer: the port is, the ORDERING is not.**

DailyBriefDashboard's rule is "7776 before 7777" — the test container on 7776
must be validated before anything touches the production container on 7777.
Two halves, and the config expresses only one of them.

**What IS expressible.** `container.port` names the port Quinn is pointed at,
`container.hosts` names where it lives, and `container.healthPath` is what the
env check curls. Setting `container.port: 7776` is a complete statement of
*which* environment gets verified, and `ship.js`'s container verify reads all
three without any code change.

**What is NOT expressible.** There is no key that says "7776 must pass before
7777 is touched." The ordering lives in `workflows/ship.js` as statement order
and in `gates/workflow.test.ts` as the `local-before-prod` check, and both are
written against `environments.local.*` and `environments.prod.*` — a two-tier
vocabulary that does not know port numbers. A consumer can configure WHICH
container, not WHICH ORDER. Expressing the second would need either an ordered
list of environments in config, or a per-environment `dependsOn`; neither
exists, and inventing one is outside #274.

### Three facts measured on this repo that a DailyBriefDashboard run will hit

Each was read off the source rather than inferred, and each is recorded here
because the measurement is cheap now and expensive during a consumer's first
run.

1. **`dev.testCmd` versus `test.command` — one fact, two key names, and the two
   projects are exactly complementary (#294).** `gates/workflow.test.ts:532`
   returns early unless `harness?.dev?.testCmd` is set, so the `tests-pass`
   check — the one `suiteVerdictViolations` was mutation-proven for in #224 —
   simply does not run without it. `gates/gate-executor.ts:92` captures the test
   baseline from `harness.test?.command` and ignores `dev.testCmd`. rungate's
   config sets `test.command` and no `dev` block; DailyBriefDashboard's sets
   `dev.testCmd` and no `test` block. So **each project exercises exactly one of
   the two readers, and neither exercises both.** Observed two-sided with one
   planted state and two `projectRoot`s: at rungate the check passes having made
   ZERO `expect()` calls; at DailyBriefDashboard the identical state fails at the
   assertion. The mutation-proven binding has therefore never been REACHED on
   this repo — the function can fail, and nothing proves the gate calls it.

2. **Ten gate checks sit behind `loadProjectHarness()`, and a missing or
   differently-keyed config makes every one of them return early.**
   `gates/workflow.test.ts` calls it at lines 397, 531, 602, 627, 642, 973,
   1036, 1052, 1068 and 1110. Each call is followed by a guard that returns when
   the key it wants is absent. A returning test passes, so on any project whose
   config does not carry the expected key these ten report green without
   asserting anything — which is indistinguishable, in every artefact the
   harness writes, from ten checks that were satisfied.

3. **`environments.prod.rebuild` is set to `PASS` by an agent prompt, on a
   project whose own rules forbid the agent from doing the thing it attests
   to.** `workflows/ship.js:4566` embeds, in a prompt handed to an agent, a
   `bun -e` one-liner that writes `s.environments.prod.rebuild = 'PASS'`. The
   gate check at `gates/workflow.test.ts:1034` then reads that value and is
   satisfied by it. On a DailyBriefDashboard run the chain is circular: the
   agent is told to write `PASS`, the gate reads `PASS`, and DailyBriefDashboard's
   CLAUDE.md forbids the agent from running the rebuild while its Makefile has a
   worktree guard that exits 1. The honest value for a rebuild nobody performed
   is `SKIP` with a reason, which the same prompt already knows how to write
   (`ship.js:4569`, the "test container not running" arm). The gap is that
   nothing forces the second arm when the first is impossible.

4. **A fourth, found while building the fixture and recorded with the others:
   the container verify DELEGATES the rebuild to an agent.**
   `workflows/ship.js:3769` spawns a `container-rebuild` agent whose prompt is
   `cd ${PROJECT_ROOT} && ${containerConfig.rebuildCommand}`. Setting
   `container.rebuildCommand` on DailyBriefDashboard therefore instructs an
   agent to run exactly the command that project forbids an agent from running.
   The fixture at `test/fixtures/consumer-ui-project` carries the command as an
   inert string precisely so this is observable without being performed, and
   `test/consumer-no-rebuild-delegation.test.ts` is the scan that keeps it
   inert. A consumer that cannot delegate its rebuild needs either an
   `externally-rebuilt` container mode or a `rebuildCommand`-less container
   block that still verifies; neither exists today.

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
