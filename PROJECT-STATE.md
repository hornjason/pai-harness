# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 14 — AES hill-climb + pipeline optimization + spec alignment.

Hill-climb: AES 32.75 → 87 in 3 dry-run iterations. Key levers: TDD at top of brief, context injection (excerpts not Read steps), conditional context reads, efficiency rules.
Pipeline: Context injection backported to ship.js briefedAgent(). Verify gate cwd fixed (EVIDENCE_CWD). Merge guard added. Redundant test runs eliminated (4-5 → 0-1 full suite). bun test --parallel --no-isolate.
Grading: Aligned to spec COMP-1 through COMP-13. Every rule reports verdict + evidence. Followed AND violated both tracked.
Real ship runs: #590 shipped (compliance 40%), #592 shipped (compliance 70%). Compliance improving but still below 80% target on real tasks.

Baseline AES: 31.5 → Dry-run AES: 87 → Production: ~60-70 (real tasks harder than toy tasks).
Test suite: 1304 pass, 0 fail, 73 files. bun test --parallel --no-isolate = 176s.

Suite: 1304 pass, 0 fail, 73 files. 26/47 SCs done.

**Next priorities:**
1. P0: AES quality gate — verify grading holds in production pipeline
2. P0: Verify gate cwd fix — evidence commands run from worktree, not main
3. P0: Merge guard — block merge on verify FAIL
4. P1: #593 Fast path for XS issues (target <7 min)
5. P1: #590 create-brief CLI (shipped by pipeline, needs verification)
6. P1: #591 SC validation hook
7. P2: #584 Behavioral SC cache
8. P3: Scaffold Decomposition, Hook Architecture, Gate Contracts

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ✅ | SC-295 | SC enrichment — 35 SCs enriched to matchable patterns |

## ✅ Config-Driven Testing — Phases A-H (COMPLETE)

## ✅ Brief Compliance (#558) (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-400 | test-brief CLI |
| ✅ | SC-401 | Directive extractor |
| ✅ | SC-402 | Transcript checker |
| ✅ | SC-403 | Cross-reference report |
| ✅ | SC-404 | Hill climb mode |
| ✅ | SC-405 | All briefs ≥80% |
| ✅ | SC-406 | briefedAgent() context parsing |
| ✅ | SC-407 | Compliance pre-flight gate |
| ✅ | SC-408 | Standard tasks per role |
| ✅ | SC-409 | Behavioral canary |

## ✅ Agent Brief Templates (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-348 | Templates in templates/agent-briefs/ |
| ✅ | SC-349 | Shared rules in _shared.md |
| ✅ | SC-350 | Scaffold reads template files |
| ✅ | SC-351 | All 8 required sections present |
| ✅ | SC-352 | All briefs model: sonnet |
| ✅ | SC-353 | Briefs under 120 lines each |
| ✅ | SC-354 | Edit template → re-scaffold updates brief |
| ✅ | SC-355 | Shared rules in every brief |
| ✅ | SC-356 | Prompt routing generated dynamically |
| ✅ | SC-357 | Template vars match project values |

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter |

## ⬜ AES Quality Gate (NOT STARTED)

## ⬜ Scaffold Decomposition (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ⬜ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ⬜ | SC-360 | AGENTS.md generator from ProjectScan |
| ⬜ | SC-361 | Brief generator reads template files |
| ⬜ | SC-362 | CODE-MAP generator from ProjectScan |
| ⬜ | SC-363 | scaffold-project.ts under 200 lines |
| ⬜ | SC-364 | Identical output before and after |
| ⬜ | SC-365 | Scanner importable without generation |
| ⬜ | SC-366 | Generators testable with mock data |

## ⬜ Hook Architecture (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-367 | AgentBriefGuard under 50 lines |
| ⬜ | SC-368 | lib/brief-validator.ts independently testable |
| ⬜ | SC-369 | GateEnforcement under 100 lines |
| ⬜ | SC-370 | Every hook traces to an SC |
| ⬜ | SC-371 | No hook over 150 lines |
| ⬜ | SC-372 | Hook logic in lib/ has unit tests |

## ⬜ Gate Contracts (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-373 | Every gate has typed input/output |
| ⬜ | SC-374 | Pass/fail criteria documented as SCs |
| ⬜ | SC-375 | Gate chain order documented |
| ⬜ | SC-376 | run-gate.ts under 400 lines |
| ⬜ | SC-377 | Contracts testable by conformity engine |
| ⬜ | SC-378 | No implicit state passing |

---

**Session 2026-09-25 session 14:**
- AES hill-climb: 32.75 → 87 in 3 dry-run iterations (TDD top, context injection, efficiency rules)
- Context injection: Discovery extracts excerpts, briefedAgent() injects inline, Marcus doesn't read reference files
- Grading aligned to spec: COMP-1 through COMP-13, verdict + evidence per rule
- Pipeline bugs fixed: verify cwd (EVIDENCE_CWD), merge guard, ${elapsed} template literal
- Redundant test runs eliminated: 4-5 full suite → 0-1 + targeted
- bun test --parallel --no-isolate: 209s → 176s (0 failures after promptContent fix)
- Ship #590: compliance 40% (4/10), 66 tool calls, 24 min — wrong repo bug found and fixed
- Ship #592: compliance 70% (7/10), 63 tool calls, 81 min — verify cwd bug caused regression loop
- Marcus brief improved: TDD at top, conditional reads, grep-before-read, efficiency rules, STOP warning
- Prompt-aware grader: checks content in prompt, not just file reads (COMP-1, COMP-5, COMP-11)

**Session 2026-09-24 session 13:**
- Ship-and-heal dogfood: #585 shipped (HEALED), #591 shipped (HEALED)
- Grading pipeline shipped: transcript path fix, role filtering, remediation flow
- Violation categorization: quality vs process (SC-465-468)
- analyze-transcript.ts: file efficiency, deliverable ratio, test runs, context growth

**Session 2026-09-23 session 8 (AFK):**
- Prior-branch detection, worktree cleanup, stale TTL hook
- First cross-repo harness run (#1447 on pai-config)

