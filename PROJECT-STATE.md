# Project State

**Current phase: Scaffold Decomposition — 9 SCs open**

Session 14 — AES hill-climb + pipeline optimization + agent count reduction.

Hill-climb: AES 32→87 in 3 dry-run iterations. Production compliance: 83% (10/12).
Pipeline: 32 agents/141 min → 16 agents/20 min. Prove regression eliminated. Bash agents batched.
Grading: Aligned to spec COMP-1 through COMP-13. Every rule reports verdict + evidence.
Context injection: Discovery extracts excerpts, briefedAgent() injects inline.

Remaining bottleneck: 16 agents × 75s overhead = 20 min. Target: 6 agents × 75s = ~7.5 min.
Ship gate fails on ceremony checks (B1/B2/evidence-type-ratio) that shouldn't apply to LIGHT.
5 issues shipped through pipeline: #590, #592, #584, #594, #595.

Suite: 1304 pass, 0 fail, 73 files. 4/25 SCs done.

**Next priorities:**
1. P0: Fix gates before shipping — every issue takes 2 runs because gates fail on untested LIGHT paths
2. P0: Gate integration tests for LIGHT/XS path — exercise verify/ship/prove gates with mock state
3. P0: 6-agent refactor — collapse 16 agents to 6 for <5 min XS pipeline
4. P1: #593 Fast path for XS issues (mechanically blocked until 6-agent refactor)
5. P1: Close gap between dry-run AES (87) and production (~70)
6. P2: Canary tests (spec requirement, not implemented)
7. P3: Scaffold Decomposition, Hook Architecture, Gate Contracts

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
- AES hill-climb: 32→87 in 3 dry-run iterations (TDD top, context injection, efficiency rules)
- Pipeline optimization: 32 agents/141 min → 16 agents/20 min
- Prove regression eliminated: LIGHT skips prove, no re-implementation loop
- Agent batching: init+prior-branch, ac-prevalidation+prior-branch, brief-preflight+assemble, commit+env-check+record, merge+push, finalize (4→1)
- Grading aligned to COMP-1 through COMP-13 with verdict + evidence
- Context injection working: COMP-1/COMP-5/COMP-11 pass via prompt injection
- Verify gate cwd fixed (EVIDENCE_CWD), merge guard added
- bun test --parallel --no-isolate (209→176s), redundant test runs eliminated
- 5 issues shipped: #590 (40%), #592 (70%), #584 (67%), #594 (83%), #595 (83%)
- Ship gate false positives: B1/B2/evidence-type-ratio checks fire on LIGHT (should be exempt)
- Deep adversarial audit: 26/32 agents were bash wrappers, prove was 42% of runtime

**Session 2026-09-24 session 13:**
- Ship-and-heal dogfood: #585 shipped (HEALED), #591 shipped (HEALED)
- Grading pipeline shipped: transcript path fix, role filtering, remediation flow
- Violation categorization: quality vs process (SC-465-468)
- analyze-transcript.ts: file efficiency, deliverable ratio, test runs, context growth

