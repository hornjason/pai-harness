# Project State

**Current phase: All phases complete**

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
23 issues remain open.
  #508 SHIPPED — closed-loop spec sync. M-size, 1 regression, 21 agents, ~33 min.
  Session 18 final: 18 shipped/closed through pipeline, 15 housekeeping. First-pass: 10/14 (71%).

Retroactive compliance audit (48 runs, 1125 agent transcripts):
  Marcus avg: 8.1/13 (62%). Min 5/13, Max 11/13.
  Top violations (% of runs):
    COMP-7  No cat/head via Bash (use Read)           — 90% ignored
    COMP-12 Grep before Read for non-key files        — 81% ignored
    COMP-9  Total tool calls <= 30                    — 75% ignored
    COMP-8  Read PROJECT-STATE if task needs context   — 65% ignored
    COMP-6  No duplicate file reads                   — 60% ignored
    COMP-13 Write failing test before impl (TDD)      — 48% ignored
    COMP-11 Coding/testing principles available        — 40% ignored
  Action items:
    1. COMP-7/COMP-12 need mechanical enforcement (hook or gate), not brief rules — 90%/81% ignore rate proves brief reinforcement alone fails
    2. COMP-9 tool-call limit may be too tight (75% exceed) — evaluate raising to 40 or enforcing at gate
    3. COMP-13 TDD improved from 60% to 48% violation but needs mechanical pre-check
    4. Run grading on EVERY ship going forward (skipGrade=false)
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: Pipeline pass rate — 71% first-pass (10/14). Keep improving evidence quality and agent reliability
2. P1: #512 Isolated per-issue execution (worktree-based parallel ships) — biggest pipeline scalability win
3. P1: #510 Wire Playwright MCP into Quinn's UI validation — enables real browser testing in prove
4. P1: #507 Prove must capture before/after screenshots to issue — visual proof of changes
5. P1: #307 Doc-hygiene: evolve from format stamping to content alignment
6. P1: Agent consolidation — 17 agents, target <10. Merge overlapping roles
7. P2: #511 Evaluate Anthropic official plugins for PAI workflow
8. P2: #506 Quinn prove brief improvements — input mode and reproduction steps from issue
9. P2: #477 Move gates/ out of ~/.claude/ — eliminates sensitive-file permission prompts
10. P2: #470 Mechanical gap detection — post-ship scanner for product and harness drift
11. P2: #469 Fix .pai-work lifecycle — archive-then-purge replaces file-level TTL
12. P2: #412 Per-project ceremony overrides with protected-checks
13. P2: #342 Doc archival — prune stale docs to reduce context load
14. P2: Remaining SCs — SC-364/365/366 (scaffold identical output, scanner importable, generators testable), SC-367 (AgentBriefGuard <50 lines), SC-377/378 (gate contracts testable, no implicit state)
15. P3: #533 ADR auto-discover, #526 skill wrappers, #525 workflow project type, #522 GitHub MCP, #503 journal replay, #466 AC refresh, #455 worktree security ADR, #418 Wave 10 decisions, #416/#415 gate output, #386 regex precision, #337 /audit skill, #330 L3 compatibility
16. P4: #341 data-driven skill contracts, #340 AgentGrit patterns, #339 perf profiles, #338 telemetry, #312 council frontmatter

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

## ✅ Scaffold Decomposition (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ✅ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ✅ | SC-360 | AGENTS.md generator from ProjectScan |
| ✅ | SC-361 | Brief generator reads template files |
| ✅ | SC-362 | CODE-MAP generator from ProjectScan |
| ✅ | SC-363 | scaffold-project.ts under 200 lines |
| ✅ | SC-364 | Identical output before and after |
| ✅ | SC-365 | Scanner importable without generation |
| ✅ | SC-366 | Generators testable with mock data |

## ✅ Hook Architecture (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-367 | AgentBriefGuard under 50 lines |
| ✅ | SC-368 | lib/brief-validator.ts independently testable |
| ✅ | SC-369 | GateEnforcement under 100 lines |
| ✅ | SC-370 | Every hook traces to an SC |
| ✅ | SC-371 | No hook over 150 lines |
| ✅ | SC-372 | Hook logic in lib/ has unit tests |

## ✅ Gate Contracts (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-373 | Every gate has typed input/output |
| ✅ | SC-374 | Pass/fail criteria documented as SCs |
| ✅ | SC-375 | Gate chain order documented |
| ✅ | SC-376 | run-gate.ts under 400 lines |
| ✅ | SC-377 | Contracts testable by conformity engine |
| ✅ | SC-378 | No implicit state passing |

---

**Session 2026-09-29 session 18:**
- AFK marathon: 18 issues shipped/closed through pipeline, 15 housekeeping closures (shipped-but-open cleanup)
- Pipeline shipped: #540, #590, #542, #596, #535, #598, #515, #532, #527, #583, #531, #529, #530, #599, #419, #508. Already fixed: #597, #600
- First-pass rate: 21%→71% (10/14). Key fixes: grep exit-code-1 evidence (717fc8e0), evidence pre-validation (#598), test baseline diffing (#599)
- RCA: 70% of failures were EVIDENCE_MISSING (Marcus correct 23/29 runs). Root cause was gate-executor dropping grep exit code 1
- Retroactive compliance audit of 48 runs (1125 agent transcripts, 284MB):
-   Marcus avg: 8.1/13 (62%). COMP-7 cat usage 90% ignored, COMP-12 grep-before-read 81%, COMP-9 tool count 75%, COMP-13 TDD 48%
-   Key insight: brief-level rules alone fail at 80-90% rates — need mechanical enforcement (hooks/gates) for COMP-7, COMP-12
-   Action: skipGrade=false for all future runs. Hill-climb Marcus brief using retroactive data
- Suite: 1729 pass, 0 fail, 97 files. 23 issues remain open

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

