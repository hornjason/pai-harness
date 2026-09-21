---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Consumer Requirements + 6 more
testable: true
---

## Consumer Requirements

### CODE-MAP.md

Produced by: `scripts/generate-code-map.ts`
Read by: AGENTS.md (references it), agents/marcus.md (Module Dependencies, Code Health), agents/quinn.md (Page→Component Map, API Routes)

| Section | What's In It | Who Reads It |
|---------|-------------|--------------|
| Summary | Counts: dirs, deps, routes, components, entry points, unused, circular | Quick orientation |
| Directory Structure | Dirs with file counts and types | Project navigation |
| Entry Points | package.json main/exports, Makefile entry targets | Agent orientation |
| API Routes | Method, path, file, line for every route (framework-agnostic detection) | Marcus (endpoint awareness) |
| UI Components | Component names (detected from component dirs, not hardcoded path) | Quinn (what exists to test) |
| Module Dependencies | Top modules by import count (highest-impact first, no arbitrary cutoff) | Marcus (cascade impact) |
| Page→Component Map | Which components render on each page (from detected router file) | Quinn (targeted UI testing) |
| Test Coverage | Test files in test/, what modules they cover (import analysis) | Marcus (knows what's tested vs gaps), gates (baseline) |
| Code Health | Circular deps, unused files, unused exports | Marcus (tech debt awareness) |
| Package Scripts | Available npm/bun scripts | Workflow commands |

**Required frontmatter:**
```yaml
---
scanned-at-sha: abc1234
scanned-at: 2026-09-18T21:00:00Z
scan-paths: [src/, lib/, test/]
---
```

**Staleness detection (git SHA, not time-based):**

CODE-MAP.md frontmatter includes `scanned-at-sha` — the git commit SHA when the scan ran. On re-scaffold:

```
1. Read CODE-MAP.md frontmatter → get scanned-at-sha
2. Run: git log --oneline {scanned-at-sha}..HEAD -- src/ lib/ gates/ hooks/
3. Any commits returned? → YES → regenerate CODE-MAP
4. No commits? → SKIP (source hasn't changed)
5. No scanned-at-sha? (first run or missing) → always regenerate
```

This replaces the previous 14-day/50-commit heuristic. One changed route file triggers a re-scan immediately. 100 doc-only commits don't trigger a pointless re-scan.

The scan paths (`src/ lib/ gates/ hooks/`) are the same directories CODE-MAP scans for routes, components, and modules. Changes outside these paths (docs, specs, reference) don't affect CODE-MAP.

### rungate.json

Produced by: `scripts/scaffold-project.ts` → `generateOrAuditProjectHarness()`
Read by: AGENTS.md, agents/*.md, ship.js, prove.js, verify.js, gates, CI workflows

**Ownership: Hybrid (field-level merge).** Auto-detected fields are regenerated from scan on every re-scaffold. Manual fields are preserved — never overwritten. New fields added as null.

**Re-scaffold behavior:**
```
1. Read existing rungate.json
2. Re-scan code (CODE-MAP, Makefile, package.json, git remote)
3. Auto-detected fields → OVERWRITE with fresh scan data
4. Manual fields → PRESERVE existing value
5. New fields (from harness update) → ADD with null
6. Unknown fields (user-added) → PRESERVE
```

| Field | Source | Type | Who Reads It |
|-------|--------|------|-------------|
| harnessVersion | Harness package.json version | Auto-detect | Conformity (version mismatch WARN), upgrade detection |
| scaffoldedAt | Scaffold execution timestamp | Auto-detect | Audit trail, staleness detection |
| project | package.json name | Auto-detect | Slug generation, issue tracking |
| repo | git remote | Auto-detect | git push, PR creation |
| issueRepo | User-configured (may differ from repo) | Manual | gh issue commands |
| dev.start | Makefile or package.json scripts.dev | Auto-detect | Ship workflow (start dev server) |
| dev.apiBase | Makefile port mappings | Auto-detect | Ship workflow (health checks), agents |
| dev.uiBase | Makefile port mappings | Auto-detect | Ship workflow (UI checks), Quinn |
| dev.testCmd | package.json scripts.test or "bun test" | Auto-detect | Ship workflow (run tests), gates |
| dev.typeCheck | tsconfig.json exists → "bunx tsc --noEmit" | Auto-detect | Ship workflow (type checking) |
| dev.preStart | User-configured (e.g., seed DB, start dependencies) | Manual | Pre-dev setup commands |
| prod.rebuild | Makefile target `rebuild` (if exists) | Auto-detect | Ship workflow (container deploy) |
| prod.apiBase | Makefile port mappings | Auto-detect | Ship workflow (smoke test URL) |
| prod.smokeTest | Makefile target `smoke` (if exists) | Auto-detect | Ship workflow (post-deploy health check) |
| test.rebuild | Makefile (make test-rebuild) | Auto-detect | Ship workflow (test container rebuild) |
| test.start | Makefile (make prove-up) | Auto-detect | Prove workflow (start prove container) |
| test.stop | Makefile (make prove-down) | Auto-detect | Prove workflow (stop prove container) |
| test.apiBase | Makefile port mappings | Auto-detect | Ship/prove workflows (test container URL) |
| pages | Router file scan (detected path) | Auto-detect | Quinn (URL navigation), AGENTS.md |
| consumers | CODE-MAP consumer modules | Auto-detect | AGENTS.md, Marcus (cascade impact) |
| contextDocs | User-configured | Manual | DISCOVERY phase (additional reading) |
| codeCommittedPaths | User-configured | Manual | Gates (code-committed check) |
| specs | Convention (specs/) | Auto-detect | Gate discovery |
| ci.runner | User-configured | Manual | CI workflow (GitHub Actions runner) |
| ci.bunVersion | User-configured | Manual | CI workflow (Bun version) |
| ci.branches | User-configured | Manual | CI workflow (push trigger branches) |
| mcp | Auto-detect from .claude/settings.json | Hybrid | Agent briefs (available tools), AGENTS.md |
| envVars | .env.example (if exists) | Auto-detect | Agents know what env vars the project expects |

**Null means skip, not guess:** Undetected auto-detect fields are null. Unconfigured manual fields are null. Null causes the dependent workflow step to SKIP — no agent spawned, no command run.

### AGENTS.md

Produced by: `scripts/scaffold-project.ts` → `generateAgentsMd()`
Read by: All agents (explicitly — "Read AGENTS.md first"), copilot-instructions.md (pointer), CLAUDE.md (via @AGENTS.md bridge)

**Sizing constraint:** MUST be under 150 lines. Scaffold WARNS if over. Empty sections are OMITTED (no consumers = no Consumers section).

| Section | Source | Purpose | Omit when |
|---------|--------|---------|-----------|
| Project Identity | README.md first paragraph (skip frontmatter + HTML) | Agent knows what the project is | Never — always present |
| Hard Constraints | Preserved from existing AGENTS.md + extract-constraints | Rules agents can't discover from code | Empty placeholder on new project |
| Commands | rungate.json testCmd + Makefile targets + CLI commands | Agent knows how to build/test/deploy/create files | Never — at minimum has "bun test" |
| Where to Create Things | Static table (from File Location Contract) | Agent knows correct location for every file type | Never |
| Harness-Managed Files | Static table (from File Ownership Model) | Agent knows what NOT to edit + how to customize | Never |
| Available MCP Servers | rungate.json mcp field | Agent knows what tools are available | No MCP servers configured |
| Project Structure | Directory scan | Agent knows where to put code | Never — at minimum has src/ |
| Code Style | Detected: runtime (Bun/Node), language (TS/JS), module system (ESM/CJS) | Agent follows conventions | Never |
| Documentation Routing | docs/ scan (top 10 by relevance priority) + CODE-MAP first | Agent finds the right doc fast | No docs/ dir |
| Specs | specs/ frontmatter scan | Agent knows governing specs | No specs |
| Environment | rungate.json dev/prod sections | Agent knows ports, commands | All values null |
| Pages | rungate.json pages map | Agent knows URL paths | No pages detected |
| Consumers | rungate.json consumers | Agent knows cascade impact | No consumers detected |
| Boundaries | Static (never rebuild, never commit creds) | What agents must not do | Never |
| Workflow | git remote + Makefile targets | Agent knows how to ship | No git remote |
| Reference Files | reference/ scan | Historical docs index | reference/ empty |

### .claude/agents/*.md

Produced by: `scripts/scaffold-project.ts` → `generateAgentBriefs()`
Read by: Claude Code (auto-loaded as system prompt when agent is spawned via subagent_type)

| Agent | Config from rungate.json | Layer 1 templates embedded | Purpose |
|-------|-------------------------|---------------------------|---------|
| marcus.md | Source dirs, consumers, test commands, fallow step, envVars | RCA protocol, blast radius checklist, regression prevention, read-before-write protocol, prevention-oriented fix, evidence hierarchy | Implementation: code, tests, evidence |
| quinn.md | Pages map, dev/test ports, viewport, components | Quinn journey decision tree, evidence hierarchy | QA: typed journey testing, a11y-first assertions |
| rook.md | Source dirs, .gitignore entries, envVars | Evidence hierarchy | Security: scan targets, secret detection, OWASP patterns |
| serena.md | ADR location (docs/adr/), specs location (specs/), module boundaries from CODE-MAP | Evidence hierarchy | Architecture: ADR review, cross-boundary analysis |
| aditi.md | Component paths from CODE-MAP, pages map | Evidence hierarchy | Design: component specs, a11y requirements |

These briefs are ALWAYS regenerated on re-scaffold — they're harness-owned templates, not user-customized. Config values come from rungate.json. Layer 1 methodology templates come from the harness `prompts/` directory. Null config values shown as "not configured — edit .claude/rungate.json."

### Cross-Tool Bridge

| File | Purpose | Generated by |
|------|---------|-------------|
| AGENTS.md | Cross-vendor standard (30+ tools) | scaffold Phase 2.1 |
| CLAUDE.md | Claude Code primary config | scaffold Phase 0.17 |
| .github/copilot-instructions.md | GitHub Copilot (chat + coding agent) — NOT CI/CD | scaffold Phase 0.14 |

Scaffold Phase 0.17: If CLAUDE.md exists and doesn't contain `@AGENTS.md`, prepend `@AGENTS.md` as first line. If CLAUDE.md doesn't exist, create minimal one with `@AGENTS.md` import.

**copilot-instructions.md content** (created at Phase 0.14):
```markdown
# Copilot Instructions

For project context, conventions, constraints, and commands, see [AGENTS.md](../AGENTS.md) in the repository root.

AGENTS.md is the single source of truth for all AI tools working on this project.
```

### CI/CD Workflows

Produced by: Harness-owned templates in Phase 0
Ownership: **Harness-owned** — always regenerated. Customizable settings come from rungate.json, not from editing the workflow file.

The harness provides two workflow files that enforce gates in the CI pipeline. Local gates can be skipped (agent ignores WARN, user bypasses). CI gates can't — they block merge mechanically.

#### rungate.json CI config

```json
{
  "ci": {
    "runner": "ubuntu-latest",
    "bunVersion": "latest",
    "branches": ["main"]
  }
}
```

| Field | Default | What it controls |
|-------|---------|-----------------|
| `ci.runner` | `"ubuntu-latest"` | GitHub Actions runner (e.g., `"self-hosted"`, `"ubuntu-24.04"`) |
| `ci.bunVersion` | `"latest"` | Bun version in CI (pin for reproducibility) |
| `ci.branches` | `["main"]` | Which branches trigger push CI |

All fields optional — defaults used when null.

#### `.github/workflows/ci.yml` (Phase 0.15)

Runs on every PR and push to configured branches. Always regenerated from template + rungate.json config.

```yaml
# Managed by rungate — do not edit manually.
# Customize runner/version in .claude/rungate.json under "ci".
# For additional CI steps, create a separate workflow file.

name: CI
on:
  pull_request:
  push:
    branches: [main]  # from ci.branches

jobs:
  test:
    runs-on: ubuntu-latest  # from ci.runner
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest  # from ci.bunVersion
      - run: bun install
      - run: bun test
      - run: bunx tsc --noEmit
```

**What this enforces:**
- `bun test` runs ALL conformity suites (scaffold, spec-discovery, spec-drift, doc-hygiene, agent-validation, fallow, package-validation, tsconfig-validation) + any project tests
- `bunx tsc --noEmit` catches type errors
- PR can't merge if either fails (when branch protection requires this check)

#### `.github/workflows/gates.yml` (Phase 0.16)

Runs on PRs only. Always regenerated from template + rungate.json config.

```yaml
# Managed by rungate — do not edit manually.
# Customize runner/version in .claude/rungate.json under "ci".
# For additional gate checks, create a separate workflow file.

name: Harness Gates
on:
  pull_request:

jobs:
  gates:
    runs-on: ubuntu-latest  # from ci.runner
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest  # from ci.bunVersion
      - run: bun install
      - name: Secret scan
        run: bunx rungate check-secrets --staged
      - name: Conformity check
        run: bun test test/scaffold-conformity.test.ts
      - name: Spec drift check
        run: bunx rungate check-drift
```

**What this enforces:**
- **Secret scan** — catches .env files, credentials, API keys in PR diff (HYGIENE-12 in CI)
- **Conformity** — all structural checks pass (misplaced files, missing frontmatter, broken refs)
- **Spec drift** — tests match current spec (content hash comparison)

#### Workflow rules

| Scenario | What happens |
|----------|-------------|
| File doesn't exist | Created from template |
| File exists | **Regenerated** — harness owns these files |
| User wants different runner | Set `ci.runner` in rungate.json — picked up on next scaffold |
| User wants custom CI steps | Create a separate workflow file (e.g., `deploy.yml`) — harness never touches it |
| Harness adds new gate checks | Next re-scaffold regenerates workflows with new steps |
| Branch protection setup | User configures in GitHub settings — harness doesn't touch |

#### What the harness does NOT create

| Workflow | Why not |
|----------|---------|
| Deploy workflows | Project-specific (containers, cloud, static hosting) |
| Release automation | Project-specific (versioning strategy, changelog format) |
| Environment-specific CI | Project-specific (staging, prod, review apps) |
| Custom Actions | User-owned |

These are out of scope for the harness. The harness provides the quality gates. Deploy and release are project decisions. Users create separate workflow files for these — the harness never touches them.

### Prompt Templates (`prompts/`)

All prompt templates live in the **harness repo** (`prompts/`), not in projects. The brief-assembler reads templates, fills them with project config (from rungate.json) and issue data (from workflow-state.json), and generates complete briefs at ship time.

#### Ship workflow prompts (per-issue, filled at ship time)

Every agent spawned during a ship cycle gets a filled prompt template. No agent runs without one.

| Template | Agent | Variables From Config | Status |
|----------|-------|---------------------|--------|
| discovery-brief.md | DA (DISCOVERY phase) | ${PROJECT}, ${CONTEXT_DOCS}, ${REPO}, ${SPECS} | Missing |
| marcus-implementation.md | Marcus | ${DEV_API}, ${DEV_UI}, ${TEST_CMD}, ${CONSUMERS}, ${SOURCE_DIRS}, ${ENV_VARS} | Missing |
| quinn-ui-brief.md | Quinn | ${DEV_UI}, ${PAGES}, ${TEST_API}, ${COMPONENTS}, ${VIEWPORT} | Exists |
| rook-security-brief.md | Rook | ${SOURCE_DIRS}, ${GITIGNORE_ENTRIES}, ${ENV_VARS}, ${CHANGED_FILES} | Missing |
| serena-architecture-brief.md | Serena | ${ADR_DIR}, ${SPECS_DIR}, ${MODULE_DEPS}, ${CODE_HEALTH} | Missing |
| aditi-design-brief.md | Aditi | ${COMPONENT_PATHS}, ${PAGES}, ${DESIGN_SYSTEM} | Missing |
| environment-check.md | Ship workflow | ${DEV_API}, ${DEV_UI}, ${DEV_START} | Missing |
| container-rebuild.md | Ship workflow | ${TEST_REBUILD} or null → skip | Missing |
| container-verify.md | Ship workflow | ${TEST_API}, ${SMOKE_TEST} | Missing |

#### Gate prompts (used by gate runner during scope/verify/ship/prove)

| Template | Purpose | Used by | Status |
|----------|---------|---------|--------|
| ac-adversary.md | B1 AC adversary agent | scope + verify gates | Exists |
| evidence-validator.md | B2 evidence validation agent | ship gate | Exists |
| prove-reproducer.md | B3 prove reproduction agent | prove gate | Exists |

#### Layer 1 methodology templates (harness-generic, embedded in briefs)

These are the research-derived templates that get embedded into per-agent briefs. They contain no project-specific data — they're the same for every project. The brief-assembler includes the relevant subset per agent role.

| Template | Purpose | Embedded in | Status |
|----------|---------|-------------|--------|
| rca-protocol.md | 4-phase investigation (Hermes adapted) | Marcus briefs (bug-fix issues) | Missing |
| blast-radius-checklist.md | Pre-implementation dependency analysis | Marcus briefs (all issues) | Missing |
| prevention-oriented-fix.md | Post-fix guard/type-narrow/audit | Marcus briefs (bug-fix issues) | Missing |
| regression-prevention-checklist.md | Test baseline, failing test first, count check | Marcus briefs (all issues) | Missing |
| read-before-write-protocol.md | 3:1 ratio, read callers/tests/types first | Marcus briefs (all issues) | Missing |
| quinn-journey-decision-tree.md | Step-by-step decision tree for UI testing | Quinn briefs (all issues with UI ACs) | Missing |
| evidence-hierarchy.md | S/A/B/C/D/F tier definitions + examples | All agent briefs | Missing |
| ac-format-guide.md | Given/When/Then + oracle format reference | DISCOVERY phase (AC authoring) | Missing |
| coding-principles.md | Deep modules, Zod at boundaries, assertNever, branded types, immutability, error handling, context loading architecture — EXPLAINED not just named | Marcus + Serena briefs (all issues) | Missing |
| testing-strategy.md | PBT, contract tests, tautological trap, boundary testing (horizontal+vertical), test evidence per AC type, mutation testing as quality signal | Marcus briefs (all issues) | Missing |
| escalation-decision-tree.md | When to research vs iterate, available tools, circuit breaker routing | All agent briefs | Missing |

#### Template lifecycle

1. Templates ship with the harness npm package
2. Projects get them via `bun install` (devDependency)
3. Brief-assembler reads templates + rungate.json + issue ACs → generates filled briefs
4. Template improvements in harness → projects get them on next `bun install`
5. No project-level prompts/ directory needed — everything comes from the harness

## Complete Project Inventory

Every project integrated with the harness has these files. On new projects, scaffold creates them. On existing projects, scaffold refreshes/audits them.

### Files from scaffold (harness-managed)

| File | Created by | Updated on re-run | Purpose |
|------|-----------|-------------------|---------|
| `AGENTS.md` | Phase 2.1 | Refreshed (HC preserved) | Cross-tool agent context (<150 lines) |
| `CODE-MAP.md` | Phase 1.1 | Refreshed if src/ changed (git SHA) | Code structure scan |
| `.claude/rungate.json` | Phase 1.2 | Audited (gaps reported) | Project config (ports, commands, pages) |
| `.claude/agents/marcus.md` | Phase 2.2 | Always regenerated | Engineer brief — source dirs, test cmds, consumers |
| `.claude/agents/quinn.md` | Phase 2.2 | Always regenerated | QA brief — ports, pages, viewport, methodology ref |
| `.claude/agents/rook.md` | Phase 2.2 | Always regenerated | Security brief — scan targets, security baseline |
| `.claude/agents/serena.md` | Phase 2.2 | Always regenerated | Architect brief — ADR location, module boundaries |
| `.claude/agents/aditi.md` | Phase 2.2 | Always regenerated | Designer brief — component paths, design system |
| `package.json` | Phase 0.18 | Required fields added if missing | name, type:module, scripts.test, devDep |
| `tsconfig.json` | Phase 0.19 | WARN on missing recommended fields | strict:true, module:ESNext |
| `.gitignore` | Phase 0.11 | Verified, missing entries appended | node_modules, dist, .env*, .rungate, secrets |
| `.github/copilot-instructions.md` | Phase 0.14 | Skip if exists | Tool-bridge: points Copilot to AGENTS.md |
| `.github/workflows/ci.yml` | Phase 0.15 | Always regenerated (harness-owned) | CI pipeline: bun test + typecheck on PR/push |
| `.github/workflows/gates.yml` | Phase 0.16 | Always regenerated (harness-owned) | Gate enforcement: secret scan + conformity + spec drift |
| `test/scaffold-conformity.test.ts` | Phase 0.13 | Always regenerated | Conformity + hygiene + drift tests (harness-owned) |
| `specs/SPEC-TEMPLATE.md` | Phase 0.12 | Updated to latest | Template for creating new specs |
| `CLAUDE.md` (bridge) | Phase 0.17 | Add @AGENTS.md if missing | Claude Code reads this → imports AGENTS.md |

### Files created by developer/agent

| File | Purpose | Guidance |
|------|---------|----------|
| `src/index.ts` | Entry point (stub created by scaffold) | Framework choice comes from first /goal |
| `src/**/*.ts` | Source code | Agent writes, harness never touches |
| `test/**/*.test.ts` | Project tests (not conformity) | Agent writes, harness never touches |
| `specs/*.md` | Governing specs | Use `bunx rungate create-spec "title"` — never create manually |
| `docs/*.md` | Project documentation | Scanned by AGENTS.md doc routing on re-scaffold |
| `docs/adr/*.md` | Architecture decision records | Use `bunx rungate create-adr "title"` — never create manually |
| `scripts/*.ts` | Project-specific scripts | User-created, harness never touches |
| `.github/workflows/*.yml` (user) | Custom CI workflows (deploy, etc.) | Harness never touches user-created workflows |
| `.husky/*` or `package.json` hooks | Git hooks (project-specific) | In-repo, not global |
| `reference/` | Archived/historical docs | Stale docs moved here by doc hygiene |
| `reference/rejected-constraints.md` | Rejected extract-constraints candidates | Content-hash dedup prevents resurfacing |

### Conformity Tests (auto-run via `bun test`)

The scaffold creates `test/scaffold-conformity.test.ts` which imports test suites from the harness. These run on every `bun test` in the project:

| Suite | Import | What it tests |
|-------|--------|---------------|
| **Scaffold Conformity** | `runScaffoldConformity(ROOT)` | SCs from specs with `testable: true` — auto-generates assertions from parseable SC patterns |
| **Spec Discovery** | `runSpecDiscovery(ROOT)` | Every .md in specs/ has frontmatter, `testable` field present, at least one testable spec exists |
| **Spec Drift** | `runSpecDrift(ROOT)` | Every SPEC-REF points to existing file, every testable spec referenced by at least one test |
| **Doc Hygiene** | `runDocHygiene(ROOT)` | Specs have `governs` field, `updated` field, no orphaned files, all specs listed in AGENTS.md |
| **Agent File Validation** | `runAgentFileValidation(ROOT)` | .claude/agents/ exists, all agent files have frontmatter (name + description), names lowercase, name matches filename |
| **Fallow** | `runFallowCheck(ROOT)` | No unused files, no unused exports, no unused deps, no circular deps |
| **Constraint Candidates** | HYGIENE-6 (inside Doc Hygiene) | Warns about unreviewed extract-constraints candidates |
| **Package Validation** | `runPackageValidation(ROOT)` | package.json has name, type:module, scripts.test, devDependencies.rungate — FAIL if required missing |
| **Tsconfig Validation** | `runTsconfigValidation(ROOT)` | tsconfig.json exists, strict:true recommended — WARN only, never FAIL |

**What this means for developers/agents:** Run `bun test` — if it passes, the project is conformant. If it fails, the failure message says exactly what's wrong and how to fix it. Zero manual checking needed.

### AGENTS.md Required Sections

AGENTS.md must include guidance on how to work with the harness. The Commands and Specs sections are mandatory:

```markdown
## Commands

| Action | Command |
|--------|---------|
| Install | `bun install` |
| Test | `bun test` |
| Type check | `bunx tsc --noEmit` |
| Conformity | `bun test test/scaffold-conformity.test.ts` |
| Sync spec tests | `bunx rungate sync-tests .` |
| Create spec | `bunx rungate create-spec "title"` |
| Create ADR | `bunx rungate create-adr "title"` |
| Extract constraints | `bunx rungate extract-constraints .` |
| Re-scaffold | `bun ~/Projects/rungate/scripts/scaffold-project.ts .` |

## Specs

Create specs with `bunx rungate create-spec "title"` — creates at `specs/` with correct frontmatter.
Create ADRs with `bunx rungate create-adr "title"` — creates at `docs/adr/` with auto-incremented number.
Set `testable: true` in frontmatter → `bun test` auto-generates assertions from SCs.
SCs must follow parseable patterns (see template for examples).

## Harness-Managed Files

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| `.github/workflows/ci.yml` | Set `ci.runner`, `ci.bunVersion`, `ci.branches` in `.claude/rungate.json` | Don't edit the YAML — it regenerates |
| `.github/workflows/gates.yml` | Settings from `.claude/rungate.json` `ci` section | Don't edit the YAML — it regenerates |
| `.claude/agents/*.md` | Settings from `.claude/rungate.json` (ports, pages, consumers) | Don't edit briefs — they regenerate |
| `test/scaffold-conformity.test.ts` | Runs automatically — no config needed | Don't edit — it regenerates |
| `CODE-MAP.md` | Auto-generated from code scan | Don't edit — it regenerates |

**To add custom CI steps:** Create a separate workflow file (e.g., `.github/workflows/deploy.yml`). The harness never touches user-created workflow files.

**To change project config:** Edit `.claude/rungate.json` then re-scaffold. Changes flow into agent briefs, AGENTS.md, and CI workflows.

## Where to Create Things

Everything must be self-contained in the repo. No global installs.

| I need to create... | Put it here | Not here |
|---------------------|-------------|----------|
| A new spec | `bunx rungate create-spec "title"` → `specs/` | Don't create manually at root |
| A new ADR | `bunx rungate create-adr "title"` → `docs/adr/` | Don't create in specs/ |
| A git pre-commit hook | `package.json` scripts or `.husky/pre-commit` | Not ~/.gitconfig or global hooks |
| A git pre-push hook | `package.json` scripts or `.husky/pre-push` | Not ~/.gitconfig or global hooks |
| A project script | `scripts/my-script.ts` | Not root, not src/ |
| A custom CI workflow | `.github/workflows/my-workflow.yml` | Don't edit ci.yml or gates.yml |
| A Claude Code hook | `.claude/settings.json` in the repo | Not global Claude settings |
| Documentation | `docs/my-doc.md` | Not root (HYGIENE-7 enforces) |
| Test files | `test/my-test.test.ts` | Not src/ |
```

## File Location Contract (anti-sprawl)

Every file type has ONE correct location. Agents and developers follow this contract. Conformity tests enforce it mechanically.

| What | Where | Wrong place | Enforcement |
|------|-------|-------------|-------------|
| Specs | `specs/*.md` | NOT docs/, NOT root | HYGIENE-8: FAIL |
| ADRs | `docs/adr/*.md` | NOT specs/, NOT root | HYGIENE-9: FAIL |
| Documentation | `docs/*.md` | NOT root (except AGENTS.md, CODE-MAP.md, README.md, CLAUDE.md, CONTRIBUTING.md, ARCHITECTURE.md, PRINCIPLES.md) | HYGIENE-7: FAIL |
| Archived docs | `reference/` | NOT docs/ (moved when stale) | Staleness audit |
| Agent briefs | `.claude/agents/*.md` | NOT root, NOT docs/ | Agent validation |
| Project config | `.claude/rungate.json` | NOT root | Schema check |
| Test files | `test/*.test.ts` | NOT src/ | Convention |
| Source code | `src/` | NOT root | Convention |
| Harness hooks/prompts | In harness (npm package) | NOT in project repo | Self-containment |
| Project git hooks | `package.json` scripts or `.husky/` | NOT global (~/.git/hooks) | Must be in-repo |
| Project scripts | `scripts/` | NOT root, NOT src/ | Convention |
| CI/CD workflows (harness) | `.github/workflows/ci.yml`, `gates.yml` | Don't edit — harness-owned | Regenerated |
| CI/CD workflows (project) | `.github/workflows/*.yml` (user-created) | NOT outside .github/workflows/ | Convention |
| Claude Code hooks | `.claude/settings.json` | NOT global settings | In-repo for portability |

### Self-containment principle

Everything the project needs must be IN the repo. When someone clones the repo and runs `bun install`, all hooks, workflows, tests, and config should work. No global installs, no machine-specific hooks, no external dependencies beyond the harness npm package.

| Need | Where it lives | Why |
|------|---------------|-----|
| Git pre-commit hook | `package.json` scripts or `.husky/` in repo | Global hooks don't follow the clone |
| Git pre-push hook | `package.json` scripts or `.husky/` in repo | Global hooks don't follow the clone |
| Claude Code hooks | `.claude/settings.json` in repo | Per-machine settings don't transfer |
| CI/CD workflows | `.github/workflows/` in repo | Actions read from repo, not external |
| Test suites | `test/` in repo (imports from harness) | Tests must run on any machine |
| Project-specific scripts | `scripts/` in repo | Not on the harness, not global |

**The distinction:**
- **Harness-provided** (ci.yml, gates.yml, conformity test, agent briefs) → comes from the harness package, regenerated on scaffold
- **Project-specific** (deploy.yml, custom hooks, project scripts) → created by developer/agent, lives in repo, never touched by harness
- **Global** → NOT ALLOWED. Nothing should require a global install or machine-specific setup beyond `bun install`

If a markdown file doesn't fit any category, the agent must ask before creating it.

### Mechanical enforcement (HYGIENE-7/8/9)

```
HYGIENE-7: No .md files at root except AGENTS.md, CODE-MAP.md, README.md, 
           CLAUDE.md, CONTRIBUTING.md, ARCHITECTURE.md, PRINCIPLES.md — FAIL with fix instruction
HYGIENE-8: No spec-like files outside specs/ (files with "testable:" 
           frontmatter in wrong location) — FAIL with move command
HYGIENE-9: No ADR-like files outside docs/adr/ (files matching ADR-NNN 
           pattern in wrong location) — FAIL with move command
```

These run on every `bun test`. Misplaced files are FAIL, not WARN. The error message includes the fix command.
