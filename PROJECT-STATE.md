# Project State

**Current phase: All phases complete**

Session 27 (2026-10-04/05) — Pipeline optimization shipped, then deep audit found 8 systemic issues.

Key results:
  - #47 pipeline optimization: ceremony agents eliminated, precompute-goal.ts, ceremony caching
  - #41 SHIPPED via optimized pipeline (17 agents/20 min, first-pass)
  - #42 SHIP_FAILED 2x: root cause = Discovery invents test filenames Marcus doesn't create (unwinnable ACs)
  - Pipeline audit found: env-defaults redundant (170s), commit runs tests (431s), ac-completion-check duplicates verify, git add -A unsafe, hill-climb dead code
  - #53 created: pipeline hardening (fix evidence paths, delete dead agents, safety guards)
  - permissions.deny reduced COMP-7 cat usage 80% but not eliminated in worktrees
  - DDB #1450 still OPEN — CI still failing, not yet tested

Pipeline trend:
  #41: 17 agents/20min SHIPPED (optimized, first-pass)
  #42 attempt 1: 27 agents/57min SHIP_FAILED (evidence corruption)
  #42 attempt 2: 19 agents/34min SHIP_FAILED (ceremony caching worked, Marcus researched instead of implementing)

Suite: 1880+ pass, 0 fail.

Next: #53 pipeline hardening → DDB #1450 CI fix → #23 Mac Mini isolation.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #53 Pipeline hardening — fix evidence paths, eliminate dead agents, add safety guards (BLOCKS all shipping)
2. P1: DDB #1450 — Fix CI checks on Mac Mini runner (5 failures, still OPEN, CI still red)
3. P1: #23 Isolated execution on Mac Mini — research devcontainer vs worktree, enable laptop-off AFK runs
4. P2: #45 BashToolGuard in worktrees — permissions.deny reduced cat 80% but not eliminated
5. P2: #43 acHash integrity — code written (writeWorkflowState recompute), needs pipeline proof
6. DONE: #47 Pipeline optimization — ceremony agents eliminated, ~50% pre-Marcus speedup
7. DONE: #41 Scaffold: detect and migrate specs — SHIPPED via pipeline session 27
8. DONE: #42 Scaffold auto-fix — code merged but SHIP_FAILED 2x (evidence path mismatch, tracked in #53)

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

**Session 2026-10-04 session 27:**
- #47 pipeline optimization COMPLETE: all 5 phases shipped (sub-issues #48-#52)
- Phase 1: Goal determinism — read-issue agent replaced with gh CLI pre-computation, preflight agents batched
- Phase 2: Context preloading — preloadedContexts arg skips preload-contexts agent, <0.4s vs ~3 min
- Phase 3: Implement ceremony — brief-preflight + brief-assemble batched to 1 agent, extract-context replaced with inline require('fs')
- Phase 4: Scope ceremony — prior branch detection moved to precompute script, ac-prevalidation simplified
- Phase 5: Validation dry-run — 2 agents / 193s for Goal→Scope (was ~7 agents / 5-8 min)
- precompute-goal.ts script: extracts issue data, SSH pre-flights, brief contexts, prior branches deterministically
- Security fix: SSH pre-flight uses execFileSync with arg arrays (no shell injection)
- transcript-checker.ts: fixed 4 unguarded data.promptContent accesses (optional chaining)
- ship skill updated: documents pre-computation step + new args
- DDB #1450 UNBLOCKED — pipeline optimization was the blocker
- Suite: 1880+ pass, 0 fail. 6 commits pushed

**Session 2026-10-04 session 26:**
- COMP-13 grader false positive fixed: N/A for NO_TESTS/NO_SOURCE (was IGNORED). COMP-8 injection check added
- Retroactive re-grade: 28/50 runs corrected, avg 57.7% → 69.8%. 8 new grader tests
- Consumer gate bugs: 8 fixes — dev config flattening, env defaults, acHash WARN, dev-server liveness, remote pre-flight
- DDB re-scaffolded with latest harness. conformity: test.skip for no specs, HYGIENE-10 WARN, AGENT-11 dynamic cap
- DDB #1452 shipped pipeline (consumer gate bugs found). DDB #1450 stopped — pipeline optimization first
- Pipeline optimization P0: user directive 'I wouldn't start shipping issues until we had this worked out'
- #47 created: 5-phase plan, 19 SCs — replace ceremony agents with deterministic bash
- Issues created: #39 (grader fix), #40 (compliance), #41-#46 (scaffold/gate/CI), #47 (pipeline opt)
- Compliance: context injection (PROJECT-STATE.md, coding-principles.md), COMP-7/COMP-6 reinforcement rules
- Suite: 1866+ pass, 0 fail. 8 commits pushed

**Session 2026-10-02 session 25:**
- #31 CLOSED: all 14 SCs done. SC-484/SC-485 implemented (scaffold directory generation + monolith split)
- Ship workflow ran for #31: Discovery, Marcus (worktree), Verify, Grade — 27 agents, 77 min
- Hill-climb loop validated: BashToolGuard blocked cat, TestSuiteGuard blocked at 6/2, compliance grading ran
- 9 phase-0 test failures fixed: golden fixture tests updated for .claude/rungate/config.json
- Helper functions (loadHarnessConfig, injectEnvironmentSection) now check directory before monolith
- Discovery AC threshold bug fixed: grep -c + contains mismatch auto-normalized to >= 1 in ship.js
- Scaffold generates briefs+config for ALL project types (was code-only, POV was type:infra)
- Repo config corrected: issueRepo from hornjason/pai-config to hornjason/pai-harness
- Suite: 1779 pass, 0 fail, 111 files. 7 commits pushed

