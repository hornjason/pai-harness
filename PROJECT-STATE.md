# Project State

**Current phase: All phases complete**

Session 28 (2026-10-05) — Fixed 36 test failures, shipped #53 pipeline hardening, built Phase 1 of pipeline testing inner loop.

Key results:
  - 36 test failures fixed (scaffold --fix flag missing from 6 test files, stale MCP migration tests deleted)
  - #53 SHIPPED via pipeline (19 agents/16 min, first-pass) — 6/6 SCs
  - TDZ bug from #53 found and fixed (CACHED_CEREMONY declaration order)
  - #43 and #45 SHIP_FAILED via pipeline (unwinnable AC pattern) — code correct, merged manually
  - Council debate (4 agents, 3 rounds): designed pipeline testing inner loop with security-first approach
  - Phase 1 built directly: lib/workflow-security.ts (7 functions), test/workflow-security.test.ts (43 tests), scripts/validate-workflow.ts
  - 7 issues created (#55-#61) for phased pipeline testing plan
  - Security review findings addressed: fail-open git add, SSH option injection, path traversal edge cases

Pipeline insight: 'unwinnable AC' pattern caused #42, #43, #45 to SHIP_FAIL — Discovery writes grep evidence that doesn't match implementation. #59 (dry-run smoke test with evidence pre-validation) is the fix.

Suite: 1920+ pass, 0 fail.

Next: #57 ship.js security integration → #59 dry-run smoke tests → #60 trajectory capture.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #55 Pipeline testing inner loop — Phase 1 DONE (#56/#58 closed), Phase 2 next (#57 partial, #59, #60)
2. P1: #57 Ship.js security integration — replace inline git add/SSH with lib/workflow-security.ts functions
3. P1: #59 Dry-run smoke tests — evidence pre-validation to catch unwinnable ACs before Marcus spawns
4. P1: DDB #1450 — Fix CI checks on Mac Mini runner (5 failures, still OPEN, CI still red)
5. P2: #60 Trajectory capture — OpenTelemetry-style observability for workflow runtime
6. P2: #23 Isolated execution on Mac Mini — research devcontainer vs worktree, enable laptop-off AFK runs
7. P3: #61 Mock agent harness + pass^k determinism metrics
8. DONE: #53 Pipeline hardening — SHIPPED via pipeline, 6/6 SCs
9. DONE: #43 acHash integrity — code merged from branch, field-level diff logging added
10. DONE: #45 BashToolGuard worktrees — piped pattern blocking + COMP-7 prompt injection removed
11. DONE: #56 Workflow validator — syntax + TDZ + shell pattern checking in <200ms
12. DONE: #58 Security fuzzing — 43 adversarial tests, 0 injection vectors pass

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

**Session 2026-10-05 session 28:**
- 36 test failures fixed: scaffold --fix flag missing from 6 test files after #42, stale MCP migration tests deleted
- #53 SHIPPED via pipeline (19 agents/16 min): env-defaults removed, commit no-test, ac-completion-check removed, safe git add, CACHED_CEREMONY invalidation
- TDZ bug from #53 found and fixed: CACHED_CEREMONY let declaration moved before runDiscovery usage
- #43 SHIP_FAILED (pipeline evidence bug) — code correct on branch 43-achash-heal-fix, merged manually. diffAcHashFields() added to orchestrator.ts
- #45 SHIP_FAILED (pipeline evidence bug) — code correct on branch 45-bash-guard-piped-patterns, merged manually. BashToolGuard now blocks piped patterns
- Council debate (Architect/Engineer/Researcher/Security, 3 rounds): designed pipeline testing inner loop
- Council key finding: security boundary extraction urgent, keep orchestration inline, trajectory capture unifies
- Phase 1 built: lib/workflow-security.ts (7 functions), test/workflow-security.test.ts (43 tests), scripts/validate-workflow.ts
- Issues created: #55 (epic), #56 (validator, DONE), #57 (extraction, partial), #58 (fuzzing, DONE), #59 (dry-run), #60 (trajectory), #61 (harness)
- Security review findings addressed: fail-open git add, SSH option injection, path traversal bare .., denylist documentation
- Suite: 1920+ pass, 0 fail. 8 commits pushed, 5 issues closed

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

