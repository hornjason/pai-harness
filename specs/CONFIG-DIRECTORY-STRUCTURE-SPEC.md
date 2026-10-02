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
- [ ] SC-474: `.claude/rungate/config.json` exists with project, repo, issueRepo, contextDocs, pages, test fields
- [ ] SC-475: `.claude/rungate/roles.json` exists with agent role definitions
- [ ] SC-476: `.claude/rungate/hooks.json` exists with hook registrations array
- [ ] SC-477: `.claude/rungate/compliance.json` exists with rules, each having description, directives, reinforcement, tiers, threshold
- [ ] SC-478: Config loader reads `.claude/rungate/` directory and merges into same shape as current monolith
- [ ] SC-479: Config loader falls back to `.claude/rungate.json` when directory doesn't exist
- [ ] SC-480: `detectHillClimbNeeds()` reads compliance.json — no hardcoded BRIEF_REINFORCEMENTS or TIER_PROMOTIONS
- [ ] SC-481: `normalizeDirToComp()` reads DIR→COMP mapping from compliance.json — no hardcoded DIR_TO_COMP
- [ ] SC-482: compliance.json contains organize.externalSources with path, type, target, method fields
- [ ] SC-483: Existing tests pass unchanged after config migration

### Phase 2 — Deferred (future session)
- [ ] SC-484: Scaffold generates `.claude/rungate/` directory for new projects (behavioral)
- [ ] SC-485: Re-scaffold splits existing `rungate.json` into directory structure (behavioral)
- [ ] SC-486: organize-project reads externalSources from compliance.json and scans listed paths (behavioral)
- [ ] SC-487: organize-project handles `.html` and `.pdf` files at root using config-driven classification (behavioral)
