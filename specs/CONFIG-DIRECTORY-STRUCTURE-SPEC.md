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
- [x] SC-487: lib/organize.ts contains [artifactClassification, artifact] — the source reads the extension map from config and must NOT hardcode extensions; asserting `.html` and `.pdf` here asked the source to contain exactly what this spec exists to move out of it
- [x] SC-606: .claude/rungate/compliance.json contains [artifactClassification, .html, .pdf] — the other half of SC-487: the extensions live in config, and this is where they are pinned
