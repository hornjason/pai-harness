---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Problem Statement + 7 more
testable: true
---

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
| `AGENTS.md` | Harness-owned | Always regenerated. User rules go in CLAUDE.md, not AGENTS.md |
| `.claude/rungate.json` | Hybrid (field-level merge) | Auto-detected fields regenerated from scan. Manual fields preserved. New fields added as null |
| `.github/copilot-instructions.md` | Tool-bridge | Create if missing. Skip if exists |
| `src/*.ts` | User-owned | Never touched |
| `docs/*.md` | User-owned | Never touched |
| `specs/*.md` (content) | User-owned | Never touched (frontmatter validated, not content) |
| `docs/adr/*.md` | User-owned | Never touched (frontmatter validated, not content) |
| `prompts/marcus.md` | Harness-owned | Agent methodology — scaffolded into marcus brief |
| `prompts/quinn.md` | Harness-owned | Agent methodology — scaffolded into quinn brief |
| `prompts/quinn-ui-brief.md` | Harness-owned | UI testing methodology — referenced by quinn brief |
| `prompts/quinn-decision-tree.md` | Harness-owned | Journey decision tree — referenced by quinn brief |
| `prompts/rook.md` | Harness-owned | Agent methodology — scaffolded into rook brief |
| `prompts/serena.md` | Harness-owned | Agent methodology — scaffolded into serena brief |
| `prompts/aditi.md` | Harness-owned | Agent methodology — scaffolded into aditi brief |
| `prompts/discovery.md` | Harness-owned | Discovery phase methodology |
| `prompts/environment.md` | Harness-owned | Environment detection checklist |
| `prompts/container-rebuild.md` | Harness-owned | Container rebuild protocol |
| `prompts/container-verify.md` | Harness-owned | Container verification protocol |
| `prompts/ac-adversary.md` | Harness-owned | Gate prompt — AC garbage test |
| `prompts/ac-format.md` | Harness-owned | AC format guide |
| `prompts/evidence-validator.md` | Harness-owned | Gate prompt — evidence validation |
| `prompts/evidence-hierarchy.md` | Harness-owned | Evidence tier definitions (S/A/B/C/D/F) |
| `prompts/prove-reproducer.md` | Harness-owned | Prove gate reproducer methodology |
| `prompts/rca.md` | Harness-owned | Root cause analysis protocol |
| `prompts/blast-radius.md` | Harness-owned | Blast radius checklist |
| `prompts/prevention.md` | Harness-owned | Prevention-oriented fix methodology |
| `prompts/regression.md` | Harness-owned | Regression prevention checklist |
| `prompts/read-before-write.md` | Harness-owned | Read-before-write protocol |
| `prompts/coding-principles.md` | Harness-owned | Coding standards for all agents |
| `prompts/testing-strategy.md` | Harness-owned | Testing methodology |
| `prompts/escalation-decision-tree.md` | Harness-owned | When to research vs iterate |

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
