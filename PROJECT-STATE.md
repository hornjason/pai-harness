# Project State

**Current phase: Brief Compliance (#558) — 4 SCs open**

Session 11 — AFK review with Jason (sessions 3-10, ~70 commits, ~20 issues shipped).

Flipped SC-295 (Phase 1.5 closed), SC-381 (Phase F closed). Pruned 31 stale worktrees.
Closed 6 stale shipped-but-open issues (#537, #549, #555, #562, #563, #564).
Research: Claude Code feature audit — 3 Tier 1 hooks (#577-#579), 3 Tier 2 features (#580-#582).
Key decisions: behavioral SCs should be eliminated as a category — test enforcement artifacts instead.
Option B chosen for conformity auto-flip. Ship workflow close step for stale issue detection.
Suite: 1253 pass, 0 fail, 63 files. 33/56 SCs passing in conformity (8 more ready to flip).

**Next priorities:**
1. P0: Option B — conformity test auto-flips spec checkboxes on pass (closes feedback loop)
2. P0: Reclassify ~20 misclassified behavioral SCs to matchable static checks
3. P0: Stale issue scanner in ship.js close step — detect and close orphaned issues
4. P1: #565 Worktree repo mismatch bug — Marcus gets harness repo, not target
5. P1: Observability Phase 0 — validate scorer on 5 historical transcripts
6. P1: #577 SubagentStop hook — mechanical auditor for every agent (Tier 1)
7. P1: #578 PostCompact hook — re-inject rules after context compression (Tier 1)
8. P1: #561 Brief compliance gate (SC-407–SC-409)
9. P1: Ship-and-heal post-fix verification — mechanically check generator was fixed, not just instance
10. P2: Observability Phase 1 — lib/grade-agents.ts, deterministic grading (14 SCs)
11. P2: Agent Brief Templates — SC-350, SC-351, SC-354, SC-357 still open
12. P2: #582 Agent Teams — evaluate for council and parallel coordination

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

## 🔄 Brief Compliance (#558) (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-400 | test-brief CLI: isolated worktree compliance test |
| ✅ | SC-401 | Directive extractor parses brief mechanically |
| ⬜ | SC-402 | Transcript checker: FOLLOWED/IGNORED per directive |
| ⬜ | SC-403 | Cross-reference report: brief position + RepoRails + transcript |
| ✅ | SC-404 | Hill climb mode: 5 iterations max |
| ✅ | SC-405 | All 6 briefs score ≥80% before shipping |
| ✅ | SC-406 | briefedAgent() parses Context section → explicit Read steps |
| ⬜ | SC-407 | Compliance pre-flight gate in ship workflow |
| ⬜ | SC-408 | Standard tasks per role defined in config |
| ✅ | SC-409 | Behavioral canary: read ≠ followed verification |

## 🔄 Agent Brief Templates (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-348 | Templates in templates/agent-briefs/ |
| ✅ | SC-349 | Shared rules in _shared.md |
| ✅ | SC-350 | Scaffold reads template files |
| ⬜ | SC-351 | All 8 required sections present |
| ✅ | SC-352 | All briefs model: sonnet |
| ✅ | SC-353 | Briefs under 120 lines each |
| ⬜ | SC-354 | Edit template → re-scaffold updates brief |
| ✅ | SC-355 | Shared rules in every brief |
| ✅ | SC-356 | Prompt routing generated dynamically |
| ⬜ | SC-357 | Template vars match project values |

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

**Session 2026-09-23 session 8 (AFK):**
- Closed #559 (briefedAgent parser), #560 (Quinn worktree fix), #536 (merge worktrees) — all already on main
- lib/prior-branch.ts: detects existing branches by issue number, word-boundary matching, isolated temp worktree for tests
- lib/worktree-cleanup.ts: safely prunes stale worktrees (checks uncommitted changes + merge status)
- ship.js: prior-branch detection between Discovery/Implement, worktree cleanup post-workflow
- hooks/StaleTTLCleanup: worktree pruning (24h+ with merged branches) on session start
- /simplify review: fixed destructive checkout → temp worktree, collapsed redundant booleans, replaced agent merge with direct spawn, populated filesChanged from git diff
- Test suite: 1,062 pass, 0 fail across 57 files
- Commits: 624796b, 2a8a5f3, c04253d
- Verified and closed #550 (matcher-registry.json — 19 patterns, all required fields)
- Verified and closed #514 (ship gate blocks on FAIL ACs — already implemented in orchestrator.ts:66-82)
- Verified and closed #513 (per-AC evidence commands — already implemented in run-gate.ts:108-136)
- Harness readiness audit: no remaining blockers for consumer project dogfooding
- Shipped SC-380 (#551): matchPattern() refactored to config-driven dispatch — 19 handlers, 365→14 line body, zero test changes
- Shipped SC-381 (#552): SPEC-TEMPLATE patterns auto-generated from config/matcher-registry.json
- Fixed import() sandbox issue in ship.js and prove.js — Workflow sandbox doesn't support import()
- First harness dogfood: #1447 shipped via ship workflow — ALREADY_SHIPPED path, all 7 ACs MET, prove UNPROVEN
- Closed #1447 (council fixes) with harness evidence — first cross-repo harness run
- Dogfood finding: GRADE unreachable on ALREADY_SHIPPED path (by design — no Marcus work to grade)
- Dogfood finding: need an unimplemented issue to test full pipeline including Marcus briefs + GRADE

**Session 2026-09-22 session 5:**
- Merged SC-293 (already on main), SC-302 (6d1ba72), worktrees cleaned
- Merged #560 worktree fix (70ed812), #559 briefedAgent parser (0671786), combined (86181db)
- Fixed 3 pre-existing test failures ST-6, SC-140, SC-145 (d821e53) — suite green 955/0
- Created issues #559, #560, #561. Wrote PARALLEL-AGENT-COORDINATION-SPEC (SC-410–415)
- DA self-audit: F(40%), 12/20 rules violated. Hill climb 4 iterations: CLAUDE.md procedural rules proven ineffective
- Key finding: behavioral rules work in CLAUDE.md, procedural rules do NOT — model prioritizes task over system context
- Council (4 members, 2 rounds): hooks as enforcement floor, /ship for workflow, CLAUDE.md behavioral only
- Rewrote global CLAUDE.md: 91→33 lines, 7 behavioral rules. Procedural rules dropped.
- Rewrote project CLAUDE.md: 6 project-specific rules as guidance
- Decision: RunGate exempt from harness enforcement (bootstrap problem)
- Mid-session rule refresh via Bash cat works — Read tool blocks unchanged files

**Session 2026-09-22 session 4:**
- Ship workflow dogfood: 3 bugs found (process.env, agentType, unnamed discovery)
- Config-driven roles: rungate.json roles{} maps role→brief+isolation
- Transcript auditor: scripts/audit-transcript.ts grades agent behavior (11 rules)
- test-brief CLI: scripts/test-brief.ts extracts directives from brief, cross-references with transcript
- Compliance hill climb: Marcus F(27%)→D(45%)→C(70%)→B(85%)→B(80%) in 5 iterations
- Key finding: explicit numbered Read steps in prompt > 'read Context section' > brief-only
- briefedAgent() parses brief Context section, generates explicit Read steps at prompt-build time
- Template system: discovery.md + marcus.md externalized to templates/agent-briefs/ with ${VAR}
- Published 8 issues (#550-#557) for Phase F/G/H: matcher registry, create-sc, audit-specs --fix
- Published #558: test-brief CLI for isolated agent compliance testing
- Ship #550 VALIDATE_FAILED: worktree isolation bug — Quinn can't see Marcus's worktree changes
- agnix+RepoRails: run on all 32 files, 10 HIGH findings. Cross-referenced with transcript for behavioral gaps

