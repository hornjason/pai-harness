# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 14 — AES dry-run pipeline + lessons learned analysis.

Dry-run approach: Workflow agent() with isolation:'worktree' bypasses the test-brief trust blocker.
AES formula: compliance(0.3) + file_efficiency(0.25) + deliverable_ratio(0.25) + test_discipline(0.1) + context_discipline(0.1).
Baseline AES: 31.5. Target: 80.
Baseline metrics: compliance 71%, file efficiency 23%, deliverable ratio 7%, test runs 13 (limit 2), context growth 440%.

Dry-run AES (workflow brief-test): 32.75.
Dry-run metrics: compliance 50% (5/10), file efficiency 22% (2/9), deliverable ratio 9%, test runs 4 (2 full + 2 targeted), context growth 153%.
Flags: TDD_SEQUENCE_VIOLATED, SHARED-02 (dup reads), SHARED-03 (cat via bash), M-03 (test runs), M-04 (no governing spec), M-06 (no grep before read).
All 10 reads marked unused — 0% read utility. Brief rules aren't producing behavior change yet.

Key decisions this session:
- DRY_RUN should flow through full pipeline but skip commit/push/PR/heal
- Workflow agent() with isolation:'worktree' is the solution for worktree trust (auto-trusts)
- AES ≥ 80 must gate commits — quality violations block shipping
- Process violations → brief heal only, quality violations → remediation pass
- All AES dimensions must hit 80%+ (compliance, file efficiency, deliverable ratio, test discipline, context discipline)

Suite: 1304 pass, 0 fail, 72 files. 39/60 SCs done.

**Next priorities:**
1. P0: AES dry-run — get Agent Efficiency Score to 80% via workflow-based brief testing
2. P0: Grade BEFORE commit — move grading gate between implement and commit in ship.js
3. P0: AES ≥ 80 gate — block commit if AES below threshold
4. P1: #590 create-brief CLI — generate new agent briefs from templates
5. P1: #591 SC validation hook — block unmatchable SCs in strict specs
6. P1: #593 Fast path for XS issues (38 min full pipeline is too slow)
7. P2: #584 Behavioral SC cache
8. P3: Scaffold Decomposition, Hook Architecture, Gate Contracts

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ✅ | SC-295 | SC enrichment — 35 SCs enriched to matchable patterns |

## ✅ Config-Driven Testing — Phases A-E (COMPLETE)

## ✅ Config-Driven Testing — Phase F: Matcher Registry (#550-#552, #555) (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-379 | matcher-registry.json config with all 19 patterns |
| ✅ | SC-380 | matchPattern() reads from config, no hardcoded branches |
| ✅ | SC-381 | SPEC-TEMPLATE auto-generated from config |
| ✅ | SC-384 | Consumer custom matcher extension |

## ✅ Config-Driven Testing — Phase G: Structured SC Authoring (#553-#554) (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-382 | create-spec validates SCs at write time |
| ✅ | SC-396 | create-sc CLI: pattern + params → matchable SC |
| ✅ | SC-397 | create-sc --list shows all patterns |
| ✅ | SC-399 | AGENTS.md Commands table includes create-sc |

## ✅ Config-Driven Testing — Phase H: Legacy Migration (#556-#557) (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-383 | audit-specs classifies all SCs |
| ✅ | SC-393 | audit-specs --fix auto-rewrites unmatched SCs |
| ✅ | SC-394 | Scaffold runs audit-specs post-generation |
| ✅ | SC-395 | Consumers get identical create-spec validation |
| ✅ | SC-398 | All RunGate specs at compliance: strict |

## ✅ Brief Compliance (#558) (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-400 | test-brief CLI: isolated worktree compliance test |
| ✅ | SC-401 | Directive extractor parses brief mechanically |
| ✅ | SC-402 | Transcript checker: FOLLOWED/IGNORED per directive |
| ✅ | SC-403 | Cross-reference report: brief position + RepoRails + transcript |
| ✅ | SC-404 | Hill climb mode: 5 iterations max |
| ✅ | SC-405 | All 6 briefs score ≥80% before shipping |
| ✅ | SC-406 | briefedAgent() parses Context section → explicit Read steps |
| ✅ | SC-407 | Compliance pre-flight gate in ship workflow |
| ✅ | SC-408 | Standard tasks per role defined in config |
| ✅ | SC-409 | Behavioral canary: read ≠ followed verification |

## ✅ Agent Brief Templates (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-348 | Templates in templates/agent-briefs/ |
| ✅ | SC-349 | Shared rules in _shared.md |
| ✅ | SC-350 | Scaffold reads template files |
| ✅ | SC-351 | All 8 required sections present |
| ✅ | SC-352 | All briefs model: sonnet |
| ✅ | SC-353 | Briefs under 120 lines each |
| ✅ | SC-354 | Edit template → re-scaffold updates brief |
| ✅ | SC-355 | Shared rules in every brief |
| ✅ | SC-356 | Prompt routing generated dynamically |
| ✅ | SC-357 | Template vars match project values |

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category field (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First sections → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter demotes matching directives |

## ⬜ AES Quality Gate (NEW) (NOT STARTED)

## ⬜ Scaffold Decomposition (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ⬜ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ⬜ | SC-360 | AGENTS.md generator from ProjectScan |
| ⬜ | SC-361 | Brief generator reads template files |
| ⬜ | SC-362 | CODE-MAP generator from ProjectScan |
| ⬜ | SC-363 | scaffold-project.ts under 200 lines |
| ⬜ | SC-364 | Identical output before and after |
| ⬜ | SC-365 | Scanner importable without generation |
| ⬜ | SC-366 | Generators testable with mock data |

## ⬜ Hook Architecture (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-367 | AgentBriefGuard under 50 lines |
| ⬜ | SC-368 | lib/brief-validator.ts independently testable |
| ⬜ | SC-369 | GateEnforcement under 100 lines |
| ⬜ | SC-370 | Every hook traces to an SC |
| ⬜ | SC-371 | No hook over 150 lines |
| ⬜ | SC-372 | Hook logic in lib/ has unit tests |

## ⬜ Gate Contracts (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-373 | Every gate has typed input/output |
| ⬜ | SC-374 | Pass/fail criteria documented as SCs |
| ⬜ | SC-375 | Gate chain order documented |
| ⬜ | SC-376 | run-gate.ts under 400 lines |
| ⬜ | SC-377 | Contracts testable by conformity engine |
| ⬜ | SC-378 | No implicit state passing |

---

**Session 2026-09-25 session 14:**
- AES dry-run completed via Workflow agent(isolation:'worktree') — trust blocker bypassed
- Dry-run AES: 32.75 (vs baseline 31.5) — marginal improvement, same core problems
- Compliance 50% (5/10), file efficiency 22%, deliverable ratio 9%, context growth 153%
- Flags: TDD violated, dup reads, cat-via-bash, no governing spec, no grep-before-read
- All 10 reads unused (0% utility) — brief rules not producing behavior change
- AES formula finalized: compliance(0.3) + file_eff(0.25) + deliverable(0.25) + test(0.1) + context(0.1)
- Baseline AES: 31.5 — target 80. All dimensions must hit 80%+
- Launched brief-test workflow: context extraction → Marcus in worktree → grade + analyze
- Key design: DRY_RUN flows through full pipeline but skips commit/push/PR/heal
- Decision: quality violations block shipping, process violations get brief heal only
- Lessons learned analysis from shipped issues: TDD, context bloat, test discipline all improvable
- analyze-transcript.ts provides: file efficiency, deliverable ratio, test runs, context growth
- Blocker resolved: worktree trust bypass via Workflow agent() isolation:'worktree' (auto-trusts)

**Session 2026-09-24 session 13:**
- Ship-and-heal dogfood: #585 shipped, status HEALED, 26 agents
- Found critical bug #586: grade-deterministic.ts transcript path disconnect
- Grading works when connected: Marcus avg 7.3/10, DA avg 4/9
- ship.js fix: added git push after worktree-to-main merge (cbf2b512)
- PR #17 merged on pai-harness
- Key findings: TDD violated on all Marcus agents, SHARED-01/04 fail on 96%

**Session 2026-09-23 session 8 (AFK):**
- Closed #559 (briefedAgent parser), #560 (Quinn worktree fix), #536 (merge worktrees) — all already on main
- lib/prior-branch.ts: detects existing branches by issue number, word-boundary matching, isolated temp worktree for tests
- lib/worktree-cleanup.ts: safely prunes stale worktrees (checks uncommitted changes + merge status)
- ship.js: prior-branch detection between Discovery/Implement, worktree cleanup post-workflow
- hooks/StaleTTLCleanup: worktree pruning (24h+ with merged branches) on session start
- First harness dogfood: #1447 shipped via ship workflow — first cross-repo harness run

