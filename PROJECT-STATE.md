# Project State

**Current phase: All phases complete**

Session 20 (2026-09-29/30) — Compliance self-improvement loop built and demonstrated.

Key deliverables:
  - Compliance report system (lib/compliance-report.ts): JSONL trend tracking, per-COMP pass rates, threshold alerts at 70%
  - Auto hill-climb: briefs auto-patched when COMP dimensions fail 3+ consecutive runs
  - Grading pipeline fixed: COMP-7/12 were silently skipped, now always run
  - COMP-7/12 false positive reduction: system paths excluded, offset/limit reads exempt
  - Report noise reduction: DIR-L* collapsed to summary, declining alerts require 3+ data points

4 controlled compliance tests this session — each improved the pipeline:
  Test 1: found piped head violation → updated brief
  Test 2: COMP-7 FOLLOWED (fix worked) → verified
  Test 3: COMP-12 at 67% → refined check (offset/limit exclusion)
  Test 4: found piped tail violation → updated brief, fixed noisy report

Issues shipped (6): #512 (parallel ship), #295 (council decisions), #525 (workflow type), #526 (skill wrappers), #511 (plugin eval), gap scanner hook
Issues closed (31 total, 52→21): Langfuse (#82-86), TELOS (#2), old phases (#40,41,129,130), AgentGrit (#338-341), and more

Pipeline state: first-pass rate 71%. COMP-7 90%→FOLLOWED, COMP-12 81%→50%, COMP-13 48%→FOLLOWED.
Suite: 1790 pass, 0 fail, 108 files. 21 issues remain (mostly DDB/NLM/Control Plane).

Remaining rungate work: #307 doc-hygiene (needs council), #512 Mac Mini integration, #522 GitHub MCP.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: Pipeline pass rate — 71% first-pass. Compliance report + trend tracking + auto hill-climb. Next: ratchet threshold from 70% upward
2. P1: pai-harness#23 Isolated per-issue execution (script shipped, Mac Mini integration remaining)
3. P1: pai-harness#24 Doc-hygiene: content alignment — needs council
4. P2: security-guidance plugin installed — ADOPT decision from #511 evaluation
5. P3: pai-harness#25 GitHub MCP for structured tool calls
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
- #295 shipped: council structured decisions[] + auto-reconcile
- #525 shipped: --type workflow flag for scaffold-project.ts
- #511 shipped: plugin evaluation — security-guidance ADOPTED, 5 others SKIP
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

