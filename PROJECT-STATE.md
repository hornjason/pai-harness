# Project State

**Current phase: Scaffold Decomposition — 3 SCs open**

Session 17 — 11 fixes, 8 shipped, 6 ALREADY_SHIPPED. First M-size ship (#541).

11 fixes:
  1. M-size decomposition (c835bbb6) — batched Marcus for >5 ACs
  2. Verify gate ReferenceError (020fcb8c) — temporal dead zone crash
  3. Auto-populate timeout (f794fb04) — 10s→300s for bun test
  4. AC anchoring relaxed (6bdea4a1) — additional ACs for test/import coverage
  5. Discovery brief consolidated (751d219d) — merged Never Do + reinforcement tier
  6. Bun test output rule (3c170471) — prevents broken grep evidence commands
  7. Spec-compliance test (d9f96db1) — ROOT CAUSE of all bun test AC failures
  8. Circular dep fix (fd8c96ad) — parseTestResults post-#548 decomp
  9. Project-state scope-out (582a5538) — prevents Marcus overwriting project state
  10. AgentBriefGuard test fix (47b1f2b0) — stderr format changed post-#544 decomp
  11. create-sc test fix (a10596ab) — Commands table moved to generators

Shipped:
  #541: SHIPPED M-SIZE (23 agents, 29m, batched B1+B2) — file generators extracted
  #543: SHIPPED (22 agents, 35m) — AgentBriefGuard extracted
  #544: SHIPPED (merged+fixes) — GateEnforcement extracted to lib/
  #545: SHIPPED (17 agents, 24m) — hook SC traceability
  #546: SHIPPED (17 agents, 23m) — gate contracts audited
  #539: SHIPPED (17 agents, 32m) — brief validation
  #548: SHIPPED (merged+fix) — run-gate.ts 1008→60 lines
  #547, #579, #585, #587, #588, #594: ALREADY_SHIPPED
  #540: SHIPPED (manual merge after gate fix 717fc8e0) — scanner extracted
  #590: SHIPPED (manual merge after workflow stall) — buildAgentMeta, DEFAULT_AGENT_META exported

Session 18:
  Gate fix: grep exit-code-1 evidence capture (717fc8e0) — root cause of #540 3x failures
  #540 SHIPPED — lib/scanner.ts with ProjectScan, 36 tests, SC-358+SC-359 done
  #590 SHIPPED — buildAgentMeta from config, no hardcoded meta in generator
  RCA: 70% of failures are EVIDENCE_MISSING, Marcus correct 23/29 runs
  Filed #597 (grep evidence), #598 (evidence pre-validation P1), #599 (test baseline diffing P2)

22 issues shipped total, 26 closed. Suite: 1631 pass, 0 fail, 92 files. 19/25 SCs done.

  #542 SHIPPED — scaffold-project.ts 1500→133 lines, lib/scaffold/ + lib/validators/ extracted. SC-363 done.
  #596 SHIPPED — first-pass! 0 regressions, 17 agents, 21 min. M-size to-issues decomposition.
  #535 SHIPPED — first-pass! 0 regressions, 17 agents, 20 min. Rule health pipeline (L-size).

**Next priorities:**
1. P0: Pipeline pass rate — broken spec-compliance test was silently failing ALL bun-test evidence ACs. Fixed. Retrying #544/#548
2. P1: TDD compliance — Marcus TDD_SEQUENCE_VIOLATED in ~40% of runs. Brief says TDD first but not mechanically enforced
3. P1: Discovery cat usage — 6/8 compliance after consolidating Never Do sections + adding to reinforcement tier
4. P1: Further consolidation — 17 agents, target <10
5. P2: Navigability scoring (SC-236/237 still test.todo)
6. P3: Scaffold Decomposition remaining issues

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality + Config-Driven Testing (A-H) (COMPLETE)

## ✅ Brief Compliance + Agent Brief Templates (COMPLETE)

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter |

## ⬜ AES Quality Gate + Pipeline Optimization (NOT STARTED)

## 🔄 Scaffold Decomposition (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ✅ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ✅ | SC-360 | AGENTS.md generator from ProjectScan |
| ✅ | SC-361 | Brief generator reads template files |
| ✅ | SC-362 | CODE-MAP generator from ProjectScan |
| ✅ | SC-363 | scaffold-project.ts under 200 lines |
| ⬜ | SC-364 | Identical output before and after |
| ⬜ | SC-365 | Scanner importable without generation |
| ⬜ | SC-366 | Generators testable with mock data |

## 🔄 Hook Architecture (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-367 | AgentBriefGuard under 50 lines |
| ✅ | SC-368 | lib/brief-validator.ts independently testable |
| ✅ | SC-369 | GateEnforcement under 100 lines |
| ✅ | SC-370 | Every hook traces to an SC |
| ✅ | SC-371 | No hook over 150 lines |
| ✅ | SC-372 | Hook logic in lib/ has unit tests |

## 🔄 Gate Contracts (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-373 | Every gate has typed input/output |
| ✅ | SC-374 | Pass/fail criteria documented as SCs |
| ✅ | SC-375 | Gate chain order documented |
| ✅ | SC-376 | run-gate.ts under 400 lines |
| ⬜ | SC-377 | Contracts testable by conformity engine |
| ⬜ | SC-378 | No implicit state passing |

---

**Session 2026-09-26 session 15:**
- 6-agent refactor shipped: batched agents, 7 spec-compliance tests fixed, undefined alreadyVerdict bug fixed
- Pipeline run #595: 19 agents, 14 min, SHIPPED. All 3 ACs PASS. Marcus 9/12 compliance (75%)
- Root cause analysis: 21% first-attempt pass rate. Evidence-path worktree mismatch + ceremony gaps
- Canary testing module: lib/canary.ts + 13 tests (generateCanaryPhrase, plantCanaries, checkCanaries)
- B2 evidence validator: added missing contains/exists/!=/< operators + NaN guards
- AES prompt reinforcement: COMP-6/COMP-12 in Marcus prompt (still leaks — needs mechanical enforcement)
- Council v2 launched with full forensic data: 10 runs, 37 gate attempts, agent-level transcripts

**Session 2026-09-25 session 14:**
- AES hill-climb: 32→87 in 3 dry-run iterations (TDD top, context injection, efficiency rules)
- Pipeline optimization: 32 agents/141 min → 16 agents/20 min
- Prove regression eliminated: LIGHT skips prove, no re-implementation loop
- Agent batching: init+prior-branch, ac-prevalidation+prior-branch, brief-preflight+assemble, commit+env-check+record, merge+push, finalize (4→1)
- Grading aligned to COMP-1 through COMP-13 with verdict + evidence
- Context injection working: COMP-1/COMP-5/COMP-11 pass via prompt injection
- Verify gate cwd fixed (EVIDENCE_CWD), merge guard added
- bun test --parallel --no-isolate (209→176s), redundant test runs eliminated
- 5 issues shipped: #590 (40%), #592 (70%), #584 (67%), #594 (83%), #595 (83%)
- Ship gate false positives: B1/B2/evidence-type-ratio checks fire on LIGHT (should be exempt)
- Deep adversarial audit: 26/32 agents were bash wrappers, prove was 42% of runtime

**Session 2026-09-27 session 17:**
- M-size decomposition (c835bbb6) — batched Marcus for M/L issues with >5 ACs
- ReferenceError fix (020fcb8c) — verify gate fails/results temporal dead zone. Root cause of all #547 failures
- Auto-populate timeout (f794fb04) — 10s→300s for bun test evidence commands. Prevented AC verdicts
- #547 ALREADY_SHIPPED (attempt 4) — prior work from attempts 1-2 satisfied all 3 ACs
- #548 SHIP_FAILED — Marcus decomposed run-gate.ts to 353 lines but broke full test suite. Need more ACs for test updates
- #582 SHIPPED (23 agents, 30m) — from previous session compaction
- Suite: 1387 pass, 0 fail, 82 files. 4 pipeline runs. 2 critical gate bugs fixed

