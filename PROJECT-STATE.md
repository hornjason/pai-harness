# Project State

**Current phase: All phases complete**

Session 24 (2026-10-02) — AFK batch + config architecture + POV validation.

Key deliverables:
  - 5 issues closed: #26 (already shipped), #27 (convert-spec CLI), #28 (root scanning), #30 (auto-organize), #31 Phase 1+2 (12/14 SCs)
  - #31: .claude/rungate/ directory with config.json, roles.json, hooks.json, compliance.json. Config loader with fallback. Hill-climb reads from config.
  - organize-project: now handles .html/.pdf via config, scans external sources (MEMORY/RESEARCH), symlinks external dirs
  - POV project fully organized: 7 files moved/symlinked, POV-SPEC.md converted to RunGate format (43 SCs), rungate.json + agent briefs created
  - TestSuiteGuard hook (SC-473): Tier 3 for DIR-L29. Hill-climb DIR→COMP mapping fixed.
  - create-spec.ts now includes compliance:strict
  - Stale PRs #21, #22 closed

POV validation:
  organize-project: 7 proposals (HTML, PDF, MD, research vault) — all applied correctly
  convert-spec: 43 SCs extracted from POV-SPEC.md, zero duplicates
  extract-constraints: 46 candidates from root + specs

Gap found: scaffold only generates briefs/config for projectType=code, not infra. POV was type:infra → no briefs.

Next P0: worktree hook propagation + auto-rerun after escalation (closes the hill-climb loop).
Suite: 1786 pass, 0 fail.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: Worktree hook propagation — briefedAgent() copies hooks to worktree settings before spawn (~20 lines in ship.js)
2. P0: Auto-rerun after escalation — grade → patch brief → re-test → compare → commit if improved (~50 lines in ship.js)
3. P1: Scaffold generates briefs+config for all project types (not just code) — POV was type:infra, skipped briefs
4. P1: #31 SC-484/485 — scaffold generates .claude/rungate/ directory, re-scaffold splits monolith
5. P2: #24 Doc-hygiene: content alignment — needs council
6. P3: #25 Use GitHub MCP server instead of gh CLI in ship workflow
7. P3: #23 Isolated per-issue execution — worktree-based parallel ship runs

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

**Session 2026-10-02 session 24:**
- AFK batch: 4 issues closed (#26, #27, #28, #30), all P0/P1 priorities cleared
- #26 ALREADY_SHIPPED: SC-470/471/472 all implemented in prior sessions. Specs marked done, issue closed
- #28 SHIPPED via pipeline: Marcus 12/15 (80%). Root-level .md scanning + numbered bold rule pattern added to extract-constraints.ts
- #27 SHIP_FAILED then fixed directly: convert-spec.ts dedup bug (trailing punctuation in seenTexts keys). 10 tests, CLI registered in AGENTS.md
- #30 SHIPPED via pipeline: Marcus 11/15 (73%). organize-project.ts with classification heuristics, --apply mode, docs-routing update
- TestSuiteGuard hook (SC-473): Tier 3 enforcement for DIR-L29. Blocks full bun test after 2 runs. 100% violation rate across 6 prior runs
- Hill-climb escalation bug FOUND AND FIXED: detectHillClimbNeeds only tracked COMP-* IDs, DIR-L* violations silently fell through. Added DIR→COMP mapping
- Alert filter also fixed: was skipping DIR-L violations entirely (line 134: !compId.startsWith('COMP-') → continue)
- Pre-flight: fixed 3 test failures (duplicate SC-472 across specs, HELP-SPEC.md stub missing compliance:strict, behavioral SC count)
- #31 created: directory-based rungate config + self-describing compliance policy (.claude/rungate/ replaces monolith)
- Compliance scores this session: Marcus 73-80%, Discovery 50-67%. Persistent: COMP-7 (worktree hook gap), DIR-L29 (now mechanically enforced)
- Suite: 1745+ pass, 0 fail across session. 8 commits pushed

**Session 2026-10-01 session 23:**
- COMP-1 grader false negative FIXED: extractPromptContent() was only checking first user message (relay header), missing AGENTS.md injection in second message (task prompt). All 3 baseline runs now FOLLOWED. 2 tests added
- BashToolGuard hook VALIDATED: replay with hook scored 0 cat commands (baseline: 1-11 per run). Tier 3 mechanical enforcement works
- Issue #26 shipped through pipeline: Marcus 9/15 (60%). COMP-1 ✅, COMP-13 ✅ (TDD passed first time!). COMP-7 ❌ (hook in rungate.json but not project settings)
- SCs created: SC-469 (grader fix, done), SC-470 (test-brief --prompt flag), SC-471 (COMP-level grading in fast loop), SC-472 (scaffold hook deployment to consumers)
- Course correction: user flagged non-spec-driven work. Removed replay-prompt.ts (belongs in test-brief per SC-400/470). Created SCs before further implementation
- DDB-1344 re-graded with fixed grader: 77%/69%/77% (was 69%/54%/69% — +8-15% from grader fix alone)
- Replay validated end-to-end: 85% with grader fix + BashToolGuard (vs 74% baseline avg)
- Project state updated, issue #26 created for SC-470/471/472 implementation

**Session 2026-09-30 session 22:**
- Eval-driven brief hill-climbing: 66-run suite, ZERO negative deltas, 82% pass rate
- Marcus brief trimmed 35%: reversed marcus-tdd-vs-speed from Δ -0.67 to Δ +0.22
- Quinn brief restructured: Core Rule first. Δ improved from -0.50 to 0.00
- Three-tier promotion: BashToolGuard hook, AGENTS.md injection in briefedAgent(), detectHillClimbNeeds() promotes at 5+ fails
- Ship.js duplicated rules removed (30+ lines hardcoded in 3 Marcus prompts)
- Ship workflow rule deployed to all consumers via scaffold (ship-workflow.md)
- DDB-1344 shipped through pipeline: Marcus 62%/69% compliance. Persistent: COMP-1, COMP-7

