---
doc-type: spec
status: draft
owner: TODO
created: 2026-09-22
updated: 2026-09-22
governs: TODO — describe what this spec governs
testable: false
---

# Project State

**Current phase: Phase 1.5 — Context Quality — 2 SCs open**

Config-driven testing migration complete (Phases A-E). 19 matchers in conformity engine. Phase tests migrated to thin consumers (2,463→1,125 lines). Scaffold fixed: prompt inlining→routing tables (briefs 3,936→483 lines). All template improvements baked into scaffold template. Suite: 984 tests, 931 pass, 0 fail. Ship workflow dogfood: fixed process.env crash, fixed agentType crash (workflows can't resolve project-local agents), added config-driven role→brief mapping in rungate.json, built transcript auditor (scripts/audit-transcript.ts), created discovery.md agent brief.

**Next priorities:**
1. AGENT-BRIEF-TEMPLATE-SPEC (SC-348–SC-357): Externalize agent brief templates to markdown files with ${VAR} placeholders
2. SCAFFOLD-DECOMPOSITION-SPEC (SC-358–SC-366): Split scaffold-project.ts (1,844→200 lines). Depends on template spec
3. HOOK-ARCHITECTURE-SPEC (SC-367–SC-372): Extract AgentBriefGuard (586→50 lines). Can parallel with scaffold decomp
4. GATE-CONTRACTS-SPEC (SC-373–SC-378): Typed contracts for all gates. Audit-first, then code
5. Merge pending worktrees (SC-293, SC-302) — refactor has landed, safe to merge
6. Close Phase 1.5 — SC-293 and SC-295 still open

## ⬜ Phase 0+1 — Scaffold + Knowledge Extraction (NOT STARTED)

## ⬜ Phase 1.5 — Context Quality (NOT STARTED)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ⬜ | SC-295 | SC enrichment — 25 remaining |

## ⬜ Config-Driven Testing (Architecture Refactor) (NOT STARTED)

## 🔄 Agent Brief Templates (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-348 | Templates in templates/agent-briefs/ |
| ⬜ | SC-349 | Shared rules in _shared.md |
| ⬜ | SC-350 | Scaffold reads template files |
| ⬜ | SC-351 | All 8 required sections present |
| ✅ | SC-352 | All briefs model: sonnet |
| ✅ | SC-353 | Briefs under 120 lines each |
| ⬜ | SC-354 | Edit template → re-scaffold updates brief |
| ✅ | SC-355 | Shared rules in every brief |
| ✅ | SC-356 | Prompt routing generated dynamically |
| ⬜ | SC-357 | Template vars match project values |

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

**Session 2026-09-22 session 4:**
- Ship workflow dogfood: 3 bugs found (process.env, agentType, unnamed discovery)
- Config-driven roles: rungate.json roles{} maps role→brief+isolation
- Transcript auditor: scripts/audit-transcript.ts grades agent behavior
- Discovery agent: created .claude/agents/discovery.md brief
- ship.js/prove.js: codeAgent→briefedAgent, reads briefs from config not agentType
- Ship skill updated to pass roles from rungate.json

**Session 2026-09-21 session 3:**
- Council reviewed CONFIG-DRIVEN-TESTING-SPEC (3 rounds), revised spec
- Executed Phases A-E: SC classification, 6 matchers, test migration, staleness check
- Scaffold fixed: prompt inlining → routing tables (briefs -88%)
- Audit hill climb: 55%→82% direct hits, 28→3 wasted calls
- Template improvements baked into scaffold template (model:sonnet, no subagents, AGENTS.md first)
- Post-migration audit: 3 foundational specs written (scaffold decomp, hooks, gates)
- AGENT-BRIEF-TEMPLATE-SPEC written (externalize templates from TypeScript)

