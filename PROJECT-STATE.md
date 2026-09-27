# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 16 — pipeline reliability fixes, 5 pipeline runs, 3 new fixes shipped.

Fixes shipped:
  1. writeACs resilience (bb219258) — safeParse prevents 0-AC state corruption. Root cause of #588 0-AC failure.
  2. Verify BUILD regression handler (4a18bdac) — re-implements and re-verifies instead of no-op.
  3. quinn-on-ui-change LIGHT tier (5cb983a0) — skip Quinn check for CLI/library projects.

Pipeline runs this session:
  #588 (attempt 3): ALREADY_SHIPPED, 7 agents, 3.5m — prior work detected correctly
  #589 (attempt 1): SHIP_FAILED, 21 agents, 18m — Marcus incomplete (AC-3, AC-4)
  #590: SHIP_FAILED, 21 agents, 18m — Marcus incomplete (AC-4)
  #589 (attempt 2): SHIP_FAILED, 24 agents, 22m — all ACs PASS but quinn false positive
  #593: SHIPPED, 24 agents, 30m, 1 regression — verify regression handler worked

Key findings:
  - writeACs was silently failing due to ACSchema.parse() throwing on quality heuristics
  - Verify BUILD regression was a no-op — incremented counter but never re-implemented
  - quinn-on-ui-change regex too broad — 'template' matched agent brief templates, not UI
  - Marcus compliance: 28% (5/18) — TDD violated, AGENTS.md not read, duplicate reads
  - Pipeline now has verify regression handling that actually works (#593 shipped via it)

Suite: 1392 pass, 0 fail, 78 files. 4/25 SCs done. 7 issues shipped: #590, #592, #584, #594, #595, #593.

**Next priorities:**
1. P0: Marcus compliance — 28% directive compliance causes regressions. Need mechanical enforcement or brief simplification
2. P0: witness-ac-verdict gate — AC PASS verdicts need matching witness evidence in workflow state
3. P1: Close AES gap — COMP-6 (dup reads), COMP-12 (cat instead of Read) persistent across all runs
4. P1: Agent consolidation — still 21-24 agents for implementation runs (bash-wrapper agents)
5. P1: Integrate canary module into brief assembler + transcript checker
6. P2: Navigability scoring (SC-236/237 still test.todo)
7. P3: Scaffold Decomposition, Hook Architecture, Gate Contracts

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

