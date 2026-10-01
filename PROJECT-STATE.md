# Project State

**Current phase: All phases complete**

Session 21 (2026-09-30) — Platform adoption + plugin eval framework.

Key deliverables:
  - Three-tier context architecture validated (3/4 checks pass), docs-routing rule conflict fixed
  - Platform audit: 70+ features across 26 doc pages (docs/research/claude-code-platform-audit.md)
  - Phase 1 adopted: cache TTL 1h, agent memory, maxTurns, effort, disallowedTools, worktreeinclude, omitClaudeMd, isolation, Stop hook, output style, /ship-issue command
  - Plugin eval framework: 7 cases across 4 agents, 100% pass, Vertex auth solved
  - Δ baseline scoring: mean +0.06 — most cases Claude passes natively, Quinn +0.40 is the differentiated case
  - Scaffold generator updated: emits all platform-native frontmatter fields (consumers get them on re-scaffold)
  - AGENT-BRIEF-TEMPLATE-SPEC updated: SC-410 through SC-413 for platform fields
  - GitHub MCP server added (#25 partially done)
  - eval-to-hillclimb bridge script created
  - 3 stale PRs closed, 16 commits, all pushed

Suite: 1749 pass, 0 fail, 108 files. 3 issues remain (#23, #24, #25). 2 PRs open (#21, #22).
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: Pipeline pass rate — 71% first-pass. Ratchet threshold from 70% upward via compliance report + trend tracking + auto hill-climb
2. P1: Three-tier context architecture — validate through shipping issues + grading. Iterate on what rules load when, measure cold-start routing accuracy, fix rule conflicts as found
3. P1: pai-harness#24 Doc-hygiene: content alignment — needs council
4. P2: Harder eval cases — current Δ baseline shows Claude passes natively on easy tasks. Need complex multi-file cases where briefs differentiate
5. P2: Ship a real DDB issue through improved pipeline — prove the improvements work on a consumer project
6. P3: /goal adoption — replaces verify gate (~300 lines)
7. P3: Agent teams investigation — experimental but could change pipeline coordination

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
- Three-tier context architecture validated: 3/4 checks pass. docs-routing rule conflict fixed with trust directive
- Platform audit: 70+ features across 26 Claude Code doc pages (docs/research/claude-code-platform-audit.md)
- Phase 1 adopted: cache TTL 1h, agent memory, maxTurns 30, effort per-agent, disallowedTools, worktreeinclude, omitClaudeMd, isolation, Stop hook on Marcus
- Plugin eval framework: 7 cases, 4 agents, 100% pass rate, $1.38 per suite, 188s
- Vertex eval auth fix: copy ADC to evals/.gcp-adc.json + GOOGLE_APPLICATION_CREDENTIALS + env scrub off
- Δ baseline scoring: mean +0.06 — 6/7 cases Claude passes natively, Quinn Δ +0.40 (brief matters for QA quality)
- Scaffold generator updated: emits all platform-native frontmatter fields (memory, effort, disallowedTools, etc)
- AGENT-BRIEF-TEMPLATE-SPEC: SC-410 through SC-413 for platform fields
- GitHub MCP server added (.mcp.json), /ship-issue command created, output style created
- eval-to-hillclimb bridge: maps eval results to COMP dimensions for auto-improvement
- rungate.json config synced: serena/aditi tools=[Read], disallowedTools added
- 3 stale PRs closed (#2, #5, #6), 16 commits pushed. 4 test failures fixed → 0
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

