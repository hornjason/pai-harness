---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Scaffold decomposition — extracting scan, generation, and validation from the 1,844-line scaffold-project.ts into focused modules
testable: true
compliance: permissive
---

# Scaffold Decomposition

## Problem Statement

`scripts/scaffold-project.ts` is 1,844 lines doing four distinct jobs: project scanning (reads package.json, specs, code structure), template filling (generates AGENTS.md, agent briefs, CODE-MAP.md), file writing (creates/updates output files), and validation (checks references, runs lint). When you need to change how scanning works, you're editing the same file as template logic. When a scan bug breaks generation, the blast radius is the entire scaffold.

The AGENT-BRIEF-TEMPLATE-SPEC (SC-348–SC-357) addresses one piece — extracting template strings into files. This spec covers the remaining decomposition: separating scan, generation, and validation into independent modules.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Extract project scanner into `lib/scanner.ts` | Scan logic (read package.json, find specs, detect tech stack) is reusable. Other tools need scan data without running the full scaffold |
| D-2 | Extract file generators into `lib/generators/` | Each output file (AGENTS.md, CODE-MAP.md, agent briefs) gets its own generator. Generators take scan data in, produce file content out |
| D-3 | Scaffold becomes orchestrator only | scaffold-project.ts calls scanner → generators → writers. Under 200 lines. Deep modules do the work |
| D-4 | Validation extracted into `lib/validators/` | Reference checking, lint integration, finding report — these are reusable outside scaffold |
| D-5 | Scan data passed as typed interface, not globals | Scanner returns a `ProjectScan` object. Generators consume it. No shared mutable state |

## Current State

```
scaffold-project.ts (1,844 lines)
├── Project scanning (~400 lines) — reads package.json, specs, code structure
├── AGENTS.md generation (~300 lines) — template filling, section assembly
├── Agent brief generation (~200 lines) — per-agent templates, prompt routing
├── CODE-MAP.md generation (~200 lines) — module scanning, health checks
├── File writing (~150 lines) — mkdir, writeFile, action tracking
├── Validation (~200 lines) — reference checking, lint integration
└── Misc helpers (~394 lines) — type definitions, utilities
```

## Target State

```
scripts/scaffold-project.ts (~150 lines) — orchestrator only
lib/scanner.ts (~300 lines) — project scanning, returns ProjectScan
lib/generators/
  agents-md.ts (~200 lines) — AGENTS.md generation
  agent-briefs.ts (~150 lines) — reads templates, fills variables
  code-map.ts (~200 lines) — CODE-MAP.md generation
lib/validators/
  reference-check.ts (~100 lines) — broken link detection
  lint-integration.ts (~100 lines) — agnix, RepoRails
```

## Success Criteria

- [ ] SC-358: `lib/scanner.ts` exists and returns typed `ProjectScan` interface
- [ ] SC-359: Scanner detects tech stack, specs, consumers, source directories from project root
- [ ] SC-360: AGENTS.md generator takes ProjectScan input, produces AGENTS.md content
- [ ] SC-361: Agent brief generator reads template files and fills variables from ProjectScan
- [ ] SC-362: CODE-MAP.md generator takes ProjectScan input, produces CODE-MAP.md content
- [ ] SC-363: scaffold-project.ts is under 200 lines — orchestrator only
- [ ] SC-364: Re-scaffold produces identical output before and after decomposition
- [ ] SC-365: Scanner is importable by other scripts without pulling in generation logic
- [ ] SC-366: Each generator is independently testable with mock ProjectScan data

## Implementation

### Phase 1: Extract scanner
1. Define `ProjectScan` interface
2. Extract scan logic into `lib/scanner.ts`
3. Scaffold imports scanner, passes data to existing inline generators
4. Verify: identical output

### Phase 2: Extract generators
1. Extract AGENTS.md generation into `lib/generators/agents-md.ts`
2. Extract agent brief generation into `lib/generators/agent-briefs.ts` (connects to AGENT-BRIEF-TEMPLATE-SPEC)
3. Extract CODE-MAP.md into `lib/generators/code-map.ts`
4. Verify: identical output

### Phase 3: Extract validation
1. Extract reference checking into `lib/validators/`
2. Scaffold becomes orchestrator — under 200 lines
3. Verify: identical output, all tests green

## Cautions

- SC-364 is the critical gate: output must be IDENTICAL before and after. Diff the generated files
- Don't change behavior during decomposition — this is a pure refactor
- AGENT-BRIEF-TEMPLATE-SPEC (SC-348–SC-357) should land first — it externalizes templates, simplifying the agent-briefs generator extraction
