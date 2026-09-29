# Project State

**Current phase: Scaffold Decomposition — 3 SCs open**

Session 18 (2026-09-28/29) — AFK marathon. 17 issues shipped/closed through pipeline. 15 shipped-but-open housekeeping closures. First-pass rate 21%→71%.

Key fixes:
  - grep exit-code-1 evidence capture (717fc8e0) — root cause of 70% EVIDENCE_MISSING failures
  - Evidence pre-validation (#598) — dry-run AC commands at SCOPE before Marcus implements
  - Test baseline diffing (#599) — only count NEW failures after Marcus
  - Mechanical spec update on close (#419) — auto-patch governing spec status

Pipeline shipped (17):
  #540 (scanner), #590 (buildAgentMeta), #542 (scaffold decomposition), #596 (to-issues),
  #535 (rule health), #598 (evidence pre-validation), #515 (branch reuse), #532 (harness config),
  #527 (doc staleness), #583 (feature parity), #531 (README fix), #529 (spec template),
  #530 (stale docs), #599 (test baseline), #419 (spec update on close)
  Already fixed: #597, #600

Housekeeping (15 closed): #516, #504, #502, #501, #500, #498, #496, #487, #482, #409, #505, #495, #497, #457, #509

First-pass rate: 10/14 (71%), up from 21%. Suite: 1729 pass, 0 fail, 97 files.
24 issues remain open. #508 shipping now.
Suite: 19/25 SCs done.

**Next priorities:**
1. P0: Pipeline pass rate — 71% first-pass (10/14). Monitor for further improvements
2. P1: #512 (isolated execution), #510 (Playwright MCP), #507 (prove screenshots), #307 (doc hygiene)
3. P1: Further consolidation — 17 agents, target <10
4. P2: #508 (spec sync, shipping), #506 (Quinn brief), #477 (move gates/), #470 (gap detection), #469 (.pai-work), #342 (doc archival)
5. P2: Remaining SCs — SC-364/365/366 (scaffold), SC-367 (AgentBriefGuard), SC-377/378 (gate contracts)
6. P3: #533 (ADR auto-discover), #526 (skill wrappers), #503 (journal replay), 9 more

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

