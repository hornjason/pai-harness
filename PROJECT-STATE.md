# Project State

**Current phase: All phases complete**

Session 21 (2026-09-30) — Three-tier architecture validation + platform audit.

Key deliverables:
  - Three-tier context architecture validated (3/4 checks pass): scoped rules, agent brief dedup, prompt routing all working
  - Root cause: docs-routing rule conflict with verify-before-asserting — fixed with trust directive
  - 4 test failures fixed: stale spec hashes, scaffold section expectations, agent fixture transcripts
  - transcript-checker.ts: added never-patterns for implementation code + build/test/deploy
  - Comprehensive platform audit: 70+ features across 26 Claude Code doc pages
  - Key finding: plugin evals could replace ~1700 lines of compliance grading code
  - 3 stale PRs closed (#2, #5, #6), 2 remaining (#21, #22) reviewed
  - Priorities updated: dropped shipped items, added three-tier context + platform adoption

Suite: 1749 pass, 0 fail, 108 files. 3 issues remain (#23, #24, #25). 2 PRs open (#21, #22).
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: Pipeline pass rate — 71% first-pass. Ratchet threshold from 70% upward via compliance report + trend tracking + auto hill-climb
2. P1: Three-tier context architecture — validate through shipping issues + grading. Iterate on what rules load when, measure cold-start routing accuracy, fix rule conflicts as found
3. P1: pai-harness#24 Doc-hygiene: content alignment — needs council
4. P2: pai-harness#25 GitHub MCP for structured tool calls

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

**Session 2026-09-30 session 21:**
- Three-tier context architecture validated: 3/4 checks pass (scoped rules, brief dedup, prompt routing)
- Check 1 fail diagnosed: docs-routing vs verify-before-asserting rule conflict. Fixed with trust directive
- 4 test failures fixed: stale BOOTSTRAP-DATA-FLOW-SPEC hash, scaffold section expectations, serena/aditi fixtures
- transcript-checker.ts: added never-patterns for implementation code writes + build/test/deploy commands
- Comprehensive Claude Code platform audit: 70+ features across 26 doc pages (docs/research/claude-code-platform-audit.md)
- Top findings: plugin evals (replaces ~1700 lines compliance code), agent memory, .worktreeinclude, Stop hooks, /goal, cache TTL
- 3 stale PRs closed (#2, #5, #6). 2 remaining (#21 feature parity, #22 spec sync) reviewed
- Priorities updated: dropped shipped/closed items, added three-tier context + platform adoption
- Suite: 1749 pass, 0 fail, 108 files. 3 issues remain (#23, #24, #25)

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

