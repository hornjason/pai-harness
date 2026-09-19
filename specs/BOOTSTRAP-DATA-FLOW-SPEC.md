---
doc-type: spec
status: draft
owner: jason
created: 2026-09-17
updated: 2026-09-18
governs: Bootstrap data flow — scan order, data sources, consumer requirements, re-run behavior
testable: true
---

# Bootstrap Data Flow Spec

## Problem Statement

Bootstrap generates files in the wrong order — AGENTS.md before CODE-MAP.md and rungate.json exist. The ship workflow hardcodes 50 DDB-specific values instead of reading from project config. No spec defines what data each consumer needs or where it comes from. Result: scaffolding that looks right but doesn't flow right.

## Core Principles

1. **Data flows DOWN. Never sideways, never up.** Code is scanned once. Each downstream file reads from the file above it, never from raw code.
2. **Null means skip, not guess.** Undetected config fields are null. Null causes the dependent workflow step to SKIP — no agent spawned, no command run. Never substitute hardcoded defaults for missing data.
3. **AGENTS.md under 150 lines.** Research (ETH Zurich, GitHub 2,500-repo study) shows files over 150 lines increase inference costs 20-23% with no behavior improvement. Omit empty sections. Scaffold WARNS if over 150.
4. **Only include non-inferrable details.** Agent context files should contain what agents can't discover from reading the code: commands, constraints, boundaries, environment config.
5. **One command, idempotent.** `bun scripts/scaffold-project.ts /path` handles both new and existing projects. Re-running updates what changed, preserves what was manually added.
6. **Everything is regenerable.** All harness-managed files can be rebuilt from scratch by re-running scaffold. The only user-owned content that survives regeneration is Hard Constraints in AGENTS.md (preserved between markers). Agent briefs, CODE-MAP, AGENTS.md sections, conformity tests, templates — all ephemeral. If a conformity check fails on missing frontmatter or broken structure, the fix is always: re-run scaffold.
7. **Required content, not just required files.** Phase 0 doesn't just create files — it ensures required fields exist inside them (package.json fields, spec frontmatter, agent brief frontmatter). Checking file existence without validating content is theater.
8. **Test suite updates flow downstream automatically.** The conformity test file in the project imports suites from the harness package. When the harness adds new checks (new suites in `lib/conformity.ts`), projects get them on next `bun install` (package update). If the import line itself changes (new suite added to the generated test), re-scaffold regenerates the test file. The harness spec drives the tests, not the project.

## File Ownership Model

Every file the harness touches has exactly one ownership type. This determines what happens on re-scaffold.

| File | Ownership | Re-scaffold behavior |
|------|-----------|---------------------|
| `.claude/agents/marcus.md` | Harness-owned | Always regenerated from template |
| `.claude/agents/quinn.md` | Harness-owned | Always regenerated from template |
| `.claude/agents/rook.md` | Harness-owned | Always regenerated from template |
| `.claude/agents/serena.md` | Harness-owned | Always regenerated from template |
| `.claude/agents/aditi.md` | Harness-owned | Always regenerated from template |
| `CODE-MAP.md` | Harness-owned | Regenerated if src/ changed since last scan (git SHA comparison) |
| `test/scaffold-conformity.test.ts` | Harness-owned | Always regenerated to match harness version |
| `specs/SPEC-TEMPLATE.md` | Harness-owned | Updated to latest harness template |
| `.gitignore` | Co-owned (additive) | Append missing required entries. Never remove existing |
| `package.json` | Co-owned (additive) | Add missing required fields. Never overwrite existing |
| `CLAUDE.md` | Co-owned (additive) | Add `@AGENTS.md` if missing. Never overwrite existing |
| `.github/workflows/ci.yml` | Harness-owned | Always regenerated. Config (runner, bun version) from rungate.json |
| `.github/workflows/gates.yml` | Harness-owned | Always regenerated. Config from rungate.json |
| `tsconfig.json` | Co-owned (WARN) | WARN on missing recommended fields. Never modify |
| `AGENTS.md` | Hybrid (preserve markers) | Regenerate all sections EXCEPT Hard Constraints between markers |
| `.claude/rungate.json` | Hybrid (field-level merge) | Auto-detected fields regenerated from scan. Manual fields preserved. New fields added as null |
| `.github/copilot-instructions.md` | Tool-bridge | Create if missing. Skip if exists |
| `src/*.ts` | User-owned | Never touched |
| `docs/*.md` | User-owned | Never touched |
| `specs/*.md` (content) | User-owned | Never touched (frontmatter validated, not content) |
| `docs/adr/*.md` | User-owned | Never touched (frontmatter validated, not content) |
| `prompts/discovery-brief.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/marcus-implementation.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/quinn-ui-brief.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/rook-security-brief.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/serena-architecture-brief.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/aditi-design-brief.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/environment-check.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/container-rebuild.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/container-verify.md` | Harness-owned | Ships with harness package — not in project repo |
| `prompts/ac-adversary.md` | Harness-owned | Ships with harness package — gate prompt |
| `prompts/evidence-validator.md` | Harness-owned | Ships with harness package — gate prompt |
| `prompts/prove-reproducer.md` | Harness-owned | Ships with harness package — gate prompt |
| `prompts/rca-protocol.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/blast-radius-checklist.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/prevention-oriented-fix.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/regression-prevention-checklist.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/read-before-write-protocol.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/quinn-journey-decision-tree.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/evidence-hierarchy.md` | Harness-owned | Ships with harness package — Layer 1 methodology |
| `prompts/ac-format-guide.md` | Harness-owned | Ships with harness package — Layer 1 methodology |

**Ownership types explained:**
- **Harness-owned** — fully managed, user should not edit, always regenerated
- **Co-owned (additive)** — harness ensures required entries, user adds their own, never removes existing
- **Co-owned (WARN)** — harness recommends fields, user decides, never modifies
- **Hybrid** — mostly regenerated, user content between preservation markers survives
- **Harness-audited** — harness reads and reports drift, user owns content
- **Tool-bridge** — one-line pointer to AGENTS.md, only created if missing
- **User-owned** — harness never touches content

### .gitignore template

Full template created on new projects. On existing projects, missing required entries are appended.

```gitignore
# === Dependencies ===
node_modules/

# === Build output ===
dist/
*.tsbuildinfo

# === Secrets — CRITICAL for AI repos ===
# Agents may create credential files without recognizing them as sensitive.
# This is a mechanical backstop: even if an agent writes a secret file,
# git won't stage it.
.env
.env.*
!.env.example
*.pem
*.key
credentials.json
service-account*.json
*-secret*
*_secret*

# === Harness work directories ===
.rungate/

# === OS artifacts ===
.DS_Store
Thumbs.db

# === Test/coverage artifacts ===
coverage/
*.lcov

# === Logs ===
*.log
npm-debug.log*

# === Editor/IDE (local settings only) ===
.vscode/settings.json
.idea/

# === Temporary files ===
tmp/
.tmp/
*.swp
*.swo
```

**Required entries** (scaffold verifies these exist — appends if missing):
- `node_modules/`, `dist/`, `.env`, `.env.*`, `.rungate/`, `*.pem`, `*.key`, `credentials.json`

**Recommended entries** (included in template, not enforced on re-scaffold):
- `coverage/`, `*.log`, `.DS_Store`, `*.tsbuildinfo`, `tmp/`

**Never auto-add:** Project-specific entries (database files, vendor dirs, generated assets). User adds these.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | CODE-MAP.md generates FIRST (from code scan) | All other files depend on it — routes, components, modules, consumers |
| D-2 | rungate.json generates SECOND (from CODE-MAP + Makefile + package.json) | Config file that every workflow reads — must have complete data |
| D-3 | AGENTS.md generates THIRD (from rungate + CODE-MAP ref + docs scan) | Routing table that agents read — needs environment, consumers, docs |
| D-4 | .claude/agents/*.md generate FOURTH (from rungate + AGENTS.md) | Agent context — needs ports, pages, consumers from upstream |
| D-5 | Ship workflow reads rungate.json at startup, fills prompt templates | Zero hardcoded values — all from config |
| D-6 | Prompt templates in prompts/*.md with ${VAR} placeholders | Methodology is harness-owned, project data is config-driven |
| D-7 | If a config field is null, the dependent step is SKIPPED — no agent spawned | Library projects (no container) skip container steps cleanly |
| D-8 | AGENTS.md is the cross-tool standard; CLAUDE.md bridges to Claude Code | 30+ tools read AGENTS.md natively. Claude Code reads CLAUDE.md. Bridge: `@AGENTS.md` import in CLAUDE.md |
| D-9 | Bun + TypeScript are safe defaults for testCmd and typeCheck | All projects use this runtime/language. Ports, commands, and structure are NOT safe defaults |
| D-10 | Empty sections omitted from AGENTS.md | No consumers = no Consumers section. Keeps file under 150 lines naturally |
| D-11 | New code projects get a src/index.ts stub | Gives agents a starting point. One-liner, no framework — framework choice comes from the first /goal |
| D-12 | ACs use Given/When/Then format with executable verification command | AC IS the oracle — not prose. Research: 50% error reduction, 16pp higher acceptance rates |
| D-13 | Evidence hierarchy S/A/B/C/D/F with minimum tier per AC type | Tier S (dual-arm) for bug fixes, A (execution) for CODE, B (behavioral) for UI. Self-attestation always FAIL |
| D-14 | RCA required before implementation on bug-fix issues | 63% of top SWE-bench scores retrieve fixes rather than derive them. RCA forces understanding before patching |
| D-15 | Quinn uses typed test journeys with a11y-first perception | CHI 2026: a11y tree degradation drops success 80%→42%. Typed steps prevent Explore→Explore→Explore loop |
| D-16 | Proof-of-fix includes negative control (revert, confirm bug returns) | 46% of validation events carry zero discriminating information (BSG-VA). Negative control is the discriminator |
| D-17 | Templates three-layered: harness-generic + project-config + issue-specific | Generic ships with rungate. Project from scan. Issue from brief-assembler. Any project gets best practices free |
| D-18 | Spec content hash enforced at gates — mismatch = FAIL not WARN | WARN is behavioral (agent ignores). FAIL is mechanical (can't proceed with stale tests) |
| D-19 | Blast radius analysis required before implementation | Change failure rate up ~30% since AI adoption (Cortex 2026). Agents must map dependents before changing code |
| D-20 | Read-before-write ratio ≥ 3:1 | SWE-Explore: context efficiency r=0.928 with solve rate. Epoch AI uses 10:1 read-to-write ratio |
| D-21 | Writer and verifier must be separate agents | Same-agent test authorship has 31.7% semantic drift miss rate. Marcus writes, Quinn verifies, gate enforces |
| D-22 | CI workflows ship with the harness — gates enforced in pipeline, not just locally | Local gates can be skipped. CI gates can't. The pipeline is the final mechanical enforcement layer |
| D-23 | .github/copilot-instructions.md is a tool-bridge, not CI config | Points Copilot (chat + coding agent) to AGENTS.md. CI/CD enforcement is in .github/workflows/ |

## Bootstrap Execution Order

Single entry point: `bun scripts/scaffold-project.ts /path/to/project`

```
Pre-flight — INIT (ensure git + bun are set up — runs BEFORE Phase 0)

  Check: is this a git repo?
    YES → skip
    NO  → git init

  Check: does package.json exist?
    YES → skip
    NO  → bun init (creates package.json + tsconfig.json)

  Check: does .gitignore exist?
    YES → verify required entries, append missing
    NO  → create from template (BEFORE any git add — secrets never touch history)

  These three checks are idempotent. On existing projects, all three skip.

Phase 0 — STRUCTURE (directories + static files — no scan dependency)

  Directories:
  0.1  specs/              ← create dir (governs: spec files with testable SCs)
  0.2  docs/               ← create dir (governs: project documentation)
  0.3  docs/adr/           ← create dir (governs: architecture decision records)
  0.4  reference/          ← create dir (governs: archived/historical docs)
  0.5  test/               ← create dir (respects existing test/ vs tests/)
  0.6  src/                ← create dir + index.ts stub (new code projects only)
  0.7  .claude/            ← create dir
  0.8  .claude/agents/     ← create dir (governs: agent brief files)
  0.9  .github/            ← create dir (governs: GitHub config)
  0.10 .github/workflows/  ← create dir (governs: CI/CD pipeline)

  Static files (no scan data needed — harness-owned templates and config):
  0.11 .gitignore                           ← verify required entries (created in pre-flight if missing)
  0.12 specs/SPEC-TEMPLATE.md               ← copy harness template if specs/ empty
  0.13 test/scaffold-conformity.test.ts     ← imports from harness package (always regenerated)
  0.14 .github/copilot-instructions.md      ← tool-bridge: points Copilot to AGENTS.md (skip if exists)
  0.15 .github/workflows/ci.yml            ← CI pipeline: bun test + typecheck on PR/push (see CI Workflows)
  0.16 .github/workflows/gates.yml         ← gate enforcement: conformity + secret scan on PR (see CI Workflows)
  0.17 CLAUDE.md bridge                     ← add @AGENTS.md if not present, create minimal if missing
  0.18 package.json                         ← ensure required fields (see Required File Content)
  0.19 tsconfig.json                        ← ensure required fields (see Required File Content)
  0.20 Frontmatter                          ← add to any bare spec files (see Required File Content)

Phase 1 — SCAN (produce raw data files — requires code to exist)
  1.1  CODE-MAP.md      ← fallow + route + component + module + page scans
  1.2  rungate.json     ← CODE-MAP consumers + Makefile + package.json (null for undetected)

Phase 1.5 — EXTRACT (separate command, not auto-run)
  1.5  extract-constraints ← signal phrase scan of docs → candidates for human review
       On re-scaffold: HYGIENE-6 warns about unreviewed candidates

Phase 2 — GENERATE (produce agent-facing files from Phase 1 outputs)
  2.1  AGENTS.md        ← rungate.json (env, consumers, pages) + CODE-MAP (ref) + docs scan
  2.2  .claude/agents/  ← rungate.json (ports, pages) + AGENTS.md (identity, routing)

Post-scaffold — COMMIT (stage + commit harness files)

  Check: are there unstaged harness changes?
    YES (new project) → git add . && git commit -m "scaffold: initialize project with rungate"
    YES (re-scaffold) → git add . && git commit -m "scaffold: update harness files"
    NO  → skip (nothing changed)

  .gitignore is already in place (pre-flight), so git add . is safe — secrets won't be staged.
  On re-scaffold, only changed files are staged (git tracks this naturally).
```

## Required File Content

Phase 0 doesn't just create files — it ensures required content exists inside them. The pattern is always: **read → check → add missing → never overwrite existing.** If the file doesn't exist, create it from template. If it exists, add only what's missing.

### package.json (Phase 0.15)

**If file doesn't exist:** Create from template with all required + recommended fields.
**If file exists:** Read it, add missing required fields, WARN on missing recommended fields.

```json
{
  "name": "${PROJECT_NAME}",
  "type": "module",
  "scripts": {
    "test": "bun test"
  },
  "devDependencies": {
    "rungate": "latest"
  }
}
```

| Field | Required | Default value | Behavior if exists |
|-------|----------|--------------|-------------------|
| `name` | Yes | Directory name | Never overwrite |
| `type` | Yes | `"module"` | Never overwrite — WARN if not "module" |
| `scripts.test` | Yes | `"bun test"` | Never overwrite — use existing value for testCmd |
| `devDependencies.rungate` | Yes | `"latest"` | Add if missing, don't change version if present |
| `scripts.dev` | Recommended | — | WARN if missing (dev server command) |
| `scripts.build` | Recommended | — | WARN if missing (build command) |

**Never touch:** `dependencies`, `version`, `description`, `scripts.*` (other than test/dev/build if missing), any other existing fields.

### tsconfig.json (Phase 0.16)

**If file doesn't exist:** Create from template.
**If file exists:** Read it, WARN on missing recommended fields. Never overwrite.

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"]
}
```

| Field | Required | Default value | Behavior if exists |
|-------|----------|--------------|-------------------|
| `compilerOptions.strict` | Recommended | `true` | WARN if false — type safety for agent-written code |
| `compilerOptions.module` | Recommended | `"ESNext"` | Never overwrite |
| `include` | Recommended | `["src"]` | Never overwrite |

**Never touch:** Any existing compiler options, paths, references, custom settings.

### Spec frontmatter (Phase 0.17)

**If spec file has no frontmatter (bare .md):** Prepend frontmatter block with required fields.
**If spec file has frontmatter:** Check for missing required fields, add them with placeholder values.

```yaml
---
doc-type: spec
status: draft
owner: (unknown)
created: ${TODAY}
testable: false
governs: (describe what this spec controls)
---
```

| Field | Required | Default value | Conformity check |
|-------|----------|--------------|-----------------|
| `doc-type` | Yes | `spec` | Spec Discovery: FAIL if missing |
| `status` | Yes | `draft` | Spec Discovery: FAIL if missing |
| `testable` | Yes | `false` | Spec Discovery: FAIL if missing |
| `governs` | Yes | placeholder | Doc Hygiene: FAIL if missing |
| `owner` | Recommended | `(unknown)` | WARN if `(unknown)` |
| `created` | Recommended | today's date | No check |

### ADR frontmatter

```yaml
---
doc-type: adr
status: proposed
created: ${TODAY}
supersedes: (none)
---
```

| Field | Required | Default |
|-------|----------|---------|
| `doc-type` | Yes | `adr` |
| `status` | Yes | `proposed` (→ accepted → superseded) |
| `created` | Yes | today's date |
| `supersedes` | Recommended | `(none)` |

### Agent brief frontmatter (.claude/agents/*.md)

```yaml
---
name: marcus
description: Implementation engineer — writes code, tests, evidence
---
```

| Field | Required | Conformity check |
|-------|----------|-----------------|
| `name` | Yes | Must match filename (agent-validation: FAIL) |
| `description` | Yes | Must be present (agent-validation: FAIL) |

### .gitignore required entries (Phase 0.10)

```
node_modules/
dist/
.env*
.rungate/
*.log
```

**If file exists:** Read it, append any missing entries. Never remove existing entries.
**If file doesn't exist:** Create with all entries above.

### Conformity validation

All required fields are checked by conformity tests at gate time:
- `runSpecDiscovery` → spec frontmatter (doc-type, status, testable)
- `runDocHygiene` → spec governs field
- `runAgentFileValidation` → agent brief frontmatter (name, description)
- New: `runPackageValidation` → package.json required fields
- New: `runTsconfigValidation` → tsconfig.json recommended fields (WARN only)

## New Project vs Existing Project

### New project (empty directory)

No preconditions — scaffold handles everything.

| Phase | What happens | Result |
|-------|-------------|--------|
| Pre-flight | `git init` + `bun init` + `.gitignore` created | Git repo with package.json, secrets excluded |
| 0 (dirs) | All 10 dirs created, src/index.ts stub written | Agents have a starting point |
| 0 (static) | Spec template, conformity test, CI workflows, copilot-instructions, CLAUDE.md bridge, devDep, git hooks | Project ready for agents before any scan |
| 1.1 | CODE-MAP.md generated — minimal (just src/index.ts) | Structure documented |
| 1.2 | rungate.json generated — testCmd="bun test", everything else null | Safe defaults only |
| 2.1 | AGENTS.md generated — ~40-60 lines, empty sections omitted | Concise, under 150 |
| 2.2 | Agent briefs generated — Bun/TS defaults, null ports | Agents know runtime, not app |
| Post-scaffold | `git add . && git commit -m "scaffold: initialize project with rungate"` | Clean initial commit |

After first /ship cycle: Marcus creates real code → re-run scaffold → CODE-MAP and rungate.json populate with detected ports, routes, consumers → AGENTS.md and agent briefs update with real data.

### Existing project (files already there)

| Phase | What happens | Result |
|-------|-------------|--------|
| Pre-flight | git init: SKIP (exists). bun init: SKIP (package.json exists). .gitignore: verify entries | No destructive changes |
| 0 (dirs) | Dirs: SKIP (exist) | No change |
| 0 (static) | .gitignore verified, spec template updated, conformity test updated, CI workflows regenerated, CLAUDE.md bridge checked | Static files current |
| 1.1 | CODE-MAP.md refreshed if src/ changed since last scan (git diff against stored SHA) | Current code state — no arbitrary time/count thresholds |
| 1.2 | rungate.json field-level merge — auto-detect fields updated, manual fields preserved | Config current without losing user settings |
| 1.5 | HYGIENE-6 warns about unreviewed constraint candidates | User runs extract-constraints manually |
| 2.1 | AGENTS.md refreshed — Hard Constraints PRESERVED, env/pages/consumers UPDATED from rungate.json | Always current, never loses manual data |
| 2.2 | Agent briefs REGENERATED — always overwritten from rungate.json | Always match current config |
| Post-scaffold | `git add . && git commit -m "scaffold: update harness files"` (only if changes) | Changes tracked in git |

### Re-scaffold audits

Audits run during re-scaffold fall into two categories: auto-fixable (the scan has the data to fix it) and report-only (needs human judgment).

#### Auto-fixed (the scaffold has the right data — just fix it)

| Audit | What it checks | Action |
|-------|---------------|--------|
| Broken refs | File paths in AGENTS.md that don't resolve | **AUTO-FIX**: remove broken ref from AGENTS.md. Log: "Removed broken ref: {path}" |
| Unlisted specs | Specs in specs/ not mentioned in AGENTS.md | **AUTO-FIX**: add to AGENTS.md specs table. AGENTS.md is regenerated anyway — this is a bug if it happens |
| Missing CODE-MAP ref | CODE-MAP.md exists but not in AGENTS.md routing | **AUTO-FIX**: add to doc routing. Same as above — regeneration should handle this |
| Pages drift | Routes in code not in rungate.json pages map | **AUTO-FIX**: update rungate.json pages (auto-detected field). Agents get correct page URLs |

These should never need manual intervention — the scaffold already has the correct data from the code scan. If AGENTS.md regeneration and rungate.json field-level merge are working correctly, these audits are catching regeneration bugs, not drift.

#### Report only (needs human judgment)

| Audit | What it checks | Action |
|-------|---------------|--------|
| Stale docs | Docs older than threshold (spec 90d, guide 180d, ADR exempt) | WARN with age — stale ≠ wrong, human decides to archive or update |
| AGENTS.md line count | AGENTS.md over 150 lines (ETH Zurich: >150 lines = 20-23% cost increase, no behavior improvement) | WARN with count — may be legitimate for complex projects with many consumers/pages |
| Stale constraints | Hard Constraints referencing files that no longer exist | WARN with list — constraint may still be valid as a principle even if the referenced file was deleted |
| Constraint candidates | Unreviewed candidates from extract-constraints | WARN with count — 70% false positive rate, human review mandatory |

## Data Sources (what gets scanned from code)

| Scan | Tool | Produces | Used By |
|------|------|----------|---------|
| Dead code, unused exports, circular deps | fallow | CODE-MAP.md § Code Health | Marcus (cascade impact), gates (health check) |
| API route definitions | regex scan of src/ (framework-agnostic: Hono, Express, Fastify, tRPC, etc.) | CODE-MAP.md § API Routes | Marcus (knows endpoints), AGENTS.md (route count) |
| UI components | file scan of detected components dir (from CODE-MAP, not hardcoded path) | CODE-MAP.md § Components | Quinn (what exists to test) |
| Page→component mappings | import scan of detected router file | CODE-MAP.md § Page→Component Map | Quinn (targeted UI testing) |
| Module import chains | import scan of src/ | CODE-MAP.md § Module Dependencies | Marcus (cascade impact analysis) |
| Consumer modules | CODE-MAP module scan (not hardcoded patterns) | rungate.json consumers field | AGENTS.md, Marcus (cascade impact) |
| Entry points | package.json main/exports + Makefile targets | CODE-MAP.md § Summary | Agent orientation |
| Package info | package.json | CODE-MAP.md § Summary + rungate.json | AGENTS.md (project name, deps), workflows (test command) |
| Makefile targets | Makefile (if exists) | rungate.json (dev/prod commands) | Workflows (rebuild, dev-all, test-up) |
| Git remote | git remote get-url origin | rungate.json repo field | PR creation, issue tracking |
| tsconfig.json | tsconfig.json exists + compilerOptions | rungate.json dev.typeCheck | Ship workflow (type checking) |
| Router file | Detected from common patterns (App.tsx, routes.tsx, app/routes/, pages/) — not hardcoded path | rungate.json pages map | Quinn (URL navigation), AGENTS.md (pages table) |
| Test files | file scan of test/ or tests/ | CODE-MAP.md § Test Coverage | Marcus (knows what's tested vs not), gates (baseline) |
| MCP servers | .claude/settings.json mcp section (if exists) | rungate.json mcp field | Agent briefs (available tools), AGENTS.md |
| Environment variables | .env.example (if exists) | rungate.json envVars field | Agents know what env vars the project expects |
| Specs | specs/*.md frontmatter | AGENTS.md specs table | Conformity tests, gates |
| Docs | docs/*.md | AGENTS.md doc routing table | Agent DISCOVERY, context loading |

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

## CLI Commands for File Creation

Agents create specs and ADRs via CLI — guarantees correct location, format, and frontmatter. Never copy templates manually.

| Command | What it creates | Where |
|---------|----------------|-------|
| `bunx rungate create-spec "title"` | Spec with frontmatter + section stubs | `specs/title-slug.md` |
| `bunx rungate create-adr "title"` | ADR with template + auto-incremented number | `docs/adr/ADR-NNN-title-slug.md` |
| `bunx rungate sync-tests .` | Test assertions from testable specs | `test/spec-compliance-auto.test.ts` |
| `bunx rungate extract-constraints .` | Constraint candidates from docs | Candidates for review |

## Gate-Time Conformity Enforcement

Conformity tests run at TWO points in the ship cycle — not just at the end.

```
SCOPE GATE (before work starts):
  → runs test/scaffold-conformity.test.ts
  → verifies repo is clean BEFORE agent starts coding
  → catches: stale state, broken refs, misplaced files from prior work
  → FAIL = blocked. Fix before proceeding.

VERIFY GATE (after work complete):
  → runs test/scaffold-conformity.test.ts AGAIN
  → catches anything the agent introduced:
    - new spec in wrong dir? FAIL
    - new .md at root? FAIL
    - frontmatter missing? FAIL
    - circular dep introduced? FAIL
  → FAIL = blocked. Fix before shipping.
```

Conformity suite runs in <500ms (pure file system checks, no network/LLM).

### Findings flow (detection → structured output → agent fix → re-verify)

```
bun test (in project)
  → conformity suites run (HYGIENE-1 through HYGIENE-10)
  → extract-constraints runs (signal phrases → candidates, staleness)
  → HYGIENE-REPORT writes .rungate/conformity-findings.json:
      { findings: [{ruleId, severity, file, message, fixCommand}],
        constraintCandidates: [{rule, source, hash, status}],
        staleness: [{file, daysSince, threshold, type}] }
  → Gate runner (run-gate.ts) reads .rungate/conformity-findings.json
  → Prints structured output with fix commands
  → Stores conformityFindings in workflow-state.json
  → Agent reads workflow-state.json → executes fixCommands → re-runs bun test
```

Agent discovery paths:
- **During ship gate:** workflow-state.json `conformityFindings` field (gate runner puts it there)
- **Running bun test directly:** HYGIENE-REPORT prints path + details to terminal
- **Reading project docs:** AGENTS.md Commands table → `cat .rungate/conformity-findings.json`

Nothing is lost to stdout. Constraint candidates persist in the JSON file until applied or rejected.

Structural violations are FAIL, not WARN:

| Check | Severity | Rationale |
|-------|----------|-----------|
| Misplaced spec/ADR/doc | FAIL | Wrong location = harness can't find it |
| Missing frontmatter | FAIL | No frontmatter = no test generation |
| Broken file references | FAIL | Broken ref = broken routing |
| Missing package.json required fields | FAIL | name, type:module, scripts.test, devDep required for harness |
| Secret patterns in staged files | FAIL | HYGIENE-12 — mechanical catch for 44% AI security flaw rate |
| Spec drift (hash mismatch) | FAIL | Tests don't match current spec = stale tests |
| AGENTS.md over 150 lines | WARN | May be legitimate for complex projects |
| Stale docs | WARN | Stale ≠ wrong, needs human judgment |
| Missing tsconfig.json strict:true | WARN | Recommended, not required |
| Unreviewed constraint candidates | WARN | 70% false positive rate — human review needed |

## Agent Brief Core Principles

Every agent brief (`.claude/agents/*.md`) includes a shared Core Principles block. These are non-negotiable rules derived from a year of learned failures (25+ correction entries, 50 tiered learned rules).

### Universal block (in EVERY agent brief, ~8 lines)

```
## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run `bun test` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools (see Research and Escalation below)
```

### Role-specific rules (added per agent)

| Agent | Key rules from learned failures |
|-------|-------------------------------|
| Marcus | Read governing spec BEFORE coding. Modify ONLY files in brief. Commit after every green cycle. Never duplicate components — add props. Schema validation at boundaries (Zod). Every new module gets a drift test. |
| Quinn | Test full workflow (trigger → result → USE result). Compare against visual spec if referenced. Test edge cases after golden path. Verify fix commit deployed before testing. Open every rendered URL. |
| Rook | Check git diff for .env, credentials, tokens, API keys. Scan pattern siblings (shared-import files). |
| Serena | Read existing ADRs before proposing new ones. Every structural decision gets a spec. |

## Coding Principles (shipped with harness as `prompts/coding-principles.md`)

AI agents produce 10-50x more boundary violations per session than human engineers (Ousterhout observation, confirmed by SWE-bench analysis). These principles are EXPLAINED in the template — agents need rationale, not just rules. Context7 MCP provides current library docs to supplement stale training data.

### Deep modules over shallow wrappers

Modules should provide powerful functionality behind simple interfaces. A module with a 5-method interface that handles 15 edge cases internally is better than a module with a 15-method interface that pushes edge cases to callers. AI agents default to creating pass-through wrappers — the brief must explicitly say "absorb complexity, don't redistribute it."

**Gate signal:** If a new module has more exported functions than internal functions, it's likely shallow. WARN if exports > 5 for a single module file.

### Boundary validation with Zod

Validate at system boundaries (user input, API responses, config files, external data) using Zod schemas. Internal function calls between trusted modules do NOT need runtime validation — TypeScript types handle that. The boundary is where untrusted data enters the system.

**Template explains:** "Boundary = where data crosses a trust line. HTTP request body: boundary. Function arg from your own module: not boundary. Config file read from disk: boundary. Object passed between your functions: not boundary."

### Exhaustive matching (assertNever)

Every switch/case on a union type must have a default branch that calls `assertNever(x)` — a function that accepts `never` and throws. This catches unhandled variants at compile time when new variants are added. Without it, new enum values silently fall through.

```typescript
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}
```

### Immutability by default

Use `readonly` arrays and objects. Use `as const` for literal types. Mutate only when performance requires it and document why. AI agents frequently introduce mutation bugs because they copy patterns without understanding ownership semantics.

### Branded types for domain values

IDs, slugs, paths, and other stringly-typed values should use branded types to prevent accidental interchange:

```typescript
type IssueId = number & { readonly __brand: "IssueId" };
type SlugId = string & { readonly __brand: "SlugId" };
```

### Error handling: fail loud at boundaries, propagate inside

At boundaries: catch, log, return structured error. Inside modules: let errors propagate — don't catch-and-rethrow with less information. Never swallow errors silently. Never use empty catch blocks.

### One export per concern

Each file exports one primary thing. Utility files with 10+ exports are a code smell. If a file has unrelated exports, split it. The test for "related": could you rename the file to describe all exports in 3 words?

### Context loading architecture (D-23)

Anthropic's Claude Code architecture confirms the routing table approach:

1. **CLAUDE.md** — always loaded for every non-fork subagent automatically. Project rules, conventions, bridge to AGENTS.md
2. **AGENTS.md** — loaded via CLAUDE.md bridge. Routing table telling agents WHERE to find methodology docs
3. **Skills** — loaded on demand. Methodology files (coding principles, testing strategy, RCA protocol). Can be preloaded per agent type via frontmatter `skills` field
4. **Agent definition frontmatter** — `skills: [skill-name]` preloads specific skills for specific agent types
5. **Brief/task message** — task-specific instructions + pointers to skills/docs. Stays small (~35 lines L3)

Templates are condensed reference cards (~20-30 lines each), not full spec sections. Agent reads the card, follows the steps. Full rationale lives in the spec. Context budget: heaviest agent (Marcus bug-fix) uses ~314 lines / 3.1% of 200k context window. Full 5-agent cycle uses 11.1%.

## Testing Strategy (shipped with harness as `prompts/testing-strategy.md`)

AI-generated tests have 91% line coverage but only 34% mutation score — they test the implementation, not the behavior. The testing pyramid INVERTS for AI code: property-based > contract > integration > unit.

### Testing pyramid for AI-authored code

Traditional pyramid (unit > integration > e2e) assumes humans write focused units. AI agents write sprawling functions that pass unit tests trivially. The effective pyramid:

1. **Property-based testing (PBT)** — highest value. Define invariants ("output is always sorted", "length never negative", "round-trip encode/decode is identity"). Anthropic's own research found 984 bugs across 100 packages using PBT. 56% were true bugs.
2. **Contract tests** — verify module boundaries. Consumer-driven: the consumer defines what it expects, the provider proves it delivers. Catches the integration seam where AI agents create the most bugs.
3. **Integration tests** — test real data flow through real dependencies. No mocks for databases, APIs, file systems unless the real thing is genuinely unavailable. Mocked tests pass; prod breaks.
4. **Unit tests** — lowest priority for AI code. Still valuable for pure functions with complex logic. But an AI agent writing unit tests for its own code is the tautological testing trap — testing WHAT it built, not WHETHER what it built is correct.

### Tautological testing trap

AI writes implementation → AI writes test for that implementation → test passes → but the test only verifies the code does what the code does, not what the SPEC says. The test is a tautology.

**Mitigation:** Writer and verifier must be separate agents (SC-66). Marcus writes code + tests. Quinn verifies behavior. Gate checks that test assertions reference AC thresholds, not implementation details.

### Consumer-driven contract tests

When module A depends on module B: A defines a contract ("I expect B.get(id) to return `{name: string, active: boolean}`"). B's test suite includes A's contract as a test case. If B changes its return type, A's contract test fails BEFORE the integration breaks.

**Gate signal:** If a module has >3 importers and no contract test, WARN.

### Mutation testing as quality signal

Coverage % measures lines executed, not behavior verified. Mutation testing modifies code (change `>` to `>=`, remove a line, swap a constant) and checks if tests catch the mutation. Kill rate = test quality.

**Harness integration:** Future work (see Evaluated Concerns). Current minimum viable: test count comparison at verify gate. Mutation testing adds ~10min per run — evaluate when CI pipeline is mature.

### Boundary testing (horizontal and vertical)

- **Horizontal:** test at module boundaries — the interface between modules. What happens when module A passes unexpected data to module B?
- **Vertical:** test at layer boundaries — HTTP → service → database. What happens when the database returns unexpected data?

AI agents test the happy path vertically (request → response works). They skip horizontal boundaries (what if the service returns null? what if the type is wrong?).

**Template instruction:** "After every golden path test, write one boundary test: null input, empty array, type mismatch, concurrent access."

### Test evidence requirements per AC type

| AC Type | Minimum test evidence | Why |
|---------|----------------------|-----|
| CODE | Bun test output showing pass + assertion count | Mechanical proof |
| UI | Quinn journey PASS + screenshot on FAIL | Functional + visual |
| BUG-FIX | Regression test (fails without fix, passes with) + negative control | Proves fix, not coincidence |
| OUTCOME | Live execution output showing expected state | Can't unit-test outcomes |
| ANTI | Grep/test proving the anti-pattern is absent | Absence proof |

## Research and Escalation

Agents must know they have research tools and WHEN to use them. The #1 failure pattern is an agent iterating 5 times on the wrong approach instead of stopping to research. The circuit breaker (3 iterations max) should trigger research, not just stop.

### Available research tools (declared in AGENTS.md and agent briefs)

| Tool | What it does | When to use |
|------|-------------|------------|
| Context7 MCP | Fetches current documentation for any library, framework, SDK, API | Unknown API behavior, version-specific syntax, framework patterns |
| WebSearch | Searches the web for current information | Error messages, unfamiliar patterns, "how does X work" |
| Council workflow | Multi-perspective debate with parallel agents | Architecture decisions, tradeoff analysis, design disagreements |
| Research skill | Parallel multi-source investigation | Complex unknowns, multi-faceted questions, API investigation |
| Explore agent | Fast read-only codebase search | "Where is X defined", "which files reference Y" |

### Escalation decision tree (embedded in every agent brief)

```
STUCK? (same error on iteration 2, or no progress after iteration 1)

1. Is it a library/framework question?
   → YES → Use Context7 MCP: query the library docs
   → Got answer? → Apply it
   → No answer? → WebSearch for the error/pattern

2. Is it a codebase question? (where is X, how does Y work here)
   → YES → Spawn Explore agent with specific search query
   → Found it? → Apply it
   → Not found? → The code may not exist yet — check with DA

3. Is it a design question? (should we do A or B)
   → YES → Escalate to DA — don't make architecture decisions alone
   → DA may invoke Council for multi-perspective analysis

4. Is it an unknown API or external system?
   → YES → Use Research skill for parallel investigation
   → Don't guess API behavior — verify it

5. Still stuck after research?
   → STOP. Report what you tried, what you found, and what's blocking.
   → Don't iterate further — the problem needs human input.
```

### Circuit breaker → research escalation

```
Iteration 1:   Normal implementation
Iteration 2:   If same error → MUST research before trying again
Iteration 3:   STOP — report what you tried, what you researched, what's blocking
```

Three iterations, not five. The research is clear: failure trajectories are 12-82% longer than successful ones (SWE-bench taxonomy study). CMU found 3-7 turns is optimal — more turns often degrades quality. Five iterations down a hole is four too many.

The research requirement at iteration 2 is mechanical — if the same error occurs twice, the gate checks that a research tool was invoked before iteration 3. Without research evidence, the agent is repeating the same mistake and must stop.

**Why 3 not 5:**
- If you haven't solved it in 2 attempts + research, you're missing something fundamental
- Each additional iteration increases vulnerability count 37.6% (IEEE-ISTAS 2025)
- Stopping early preserves context window for the DA to diagnose
- The DA can invoke council, research skill, or re-scope — options the agent doesn't have

### What goes in rungate.json

```json
{
  "research": {
    "context7": true,
    "webSearch": true,
    "council": true,
    "explore": true
  }
}
```

These flags tell the brief-assembler which research tools to include in agent briefs. If a tool isn't available (MCP server not configured), the flag is false and the brief omits it. Agents only see tools they can actually use.

### What goes in AGENTS.md

```markdown
## Research Tools

When stuck (2+ iterations without progress), use these before continuing:

| Need | Tool | Example |
|------|------|---------|
| Library docs | Context7 MCP | `resolve-library-id` → `query-docs` for Hono, Zod, etc. |
| Error diagnosis | WebSearch | Search exact error message |
| Architecture decision | Council | Escalate to DA for council debate |
| Find code | Explore agent | "Where is the auth middleware defined?" |
```

## AC Format Standard

Every acceptance criterion uses a structured format with an executable oracle. Prose descriptions are not ACs — they're wishes.

### AC ID scheme

- IDs are per-issue: AC-1, AC-2, AC-3 within each issue
- Anti-criteria (must NOT happen) use: AC-A1, AC-A2
- IDs are stable — once assigned, never renumbered even if ACs are removed
- Each test must annotate which AC it covers: `// covers: AC-1`
- Gate checks: every AC has at least one test. Untested AC = WARN

### Required fields per AC

```
AC-NNN: [title]
  Given: [precondition with specific values — not "valid input" but "email=test@x.com"]
  When: [exact action — HTTP method + path, CLI command, or UI action]
  Then: [exact expected output with threshold — status code, value, element state]
  Verify: [executable command that returns pass/fail — the oracle]
  Not: [explicit exclusions — what this AC does NOT cover]
  Assumption: [what would break if this AC's protection is bypassed — powers mutation testing]
  Evidence-tier: [minimum S/A/B/C required for this AC type]
```

### Anti-criteria format (must NOT happen)

```
AC-A1: [title — negative assertion]
  Given: [precondition]
  When: [action that SHOULD NOT produce a result]
  Then: [expected ABSENCE — no output, no file, no element]
  Verify: [command that returns pass if the thing does NOT exist]
  Not: [what this anti-criterion doesn't cover]
```

Anti-criteria catch removal and deletion requirements. Agents have 71.7% deletion recall — they often retain code that should be removed. Explicit anti-criteria force verification of absence.

### Four-question checklist (every AC must answer all four)

1. **Trigger** — what action/input produces the behavior?
2. **Output** — what observable result confirms success?
3. **Verification** — what command proves it? (executable, not prose)
4. **Exclusions** — what is explicitly NOT in scope?

### Garbage test

Every AC is tested: "Could garbage data satisfy this criterion?" If yes, tighten until the answer is no. Examples:
- BAD: "Page loads successfully" → any 200 passes, even error pages
- GOOD: "GET /dashboard → 200, body contains heading 'Dashboard' + user menu shows 'jason@...'"
- BAD: "Handles errors gracefully" → unfalsifiable
- GOOD: "POST /api/login with wrong password → 401, body = `{error: 'invalid_credentials'}`"

### AC type classification

| AC Type | When | Evidence-tier minimum | Verification pattern |
|---------|------|----------------------|---------------------|
| CODE | Logic, data, API behavior | A (execution) | bun test, curl, CLI command |
| UI | Visual state, layout, interaction | B (behavioral) | browser_snapshot assertion |
| OUTCOME | End-to-end user flow | A (execution) | Full flow reproduction |
| BUG-FIX | Regression from reported issue | S (dual-arm) | Fails before fix, passes after |
| ANTI | Must NOT exist/happen | A (execution) | grep/test confirms absence |

### Examples per type

**CODE:**
```
AC-1: Login returns JWT on valid credentials
  Given: user exists with email="test@x.com", password="correct-pw"
  When: POST /api/auth/login with {email, password}
  Then: 200, body contains JWT with exp > now + 3600
  Verify: curl -s -X POST localhost:${DEV_API}/api/auth/login -d '{"email":"test@x.com","password":"correct-pw"}' | jq -e '.token'
  Not: No OAuth, no SSO, no MFA in this AC
  Assumption: If JWT validation is bypassed, auth is broken
  Evidence-tier: A
```

**UI:**
```
AC-2: Dashboard shows user name after login
  Given: user logged in as "jason@example.com"
  When: navigate to /dashboard
  Then: heading 'Dashboard' visible, user menu shows "jason@example.com"
  Verify: browser_snapshot() → assert heading 'Dashboard' + text 'jason@example.com'
  Not: No dashboard data accuracy in this AC — just presence
  Evidence-tier: B
```

**BUG-FIX:**
```
AC-3: EOL date shows 2027-09, not 2025-06
  Given: OCP Virt product in dashboard
  When: GET /api/dashboard
  Then: eolDate field = "2027-09"
  Verify: curl localhost:${DEV_API}/api/dashboard | jq -e '.products[] | select(.name=="OCP Virt") | .eolDate == "2027-09"'
  Not: Other product dates not in scope
  Assumption: If eol-dates.ts is reverted, this date returns to 2025-06
  Evidence-tier: S (must fail before fix, pass after, fail on revert)
```

**ANTI:**
```
AC-A1: Legacy signals object no longer used
  Given: codebase after registry migration
  When: grep for signals.intelligence, signals.accountPlan, signals.cases
  Then: zero matches
  Verify: grep -rn "signals\.\(intelligence\|accountPlan\|cases\)" src/ | wc -l → 0
  Not: registrySignals usage is expected and correct
  Evidence-tier: A
```

### Where ACs live

1. **Canonical source:** GitHub issue body (structured in Success Criteria section)
2. **Parsed into:** workflow-state.json `acs[]` array at DISCOVERY phase
3. **Filled into:** per-agent brief templates by brief-assembler
4. **Verified by:** gate runner at ship gate (each AC has evidence + verdict)

The brief-assembler parses ACs from workflow-state.json, not from the issue body directly. The DA writes structured ACs during DISCOVERY and stores them in workflow-state.json. This is the canonical machine-readable format that all downstream steps read.

## Evidence Hierarchy

Evidence is scored by discriminating power — how well it distinguishes correct from incorrect implementation.

| Tier | Type | Example | Gate rule |
|------|------|---------|-----------|
| S | Dual-arm (fails before, passes after + negative control) | Reproduce bug → fix → verify pass → revert → verify fails again | Required for BUG-FIX ACs |
| A | Execution-based (test output, API response) | `bun test` output: "24 pass 0 fail" | Required for CODE ACs |
| B | Behavioral observation (a11y snapshot assertion) | browser_snapshot shows heading 'Dashboard' with correct values | Required for UI ACs |
| C | Static analysis (typecheck, lint, format) | `bunx tsc --noEmit` exits 0 | Supplementary — never sole evidence |
| D | Structural grep (string presence) | `grep -c "function validateInput" src/auth.ts` returns 1 | Max 25% of total evidence (existing ratio check) |
| F | Self-attestation ("I verified it works") | Agent prose without command output | Always FAIL — zero evidentiary value |

### Evidence-to-tier mapping

The gate classifies evidence by its `evidenceMethod.type` field in workflow-state.json:

| evidenceMethod.type | Tier | Notes |
|---------------------|------|-------|
| `BUN_TEST` | A | Execution-based test output |
| `curl`, `CLI`, `command` | A | Direct command execution |
| `browser_snapshot` | B | A11y tree assertion (requires typed assertion, not just snapshot) |
| `screenshot` | B only if assertion present | Without assertion → F (self-attestation) |
| `tsc`, `lint`, `format` | C | Static analysis — never sole evidence |
| `grep` | D | Structural presence check |
| `prose`, `manual`, none | F | Self-attestation — always FAIL |

For BUG-FIX ACs, tier S requires BOTH: `evidenceMethod.type` returns PASS AND `proofOfFix.negativeControl` exists and shows FAIL on revert.

### Gate enforcement

- Each AC's evidence is scored against its type's minimum tier (see AC type classification)
- OUTCOME ACs: tier A for new features, tier S for bug-fix outcomes
- Overall evidence portfolio: tier D evidence capped at 25% (existing `evidence-type-ratio` check)
- Tier C only: if ALL evidence for an AC is tier C (static analysis only) → FAIL "static analysis alone is insufficient"
- Self-attestation (tier F) in any AC = automatic FAIL regardless of other evidence
- Evidence without assertion = tier F (screenshot taken but nothing checked = self-attestation)

### Test deletion prevention

- Scope gate captures test count (pass + fail)
- Verify gate compares: `post_test_count ≥ pre_test_count`
- Test count DECREASE = FAIL with message "Tests removed — verify no gaming"
- This catches the documented anti-pattern of agents deleting failing tests

## RCA Protocol

Required for all bug-fix issues. Included in all Marcus briefs (bug-fix AND feature). Gate enforcement only checks RCA fields on bug-fix issues — for features, the RCA section is guidance, not enforced.

### Issue type classification

The issue type determines RCA enforcement and evidence-tier minimums:

| Label on GitHub issue | `issueType` in workflow-state | RCA enforced? | Evidence minimum |
|----------------------|-------------------------------|--------------|-----------------|
| `bug` | `bug-fix` | Yes — gate checks RCA fields | S (dual-arm) |
| `enhancement`, `feature` | `feature` | No — RCA included but not enforced | A (execution) |
| `refactor` | `refactor` | No | A (execution) |
| No label | `unknown` | No — DA should classify at DISCOVERY | A (execution) |

The DA sets `issueType` in workflow-state.json during DISCOVERY based on the GitHub issue label. If no label, DA classifies from the issue description and adds the label.

### Four-phase investigation (Hermes protocol, adapted)

```
Phase 1: INVESTIGATE (mandatory before ANY code change)
  1. Reproduce the bug — exact steps/command that triggers it
  2. Trace data/control flow from symptom backward to origin
  3. Read the file(s) you intend to modify — full function, not just error line
  4. Read 2+ callers of the function you're modifying
  5. Read tests that cover the code you're about to change

Phase 2: PATTERN ANALYSIS
  1. Find WORKING examples of similar code in the codebase
  2. Diff working vs broken — identify ALL differences
  3. Map dependency chain from root cause to symptom

Phase 3: HYPOTHESIS (scientific method)
  1. State ONE falsifiable hypothesis: "The bug is caused by [X] because [Y]"
  2. PREDICT: if X is the root cause, what OTHER symptom should exist?
  3. Test the prediction — wrong prediction = wrong hypothesis → back to Phase 1
  4. Change ONE variable at a time

Phase 4: IMPLEMENT (only after Phases 1-3 complete)
  1. Write failing test that reproduces the bug BEFORE writing fix
  2. Minimal fix at the ROOT cause, not at the symptom
  3. Verify fix makes failing test pass + all existing tests still pass
  4. Guard at boundary where bad data first enters the system
  5. Audit for same pattern elsewhere: grep for similar code
```

### Gate enforcement (RCA fields in workflow-state)

```json
"rca": {
  "symptom": "EOL date shows 2025-06 instead of 2027-09",
  "reproduction": "curl localhost:${DEV_API}/api/dashboard | jq .eolDate",
  "rootCause": "src/data/eol-dates.ts:47 — hardcoded date not updated after vendor announcement",
  "prediction": "Other vendor dates in same file may also be stale",
  "predictionVerified": true,
  "predictionEvidence": "grep found 3 other stale dates in same file",
  "blastRadius": ["src/data/eol-dates.ts", "src/api/dashboard.ts", "test/eol.test.ts"]
}
```

Gate checks:
- `rootCause` populated → not empty string
- `prediction` populated → agent stated a falsifiable prediction
- `predictionVerified` is true → agent tested the prediction
- If ANY field empty on a bug-fix issue → WARN (not FAIL initially — graduate to FAIL after 30 days)

### Heuristic

If the "fix" is in the same file as the symptom, verify you haven't just suppressed the symptom. Root cause is usually 1-3 files upstream.

## Quinn Test Journey Format

Quinn receives typed test journeys — not prose instructions. Each step has explicit assertions, wait conditions, and flow control. No room for random exploration.

### Journey schema

```yaml
test_journey:
  name: "checkout-flow"
  url: "http://localhost:${DEV_UI_PORT}/products"
  preconditions:
    - "User is logged in"
    - "Cart is empty"

  steps:
    - id: "step-1"
      action: "Navigate to product listing page"
      wait_for: "heading 'Products' visible in snapshot"
      assert:
        - type: element_visible
          target: "heading 'Products'"
        - type: element_count
          target: "product cards"
          expected: ">= 1"
      on_fail: STOP
      evidence: snapshot

    - id: "step-2"
      action: "Click 'Add to Cart' on first product"
      wait_for: "cart badge updates"
      assert:
        - type: text_changed
          target: "cart badge"
          from: "0"
          to: "1"
        - type: element_visible
          target: "notification 'Added to cart'"
      on_fail: STOP
      evidence: snapshot

  verdict_rules:
    all_pass: JOURNEY_PASS
    any_critical_fail: JOURNEY_FAIL
    non_critical_fail: JOURNEY_WARN
```

### Assertion types

| Type | What it checks | Example |
|------|---------------|---------|
| element_visible | Element exists in a11y tree | heading 'Dashboard' |
| element_absent | Element should NOT be in a11y tree | error banner not present |
| text_match | Element text equals expected | user menu shows 'jason@...' |
| value_check | Element value satisfies condition | total price > $0.00 |
| state_check | Element state (checked/disabled/expanded) | submit button disabled |
| text_changed | Element text changed from X to Y | cart badge 0 → 1 |
| element_count | Count of matching elements | product cards >= 1 |
| no_errors | No error elements in snapshot + no new console errors | Clean state verification |
| visual_check | Screenshot comparison (only when a11y can't verify) | layout, color, overlap |

`element_absent` catches cases where old UI should be removed after a fix. `no_errors` is weak alone but valuable as a baseline check at step start — catches error states before testing the feature.

### Journey constraints

- **Max 5-8 steps per journey.** Context degradation: instruction compliance decays from 73% at turn 5 to 33% by turn 16. Brief-assembler splits longer flows into multiple journeys with explicit entry conditions.
- **Max steps enforced at generation time** — brief-assembler rejects journeys over 8 steps and splits automatically.
- Each split journey has `preconditions` that reference the prior journey's end state.

### Perception hierarchy

1. **Primary: browser_snapshot() (a11y tree)** — 2-5KB, deterministic, 10-100x cheaper than screenshots, no vision model needed
2. **Fallback: browser_take_screenshot()** — ONLY for visual checks (layout, color, overlap, canvas/SVG) or on FAIL
3. **Never: raw DOM/HTML** — noisy, expensive, brittle

### Decision tree (embedded in Quinn's prompt)

```
BEFORE EACH STEP:
  Am I on the right URL? → NO → navigate, retry once → still NO → FAIL
  Can I find target element in snapshot? → NO → wait 3s, re-snapshot → still NO → FAIL
  Is page in expected state? → NO → check for error banners → report actual state → FAIL

AFTER EACH ACTION:
  Did snapshot change? → NO → action may not have fired → retry once → still NO → FAIL
  Does new state match expected? → YES → PASS with evidence → NO → FAIL with diff
  Am I still on expected URL? → NO → unexpected navigation → WARN
```

### Circuit breaker

- 3 consecutive FAIL steps → ABORT journey with partial results
- Total elapsed > timeout (300s) → ABORT
- Same step retried 2x → FAIL definitively, move on

### Evidence capture rules

| Event | Snapshot (a11y) | Screenshot | Console log |
|-------|----------------|------------|-------------|
| Step start (BEFORE) | ALWAYS | Only if visual step | Check for pre-existing errors |
| After action (AFTER) | ALWAYS | Only on FAIL or visual step | Check for new errors |
| Assertion FAIL | Attach diff | ALWAYS | ALWAYS |
| Assertion PASS | Store ref only | Skip | Skip |
| Journey end | Final state | ALWAYS (final proof) | Full log |

### Journey generation and storage

The brief-assembler generates Quinn journeys from ACs with UI type:
- AC's `evidenceMethod.type` = browser_snapshot or screenshot → generates a journey step
- AC's threshold becomes the assertion expected value
- AC's contextFiles become the navigation targets
- `${DEV_UI_PORT}` from rungate.json fills URLs

**Where journeys live:**
1. **Generated at:** ship time by brief-assembler
2. **Stored in:** `~/.rungate/{slug}/quinn-journey.yaml` (per-issue)
3. **Read by:** Quinn's prompt template references the journey file path
4. **Evidence stored in:** `~/.rungate/{slug}/evidence/journey-{step-id}.json` (per-step)

Journey files are ephemeral — they live in the slug directory and follow slug lifecycle (archived after 24h, deleted after 30 days).

## Blast Radius Analysis

Required before implementation. The brief-assembler generates a blast radius section from CODE-MAP data.

### Pre-implementation checklist (in Marcus brief)

```
BEFORE writing any code change:
1. DIRECT DEPENDENTS: What imports/calls the code I'm changing?
   → grep -r "import.*{module}" src/ && grep -r "{function}" src/
2. TRANSITIVE: What depends on those dependents? (2 levels deep)
3. TEST COVERAGE: Do tests exist for each dependent?
   → NO → write tests for dependents BEFORE making the change
4. INTERFACE CONTRACT: Changing a function signature or return type?
   → YES → update every caller in the same PR
5. CROSS-BOUNDARY: Change crosses module/package boundary?
   → YES → flag for review, do not proceed autonomously
```

### Gate enforcement

```json
"blastRadius": {
  "filesRead": ["src/api/auth.ts", "src/middleware/jwt.ts", "test/auth.test.ts"],
  "filesChanged": ["src/api/auth.ts"],
  "readToWriteRatio": 3.0,
  "unlisted": []
}
```

- `filesRead.length ≥ filesChanged.length` — read more than you write
- `readToWriteRatio ≥ 3.0` — computed by gate from filesRead.length / filesChanged.length (file count, not token count — simpler and available without instrumentation)
- `unlisted` not empty → WARN "Files changed outside brief: {list}" with explanation required
- `filesRead` empty → WARN "No files read before implementation — likely symptom-fixing"

## Prevention-Oriented Fix Protocol

Beyond fixing the current bug — every fix should make the same class of bug harder to introduce. This section is included in ALL Marcus briefs (bug-fix and feature). Guard/type-narrow/pattern-audit are universal. Gate enforcement of the `prevention` JSON block only applies to bug-fix issues.

### Post-fix checklist (required before marking AC complete)

```
AFTER fixing any bug, before marking complete:

1. GUARD AT BOUNDARY: Add input validation/assertion at the point where
   bad data FIRST enters the system — not where it crashes
   → typeof checks for unexpected types
   → Range checks for numeric boundaries
   → Null guards where null propagation caused the bug
   → Schema validation (Zod) at API/module boundaries

2. TYPE NARROWING: Can the type system prevent this class of bug?
   → Discriminated unions over string literals
   → Branded types for IDs that shouldn't be interchangeable
   → NonNullable<T> where null caused the failure
   → Exhaustive switch/case (default branch = compile error)

3. INVARIANT ASSERTION: Add runtime assertion that would catch this
   bug class EVEN IF the specific fix regresses
   → assert(condition, "Invariant: [what must be true and why]")
   → Place at function entry, not deep in the logic
   → The assertion should fire on ANY variant of this bug, not just this instance

4. PATTERN AUDIT: grep for the same pattern elsewhere in codebase
   → grep -rn "[pattern that caused bug]" src/
   → If the same mistake exists elsewhere, fix ALL instances in this PR
   → Report count: "Found N instances, fixed N"

5. BOUNDARY TEST: Write a test that sends the EXACT bad input
   that caused this bug
   → Test must FAIL without your fix and PASS with it
   → Test name should describe the bug class, not the ticket number
   → Good: "rejects_negative_quantity_in_cart"
   → Bad: "fix_issue_1234"

6. BUG CLASS DOCUMENTATION: Name the class in the PR/commit
   → Null propagation, off-by-one, race condition, type coercion,
     stale cache, missing await, unhandled edge case, etc.
   → Enables pattern-matching in future reviews
   → Gate records bug class in workflow-state for trend analysis
```

### Gate enforcement

```json
"prevention": {
  "guardAdded": true,
  "guardLocation": "src/api/auth.ts:23 — Zod schema validates login payload",
  "patternAuditCount": 3,
  "patternAuditFixed": 3,
  "bugClass": "null-propagation",
  "boundaryTestName": "test/auth.test.ts:rejects_missing_email_field"
}
```

- `guardAdded` = false → WARN "No boundary guard added — same bug class can recur"
- `patternAuditCount` > `patternAuditFixed` → **FAIL** "N unfixed instances of same pattern remain — fix all or explain why not"
- `bugClass` empty → WARN "Bug class not documented — can't track trends"
- All fields populated → prevention score logged for trend analysis

`patternAuditCount > patternAuditFixed` is FAIL not WARN because: you FOUND the same bug elsewhere and chose not to fix it. That's not a judgment call — it's a known gap being shipped. If there's a legitimate reason to skip (e.g., different module owner), add to `scopeOut` with explanation.

### Why this matters

AI-generated code has a 44% security flaw rate (Veracode 2026). Without prevention-oriented fixes, each bug is fixed in isolation and the same class recurs. The pattern audit step alone (grep for siblings) caught 3+ additional instances in prior sessions that would have become separate bug reports.

## Proof-of-Fix Protocol

Extends existing /prove skill with negative control step. Required for S-tier (dual-arm) evidence.

### When each step applies

| Step | Bug-fix issues | Feature issues | Rationale |
|------|---------------|----------------|-----------|
| 1. REPRODUCE | Required | Skip (no "before") | Can't reproduce what didn't exist |
| 2. APPLY | Required | Required | Both need the fix/feature applied |
| 3. VERIFY-FIX | Required | Required | Both need verification |
| 4. VERIFY-REGRESSION | Required | Required | Both can cause regressions |
| 5. NEGATIVE CONTROL | Required | Skip | No "before" state to revert to |

### Protocol

```
1. REPRODUCE: Run reproduction steps on buggy code → capture FAIL
     Skip when: issueType != "bug-fix"
2. APPLY: Apply candidate fix
3. VERIFY-FIX: Run same reproduction steps → capture PASS
4. VERIFY-REGRESSION: Run full test suite → no new failures
5. NEGATIVE CONTROL: Revert fix → confirm bug returns (FAIL again)
     Skip when: issueType != "bug-fix"
```

### Evidence in workflow-state.json

```json
"proofOfFix": {
  "issueType": "bug-fix",
  "reproduction_before": "curl output showing eolDate=2025-06",
  "reproduction_after": "curl output showing eolDate=2027-09",
  "regression_suite": "bun test: 47 pass, 0 fail",
  "negative_control": "reverted → curl shows eolDate=2025-06 (bug returned)",
  "commit_sha": "abc1234",
  "verdict": "PROVEN"
}
```

This maps directly to `prove-evidence.json` written by the /prove skill. The gate reads `proofOfFix` from workflow-state and cross-validates against prove-evidence.json.

For feature issues, `proofOfFix` contains only steps 2-4 (no reproduction_before, no negative_control) and `verdict` is based on VERIFY-FIX + VERIFY-REGRESSION only.

Step 5 (negative control) is what distinguishes real proof from coincidence. If the bug doesn't return when the fix is reverted, either the reproduction is flawed or the fix didn't address the root cause.

## Template Architecture

Templates are three-layered. Each layer adds specificity. The brief-assembler merges all three.

### Layer 1: Harness-generic (ships with rungate)

Universal templates that work for any project:
- RCA protocol (4 phases)
- AC format (Given/When/Then + oracle)
- Evidence hierarchy (S through F)
- Quinn decision tree
- Blast radius checklist
- Regression prevention checklist
- Read-before-write protocol
- Prevention-oriented fix template (guard, type narrow, pattern audit)
- Coding principles (deep modules, boundary validation, Zod at boundaries, assertNever, branded types)
- Testing strategy (PBT, contract tests, tautological trap, boundary testing, test evidence per AC type)
- Escalation decision tree (research tools, when to stop iterating)

These never reference specific files, ports, routes, or technologies.

### Layer 1 knowledge problem: training data goes stale

Saying "use deep modules" in a brief doesn't teach the agent what deep modules ARE. Models are trained on data up to a cutoff — principles published after that cutoff aren't in their weights. The harness solves this in three ways:

1. **Inline the principle, not just the name.** The `coding-principles.md` template doesn't say "use deep modules." It says:
   ```
   DEEP MODULES: A module should do a lot of work behind a simple interface.
   - A function with 3 parameters that handles 15 edge cases internally = deep
   - 15 small functions each handling 1 case, requiring the caller to orchestrate = shallow
   - When adding functionality: extend an existing deep module rather than adding a new shallow one
   - Test: can a caller use this module without understanding its internals? If no, the interface is too complex.
   ```
   The principle is EXPLAINED, not referenced. The agent has the content, not a pointer.

2. **Context7 MCP for current library docs.** When an agent needs framework-specific guidance (Hono routing patterns, Zod schema design, Bun test runners), Context7 fetches CURRENT documentation — not the model's training data. This is why Context7 is declared in the research tools section: it's the escape hatch from stale training data.

3. **Harness update cycle.** When new research emerges (like the findings from this session's 8 researchers), it gets written into Layer 1 templates. Every project gets the updated templates on next `bun install`. The harness is the distribution mechanism for current best practices.

**The flow:**
```
New research/principle discovered
  → Written into harness prompts/ template (Layer 1)
  → Harness version bumped
  → Projects run bun install → get new templates
  → Next ship cycle → brief-assembler generates briefs with updated content
  → Agent reads the actual principle, not just a name
```

This is why Layer 1 templates contain the full explanation, not links. An agent can't click a link to "A Philosophy of Software Design." But it CAN read a 10-line summary of the principle with specific do/don't examples embedded in its brief.

### Layer 2: Project-config (from rungate.json + CODE-MAP)

Project-specific values injected into templates:
- Test command (`bun test` vs `pytest` vs `go test`)
- Port numbers (from rungate.json environments)
- File paths (from CODE-MAP)
- Framework details (Hono, React, etc.)
- Page URLs (from rungate.json pages)
- Consumer modules (from rungate.json consumers)

### Layer 3: Issue-specific (generated per brief by brief-assembler)

Per-issue values:
- ACs for this specific issue
- Files this issue touches (from brief)
- Governing spec for this issue
- Quinn journey steps for this UI change
- RCA fields pre-populated from issue description

### Merge order

```
harness-generic (Layer 1)
  + project-config (Layer 2) → variables filled
  + issue-specific (Layer 3) → ACs, files, journeys added
  = Complete agent brief
```

### Per-agent template sections

| Agent | Layer 1 sections | Layer 2 additions | Layer 3 additions |
|-------|-----------------|-------------------|-------------------|
| Marcus | RCA protocol, AC format, blast radius, regression prevention, read-before-write, coding principles, testing strategy, prevention-oriented fix | test command, source dirs, consumers | ACs, files, governing spec |
| Quinn | Decision tree, journey schema, evidence capture, circuit breaker | ports, pages, viewport | Typed journey steps from UI ACs |
| Rook | Security checklist, OWASP patterns, secret detection | security baseline path | Changed files to scan |
| Serena | Architecture review, cross-boundary analysis, coding principles | ADR location, module map | Structural changes proposed |
| Aditi | Component spec format, a11y requirements | component paths, design system | UI components affected |

### Improvement flow

Template improvement in Layer 1 → every project gets it on next re-scaffold. No per-project configuration needed for fundamental best practices.

### Brief assembly order (SC-140, SC-145)

Research: "Lost in the Middle" (Stanford, TACL 2024) shows 30-50% accuracy drop for content in the middle of context vs start/end. Instruction Stacking Collapse (arXiv:2608.02639) shows compliance drops from 96.4% to 57.7% at 16 stacked rules.

The brief-assembler MUST order sections to put critical instructions at the positions models attend to most:

```
1. IDENTITY (role, constraints, output format)     ← START (highest attention)
2. CORE PRINCIPLES (universal 6-line block)         ← near start
3. METHODOLOGY (Layer 1 templates, 10 rules max)    ← middle (lowest attention — OK because gates enforce)
4. PROJECT CONTEXT (Layer 2, from rungate.json)      ← middle
5. ACs + VERIFICATION COMMANDS (Layer 3)             ← END (high attention, recency bias)
```

This exploits the U-shaped attention curve: models attend most to start and end, least to middle. Methodology in the middle is acceptable because gates mechanically enforce what the model might miss. ACs at the end get recency bias — the thing the agent works on most is what it sees last.

### Template format requirements (SC-141, SC-142)

Research on instruction format effectiveness:

1. **Positive framing > negative.** "Use `Result<T, E>` for error handling" beats "Don't throw exceptions." Cap negative instructions at 10 per brief. Past that, models confuse what NOT to do with what to do.

2. **Examples > descriptions.** One code snippet showing the pattern beats three paragraphs describing it. Every Layer 1 template must include at least one concrete code example per principle.

3. **One concept per bullet.** Multi-action instructions get merged or reinterpreted. Break into single-action items.

4. **Calm tone.** "CRITICAL!", "YOU MUST", "NEVER EVER" overtriggers newer models and produces WORSE results than direct instructions (Anthropic context engineering guide). Emphasize one line, not many.

5. **Three-tier rule authority (SC-146).** Every rule in an agent brief is categorized by action authority. This tells the agent what it can do autonomously vs what needs approval vs what is forbidden. Research: "never do" sections are the most frequently skipped and cause the most production failures — making them explicit and separate improves compliance.

   ```
   ## Always Do (autonomous — no approval needed)
   - Run `bun test` after every change
   - Read AGENTS.md before starting work
   - Verify before asserting

   ## Ask First (needs DA approval before proceeding)
   - Modifying files outside the brief's listed files
   - Adding new dependencies
   - Changing public interfaces

   ## Never Do (hard stops — gate FAIL if violated)
   - Self-attest evidence (tier F)
   - Skip ACs without rationale
   - Commit secrets or credentials
   ```

### Activation modes (SC-143)

Industry convergence on four activation modes (Cursor, Devin, Cline all implement these). Each template declares its mode:

| Mode | When loaded | Example |
|------|------------|---------|
| always-on | Every request, unconditionally | Core Principles block, AGENTS.md |
| file-pattern | When matching files in context | Security checklist when .env files touched |
| agent-decided | Agent reads description, decides relevance | RCA protocol (only for bug-fix issues) |
| manual | Only on explicit invocation | Full spec reference |

**Budget rule:** Always-on content under 200 words total. Every word costs on every request. File-pattern and agent-decided have no hard cap but 10 essential rules per template.

### Rule count caps (SC-138)

Hard data: models reliably satisfy ~3 concurrent constraints (Instruction Complexity Cliff research). At 16 stacked instructions, compliance drops 50%+ (arXiv:2608.02639). ETH Zurich: 10 essential rules outperform 200 generic ones.

**Per-template caps:**
- Universal Core Principles: 6 rules (always-on, every agent)
- Per-role rules in agent definition: 4-6 rules
- Layer 1 methodology template: 10 rules max
- Total rules an agent sees at brief time: ≤25

The 25-rule ceiling is a design target, not a gate FAIL. Gate WARNS if brief exceeds 25 distinct rules. The intent: force prioritization. If you can't fit a principle in 25 rules, the principle isn't essential — move it to a gate check instead.

### Rule lifecycle (SC-144)

Rules go stale. Production systems report compounding stale-rule problems: old patterns in code outnumber new ones, agents imitate what they find, deprecated patterns survive test suites, each copy creates another call site for future agents.

**Rule hygiene protocol:**
1. Every rule in AGENTS.md Hard Constraints gets a `<!-- since: YYYY-MM-DD -->` comment
2. Re-scaffold flags rules older than 90 days without revalidation: WARN "Rule '{name}' last validated {N} days ago — review or reconfirm"
3. "Second occurrence" principle: only add a rule after the same mistake happens twice. First occurrence = noise. Twice = pattern.
4. Quarterly audit (manual, not automated): was it used recently? Does it solve a real problem? Can it be simplified? Does it conflict with other rules?

### Mid-session compliance (15 tool-call cliff)

Research: past 15 tool calls, system prompt constraints lose influence from attention dilution. Ship cycles easily exceed 15 tool calls.

**Mitigation strategy (mechanical, not behavioral):**
1. Gates run AFTER the work, not during — they don't depend on the agent remembering rules mid-session
2. Gate checks are deterministic code, not LLM judgment — compliance is verified, not trusted
3. Brief structure puts ACs at the END (recency bias) — the verification commands are what the agent sees last
4. Circuit breaker at iteration 3 forces a reset — fresh context, rules re-read

This is why the entire harness architecture is gate-first: we EXPECT agents to drift past 15 tool calls. The gates catch drift mechanically. The brief optimizations (ordering, caps, positive framing) reduce drift but don't eliminate it.

## Spec Drift Enforcement

Spec content hashes are tracked. When a spec changes, tests written against it are stale.

### Mechanism

1. Each testable spec's content is hashed (SHA-256 of SC section)
2. Hash stored in `test/spec-compliance-auto.test.ts` as comment
3. At gate time (scope + verify), current spec hash compared to stored hash
4. **Mismatch = FAIL** — "spec changed since tests written, update tests"
5. `bunx rungate sync-tests .` regenerates tests from current spec → hash updates

### Why FAIL not WARN

WARN is behavioral — the agent sees it, notes it, proceeds anyway. FAIL is mechanical — gate blocks, work can't ship until tests match spec. This is D-18.

## Parallel Work Isolation

When multiple agents or sessions work on the same repo concurrently, four conflict types emerge. The harness handles each mechanically.

### Conflict types and solutions

| Conflict type | What breaks | Solution | Enforcement |
|---|---|---|---|
| Code overlap | Two agents modify same file | Git worktrees (file isolation) + file-set overlap detection | SC-46, SC-69 |
| Container sharing | Two agents rebuild/test simultaneously | Container lock in Makefile | SC-45, SC-47 |
| Port collision | Two dev servers on same port | Port/namespace allocation per worktree | SC-70 |
| Stale accumulation | Old worktrees, branches, slugs pile up | Slug lifecycle + worktree cleanup | SC-42, SC-43 |

### Git worktree integration

Each parallel issue gets its own worktree. The harness manages the lifecycle:

```
CREATION (at ship SCOPE):
  1. Branch created: git branch issue-{N}-{slug} main
  2. Worktree created: git worktree add .worktrees/issue-{N} issue-{N}-{slug}
  3. Slug directory: ~/.rungate/{slug}/ (shared — not in worktree)
  4. Agent spawned with cwd = worktree path

BRANCH NAMING:
  Pattern: issue-{number}-{slug}
  Examples: issue-1452-bootstrap-fix, issue-1453-quinn-journey
  Deterministic from issue number — no collisions

DURING WORK:
  - Agent works entirely within its worktree
  - bun test runs against worktree's copy (isolated)
  - All file paths in workflow-state.json are relative to worktree root
  - Container lock checked before any make rebuild / make prove-up

MERGE (after ship + prove PASS):
  1. PR created from worktree branch → main
  2. CI runs on PR branch
  3. Human review (or auto-merge for LIGHT tier if configured)
  4. Squash merge into main
  5. Rebase subsequent worktree branches against updated main:
     git -C .worktrees/issue-{next} rebase main

CLEANUP (after merge):
  1. Worktree removed: git worktree remove .worktrees/issue-{N}
  2. Branch deleted: git branch -d issue-{N}-{slug}
  3. Slug archived (existing lifecycle — SC-42)
  4. If no changes made, worktree auto-cleaned (Claude Code native behavior)
```

### File-set overlap detection (SC-69)

Before assigning concurrent issues to parallel agents:

```
1. Each issue's brief lists expected files to modify
2. Compare file sets across all active worktrees
3. DISJOINT → safe to parallelize
4. OVERLAP on shared files (utils, config, types) → WARN with list
5. OVERLAP on same module → BLOCK — serialize these issues

Detection runs at SCOPE gate when a new ship cycle starts while other cycles are active.
```

### Port/namespace isolation (SC-70)

Git worktrees isolate files but NOT runtime resources:

```
PORT ALLOCATION:
  - Each worktree gets a port offset from base: base + (issue_number % 100)
  - Dev server: DEV_UI_PORT = 5173 + offset
  - API server: DEV_API_PORT = 7778 + offset
  - Stored in worktree-local .env or passed via env var
  - rungate.json in worktree updated with allocated ports

CONTAINER ISOLATION:
  - Container lock prevents concurrent rebuilds (SC-45)
  - Queued issues wait for lock release (SC-47)
  - Alternative: separate container per worktree (heavier but fully isolated)

TEST ISOLATION:
  - Each worktree runs its own bun test (file-isolated by worktree)
  - Database tests: use test-scoped DB name or transaction rollback
  - Cache: each worktree gets its own cache namespace
```

### Sequential merge protocol (SC-72)

Parallel work creates parallel branches. Merging is ALWAYS sequential:

```
1. Merge PR for issue A → main
2. CI runs on updated main → PASS
3. Rebase issue B's branch against new main
4. Merge PR for issue B → main
5. CI runs on updated main → PASS
6. Continue for each remaining issue

NEVER merge two PRs simultaneously — the second merge
must see the first's changes to detect conflicts.
```

### Agent concurrency cap (SC-71)

- Maximum 5 concurrent agents per session (Google Research: diminishing returns beyond this)
- Coordination overhead scales quadratically: 10 agents = 45 potential conflict pairs
- The cap applies to parallel ship cycles, not to within-cycle agents (Marcus + Quinn + Rook can all run for one issue)

## Test Baseline and Pre-existing Failures

### Scope gate captures baseline

At scope gate (beginning of ship cycle), the test baseline is captured:

```json
"beforeState": {
  "testBaseline": {
    "total": 50,
    "pass": 47,
    "fail": 3,
    "failingTests": ["test-a", "test-b", "test-c"],
    "capturedAt": "2026-09-18T..."
  }
}
```

### Verify gate compares against baseline

```
fail count AFTER ≤ fail count BEFORE = PASS (no regressions)
fail count AFTER > fail count BEFORE = FAIL (regression introduced)
total count AFTER < total count BEFORE = FAIL (tests removed — possible gaming)
```

### Pre-existing failures are tracked, not ignored

When scope gate finds pre-existing test failures:

1. Each failing test not already tracked in an open issue → auto-filed:
   ```
   gh issue create --title "Pre-existing: {test name} failing"
     --label "p3-can-wait,pre-existing"
     --body "Found during ship cycle for #{currentIssue}. Not from current changes."
   ```
2. Pre-existing failures don't block current work
3. They exist in the backlog with the `pre-existing` label

### Fix-on-find enforcement

When an agent discovers any issue during a ship cycle:

| Can fix in <10 min, no design decision? | Fix it now — same session |
| Can't fix quickly? | `gh issue create` with `found-during-#{issue}` label |
| Neither? | WARN — must explicitly scope it out in `scopeOut` |

Verify gate checks: every found issue is either (a) fixed, (b) filed as issue, or (c) in scopeOut. Silently dropping it = **FAIL** — unaddressed gaps are not acceptable.

## Makefile Fallback Chain

Not every project has a Makefile. The scan tries sources in priority order:

| Field | Source 1 (Makefile) | Source 2 (package.json) | Source 3 (null) |
|-------|--------------------|-----------------------|-----------------|
| dev.start | `make dev-all` target | `scripts.dev` → `bun run dev` | null → skip dev server steps |
| dev.testCmd | `make test` target | `scripts.test` → `bun test` | `bun test` (safe default) |
| prod.rebuild | `make rebuild` target | `scripts.build` → `bun run build` | null → skip container steps entirely |
| prod.smokeTest | `make smoke` target | `scripts.smoke` | null → skip smoke tests |
| test.rebuild | `make test-rebuild` target | none | null → skip test container |
| test.start | `make prove-up` target | none | null → skip prove container |
| test.stop | `make prove-down` target | none | null → skip prove cleanup |

When a field is null, the workflow step that uses it is SKIPPED — no agent spawned, no command run. The workflow records `environments.{env}.{step} = "SKIP"` with `skipReason: "no config"`.

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
3. Deduplicate against existing Hard Constraints in AGENTS.md (content match) and rejected-constraints.md (content-hash)
4. Present new candidates to the user for confirmation
5. Confirmed candidates → appended to AGENTS.md Hard Constraints section between AUTO-EXTRACTED markers
6. Rejected candidates → logged to `reference/rejected-constraints.md` with content-hash so they don't resurface

### Execution

- Separate command: `bunx rungate extract-constraints /path/to/project`
- NOT auto-run from scaffold (70% false positive rate — human review mandatory)
- On re-scaffold: HYGIENE-6 conformity check warns about unreviewed candidates
- `--dry-run` is the default. `--apply` writes confirmed candidates to AGENTS.md
- On first run: full scan of all docs → present all candidates
- On re-run: incremental scan (only docs modified since last scan) → present new candidates only
- Existing Hard Constraints are NEVER removed by re-scan — only added to

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

**Staleness signal:** Primary = `git log -1 --format=%ci` per file. Frontmatter `last-verified` is optional human override — if present and within threshold, file is ACTIVE regardless of git log. Frontmatter `updated` is NOT used (bulk-stamp dates prove unreliability).

## Success Criteria

<!-- Phase subheaders route SCs to test files automatically. -->
<!-- The meta-test (test/meta-sc-coverage.test.ts) reads these headers. -->
<!-- To add a new SC: paste it under the correct ### Phase header. -->

### Phase 0 — Scaffold Output

- [ ] SC-1: Bootstrap Phase 1 (CODE-MAP + rungate) completes before Phase 2 (AGENTS.md + agents/)
- [ ] SC-2: rungate.json consumers field populated from CODE-MAP consumer scan, not hardcoded patterns
- [ ] SC-3: AGENTS.md environment section reads from rungate.json (not hardcoded)
- [ ] SC-4: Zero hardcoded ports/URLs in ship.js — all from rungate.json fields
- [ ] SC-5: Zero hardcoded commands in ship.js — all from rungate.json fields
- [ ] SC-6: Zero hardcoded project names in ship.js — all from args or rungate.json
- [ ] SC-8: All ship.js inline prompts >5 lines extracted to prompts/*.md templates
- [ ] SC-11: Re-running bootstrap on an existing project updates AGENTS.md with current CODE-MAP and rungate data
- [ ] SC-15: rungate.json generation falls back from Makefile → package.json → null for each field
- [ ] SC-16: Null config fields cause workflow steps to SKIP (not error, not spawn rogue agents)
- [ ] SC-17: AGENTS.md is under 150 lines — scaffold WARNS if over
- [ ] SC-18: Empty sections omitted from AGENTS.md (no consumers = no Consumers section)
- [ ] SC-19: CLAUDE.md contains @AGENTS.md bridge for cross-tool compatibility
- [ ] SC-20: New code projects get src/index.ts stub as agent starting point
- [ ] SC-21: rungate.json has no hardcoded port numbers — all detected from Makefile/config or null
- [ ] SC-24: Conformity test calls all 9 suites (scaffold, spec-discovery, spec-drift, doc-hygiene, agent-validation, fallow, constraint-candidates, package-validation, tsconfig-validation)
- [ ] SC-25: AGENTS.md Commands section includes all harness commands (bun test, tsc, conformity, sync-tests, create-spec, create-adr, extract-constraints, re-scaffold)
- [ ] SC-26: Spec template in project matches harness version — scaffold updates on re-run
- [ ] SC-27: sync-spec-tests reads project's specs/ directory (not just harness specs)
- [ ] SC-37: Every agent brief includes Core Principles block (verify-before-asserting, no gaps, read AGENTS.md)
- [ ] SC-39: CODE-MAP.md staleness detected by git SHA comparison — regenerated when src/ has commits since last scan, not by arbitrary time/count thresholds
- [ ] SC-40: Scaffold creates/verifies .gitignore with full security template (node_modules, dist, .env*, .rungate, *.pem, *.key, credentials.json, service-account*)
- [ ] SC-73: package.json has required fields (name, type:module, scripts.test, devDependencies.rungate) — scaffold adds missing, never overwrites existing
- [ ] SC-74: tsconfig.json has recommended fields (strict:true) — scaffold WARNs if missing, never overwrites
- [ ] SC-75: Spec frontmatter has required fields (doc-type, status, testable, governs) — Spec Discovery FAILs if missing
- [ ] SC-76: ADR frontmatter has required fields (doc-type:adr, status, created) — Doc Hygiene FAILs if missing
- [ ] SC-77: `bunx rungate create-spec` creates spec with all required frontmatter fields pre-populated
- [ ] SC-78: `bunx rungate create-adr` creates ADR with all required frontmatter fields pre-populated
- [ ] SC-80: Phase 0 creates all 10 directories + all static files BEFORE any scan runs (Phase 1)
- [ ] SC-82: Scaffold creates .github/workflows/ci.yml — harness-owned, always regenerated from template + rungate.json
- [ ] SC-83: Scaffold creates .github/workflows/gates.yml — harness-owned, always regenerated from template + rungate.json
- [ ] SC-84: CI workflow runs all conformity suites that `bun test` runs (same checks, CI-enforced)
- [ ] SC-85: Gates workflow includes secret scan (HYGIENE-12) as CI check on every PR
- [ ] SC-86: CI workflows read runner, bunVersion, branches from rungate.json ci section — defaults used when null
- [ ] SC-87: CI workflow files include "Managed by rungate" header directing users to rungate.json for customization
- [ ] SC-88: All 9 ship workflow prompt templates exist in harness prompts/ (discovery, marcus, quinn, rook, serena, aditi, environment, container-rebuild, container-verify)
- [ ] SC-89: All 11 Layer 1 methodology templates exist in harness prompts/ (rca, blast-radius, prevention, regression, read-before-write, quinn-decision-tree, evidence-hierarchy, ac-format, coding-principles, testing-strategy, escalation-decision-tree)
- [ ] SC-90: Brief-assembler embeds relevant Layer 1 methodology templates into per-agent briefs at ship time
- [ ] SC-91: Scaffold creates git pre-commit hook with secret scan (HYGIENE-12) — in-repo, not global
- [ ] SC-92: Scaffold creates git pre-push hook with conformity test — in-repo, not global
- [ ] SC-93: All project hooks, scripts, and workflows are self-contained in repo — no global dependencies
- [ ] SC-94: AGENTS.md "Where to Create Things" section lists correct location for every file type agents create
- [ ] SC-95: AGENTS.md "Available MCP Servers" section lists MCP servers configured for the project with tool names
- [ ] SC-97: Pre-flight checks git repo (git init if not), package.json (bun init if not), .gitignore (create if not)
- [ ] SC-98: Pre-flight runs BEFORE Phase 0 — .gitignore exists before any git add
- [ ] SC-99: Post-scaffold commits all harness files — "scaffold: initialize" for new, "scaffold: update" for existing
- [ ] SC-100: Post-scaffold commit only runs if there are actual changes (no empty commits)
- [ ] SC-101: rungate.json uses field-level merge — auto-detected fields overwritten, manual fields preserved
- [ ] SC-107: Makefile fallback chain: each field tries Makefile → package.json → null in order
- [ ] SC-114: AGENTS.md "Research Tools" section lists available tools with usage examples
- [ ] SC-115: Coding principles reference doc (deep modules, boundary validation, etc.) ships with harness and is referenced in Marcus briefs
- [ ] SC-116: Coding principles doc auto-updated via Context7 or research on harness update — not static training data
- [ ] SC-117: Testing strategy reference doc (PBT, contract tests, tautological trap) ships with harness and is referenced in Marcus briefs
- [ ] SC-118: Writer/verifier separation enforced — gate checks that test author agent != code author agent (SC-66 mechanical)
- [ ] SC-119: Test assertions reference AC thresholds, not implementation details — gate WARNs on test files with zero AC-ID references
- [ ] SC-120: Context loading follows 5-layer architecture — CLAUDE.md → AGENTS.md → skills (on demand) → agent frontmatter → brief
- [ ] SC-121: Agent frontmatter `skills` field preloads role-specific methodology — Marcus gets coding-principles + testing-strategy, Quinn gets journey-format
- [ ] SC-122: AGENTS.md contains ONLY non-inferrable details — no info agents could discover by reading src/ or running commands
- [ ] SC-123: .github/copilot-instructions.md created if missing, NEVER overwritten if exists — scaffold skips on existing
- [ ] SC-124: rungate.json envVars field populated from .env.example if it exists — null if no .env.example
- [ ] SC-125: CODE-MAP.md frontmatter includes scan-paths array listing directories scanned
- [ ] SC-126: AGENTS.md Code Style section auto-detected from runtime (Bun/Node), language (TS/JS), module system (ESM/CJS)
- [ ] SC-128: AGENTS.md includes Harness-Managed Files section with file/customize/don't table
- [ ] SC-138: Agent briefs cap at 10 essential rules per Layer 1 template — instruction stacking beyond 16 degrades compliance 50%+
- [ ] SC-139: AGENTS.md rules content (excluding tables/headers) stays under 200 words — always-on context must be lean
- [ ] SC-140: Brief structure: Core Principles at START, ACs at END — methodology in middle (mitigates "Lost in the Middle" attention decay)
- [ ] SC-141: Templates use positive framing ("use X" not "don't use Y") — negative instructions capped at 10 per brief
- [ ] SC-142: Every Layer 1 template includes at least one code example per principle — examples outperform descriptions
- [ ] SC-143: Each template declares activation mode: always-on, file-pattern, agent-decided, or manual
- [ ] SC-144: Rule lifecycle: every rule in AGENTS.md has a `since` date in comment — rules older than 90 days without revalidation flagged at re-scaffold
- [ ] SC-145: Brief-assembler orders sections: identity (role) → principles → methodology → ACs → verification commands — never methodology after ACs
- [ ] SC-146: Every agent brief categorizes rules into three tiers: Always Do (autonomous), Ask First (needs approval), Never Do (hard stops) — gate validates "Never Do" items mechanically
- [ ] SC-147: rungate.json includes `harnessVersion` (semver from harness package.json) and `scaffoldedAt` (ISO timestamp) — projects know what version they were scaffolded with
- [ ] SC-148: Conformity test WARNs when installed harness version differs from `harnessVersion` in rungate.json — signals re-scaffold needed
- [ ] SC-159: AGENTS.md Commands table includes `Check findings | cat .rungate/conformity-findings.json` row
- [ ] SC-160: AGENTS.md Quick Reference includes "After test failures, read `.rungate/conformity-findings.json` for structured findings with fix commands"

### Phase 1 — Knowledge Extraction + Doc Hygiene

- [ ] SC-12: Bootstrap scans docs for non-inferrable rule candidates using signal phrases
- [ ] SC-13: Extracted candidates presented for user confirmation before writing to AGENTS.md
- [ ] SC-14: Staleness uses git log date with per-type thresholds (ADR exempt, spec 90d, guide 180d)
- [ ] SC-22: Re-scaffold reports stale constraints (Hard Constraints referencing deleted files)
- [ ] SC-23: Re-scaffold reports line count if AGENTS.md exceeds 150 lines
- [ ] SC-30: Misplaced spec/ADR/doc files are FAIL not WARN (HYGIENE-7/8/9)
- [ ] SC-106: Doc lifecycle: stale docs (beyond threshold) flagged for archive to reference/ — per-type thresholds applied
- [ ] SC-137: Rejected constraint candidates logged to reference/rejected-constraints.md with content-hash dedup — same candidate never resurfaces
- [ ] SC-149: Conformity findings written to `.rungate/conformity-findings.json` with structured format (ruleId, severity, file, message, fixCommand)
- [ ] SC-150: Every FAIL finding includes a `fixCommand` — agents can execute it directly to resolve the issue
- [ ] SC-154: Unified findings report includes `constraintCandidates` array with rule, source, hash, and status (pending/applied/rejected)
- [ ] SC-155: Unified findings report includes `staleness` array with file, daysSince, threshold, and type
- [ ] SC-156: HYGIENE-6 pipes extract-constraints results (candidates + staleness) into unified findings report — nothing lost to stdout
- [ ] SC-157: Gate runner reads `.rungate/conformity-findings.json` after `bun test` completes and prints structured output (findings with fix commands, candidates, stale docs)
- [ ] SC-158: Gate runner stores conformityFindings in workflow-state.json — agents read fix commands from workflow-state, not test output
- [ ] SC-151: HYGIENE-7 detects spec files at root (not in specs/) and produces FAIL with `mv` fix command
- [ ] SC-152: HYGIENE-8 detects ADR files outside docs/adr/ and produces FAIL with `mv` fix command
- [ ] SC-153: HYGIENE-9 detects doc files at root (not in docs/, not allowlisted) and produces FAIL with `mv` fix command

### Phase 2 — Gate Enforcement + Ship Behavior

- [ ] SC-7: Container-rebuild agent NOT spawned when prod.rebuild is null
- [ ] SC-9: rungate-schema.ts includes test.rebuild, test.start, test.stop, test.apiBase fields
- [ ] SC-10: Schema fields dev.typeCheck, prod.smokeTest, contextDocs read by at least one workflow
- [ ] SC-28: Scope gate runs project conformity tests — FAIL blocks scope
- [ ] SC-29: Verify gate runs project conformity tests — FAIL blocks verify
- [ ] SC-31: Scope gate captures test baseline (pass/fail count + failing test names)
- [ ] SC-32: Verify gate compares test count — fail increase = regression = FAIL
- [ ] SC-33: Pre-existing test failures auto-filed as GitHub issues with "pre-existing" label
- [ ] SC-34: Found issues during ship cycle either fixed, filed, or explicitly scoped out
- [ ] SC-35: `bunx rungate create-spec` creates spec at specs/ with correct frontmatter
- [ ] SC-36: `bunx rungate create-adr` creates ADR at docs/adr/ with auto-incremented number
- [ ] SC-38: Ship cycle runs scaffold after verify gate PASS — auto-refresh CODE-MAP, briefs, AGENTS.md
- [ ] SC-41: Conformity checks for secret patterns in staged/committed files (HYGIENE-12) — catches secrets on ALL tiers including LIGHT
- [ ] SC-42: Completed slugs (DONE + proven) auto-archived after 24h
- [ ] SC-43: Archived slugs deleted after 30 days
- [ ] SC-44: Ship cycle checks for existing slug by issue number before creating new one
- [ ] SC-48: ACs use Given/When/Then format with four required fields: trigger, output, verify command, exclusions
- [ ] SC-49: Every AC has an executable verification command (oracle) — not prose description
- [ ] SC-50: Evidence hierarchy enforced per AC — minimum tier: CODE→A, UI→B, BUG-FIX→S, static→C supplementary only
- [ ] SC-51: Self-attestation (tier F) in any AC evidence = automatic FAIL regardless of other evidence
- [ ] SC-52: Garbage test applied to every AC — "Could garbage data pass this?" If yes, AC is rejected
- [ ] SC-53: RCA section required in Marcus brief for bug-fix issues — rootCause, prediction, predictionVerified
- [ ] SC-54: Gate checks RCA fields populated on bug-fix issues — empty rootCause = WARN (graduates to FAIL after 30d)
- [ ] SC-55: Quinn briefs use typed journey format — steps with action, wait_for, typed assertions, on_fail
- [ ] SC-56: Quinn primary perception is browser_snapshot (a11y tree), screenshots only on FAIL or visual checks
- [ ] SC-57: Quinn circuit breaker — 3 consecutive FAIL steps abort journey with partial results
- [ ] SC-58: Proof-of-fix includes negative control (revert fix, confirm bug returns) for S-tier evidence
- [ ] SC-59: Blast radius section in Marcus brief — filesRead ≥ filesChanged enforced
- [ ] SC-60: Read-before-write ratio ≥ 3:1 — gate checks read vs write token count
- [ ] SC-61: Brief-assembler generates per-role templates (Marcus, Quinn, Rook, Serena, Aditi) from three layers
- [ ] SC-62: Templates are three-layered: harness-generic + project-config (rungate.json) + issue-specific (ACs)
- [ ] SC-63: Spec content hash tracked — hash mismatch at gate = FAIL (tests must match current spec)
- [ ] SC-64: Test count post ≥ pre at verify gate — decrease = FAIL "tests removed, verify no gaming"
- [ ] SC-65: Prevention-oriented fixes: guard at boundary, type narrowing, pattern audit for same-bug-class
- [ ] SC-66: Writer and verifier are separate agents — same agent cannot write code AND verify its own ACs
- [ ] SC-67: Quinn journey steps auto-generated from UI-type ACs by brief-assembler
- [ ] SC-68: Evidence without assertion = tier F — screenshot taken but nothing checked = self-attestation
- [ ] SC-79: Conformity includes `runPackageValidation` check for package.json required fields
- [ ] SC-81: Phase 0 file creation is additive — never overwrites existing content, only adds missing fields/entries
- [ ] SC-96: rungate.json `mcp` section declares MCP servers available to agents — scaffold includes in agent briefs
- [ ] SC-102: Re-scaffold auto-fixes broken refs, unlisted specs, missing CODE-MAP ref, and pages drift — not just reports them
- [ ] SC-103: Evidence-to-tier mapping implemented in gate — evidenceMethod.type maps to correct tier per mapping table
- [ ] SC-104: File ownership model enforced — harness-owned files ARE regenerated, co-owned files are NOT overwritten
- [ ] SC-105: Scaffold is idempotent — running from scratch produces same result as re-scaffold (Core Principle 6)
- [ ] SC-108: Quinn journey stored in slug directory (~/.rungate/{slug}/quinn-journey.yaml) — ephemeral, follows slug lifecycle
- [ ] SC-109: Fix-on-find: silently dropped issues = FAIL at verify gate, not WARN
- [ ] SC-110: Port allocation for parallel worktrees checks for collisions before assigning offset
- [ ] SC-111: Escalation decision tree embedded in every agent brief — agents know research tools exist
- [ ] SC-112: Circuit breaker iteration 2 requires research tool invocation before next attempt — gate checks research evidence exists before allowing iteration 3
- [ ] SC-113: rungate.json `research` section declares available research tools — brief-assembler includes only available tools
- [ ] SC-127: All 3 gate prompt templates exist in harness prompts/ (ac-adversary.md, evidence-validator.md, prove-reproducer.md)
- [ ] SC-129: Gate WARNs if a new module file has more exported functions than internal functions (shallow module signal)
- [ ] SC-130: Gate WARNs if a module with >3 importers has no contract test
- [ ] SC-131: Anti-criteria (SC-A*) use absence verification — Verify command must confirm absence, not presence
- [ ] SC-132: Tier D evidence (grep) capped at 25% of total evidence portfolio per issue — gate FAIL if exceeded
- [ ] SC-133: Brief-assembler rejects Quinn journeys over 8 steps and auto-splits into multiple journeys with entry conditions
- [ ] SC-134: Files changed outside brief's listed files → WARN "Files changed outside brief: {list}"
- [ ] SC-135: Gate cross-validates proofOfFix in workflow-state.json against prove-evidence.json — mismatch = FAIL

### Phase 3 — Parallel Work

- [ ] SC-45: Container lock checked mechanically (Makefile target, not behavioral rule) — blocks rebuild/prove-up if lock exists
- [ ] SC-46: Ship workflow supports worktree isolation for parallel execution
- [ ] SC-47: Container lock released mechanically after test completion (cleanup triggers next queued issue)
- [ ] SC-69: Parallel work: file-set overlap detection before assigning concurrent issues to agents
- [ ] SC-70: Parallel work: port/namespace isolation beyond git worktree file isolation
- [ ] SC-71: Parallel work: cap concurrent agents at 5 per session (diminishing returns beyond)
- [ ] SC-72: Parallel work: sequential merge with CI verification between each PR
- [ ] SC-136: Worktree branches use deterministic naming: issue-{N}-{slug}

### Anti-Criteria

- [ ] SC-A1: No workflow file imports or references values from a specific project (DDB, asaCommandCenter, etc.)
- [ ] SC-A2: No hardcoded file paths in rungate.json generation (no `dashboard/src/App.tsx`, no `callGemini` patterns)
- [ ] SC-A3: No references to "PAI" in lock files, work dirs, or runtime paths — all use "rungate" naming
## Evaluated Concerns

Concerns raised during spec review, evaluated, and documented for future reference:

| Concern | Verdict | Reasoning |
|---------|---------|-----------|
| Framework changes (Hono→Express) | Not a gap | Re-scaffold + CODE-MAP detects whatever's in src/. Agent briefs regenerate with new structure |
| Monorepo support | Future work | Single-project repos are current target. Nested AGENTS.md per package is future scope |
| CI/CD setup | Handled | Harness creates ci.yml + gates.yml with quality gates. Custom CI (deploy, release) is project-specific |
| Branch protection / PR templates | Out of scope | Project-specific GitHub settings, not harness concern |
| Version migration (harness major bump) | Handled | `bun update rungate` — conformity tests catch breaking changes immediately |
| Collaborator onboarding | Handled | `bun install` gets devDep, `bun test` verifies conformity. No separate setup step |
| First git push | Fixed by SC-40 | .gitignore ensures clean first push |
| Dependency management (bun.lockb) | Handled | Standard bun behavior — lockb committed, node_modules gitignored |
| Mutation testing for test quality | Future work | AI tests: 91% coverage but 34% mutation score. Meta's approach raised to 89.5%. Valuable but heavyweight — test count comparison is minimum viable gate for now |
| LLM-as-judge for verification | Not adopted | 4 known bias modes (length, position, self-preference, non-determinism). Mechanical gates preferred over LLM judgment |
| Agent teams / swarm mode | Future work | Claude Code agent teams in research preview. Current harness uses single-agent-per-role. Parallel work via worktrees |
| Merge queue tooling (Graphite/Mergify) | Future work | Merge queue becomes bottleneck at scale. Current: sequential manual merge. Worth evaluating when parallel work is routine |
| Visual regression testing (Percy/Chromatic) | Future work | Pixel-diff tools exist but add infra complexity. A11y-first assertion covers functional; visual regression is supplementary |
| Context window management for long journeys | Handled by design | Quinn journeys capped at 5-8 steps. Instruction compliance decays from 73% at turn 5 to 33% by turn 16 (Gamage 2026) |

## Cautions

- Bootstrap Phase 1 depends on fallow being installed. If fallow fails, CODE-MAP.md should still generate from other scans (routes, components, dirs) — fallow sections empty, not entire file missing.
- rungate.json consumers field: auto-detection from CODE-MAP may miss consumers that are dynamically imported or configured at runtime. Manual override must be preserved on re-scan.
- Hard Constraints in AGENTS.md must survive regeneration — they're the one section that can't be auto-detected from code. **CRITICAL (council finding):** The preservation regex must handle Hard Constraints as the last section — the lookahead `(?=\n## |\s*$)` handles this (fixed).
- Prompt templates with ${VAR} placeholders: if a variable is undefined (field missing from config), the template should show a clear placeholder or instruction, not leave a raw ${VAR} string in the agent prompt.
- `rejected-constraints.md` must use content-hash dedup so rejections survive line-number changes across doc edits. Prevents the same false positive from resurfacing on every re-scan.
- No `--auto-accept` flag on extract-constraints. 70% false positive rate means human review is mandatory. `--dry-run` is the default.
- AGENTS.md over 150 lines: research shows 20-23% inference cost increase with no behavior improvement. LLM-generated context files decrease performance by 3% (ETH Zurich). Keep it concise, human-written, and focused on non-inferrable details.
- Scaffold partial failure: if scaffold fails halfway (e.g., CODE-MAP generated but rungate.json errors out), the project may have stale data. Recovery: re-run scaffold — it's idempotent, each file is independently valid. No rollback mechanism needed because each step overwrites cleanly.
- Secrets on LIGHT tier: LIGHT tier skips Rook (security scan). Without HYGIENE-12 (secret pattern check in conformity), an agent could commit an API key through LIGHT without any mechanical catch. HYGIENE-12 runs on ALL tiers via `bun test`, closing this gap.
- .gitignore on new projects: pre-flight creates .gitignore from full security template BEFORE `bun init` runs, ensuring secrets are excluded from the first commit. On existing projects, scaffold verifies required entries and appends missing ones.
- RCA WARN→FAIL graduation: SC-54 starts as WARN to avoid blocking existing workflows. After 30 days of data collection, evaluate false positive rate. If <10%, graduate to FAIL. If >10%, refine the check before graduating.
- Evidence hierarchy adoption: existing workflows have grep-heavy evidence. SC-50 enforcement should not retroactively break passing issues. Apply to NEW issues only — existing workflow-state.json files are grandfathered.
- Quinn a11y tree dependency: browser_snapshot() requires Playwright MCP server running. If MCP unavailable, Quinn falls back to screenshots with WARN. Never block QA on infra failure.
- Negative control cost: Step 5 (revert + re-test) adds ~30-60 seconds per prove cycle. Worth it for bug fixes (46% of validations are non-discriminating without it). Can skip for feature work where there's no "before" state.
- Typed journey generation: brief-assembler generates journeys from ACs with UI type. If AC threshold is too vague for typed assertion (e.g., "looks good"), the journey step gets `type: visual_check` which requires screenshot + human review — it doesn't silently skip.
- Three-layer merge conflicts: if project-config (Layer 2) and harness-generic (Layer 1) conflict, Layer 2 wins. Project knows its own constraints better than the generic template. Issue-specific (Layer 3) can override both — but gate still enforces minimums.
- Parallel work file-overlap detection (SC-69) is advisory at first. False positives (two issues legitimately touching shared utils) should not block. Start as WARN, graduate to FAIL after calibration.
- AI-generated code security: 44% of AI-generated tasks produce known security flaws (Veracode 2026). Rook scan on EVERY build cycle is not optional — it's the only mechanical catch for a 44% defect rate.
- Iterative refinement paradox: asking an agent to "improve" its own code 5+ times increases vulnerabilities 37.6% (IEEE-ISTAS 2025). The harness's circuit breaker (3 iterations max, research required at iteration 2) exists partly for this reason.
- Read-before-write enforcement: the 3:1 ratio (SC-60) is measured from workflow-state.json token counts, not file counts. Agents that read 1 file and change 3 are likely patching symptoms. The ratio is a heuristic — some surgical fixes legitimately have low ratios.
- Rule count caps (SC-138): the 25-rule ceiling is a design target, not a gate FAIL. The data shows compliance degrades at 16+, but the gate-first architecture compensates — the rules most likely to be forgotten are methodology steps, which gates enforce mechanically anyway.
- Brief assembly order (SC-140, SC-145): the U-shaped attention curve is real but varies by model and context length. The ordering is a best-effort optimization, not a guarantee. The primary defense remains mechanical gates, not attention management.
- Always-on 200-word budget (SC-139): measured as prose content in AGENTS.md, excluding table formatting, headers, and code blocks. Tables are information-dense and parse differently than prose rules.
- Activation mode declarations (SC-143): activation modes are metadata for the brief-assembler, not runtime config. The brief-assembler decides what to include based on mode + current context. A template with `mode: agent-decided` is included only when the brief-assembler judges it relevant to the issue type.
- Rule lifecycle 90-day flag (SC-144): the WARN is advisory, not blocking. Some rules are permanent (security constraints, architectural invariants). The flag is a prompt for human review, not an expiration.
- 15 tool-call compliance cliff: this is why the harness uses gates (post-hoc verification) rather than relying on agents to self-enforce rules during long sessions. The cliff validates the architectural decision, not a gap to fix.

## Research Sources

Research informing design decisions D-12 through D-23 and SCs 48-145:

| Topic | Key finding | Source |
|-------|------------|--------|
| AC format effectiveness | Human-refined specs: ~50% error reduction | Augment Code, ClearSpec |
| AC constrainedness vs acceptance | Well-constrained: 82.1% vs ambiguous: 66.1% | ArXiv PR Acceptance Study (7,156 PRs) |
| Evidence discrimination | 46% of validation events non-discriminating | BSG-VA framework (arXiv July 2026) |
| Self-attestation failure | 31.7% semantic drift miss rate same-agent | Independent-Checker Pattern |
| Test deletion gaming | Documented anti-pattern across multiple teams | DEV Community, FreeCodeCamp |
| Mutation testing | 91% coverage, 34% mutation score in AI tests | MutGen study, Meta FSE 2025 |
| SWE-bench false positives | 50% of passing PRs wouldn't merge | METR March 2026 |
| A11y tree vs screenshots | Degraded a11y: 80%→42% success | CHI 2026 (UC Berkeley + U Michigan) |
| Quinn failure pattern | Explore→Explore→Explore loop = failure | ASE 2025 trajectory research |
| Read-before-write | Context efficiency r=0.928 with solve rate | SWE-Explore (June 2026) |
| Token ratio | Top performers: 10:1 read-to-write | Epoch AI SWE-bench evaluation |
| Context file quality | LLM-generated: -3% success, +23% cost | ETH Zurich (Feb 2026) |
| Instruction compliance decay | 73% at turn 5 → 33% by turn 16 | Gamage et al. 2026 |
| AI code defect rate | 1.7-2.7x more defects than human | Multiple 2026 studies |
| AI security flaw rate | 44% of tasks produce known flaws | Veracode July 2026 |
| Change failure rate | Up ~30% since AI adoption | Cortex 2026 Benchmark |
| Iterative refinement risk | 37.6% vulnerability increase after 5 rounds | IEEE-ISTAS 2025 |
| Adversarial review | 3 agents with structured disagreement beat 5 | ICML 2026 Workshop |
| RCA vs symptom-fix | 63% of top scores retrieve, not derive | Cursor reward-hacking study 2026 |
| Hermes 4-phase protocol | Production-tested systematic debugging | NousResearch |
| Agentless pipeline | 27.33% SWE-bench Lite at $0.34/bug | FSE 2025 |
| AgentTrace | 94.9% Hit@1, 69x faster than LLM diagnosis | ICLR 2026 Workshop |
| Parallel agent conflicts | 41.7% cross-agent conflict rate | 33,596 PR study |
| Worktree isolation | Universal standard, 3-5 agents optimal | Claude Code, Codex, Devin |
| Merge queue bottleneck | Max 48 PRs/day at 30min CI | Industry analysis |
| Agent PR quality | AI PRs break main 1.9% vs human 4.4% | Mergify 200K+ merges |
| Deep module violations | AI agents: 10-50x more boundary violations/session | Ousterhout observation, SWE-bench analysis |
| Property-based testing | 984 bugs across 100 packages, 56% true bugs | Anthropic PBT research |
| AI test quality gap | 91% coverage, 34% mutation score | MutGen study |
| Mutation testing ROI | 55% fewer production bugs | Meta FSE 2025 (mutation score raised to 89.5%) |
| Testing pyramid inversion | PBT > contract > integration > unit for AI code | Multiple studies synthesis |
| Tautological testing | AI tests verify implementation, not specification | DEV Community, FreeCodeCamp pattern analysis |
| Consumer-driven contracts | Horizontal boundary testing catches 3x more AI-code bugs | Contract testing studies |
| Context loading architecture | Subagents load CLAUDE.md hierarchy + preloaded skills | Anthropic Claude Code docs (Context7) |
| Template compression | >150 lines methodology = 20-23% cost, no behavior improvement | ETH Zurich (Feb 2026) |
| Context budget | Heaviest agent (Marcus) uses 3.1% of 200k window; full cycle 11.1% | Rungate context budget analysis |
| Instruction stacking collapse | 96.4% → 57.7% compliance at 16 stacked rules; 44.7% at 20 | arXiv:2608.02639 (2026) |
| IFScale benchmark | 94% at 1-3 instructions → 68% at 500 | Jaroslawicz et al. 2025 |
| Instruction complexity cliff | Models reliably satisfy ~3 concurrent constraints | TianPan.co research |
| Lost in the Middle | 30-50% accuracy drop for middle-positioned content | Stanford TACL 2024, Veseli et al. 2025 |
| Context rot | All 18 models degraded as input length grew; degradation at 25% capacity | Chroma study (July 2025) |
| AGENTS.md length vs performance | >500 lines underperforms 200-line files on instruction-following | DeployHQ 2026 |
| AGENTS.md empirical study | Human-written: +4% success, -35-55% bugs; LLM-generated: -3% success | Gloaguen et al. 2026 |
| AGENTS.md adoption | 60,000+ repos, 25+ tools, Linux Foundation AAIF governance | agents.md, AAIF (Dec 2025) |
| Cursor activation modes | 4 modes: always-on, glob, agent-decided, manual | Cursor docs |
| Codex config separation | .codex/config.toml (how) vs AGENTS.md (what) | OpenAI Codex docs |
| Anthropic system prompt reduction | Removed 80% of Claude Code system prompt for Claude 5 without loss | Anthropic engineering blog |
| Second occurrence rule | Only add rule after same mistake happens twice | Anthropic Claude Code best practices |
| Aggressive language counterproductive | "CRITICAL!", "YOU MUST" produces worse results than calm instructions | Anthropic context engineering guide |
| Format: examples > descriptions | Specific tool mentions increase agent usage from 0.01 to 1.6x/task | Addy Osmani research |
| Positive > negative framing | Cap negative instructions at 10-15; past that, model confuses constraints | VirtusLab, Dust research |
| 15 tool-call compliance cliff | System prompt constraints lose influence past ~15 tool calls | Engineer documentation, attention dilution |
| Runtime compliance (C-Trace) | 97.7% recovery with semantic feedback vs 31.4% with bare denials | arXiv:2606.19242 |
| Microsoft Agent Governance | Sub-millisecond external policy enforcement at runtime | Microsoft Agent Governance Toolkit (April 2026) |
| Sourcegraph context engineering | 1,281 runs: more context degrades performance; smarter selection, not bigger windows | Sourcegraph CodeScaleBench (May 2026) |
| Spec-Driven Development | Dominant coding agent pattern: structured specs feed agent briefs | GitHub Spec Kit, Kiro (AWS), Claude Code Skills |
| Multi-agent production survival | 73% Fortune 500 run multi-agent; 62% of early deployments fail to reach prod | Multi-agent production survey 2026 |
| Compact at 60-75% capacity | Not 95%; primary lever for long-horizon agents | Anthropic effective harnesses blog |
| Google ADK context layers | Static/Turn/User/Cache — most structured production context architecture | Google ADK docs |
