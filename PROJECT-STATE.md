# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 17 — gate bug fixes + pipeline hardening. 7 fixes, 3 new issues shipped, 4 ALREADY_SHIPPED.

7 fixes shipped this session:
  1. M-size decomposition (c835bbb6) — batched Marcus for >5 ACs
  2. Verify gate ReferenceError (020fcb8c) — temporal dead zone crash
  3. Auto-populate timeout (f794fb04) — 10s→300s for bun test
  4. AC anchoring relaxed (6bdea4a1) — allows additional ACs for test coverage
  5. Discovery brief consolidated (751d219d) — Never Do sections merged
  6. Bun test output rule (3c170471) — stops 'grep -c ✓' evidence commands
  7. Spec-compliance test fixed (d9f96db1) — broken test was silently failing ALL bun test ACs

Pipeline results this session:
  #543: SHIPPED, 22 agents, 35m (1 regression)
  #546: SHIPPED, 17 agents, 23m (0 regressions)
  #539: SHIPPED, 17 agents, 32m (0 regressions)
  #547: ALREADY_SHIPPED (prior work from earlier attempts)
  #579: ALREADY_SHIPPED
  #585: ALREADY_SHIPPED
  #594: ALREADY_SHIPPED
  #544: retrying (DNS failure last attempt)
  #548: retrying (DNS failure last attempt)

Key insight: broken spec-compliance test was the root cause of ALL 'bun test' AC failures. It made the full suite exit non-zero, which left ACs as PENDING, which failed verify gate. Fix (d9f96db1) unlocked #539, #546, #543 shipping.

Cumulative: 12 issues shipped, 17 closed. Suite: 1447 pass, 0 fail, 82 files.
Suite: 4/25 SCs done.

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

