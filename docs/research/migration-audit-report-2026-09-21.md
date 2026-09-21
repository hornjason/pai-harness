---
doc-type: research
status: active
owner: jason
updated: 2026-09-21
---

# Migration Audit Report

Phase-by-phase tracking of agent efficiency during CONFIG-DRIVEN-TESTING-SPEC migration (SC-331–SC-347). Each phase audits Marcus's transcript, measures brief effectiveness, and tunes instructions before the next phase.

## Audit Methodology

After each phase:
1. Auditor agent reads Marcus's transcript
2. Grades: direct hits, wasted calls, rule compliance, context efficiency
3. agnix + RepoRails run on agent briefs
4. Findings produce concrete brief edits
5. Next phase runs with improved briefs

## Baseline (pre-migration)

| Metric | Value |
|--------|-------|
| Agent brief size (marcus.md) | 100 lines (down from 772) |
| agnix warnings | 7 (0 errors) |
| RepoRails level | L3 Scoped |
| Prompt delivery | Routing table (24 prompts → on-demand reads) |
| Prior session direct hits | 55% |
| Prior session wasted calls | 28 |

**Scaffold fix applied:** Replaced 19 inlined prompt files (896 lines) with per-agent routing tables. Agent briefs reduced 88% (3,936 → 483 total lines).

## Phase A: SC Classification

Phase A was spec edits done by the DA directly (not Marcus). No transcript to audit.

| Metric | Value | Notes |
|--------|-------|-------|
| SCs rewritten | 9 | Hook-wiring SCs → static content-contains |
| SCs tagged behavioral | 5 | SC-236, SC-242, SC-248, SC-264, SC-318 |
| Reverted rewrites | 2 | SC-303, SC-306 — referenced files don't exist yet |
| New auto-generated tests | +3 | Conformity engine picked up rewritten SCs |
| Test count | 1017 (964 pass, 0 fail) | +3 from baseline |
| Lesson learned | Only rewrite to static when target file exists | Prevents false test failures |

## Phase B: Matcher Expansion

| Metric | Value | Delta vs Baseline |
|--------|-------|-------------------|
| Direct hits | 65% (11/17) | +10% vs 55% baseline |
| Wasted calls | 8 | -20 vs 28 baseline |
| Duration | 17 min | — |
| Tool calls | 42 | — |
| Test count | 1017 (964 pass, 0 fail) | No change (matchers ready, no SCs use patterns yet) |

**Inefficiencies found:**
- Spawned 2 unnecessary subagents for a single-file edit (added overhead + 4 transcript reads)
- Read EngineerContext.md before AGENTS.md (wrong priority order)
- 2 `pwd`/`ls -la` orientation calls (worktree CWD is always project root)
- 5 offset reads of conformity.ts (could be 2 with better offset planning)

**Brief changes applied for Phase C:**
1. Added "Never spawn subagents for single-file tasks" to Never Do
2. Added "Never run pwd/ls -la for orientation — worktree CWD is project root" to Never Do
3. Reinforced "READ AGENTS.md FIRST" in Context section
4. Added Key File Offsets section: `lib/conformity.ts matchPattern() at line 182–550`

## Phase C: Phase 2/3/5/1 Migration

| Metric | Value | Delta vs Phase B |
|--------|-------|-----------------|
| Direct hits | 79% (15/19) | +14% vs Phase B |
| Wasted calls | 3 | -5 vs Phase B (-62%) |
| Duration | 19.6 min (4 files) | 4.9 min/file vs 17 min/file (3.5x faster per file) |
| Tool calls | 40 | -2 vs Phase B |
| Test count | 967 (914 pass, 0 fail) | -50 structural (hand-wired → auto-generated), 0 coverage loss |

**Line reductions:**
- phase-3: 99 → 5 (-95%)
- phase-5: 112 → 78 (-30%)
- phase-2: 620 → 5 (-99%)
- phase-1: 683 → 200 (-71%)
- Total: 1,514 → 288 (-81%)

**All 4 Phase B brief improvements followed:**
- No subagents ✅ (was biggest waste in Phase B)
- No pwd/ls-la ✅
- AGENTS.md first ✅
- Offset reads of conformity.ts (2 reads vs 5 in Phase B) ✅

**Brief changes applied for Phase D:**
1. Note about voice curl failures (agent character overhead — 2 wasted calls)

## Phase D: Phase-0 Migration

| Metric | Value | Delta vs Phase C |
|--------|-------|-----------------|
| Direct hits | 82% (18/22) | +3% vs Phase C |
| Wasted calls | 4 (2 voice curl, 1 ls fixture, 1 redundant test run) | +1 vs Phase C (voice curl overhead) |
| Duration | 11.9 min | -7.7 min vs Phase C (faster despite harder task) |
| Tool calls | 39 | -1 vs Phase C |
| Test count | 966 (913 pass, 0 fail) | -1 structural |

**Phase-0 result:** 949 → 837 lines (-12%). Cross-project boundary (harness specs → scaffold output) limits thin consumer pattern. conformity engine added for in-project SCs, but ~600 lines of cross-project bootstrap verification remain by architectural necessity. SC-332 reworded to reflect this reality.

**Brief compliance:** All improvements held. Only waste source is voice curl (character prompt, not brief).

**No brief changes needed for Phase E** — brief is performing well.

## Phase E: Staleness + Strict Mode

| Metric | Value | Delta vs Phase D |
|--------|-------|-----------------|
| Direct hits | — | — |
| Wasted calls | — | — |
| Duration | — | — |
| Test count | — | — |
| Brief changes | — | — |

## Summary

| Phase | Direct Hits | Wasted Calls | Duration | Brief Changes Made | Improvement |
|-------|------------|-------------|----------|-------------------|-------------|
| Baseline | 55% | 28 | — | Scaffold fix: routing tables replace inlined prompts | — |
| A | n/a (DA) | n/a | — | — | +3 auto-generated tests |
| B | 65% | 8 | 17 min | No subagents, no orientation, offset guidance, AGENTS.md first | +10% hits, -71% waste |
| C | 79% | 3 | 19.6 min (4 files) | Voice curl note | +14% hits, -62% waste, 3.5x faster/file |
| D | 82% | 4 | 11.9 min | None needed | +3% hits, faster despite harder task |
| C | — | — | — | — | — |
| D | — | — | — | — | — |
| E | — | — | — | — | — |
