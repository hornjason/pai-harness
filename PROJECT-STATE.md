# Project State

**Current phase: Phase 1.5 — Context Quality — 1 SCs open**

Session 7 — Three-tier rule enforcement architecture.

**Shipped this session:**
- Three-tier rule enforcement: identity (brief), reinforcement (task prompt), mechanical (harness structure)
- lib/rule-registry.ts: extracts rules from briefs, classifies by tier from frontmatter config
- Config-driven: tiers field in brief frontmatter maps sections to reinforcement/mechanical, identity is default
- ship.js briefedAgent(): dynamically extracts reinforcement rules via agent call, injects at top of task prompt
- Scaffold agentMeta: carries tiers through to generated briefs (survives re-scaffold)
- Marcus tiers: reinforcement=[Testing Rules], mechanical=[Workflow], identity=24 rules
- Quinn tiers: reinforcement=[Project Type Detection, CLI Testing Mode], identity=rest
- docs/research/three-tier-enforcement.md: full writeup with Mermaid diagram
- specs/AGENT-BRIEF-TEMPLATE-SPEC.md: SC-423 through SC-428 for tier enforcement

**Validation results:**
- Marcus compliance: 3/8 → 8/8 process rules followed after reinforcement tier
- Context reads: 3/6 → 6/6 files after reinforcement
- TDD: TEST_AFTER → test-first after position fix (line 460 → line 8)
- Research confirmed: Instruction Stacking Collapse (arXiv 2608.02639), Lost-in-the-Middle (Liu 2023)

**Architecture:**
- Brief is single source of truth (rules + tier classification in frontmatter)
- Rule registry is deep module (one interface, multiple consumers: ship.js, evals, audit)
- No hardcoded rules in ship.js — dynamic extraction
- Add a rule to a brief section → everything downstream adjusts automatically

**Next:**
- Quinn solo validation (running)
- Layer 3 mechanical enforcement: split Marcus into test-only + implement-only spawns
- Eval integration: post-PROVE phase grades transcript, feeds findings back to templates
- Hill climb loop: eval watches behavior → tightens briefs → re-eval

**Test suite: 1,089 pass, 0 fail across 54 files**

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

