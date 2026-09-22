# Project State

**Current phase: Phase 1.5 — Context Quality — 1 SCs open**

Session 6 — AFK ship workflow + brief audit + eval system design.

**Shipped:**
- #562 DA-COMPLIANCE-SPEC: eval criteria, audit-transcript with FOLLOWED/IGNORED, da-compliance skill (1,384 lines, 18 tests)
- #538 Template extraction: verified already landed, closed
- #558 Brief Compliance: directive-extractor, transcript-checker, hill-climb, worktree-isolation (1,645 lines, 48 tests)
- ship.js fixed: import()→agent context extraction, object schema, pages:{}→LIGHT override, commit from worktree path
- All 6 agent briefs audited and fixed: shared boilerplate cleaned, Quinn CLI mode, Aditi CLI skip, Marcus TDD workflow
- TDD sequence checker (checkTDD) with 5 tests
- test-rules.ts CLI: auto-extracts 37 rules from all files Marcus loads, classifies as mechanical/sequence/judge
- Project settings.json added for permission-free AFK runs

**Key findings from workflow audit (#562 — 34 min, 20 agents):**
- Marcus: 11:32 (35%) — efficient, 5/5 brief compliance, 1,590 lines produced. NOT doing TDD.
- Quinn Local: 9:04 (27%) — 75% waste, ran full test suite 3x instead of targeted
- Quinn Container: 3:16 (10%) — 100% waste, navigated wrong app, checked wrong commit
- Discovery: 2:34 — sized M/STANDARD, should be LIGHT for CLI project. 38 calls (brief says max 25)
- Root cause: briefs are web-app-centric, no project-type awareness, Quinn has no CLI mode

**Brief fixes applied:**
- _shared.md: removed 'bun test after every change' (Marcus-only), removed duplicates, removed Ask First (Marcus-only)
- marcus.md: consolidated bun test to 'exactly twice', TDD as numbered workflow steps, removed contradictions
- quinn.md: added Project Type Detection gate — CLI mode (bun test + grep) vs UI mode (Playwright)
- discovery.md: removed 'run bun test' (read-only role), added pages:{} ceremony tier check
- aditi.md: added CLI skip detection
- Test suite: 1,079 tests, 0 fail (up from 955)

**Eval system design (from Anthropic article + our research):**
- Three-phase approach: Phase 1 (rule quality — test each rule in isolation), Phase 2 (rule position — test rules together), Phase 3 (integration — full ship workflow)
- Rules auto-extracted from all files each agent loads (37 for Marcus across 3 files)
- Three check types: mechanical (tool call counting), sequence (TDD ordering), judge (LLM rubric for prose principles)
- Canary tasks per rule for isolated testing
- Hill climb loop: reword failed rules, re-test until pass
- Key anti-pattern from Anthropic: don't grade path, grade outcome — EXCEPT when process IS the requirement (TDD)

**Test suite: 1,079 pass, 0 fail across 53 files**

**Next priorities:**
1. P0: RULE-LEVEL EVAL SYSTEM — extract rules from all files each agent loads, test each rule individually with canary tasks, hill climb wording until each passes. Phase 1 of 3-phase eval strategy.
2. P0: Fix ship.js Commit phase — commit from marcusWorktreePath not PROJECT_ROOT (worktree bug still causing empty commits)
3. P1: CONFIG-DRIVEN-TESTING Phase F+G+H (#550–#557, SC-379–SC-399): Matcher registry, create-sc CLI, audit-specs --fix
4. P2: SCAFFOLD-DECOMPOSITION-SPEC (SC-358–SC-366): Split scaffold-project.ts (1,844→200 lines)
5. P3: HOOK-ARCHITECTURE-SPEC (SC-367–SC-372): Extract AgentBriefGuard (586→50 lines)
6. P4: GATE-CONTRACTS-SPEC (SC-373–SC-378): Typed contracts for all gates

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## 🔄 Phase 1.5 — Context Quality (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ⬜ | SC-295 | SC enrichment — 25 remaining |

## ✅ Config-Driven Testing — Phases A-E (COMPLETE)

## ⬜ Config-Driven Testing — Phase F: Matcher Registry (#550-#552, #555) (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-379 | matcher-registry.json config with all 19 patterns |
| ⬜ | SC-380 | matchPattern() reads from config, no hardcoded branches |
| ⬜ | SC-381 | SPEC-TEMPLATE auto-generated from config |
| ⬜ | SC-384 | Consumer custom matcher extension |

## ⬜ Config-Driven Testing — Phase G: Structured SC Authoring (#553-#554) (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-382 | create-spec validates SCs at write time |
| ⬜ | SC-396 | create-sc CLI: pattern + params → matchable SC |
| ⬜ | SC-397 | create-sc --list shows all patterns |
| ⬜ | SC-399 | AGENTS.md Commands table includes create-sc |

## ⬜ Config-Driven Testing — Phase H: Legacy Migration (#556-#557) (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-383 | audit-specs classifies all SCs |
| ⬜ | SC-393 | audit-specs --fix auto-rewrites unmatched SCs |
| ⬜ | SC-394 | Scaffold runs audit-specs post-generation |
| ⬜ | SC-395 | Consumers get identical create-spec validation |
| ⬜ | SC-398 | All RunGate specs at compliance: strict |

## 🔄 Brief Compliance (#558) (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-400 | test-brief CLI: isolated worktree compliance test |
| ⬜ | SC-401 | Directive extractor parses brief mechanically |
| ⬜ | SC-402 | Transcript checker: FOLLOWED/IGNORED per directive |
| ⬜ | SC-403 | Cross-reference report: brief position + RepoRails + transcript |
| ⬜ | SC-404 | Hill climb mode: 5 iterations max |
| ⬜ | SC-405 | All 6 briefs score ≥80% before shipping |
| ✅ | SC-406 | briefedAgent() parses Context section → explicit Read steps |
| ⬜ | SC-407 | Compliance pre-flight gate in ship workflow |
| ⬜ | SC-408 | Standard tasks per role defined in config |
| ⬜ | SC-409 | Behavioral canary: read ≠ followed verification |

## 🔄 Agent Brief Templates (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-348 | Templates in templates/agent-briefs/ |
| ⬜ | SC-349 | Shared rules in _shared.md |
| ⬜ | SC-350 | Scaffold reads template files |
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

**Session 2026-09-21 session 3:**
- Council reviewed CONFIG-DRIVEN-TESTING-SPEC (3 rounds), revised spec
- Executed Phases A-E: SC classification, 6 matchers, test migration, staleness check
- Scaffold fixed: prompt inlining → routing tables (briefs -88%)
- Audit hill climb: 55%→82% direct hits, 28→3 wasted calls
- Template improvements baked into scaffold template (model:sonnet, no subagents, AGENTS.md first)
- Post-migration audit: 3 foundational specs written (scaffold decomp, hooks, gates)
- AGENT-BRIEF-TEMPLATE-SPEC written (externalize templates from TypeScript)

