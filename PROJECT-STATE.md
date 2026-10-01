# Project State

**Current phase: All phases complete**

Session 23 (2026-10-01) — Compliance grader fix + mechanical enforcement validation.

Key deliverables:
  - COMP-1 grader false negative FIXED: extractPromptContent() now checks all user messages, not just first. Was only reading relay header, missing AGENTS.md injection in task prompt. All 3 baseline runs now pass COMP-1 (was 0/3)
  - BashToolGuard hook VALIDATED: replay with hook active scored 0 cat commands (was 1-11). Hook blocks cat/head/tail at PreToolUse level
  - Issue #26 shipped through full pipeline: Marcus 9/15 (60%). COMP-1 ✅ COMP-13 ✅ (first time!). COMP-7 ❌ (hook not in project settings)
  - SCs created: SC-469 (grader fix, done), SC-470 (--prompt flag), SC-471 (COMP grading), SC-472 (scaffold hook deployment)
  - Course correction: stopped hardcoding, created SCs before implementation, removed replay-prompt.ts (belongs in test-brief.ts per SC-470)

Compliance score trend:
  Bloated baseline:   62% / 69%
  Trimmed baseline:   54% / 69% / 69%
  Re-graded baseline: 77% / 69% / 77% (grader fix alone: +8-15%)
  Replay w/ hook:     85% (grader fix + hook: +16-31%)
  Issue #26 pipeline: 60% (15 checks vs 13, new violations: COMP-6/8/9/11)

Persistent violations needing fast loop iteration:
  COMP-7: Hook not active in pipeline (needs project settings deployment)
  COMP-6: 3 files read multiple times (test-brief.ts 7x)
  COMP-9: 55 tool calls (limit 40)
  COMP-8: PROJECT-STATE not read
  COMP-11: Coding principles not read
  DIR-L29: 5 full suite runs (limit 2)

POV bootstrap session uncovered 4 gaps: #27 spec conversion CLI, #28 extractor misses root files, #29 Drive HTML-to-Doc workaround, #30 post-scaffold auto-organize. All P1-P2.

Previous session 22: Eval-driven brief hill-climbing. 66-run suite, ZERO negative deltas.

Suite: 25/25 SCs done. 8 issues remain (#23-30). #26 SHIPPED.

**Next priorities:**
1. P0: BashToolGuard DEPLOYED to project settings ✅ — run fast loop to validate COMP-7 passes in next pipeline
2. P0: Fast loop iteration on remaining COMPs — COMP-6/8/9/11 failing, Marcus prompt extracted, test-brief --prompt ready (SC-470 done)
3. P0: SC-471 COMP-level grading in fast loop — validate replay produces same grades as pipeline
4. P1: #28 extract-constraints.ts misses root-level markdown — POV bootstrap showed 40 rules invisible to scanner
5. P1: #30 Post-scaffold auto-organize — scaffold creates empty dirs but user has to manually move specs/research/docs into them
6. P1: #27 Spec conversion CLI — convert existing freeform docs (numbered rules, MUST/SHOULD) to RunGate spec format with frontmatter and SCs
7. P1: SC-472 scaffold deploys hooks to consumer settings.local.json — config-driven from rungate.json hooks[].deployToConsumers
8. P2: #24 Doc-hygiene: content alignment — needs council
9. P2: #29 Document Drive API workaround for HTML-to-Doc conversion — Google Workspace MCP doesn't convert HTML
10. P3: #23 Isolated per-issue execution — devcontainer or worktree-based parallel ship runs
11. P3: #25 GitHub MCP server for structured tool calls

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

