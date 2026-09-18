---
doc-type: spec
status: in-progress
owner: jason
created: 2026-09-16
updated: 2026-09-16
testable: true
council-reviewed: 2026-09-16
councils: [adversarial-harness-extraction-wf_4fc577fc, architecture-council-harness-wf_7c6db7df]
related-issues: [517, 281, 513, 514]
---

# Harness Extraction Spec

Extract all harness code from scattered locations into one self-contained git repo (`~/Projects/rungate/`), with mechanical tests that prevent drift forever.

## Problem Statement

The ship harness (workflows, gates, tests, specs, prompts, config) is scattered across 10+ directories under `~/.claude/`. This makes it:
- **Non-portable** — can't clone to Mac Mini or new machine
- **Drift-prone** — 35 hardcoded paths, 3 duplicate config files, no containment enforcement
- **Untestable as a unit** — tests reference absolute paths, auto-generation hardcodes one spec
- **Invisible to agents** — no single entry point; agents need DOCS.md + CONTEXT_ROUTING + CLAUDE.md to find harness files

## Success Criteria (all 10 must be true)

- [ ] SC-1: `~/Projects/rungate/` exists with all harness files in target structure
- [ ] SC-2: `hornjason/rungate` public repo on GitHub with clean history
- [ ] SC-3: Zero harness files in old scattered locations (containment test GREEN)
- [ ] SC-4: Zero hardcoded `~/.claude/` paths in any workflow/gate file (path-purity test GREEN)
- [ ] SC-5: All specs have `testable: true/false` frontmatter; auto-discovery working
- [ ] SC-6: Zod schema validates DDB rungate.json at gate load time
- [ ] SC-7: #513 fixed — AC evidence uses AC-specific commands
- [ ] SC-8: #514 fixed — phase advance blocked when ACs FAIL
- [ ] SC-9: One STANDARD-tier DDB issue SHIP_PASSED + PROVE_PROVEN through rungate/ workflows
- [ ] SC-10: Guard validation proven — intentional violations caught, then cleaned up

## Council Findings (2 councils, 2026-09-16)

### Council 1 — Migration Mechanics (adversarial, 4 members, 2 rounds)

13 convergence points, 7 BLOCKERS. Core risk: 4 categories of path references, only TypeScript imports caught by compiler. Template literal agent prompts, CLAUDE.md natural-language rules, and hook system-reminder strings all fail silently.

| Blocker | What | File:Line |
|---|---|---|
| B1 | spec-compliance.test.ts 4 absolute paths | test/spec-compliance.test.ts:4-6,237 |
| B2 | sync-spec-tests.ts hardcoded paths | scripts/sync-spec-tests.ts:19-23 |
| B3 | HOME defaults to '/Users/jhorn' | ship.js:120, prove.js:123 |
| B4 | Create lib/paths.ts (harnessRoot, paiRoot) | New file |
| B5 | 10 template literal paths in workflows | ship.js:132,135,153,202,242,283,368,724,746; prove.js:126 |
| B7 | pre-push hook cross-directory imports | scripts/git-hooks/pre-push:13-14 |
| B9 | run-gate.ts 7 cwd references | run-gate.ts:163,199,205,232,315,497,558 |

Additional convergence points (HIGH/MEDIUM):
- CP-8: 9 structure tests needed (HIGH)
- CP-9: 3 hook system-reminder strings with relative gate paths (HIGH) — AutoVerifyGate:103, MergeGuard:113, IssueCloseGuard:450,530,548
- CP-10: Config file deduplication — ceremony-profiles.json, workflow-schema.json, spec-policies.json (MEDIUM)
- CP-11: .gate-salt cross-repo dependency — orchestrator.ts:125-131, witness.ts:20-26 (MEDIUM)
- CP-12: GP-1/GP-2 assertions encode old path as correct — spec-compliance.test.ts:191-199 (HIGH)
- CP-13: batch-ship.js:211 worktree heuristic uses `PROJECT_ROOT.includes('/.claude/')` (MEDIUM)

Migration strategy: symlink-based batch (not atomic cutover). Symlinks from old→new during transition, remove in final commit.

### Council 2 — Architecture Decisions (3 members, 1 round)

| Decision | Verdict | Detail |
|---|---|---|
| D1: Spec frontmatter | MODIFY | `testable: true/false` required on every spec. Missing = FAIL. Drop check-types — parser determines claim types via regex. |
| D2: Self-contained repo | MODIFY | Self-contained for development. One CONTEXT_ROUTING entry. HARNESS.md lists "External Dependencies" — CLAUDE.md rule names. Drift detector test. |
| D3: HARNESS.md | KEEP | ~80 lines. 3 workflow entry points + rungate.json schema + test command + spec index. No internal layout exposed. |
| D4: rungate.json | MODIFY | DROP harnessRoot (use HARNESS_ROOT env var). ADD Zod schema validation at scaffold/load/test. |

**Repo boundary rule:** Harness repo owns execution machinery (phases, gates, specs, agent prompts). Does NOT own behavioral rules (CLAUDE.md), orchestration mode (Algorithm), project config (rungate.json), or PAI-wide routing (DOCS.md).

## Execution Plan (AFK overnight 2026-09-16)

### Pre-decided Answers (zero stops)

- Canary issue: create new issue meeting all 9 canary requirements
- Verify gate fails: iterate (circuit breaker at 6)
- Spec frontmatter ambiguity: default `testable: false`
- Test failure can't diagnose: log, file follow-up issue, continue
- Merge/push: push to rungate repo; commit ~/.claude changes to main
- Something breaks mid-migration: iterate via convergence loop (rollback only if 3+ phases fail)

### Phase A — Spec Infrastructure (20 min)

- [ ] A1: Add `testable: true/false` to all specs in PAI/Specs/
- [ ] A2: Modify sync-spec-tests.ts → glob scan instead of hardcoded path
- [ ] A3: Write spec-discovery.test.ts (frontmatter enforcement: every spec has field, every testable:true has ≥1 claim)
- [ ] A4: Run → verify claim extraction works across all specs

### Phase B — Path Foundation (30 min)

- [ ] B1: Create lib/paths.ts — `harnessRoot()`, `paiRoot()`, `workDir(slug)`, `gateSaltPath()`
- [ ] B2: Fix HOME defaults: ship.js:120, prove.js:123 (`'/Users/jhorn'` → `process.env.HOME`)
- [ ] B3: Fix spec-compliance.test.ts:4-6,237 + sync-spec-tests.ts:19-23 (use lib/paths.ts)
- [ ] B4: Fix 10 template literal paths in ship.js + prove.js:126 (use HARNESS_ROOT)
- [ ] B5: Fix run-gate.ts 7 cwd references (harnessRoot for Bun, paiRoot for CLI)
- [ ] B6: Fix pre-push hook cross-directory imports (scripts/git-hooks/pre-push:13-14)
- [ ] B7: Fix GP-1/GP-2 assertions in spec-compliance.test.ts:191-199
- [ ] GATE: run 12 migration invariants → all GREEN

### Phase C — Schema + Validation (20 min)

- [ ] C1: Create lib/rungate-schema.ts (Zod) — required: project, repo, issueRepo, dev.start, dev.apiBase, dev.uiBase
- [ ] C2: Validate DDB rungate.json against schema
- [ ] C3: Wire validation into run-gate.ts load time (actionable error naming missing fields)
- [ ] C4: Write schema-canary.test.ts (validates DDB config as regression canary)
- [ ] GATE: run 12 invariants → GREEN

### Phase D — Repo Structure + Guards (30 min)

- [ ] D1: Create ~/Projects/rungate/ — git init, package.json, bunfig.toml
- [ ] D2: `gh repo create hornjason/rungate --public`
- [ ] D3: Write HARNESS.md (~80 lines: 3 entry points, schema summary, test cmd, spec index, External Dependencies section)
- [ ] D4: Write migration-manifest.json (all files, migrated:false)
- [ ] D5: Write test/structure.test.ts — containment + path-purity + manifest checks (all FAIL expected)
- [ ] D6: Write test/external-deps.test.ts — drift detector (HARNESS.md External Dependencies vs CLAUDE.md)
- [ ] GATE: structure tests FAIL (expected baseline)

### Phase E — Move Files + Wire (45 min)

- [ ] E1: Copy all files to rungate/ target structure
- [ ] E2: Create symlinks: old paths → new locations
- [ ] E3: Flip manifest entries → migrated:true
- [ ] E3.5: Update 3 hook system-reminder strings (AutoVerifyGate:103, MergeGuard:113, IssueCloseGuard:450,530,548) → absolute HARNESS_ROOT paths
- [ ] E3.6: Fix batch-ship.js:211 worktree heuristic (`PROJECT_ROOT.includes('/.claude/')`)
- [ ] E4: Dedup 3 config files (delete skills/ship/ copies, remove run-gate.ts:33-35 ternary fallback)
- [ ] E5: Move .gate-salt to gates/.gate-salt (update orchestrator.ts:125-131, witness.ts:20-26)
- [ ] E6: Add spec frontmatter to moved specs
- [ ] E7: Run ALL tests (invariant + structure) → GREEN
- [ ] E8: Update CLAUDE.md scriptPath rule → new location
- [ ] E9: Remove symlinks (final cleanup commit)
- [ ] E10: Run ALL tests again → GREEN
- [ ] GATE: containment GREEN, path-purity GREEN, manifest complete

### Phase F — Fix #513 + #514 (45 min)

- [ ] F1: AC evidence must use AC-specific commands (#513)
- [ ] F2: Block phase advance when ACs FAIL (#514)
- [ ] F3: Gate tests pass from new location
- [ ] GATE: all tests GREEN

### Phase G — Canary Ship Cycle (60 min)

Canary issue must exercise (council-specified 9 requirements):
1. STANDARD tier (not LIGHT) — exercises AC Adversary, Evidence Validator, Quinn
2. At least one OUTCOME-type AC — triggers dev server liveness check
3. At least one .tsx file change — triggers Quinn local dev validation
4. Full 4-gate chain: scope → verify → ship → prove
5. Trigger at least one verify failure iteration — proves convergence loop works
6. Invoke prove.js via workflow scriptPath — proves chained workflow resolution
7. Post results to GitHub issue — proves GitHub integration
8. Run brief-assembler.ts from new location — proves brief generation pipeline
9. Run run-gate.ts child process spawns from new HARNESS_ROOT cwd

- [ ] G1: Create STANDARD-tier DDB issue meeting all 9 requirements
- [ ] G2: Full /ship through rungate/ workflows
- [ ] G3: Convergence loop on any failures (circuit breaker at 6)
- [ ] G4: /prove the shipped issue
- [ ] GATE: SHIP_PASSED + PROVE_PROVEN

### Phase H — Guard Validation + Publish (15 min)

- [ ] H1: Intentionally create harness file in old location → containment test FAIL
- [ ] H2: Add hardcoded path to workflow file → path-purity test FAIL
- [ ] H3: Remove spec frontmatter from one spec → spec-discovery test FAIL
- [ ] H4: Clean up intentional violations → all tests GREEN
- [ ] H5: Push to hornjason/rungate public repo
- [ ] H6: Update checkpoint file with final status
- [ ] GATE: all 10 success criteria met

## Target Structure (council-validated)

```
rungate/
├── HARNESS.md         ← agent entry point (~80 lines, no internal layout)
├── lib/               ← paths.ts, rungate-schema.ts (FOUNDATION)
├── workflows/         ← ship.js, prove.js, council.js (EXECUTION — 3 entry points)
├── gates/             ← run-gate.ts, tests, schema, .gate-salt (ENFORCEMENT)
├── scripts/           ← sync-spec-tests, scaffold-rungate-config (TOOLING)
├── hooks/             ← harness-lifecycle hooks only (~24, not all 52) (LIFECYCLE)
├── test/              ← spec-compliance, spec-discovery, structure, schema-canary, external-deps (VERIFICATION)
├── specs/             ← governing specs with testable frontmatter (TRUTH)
├── config/            ← ceremony-profiles, schemas — 1 canonical copy each (CONFIG)
├── prompts/           ← MarcusContext, QUINN-STANDARD, brief templates, SKILL.md docs (CONTEXT)
├── package.json       ← bun dependencies (zod, etc.)
├── bunfig.toml        ← test configuration
└── migration-manifest.json ← tracks every file source→dest (migration artifact)
```

**No `skills/` dir.** SKILL.md files are context docs — move to `prompts/`.
**No `templates/` dir.** Brief templates move to `prompts/`. Issue templates move to `config/`.
**No `testing/` dir.** QUINN-STANDARD.md moves to `prompts/`.

## Test Architecture (council-validated)

### Spec Discovery

Glob scan `specs/*.md` filtered by YAML frontmatter `testable: true`. Every spec MUST have `testable: true` or `testable: false` — missing = FAIL. Parser extracts claims via regex (make commands, GATE markers, port refs, Quinn verbs). Scanner emits manifest: N specs, N testable, N claims.

### Test Types

| Test file | What it checks | Decay it prevents |
|---|---|---|
| spec-compliance-auto.test.ts | Auto-generated assertions from spec claims | Spec↔code drift |
| spec-discovery.test.ts | Every spec has frontmatter, testable specs have claims | Silent test erosion |
| structure.test.ts | File layout, containment, path-purity, manifest | Migration stragglers, path regression |
| schema-canary.test.ts | rungate.json validates against Zod schema | Config drift |
| external-deps.test.ts | HARNESS.md External Dependencies match CLAUDE.md rules | Cross-repo behavioral drift |
| workflow.test.ts | Existing gate tests (code-committed, ports, config) | Gate regression |
| e2e-smoke.test.ts | Existing structural checks (case/default counts) | Structural regression |

### Decay Prevention (3 layers)

1. **Frontmatter enforcement** — missing field = FAIL (not skip)
2. **Claim count regression** — manifest tracks per-spec claims; decrease without opt-out = FAIL
3. **Cross-repo drift** — external-deps.test.ts catches CLAUDE.md rule changes that affect harness

## rungate.json Contract (council-validated Zod schema)

**Required fields:** project, repo, issueRepo, dev.start, dev.apiBase, dev.uiBase
**Optional fields:** dev.preStart, dev.testCmd, dev.typeCheck, test.start, test.apiBase, prod.rebuild, prod.apiBase, prod.uiBase, prod.smokeTest, pages, codeCommittedPaths, consumers, contextDocs
**Dropped fields:** harnessRoot (use HARNESS_ROOT env var), context.architecture/agents/specs (zero consumers), healthCheck (derived from apiBase)
**Validation points:** scaffold output, run-gate.ts load time, schema-canary.test.ts
**Schema versioning:** schemaVersion field, breaking changes bump major version

## Rollback Plan

1. `git revert` migration commit(s) on main
2. Remove symlinks: `find ~/.claude -type l -delete` (scoped)
3. Restart Claude Code session (reloads CLAUDE.md/settings.json)
4. Run `bun test gates/` + `bun test test/spec-compliance.test.ts` from `~/.claude/` → GREEN
5. Accept one broken session between revert and restart

## Migration Invariants (must pass at EVERY phase gate)

- INV-1: All gate unit tests in gates/*.test.ts pass
- INV-2: spec-compliance SC-1 through SC-5 pass (content-based)
- INV-3: spec-compliance PO-1 through PO-6 pass (phase ordering)
- INV-4: spec-compliance PI-1 through PI-3 pass (prompt immutability)
- INV-5: spec-compliance ER-1 through ER-4 pass (error recovery)
- INV-6: schema-parity.test.ts passes (Zod vs JSON schema)
- INV-7: chain.test.ts passes (witness chain structure)
- INV-8: ship-orchestrator.test.ts passes (self-contained in /tmp/)
- INV-9: `bun run gates/run-gate.ts --help` succeeds (import resolution smoke)
- INV-10: git push succeeds without pre-push import errors
- INV-11: No `/Users/jhorn` literal in workflows/*.js or gates/*.ts
- INV-12: Containment grep returns only intentional PAI-context references

## npm Packaging (DEFERRED)

Only when git repo proves insufficient for multi-machine use.
- Namespace: `rungate` (NOT `@agentgrit/harness` — false coupling per council)
- CLI, provenance, separate npm publish

## Related Docs

- `PAI/specs/REMOTE-EXECUTION-SPEC.md` — remote execution (Mac Mini, Tailscale, --bg)
- `PAI/specs/HARNESS-SKILL-CHAIN.md` — harness phases
- `PAI/HARNESS-STANDARD.md` — harness loop
- `PAI/HARNESS-GATES.md` — gate definitions
