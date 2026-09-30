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
1. P0: Pipeline pass rate — 71% first-pass. Compliance report + trend tracking now ships after every issue. COMP-7/12/13 verified improved. Next: ratchet threshold from 70% upward as scores improve
2. P1: #512 Isolated per-issue execution (worktree-based parallel ships) — biggest pipeline scalability win
3. P1: #307 Doc-hygiene: evolve from format stamping to content alignment — needs council
4. P2: security-guidance plugin installed — ADOPT decision from #511 evaluation
5. P3: #525 workflow project type, #522 GitHub MCP, #418 Wave 10 decisions
6. P4: #341 data-driven skill contracts, #340 AgentGrit patterns, #339 perf profiles, #338 telemetry

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

**Session 2026-09-29 session 20:**
- Grading pipeline overhaul: COMP-7/12 were silently skipped (only ran as fallback). Fixed to always run mechanical COMP checks
- Directive extractor: bold-prefixed **NEVER lines now parsed, 'Efficiency Rules' section matched via includes('rules')
- COMP-7/12 false positives: excluded system paths (/tmp/claude-*), own-file reads, task output files
- Compliance report system (lib/compliance-report.ts): JSONL history, per-COMP trend lines, threshold alerts, formatted output
- Wired into ship.js: report displayed after every issue with 70% threshold, declining-trend detection, improvement alerts
- Compliance test verified: COMP-7 90%→FOLLOWED, COMP-12 81%→33%, COMP-13 48%→FOLLOWED. Agent score 10/19→13/19
- Marcus brief updated: piped head explicitly banned for COMP-7
- 18 stale issues closed (52→36 open): #386, #337, #330, #415, #82-86, #2, #29, #40, #41, #129, #130, #206, #300, #312, #225, #455, #526
- Created /bootstrap and /spec skill wrappers (#526)
- Auto hill-climb: brief-fixable COMPs (7,12,13,6,9,2) auto-patched after 3+ consecutive fails
- #512 shipped: parallel-ship.ts with worktree isolation, port allocation, container naming
- #295 in progress: council structured decisions output (Marcus agent running)
- Gap scanner wired into session-start hook (StaleTTLCleanup.hook.ts)
- 21 stale issues closed (52→32): Langfuse (#82-86), TELOS (#2), old phases (#40,41,129,130), and more
- Suite: 1769 pass, 0 fail, 105 files

**Session 2026-09-29 session 19:**
- AFK batch: 4 issues shipped (#601, #602, #469, #470), 3 phases closed
- 19 SCs verified — 13 already satisfied by existing tests, 6 needed new work
- SC-364: scaffold idempotency test + fixed non-deterministic scanner. Caught Marcus when:kf.pattern bug
- SC-367: AgentBriefGuard 64→38 lines. Signal constants moved to lib module
- #469: archive-then-purge replaces file-level TTL. Directory-level lifecycle for .rungate
- #470: gap scanner (lib/gap-scanner.ts) with 6 drift checks, 12 tests. Gate integration follow-up
- Fixed RatingCapture hook timeout (30s→60s)
- Cleaned 32 stale worktrees (171MB), 126 stale branches
- Suite: 1729 pass, 0 fail, 100 files. 27 issues remain open

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

