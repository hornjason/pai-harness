# Project State

**Current phase: All phases complete**

Session 26 (2026-10-04) — Pipeline optimization prioritized. Consumer gate bugs fixed. Grader accuracy improved.

Key decisions:
  - User: 'I wouldn't start shipping issues until we had this worked out' — pipeline optimization is P0
  - DDB #1450 ON HOLD until #47 pipeline optimization completes
  - #47 created: phased plan with 19 SCs, 5 phases, measurable success criteria per phase

Session 26 work:
  - COMP-13 grader false positive fixed: N/A for NO_TESTS/NO_SOURCE (was IGNORED)
  - COMP-8 grader false positive fixed: added promptContent injection check
  - Retroactive re-grade: 28/50 runs affected, avg 57.7% → 69.8%
  - 8 consumer gate bugs found and fixed (dev config flattening, env defaults, acHash, dev-server liveness)
  - Remote host pre-flight added to ship pipeline
  - DDB re-scaffolded with latest harness changes
  - 8 new issues created (#39-#46)

Pipeline trend:
  Rungate: #35 17 agents/15min, #36 17 agents/18min (first-pass)
  DDB: #1452 26-36 agents/34min (consumer gate bugs), #1450 stopped (pipeline optimization)

Suite: 1866+ pass, 0 fail.

Next: #47 — replace ceremony agents with deterministic bash. Then #23 Mac Mini isolation.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #47 Pipeline optimization — replace LLM ceremony agents with deterministic bash (BLOCKING all issue shipping)
2. P1: #23 Isolated execution on Mac Mini — research devcontainer vs worktree, enable laptop-off AFK runs
3. P2: #45 BashToolGuard in worktrees (COMP-7 persistent gap)
4. P2: #43 acHash integrity root cause investigation
5. P3: #41 Scaffold: detect and migrate specs from docs/specs/ to specs/
6. HOLD: DDB #1450 — blocked on #47 pipeline optimization
7. DONE: #39 Fix grader false positives (COMP-13 + COMP-8)
8. DONE: #40 Compliance improvements (context injection + reinforcement + grader accuracy gate)

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

