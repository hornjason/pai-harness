---
doc-type: spec
status: draft
owner: jason
created: 2026-09-17
updated: 2026-09-17
governs: Bootstrap data flow — scan order, data sources, consumer requirements
testable: true
---

# Bootstrap Data Flow Spec

## Problem Statement

Bootstrap generates files in the wrong order — AGENTS.md before CODE-MAP.md and project-harness.json exist. The ship workflow hardcodes 50 DDB-specific values instead of reading from project config. No spec defines what data each consumer needs or where it comes from. Result: scaffolding that looks right but doesn't flow right.

## Core Principle

**Data flows DOWN. Never sideways, never up.** Code is scanned once. Each downstream file reads from the file above it, never from raw code. The ship workflow reads from project-harness.json and prompt templates, never from hardcoded values.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | CODE-MAP.md generates FIRST (from code scan) | All other files depend on it — routes, components, modules, consumers |
| D-2 | project-harness.json generates SECOND (from CODE-MAP + Makefile + package.json) | Config file that every workflow reads — must have complete data |
| D-3 | AGENTS.md generates THIRD (from project-harness + CODE-MAP ref + docs scan) | Routing table that agents read — needs environment, consumers, docs |
| D-4 | .claude/agents/*.md generate FOURTH (from project-harness + AGENTS.md) | Agent context — needs ports, pages, consumers from upstream |
| D-5 | Ship workflow reads project-harness.json at startup, fills prompt templates | Zero hardcoded values — all from config |
| D-6 | Prompt templates in prompts/*.md with ${VAR} placeholders | Methodology is harness-owned, project data is config-driven |
| D-7 | If a config field is null, the dependent step is SKIPPED — no agent spawned | Library projects (no container) skip container steps cleanly |

## Data Sources (what gets scanned from code)

| Scan | Tool | Produces | Used By |
|------|------|----------|---------|
| Dead code, unused exports, circular deps | fallow | CODE-MAP.md § Code Health | Marcus (cascade impact), gates (health check) |
| API route definitions (app.get/post/etc) | regex scan of src/ | CODE-MAP.md § API Routes | Marcus (knows endpoints), AGENTS.md (route count) |
| React components | file scan of dashboard/src/components/ | CODE-MAP.md § React Components | Quinn (knows what to test) |
| Page→component mappings | import scan of dashboard/src/pages/ | CODE-MAP.md § Page→Component Map | Quinn (knows which components on each page) |
| Module import chains | import scan of src/ | CODE-MAP.md § Module Dependencies | Marcus (cascade impact analysis) |
| Consumer modules | import scan of src/ | CODE-MAP.md § Consumer list | project-harness.json consumers field |
| Package info | package.json | CODE-MAP.md § Summary + project-harness.json | AGENTS.md (project name, deps), workflows (test command) |
| Makefile targets | Makefile | project-harness.json (dev/prod commands) | Workflows (rebuild, dev-all, test-up) |
| App routes | App.tsx route definitions | project-harness.json pages map | Quinn (URL navigation), AGENTS.md (pages table) |
| Specs | specs/*.md frontmatter | AGENTS.md specs table | Conformity tests, gates |
| Docs | docs/*.md | AGENTS.md doc routing table | Agent DISCOVERY, context loading |

## Bootstrap Execution Order

```
Phase 1 — SCAN (produce raw data files)
  1.1  CODE-MAP.md      ← fallow + route + component + module + page scans
  1.2  project-harness.json ← CODE-MAP consumers + Makefile + package.json + App.tsx routes

Phase 2 — GENERATE (produce agent-facing files from Phase 1 outputs)
  2.1  AGENTS.md        ← project-harness.json (env, consumers, pages) + CODE-MAP (ref) + docs scan
  2.2  .claude/agents/  ← project-harness.json (ports, pages) + AGENTS.md (identity, routing)

Phase 3 — SCAFFOLD (create structure, tests, deps)
  3.1  specs/           ← create dir, copy template if empty
  3.2  test/            ← create scaffold-conformity.test.ts
  3.3  reference/       ← create dir
  3.4  .github/         ← copilot-instructions.md
  3.5  package.json     ← add devDep
  3.6  Frontmatter      ← add to bare specs
```

## Consumer Requirements

### CODE-MAP.md

Produced by: `scripts/generate-code-map.ts`
Read by: AGENTS.md (references it), agents/marcus.md (Module Dependencies, Code Health), agents/quinn.md (Page→Component Map, API Routes)

| Section | What's In It | Who Reads It |
|---------|-------------|--------------|
| Summary | Counts: dirs, deps, routes, components, entry points, unused, circular | Quick orientation |
| Directory Structure | Dirs with file counts and types | Project navigation |
| API Routes | Method, path, file, line for every route | Marcus (endpoint awareness) |
| React Components | Component names | Quinn (what exists to test) |
| Module Dependencies | Top 15 modules by import count | Marcus (cascade impact) |
| Page→Component Map | Which components render on each page | Quinn (targeted UI testing) |
| Code Health | Circular deps, unused files | Marcus (tech debt awareness) |
| Package Scripts | Available npm/bun scripts | Workflow commands |

### project-harness.json

Produced by: `scripts/scaffold-project.ts` → `generateOrAuditProjectHarness()`
Read by: AGENTS.md, agents/*.md, ship.js, prove.js, verify.js, gates

| Field | Source | Who Reads It | Required? |
|-------|--------|-------------|-----------|
| project | package.json name | Slug generation, issue tracking | Yes |
| repo | git remote | git push, PR creation | Yes |
| issueRepo | manual or same as repo | gh issue commands | Yes |
| dev.start | Makefile (make dev-all) or package.json | Ship workflow (start dev server) | No — null means no dev server |
| dev.apiBase | Convention or Makefile | Ship workflow (health checks), agents (curl) | No |
| dev.uiBase | Convention or Makefile | Ship workflow (UI checks), Quinn | No |
| dev.testCmd | package.json scripts.test | Ship workflow (run tests), gates (test-pass check) | Yes |
| dev.typeCheck | Convention (tsc --noEmit) | Ship workflow (type checking) | No |
| dev.preStart | Convention | Pre-dev setup commands | No |
| prod.rebuild | Makefile (make rebuild) | Ship workflow (container deploy) | No — null means skip container steps |
| prod.apiBase | Convention | Ship workflow (smoke test URL) | No |
| prod.smokeTest | Convention or Makefile | Ship workflow (post-deploy health check) | No |
| test.rebuild | Makefile (make test-rebuild) | Ship workflow (test container rebuild) | No — null means skip |
| test.start | Makefile (make prove-up) | Prove workflow (start prove container) | No — null means skip |
| test.stop | Makefile (make prove-down) | Prove workflow (stop prove container) | No — null means skip |
| test.apiBase | Convention | Ship/prove workflows (test container URL) | No |
| pages | App.tsx route scan | Quinn (URL navigation), AGENTS.md | No |
| consumers | CODE-MAP consumer modules or manual | AGENTS.md, Marcus (cascade impact) | No |
| contextDocs | Manual | DISCOVERY phase (additional reading) | No |
| codeCommittedPaths | Manual | Gates (code-committed check) | No |
| specs | Convention (specs/) | Gate discovery | No |

### AGENTS.md

Produced by: `scripts/scaffold-project.ts` → `generateAgentsMd()`
Read by: All agents (explicitly — "Read AGENTS.md first"), copilot-instructions.md (pointer)

| Section | Source | Purpose |
|---------|--------|---------|
| Project Identity | README.md first paragraph (skip frontmatter + HTML) | Agent knows what the project is |
| Hard Constraints | Preserved from existing AGENTS.md or manual entry | Rules agents can't discover from code |
| Key Files | Directory scan + CODE-MAP ref | Agent knows where to look |
| Documentation Routing | docs/ scan (top 10 by relevance priority) + CODE-MAP first | Agent finds the right doc fast |
| Specs | specs/ frontmatter scan | Agent knows governing specs |
| Tests | test/ file scan | Agent knows test commands |
| Environment | project-harness.json dev/prod sections | Agent knows ports, commands |
| Pages | project-harness.json pages map | Agent knows URL paths |
| Consumers | project-harness.json consumers | Agent knows cascade impact |
| Workflow | git remote + Makefile targets | Agent knows how to ship |
| Quick Reference | Static (5 rules) | Orientation |
| Reference Files | reference/ scan | Historical docs index |

### .claude/agents/*.md

Produced by: `scripts/scaffold-project.ts` → `generateAgentBriefs()`
Read by: Claude Code (auto-loaded as system prompt when agent is spawned via subagent_type)

| Agent | Needs From Config | Purpose |
|-------|-------------------|---------|
| marcus.md | Source dirs, consumers, test commands, fallow step | Knows what to implement, test, and audit |
| quinn.md | Pages map, dev/test ports, viewport, components | Knows what URLs to test and what to look for |
| rook.md | Security baseline path | Knows where security rules are |
| serena.md | Architecture doc path | Knows where design decisions live |
| aditi.md | UI component paths | Knows where design specs are |

### Ship Workflow Prompt Templates

Produced by: Harness-owned templates in `prompts/`
Filled by: Ship workflow reading project-harness.json at startup

| Template | Purpose | Variables From Config |
|----------|---------|---------------------|
| discovery-brief.md | DISCOVERY agent instructions | ${PROJECT}, ${CONTEXT_DOCS}, ${REPO} |
| marcus-implementation.md | Marcus task brief | ${DEV_API}, ${DEV_UI}, ${TEST_CMD}, ${CONSUMERS} |
| quinn-ui-brief.md | Quinn UI testing (exists) | ${DEV_UI}, ${PAGES}, ${TEST_API} |
| environment-check.md | Pre-verify health check | ${DEV_API}, ${DEV_UI}, ${DEV_START} |
| container-rebuild.md | Test container rebuild (or SKIP) | ${TEST_REBUILD} or null → skip |
| container-verify.md | Post-rebuild smoke test | ${TEST_API}, ${SMOKE_TEST} |
| prove-reproducer.md | Prove reproduction (exists) | ${DEV_API}, ${TEST_API}, ${PAGES} |

## Success Criteria

- [ ] SC-1: Bootstrap Phase 1 (CODE-MAP + project-harness) completes before Phase 2 (AGENTS.md + agents/)
- [ ] SC-2: project-harness.json consumers field populated from CODE-MAP consumer scan, not hardcoded
- [ ] SC-3: AGENTS.md environment section reads from project-harness.json (not hardcoded)
- [ ] SC-4: Zero hardcoded ports/URLs in ship.js — all from project-harness.json fields
- [ ] SC-5: Zero hardcoded commands in ship.js — all from project-harness.json fields
- [ ] SC-6: Zero hardcoded project names in ship.js — all from args or project-harness.json
- [ ] SC-7: Container-rebuild agent NOT spawned when prod.rebuild is null
- [ ] SC-8: All ship.js inline prompts >5 lines extracted to prompts/*.md templates
- [ ] SC-9: project-harness-schema.ts includes test.rebuild, test.start, test.stop, test.apiBase fields
- [ ] SC-10: Schema fields dev.typeCheck, prod.smokeTest, contextDocs read by at least one workflow
- [ ] SC-11: Re-running bootstrap on an existing project updates AGENTS.md with current CODE-MAP and project-harness data
- [ ] SC-A1: No workflow file imports or references values from a specific project (DDB, asaCommandCenter, etc.)

## Phase 1.5 — Knowledge Extraction (non-inferrable rules from docs)

Code scans produce structure. But projects accumulate organic knowledge in docs, ADRs, and specs that agents can't discover from code — intentional anti-patterns, deploy gotchas, disabled features, safety boundaries.

### Source Scan

Bootstrap scans these locations for non-inferrable rule candidates:

| Source | What to Look For |
|--------|-----------------|
| `docs/adr/*.md` | Decisions marked "accepted" — these are intentional choices |
| `docs/*.md` | Patterns: "intentional", "by design", "do not change", "never", "must not" |
| `specs/*.md` | Constraints section, anti-patterns section |
| `ARCHITECTURE.md` | "Looks like X but is actually Y", intentional coupling |
| `PRINCIPLES.md` | Hard rules, pre-flight checks |

### Extraction Rules

1. Grep all docs for signal phrases: `intentional|by design|do not|never|must not|anti-pattern|permanently disabled|looks like.*but`
2. Extract the sentence + surrounding context (3 lines)
3. Deduplicate against existing Hard Constraints in AGENTS.md
4. Present new candidates to the user for confirmation
5. Confirmed candidates → appended to AGENTS.md Hard Constraints section
6. Rejected candidates → logged to `reference/rejected-constraints.md` so they don't resurface

### Execution

- On first bootstrap: full scan of all docs → present all candidates
- On re-bootstrap: incremental scan (only docs modified since last scan) → present new candidates only
- Existing Hard Constraints are NEVER removed by re-scan — only added to
- Command: `bunx rungate extract-constraints /path/to/project`

### Doc Lifecycle (archive stale, keep current)

During extraction, docs are also classified:

| Classification | Criteria | Action |
|---------------|----------|--------|
| ACTIVE | Git log shows commit within threshold (per-type below) | Keep in `docs/` |
| ARCHIVED | Git log older than threshold OR manually moved | Move to `reference/` |

**Per-doc-type staleness thresholds** (council decision — single 90d threshold flags 84% of DDB docs):

| Doc type | Path pattern | Threshold | Rationale |
|----------|-------------|-----------|-----------|
| ADR | `docs/adr/` | NEVER time-staled | Durable decisions — stale only by `status: superseded` |
| Spec | `specs/` | 90 days | Active governance docs should be current |
| Guide/runbook | `docs/` | 180 days | Operational docs change less frequently |

**Staleness signal:** Primary = `git log -1 --format=%ci` per file (already at scaffold-project.ts:860). Frontmatter `last-verified` is optional human override — if present and within threshold, file is ACTIVE regardless of git log. Frontmatter `updated` is NOT used (17/38 DDB docs share bulk-stamp date 2026-05-05, proving unreliability).

After extraction, active docs remain in `docs/`. Archived docs are in `reference/` with a reason. Two tiers only — SUPERSEDED and EXTRACTED classifications removed (require human judgment that can't be mechanically determined).

## Makefile Fallback Chain

Not every project has a Makefile. The scan tries sources in priority order:

| Field | Source 1 (Makefile) | Source 2 (package.json) | Source 3 (null) |
|-------|--------------------|-----------------------|-----------------|
| dev.start | `make dev-all` target | `scripts.dev` → `bun run dev` | null → skip dev server steps |
| dev.testCmd | `make test` target | `scripts.test` → `bun test` | `bun test` (default) |
| prod.rebuild | `make rebuild` target | `scripts.build` → `bun run build` | null → skip container steps entirely |
| prod.smokeTest | `make smoke` target | `scripts.smoke` | null → skip smoke tests |
| test.rebuild | `make test-rebuild` target | none | null → skip test container |
| test.start | `make prove-up` target | none | null → skip prove container |
| test.stop | `make prove-down` target | none | null → skip prove cleanup |

When a field is null, the workflow step that uses it is SKIPPED — no agent spawned, no command run. The workflow records `environments.{env}.{step} = "SKIP"` with `skipReason: "no config"`.

## Success Criteria (additional)

- [ ] SC-12: Bootstrap scans docs for non-inferrable rule candidates using signal phrases
- [ ] SC-13: Extracted candidates presented for user confirmation before writing to AGENTS.md
- [ ] SC-14: Staleness uses git log date with per-type thresholds (ADR exempt, spec 90d, guide 180d)
- [ ] SC-15: project-harness.json generation falls back from Makefile → package.json → null for each field
- [ ] SC-16: Null config fields cause workflow steps to SKIP (not error, not spawn rogue agents)

## Cautions

- Bootstrap Phase 1 depends on fallow being installed. If fallow fails, CODE-MAP.md should still generate from other scans (routes, components, dirs) — fallow sections empty, not entire file missing.
- project-harness.json consumers field: auto-detection from CODE-MAP may miss consumers that are dynamically imported or configured at runtime. Manual override must be preserved on re-scan.
- Hard Constraints in AGENTS.md must survive regeneration — they're the one section that can't be auto-detected from code. **CRITICAL (council finding):** The preservation regex at scaffold-project.ts:224 silently drops constraints when Hard Constraints is the last section — the lookahead `(?=\n## )` fails, returns null, and `catch {}` at line 232 swallows the error. Must be fixed before building extract-constraints.
- Prompt templates with ${VAR} placeholders: if a variable is undefined (field missing from config), the template should show a clear placeholder or instruction, not leave a raw ${VAR} string in the agent prompt.
- `rejected-constraints.md` must use content-hash dedup so rejections survive line-number changes across doc edits. Prevents the same false positive from resurfacing on every re-scan.
- No `--auto-accept` flag on extract-constraints. 70% false positive rate (80 raw hits → 24 real candidates in DDB scan) means human review is mandatory. `--dry-run` is the default.
