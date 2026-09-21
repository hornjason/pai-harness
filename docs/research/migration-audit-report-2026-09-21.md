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

| Metric | Value | Delta vs Baseline |
|--------|-------|-------------------|
| Direct hits | — | — |
| Wasted calls | — | — |
| Duration | — | — |
| Test count | — | — |
| Brief changes | — | — |

## Phase B: Matcher Expansion

| Metric | Value | Delta vs Phase A |
|--------|-------|-----------------|
| Direct hits | — | — |
| Wasted calls | — | — |
| Duration | — | — |
| Test count | — | — |
| Brief changes | — | — |

## Phase C: Phase 2/3/5/1 Migration

| Metric | Value | Delta vs Phase B |
|--------|-------|-----------------|
| Direct hits | — | — |
| Wasted calls | — | — |
| Duration | — | — |
| Test count | — | — |
| Brief changes | — | — |

## Phase D: Phase-0 Migration

| Metric | Value | Delta vs Phase C |
|--------|-------|-----------------|
| Direct hits | — | — |
| Wasted calls | — | — |
| Duration | — | — |
| Test count | — | — |
| Brief changes | — | — |

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
| A | — | — | — | — | — |
| B | — | — | — | — | — |
| C | — | — | — | — | — |
| D | — | — | — | — | — |
| E | — | — | — | — | — |
