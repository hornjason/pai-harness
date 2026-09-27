# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 16 — pipeline reliability + efficiency. 7 implementation issues shipped, 0 failures post-fix.

6 fixes shipped:
  1. writeACs resilience (bb219258) — safeParse prevents 0-AC state corruption
  2. Verify BUILD regression (4a18bdac) — re-implements and re-verifies
  3. quinn-on-ui-change LIGHT (5cb983a0) — skip Quinn for CLI projects
  4. Brief simplification (0ff53f9b) — Marcus 18→8 directives, compliance 17%→80%
  5. Agent consolidation (cbd0550c) — preload-contexts + merged setup. 20→17 agents
  6. Karpathy rules (1f1033c7) — Surgical Changes + Simplicity First in Marcus brief

Pipeline results (implementation runs only):
  #593: SHIPPED, 24 agents, 30m (pre-simplification, 28% compliance)
  #589: SHIPPED, 20 agents, 12m (pre-simplification, 17% compliance)
  #561: SHIPPED, 20 agents, 19m (pre-simplification, 33% compliance)
  #581: SHIPPED, 17 agents, 18m (post-simplification, 80% compliance)
  #580: SHIPPED, 17 agents, 15.5m (post-simplification, 80% compliance)

Key metrics post-optimization:
  - First-attempt pass rate: 100% (5/5 post-fix runs)
  - Agent count: 17 (down from 20-24)
  - Marcus compliance: 80% (up from 17-33%)
  - ALREADY_SHIPPED: 4 agents / 3-5 min

Suite: 1415 pass, 0 fail, 80 files. 9 issues shipped total: #579, #580, #581, #584, #589, #590, #592, #593, #595.
Suite: 4/25 SCs done.

**Next priorities:**
1. P0: TDD compliance — Marcus TDD_SEQUENCE_VIOLATED in 1/2 post-simplification runs. Brief says TDD first but Marcus still writes impl before tests sometimes
2. P1: Discovery cat usage — 17-19 cat commands per run. Discovery brief needs efficiency rules similar to Marcus
3. P1: Canary integration — wire lib/canary.ts into brief assembler + transcript checker
4. P1: Further consolidation — 17 agents, target <10. Batch brief-setup + extract-context, merge grade + finalize
5. P2: Navigability scoring (SC-236/237 still test.todo)
6. P3: Scaffold Decomposition, Hook Architecture, Gate Contracts

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

**Session 2026-09-24 session 13:**
- Ship-and-heal dogfood: #585 shipped (HEALED), #591 shipped (HEALED)
- Grading pipeline shipped: transcript path fix, role filtering, remediation flow
- Violation categorization: quality vs process (SC-465-468)
- analyze-transcript.ts: file efficiency, deliverable ratio, test runs, context growth

