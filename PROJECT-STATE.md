# Project State

**Current phase: Phase 1.5 — Context Quality — 2 SCs open**

Phase 0+1 complete. Config-driven testing spec written (SC-331–SC-343). Session audit spec rewritten with 7-section report format and two feedback loops. Global CLAUDE.md tightened (118→91 lines, rules moved to top, Rule 6/7/8 strengthened). AGENTS.md routing expanded, rules deduplicated (8→6). Baseline audit: 55% direct hits, 28 wasted calls. 5 test failures fixed, 4 stale worktrees pruned. 2 worktrees remain (SC-293, SC-302) on hold. Suite: 961 pass, 0 fail.

**Next priorities:**
1. CONFIG-DRIVEN TESTING: Expand matchers to 100% SC coverage, migrate phase tests to thin consumers (CONFIG-DRIVEN-TESTING-SPEC.md, SC-331 through SC-343)
2. Phase A: Audit unmatched SCs, implement 6 new matchers (regex-match, source-contains, json-has-field, scaffold-produces, frontmatter-field, file-line-range)
3. Phase B: Migrate phase-0 to thin consumer (949→≤100 lines)
4. Phase C: Migrate phase-2/3/5 to thin consumers via source-contains matcher
5. Phase D: Golden fixture staleness check + end-to-end verification
6. THEN merge pending worktrees (SC-293, SC-302) into refactored architecture

## ✅ Phase 0 — Scaffold Output (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-1 | CODE-MAP.md exists |
| ✅ | SC-2 | Consumers from scan |
| ✅ | SC-3 | Environment section from rungate.json |
| ✅ | SC-11 | Re-scaffold always regenerates AGENTS.md |
| ✅ | SC-17 | AGENTS.md under 150 lines |
| ✅ | SC-265 | Rules contain Fix all test failures |
| ✅ | SC-266 | Tech stack from package.json |
| ✅ | SC-267 | Rules name specific commands |
| ✅ | SC-272 | Single merged specs table |
| ✅ | SC-274 | contextDocs rejects path traversal |
| ✅ | SC-275 | Governs field escaped, capped 120 chars |
| ✅ | SC-273 | Table bounded by 150-line cap |

## ✅ Phase 1 — Knowledge Extraction + Doc Hygiene (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-270 | Split files under 500 lines |
| ✅ | SC-280 | Split files group under one routing entry |
| ✅ | SC-282 | Directory name from filename |
| ✅ | SC-268 | Governs at spec creation time |
| ✅ | SC-269 | Every spec has governs, WARN if TODO |
| ✅ | SC-271 | Routing table uses intent language |
| ✅ | SC-277 | LLM one-pass generates governs |
| ✅ | SC-278 | split-spec auto-detects files over 500 lines |
| ✅ | SC-279 | Content not matching governs → create new file |
| ✅ | SC-281 | Routing filters to non-obvious mappings only |
| ✅ | SC-283 | Routing and create tables use same categories |
| ✅ | SC-284 | Permanent categories always in AGENTS.md |
| ✅ | SC-285 | WARN when create-category has no directory |

## 🔄 Phase 1.5 — Context Quality (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-286 | resolveAndContain() path validation |
| ✅ | SC-287 | Strict/permissive mode |
| ✅ | SC-288 | content-contains matcher |
| ✅ | SC-289 | content-not-contains matcher |
| ✅ | SC-290 | count-threshold matcher |
| ✅ | SC-291 | json-field-equals matcher |
| ✅ | SC-292 | section-exists matcher |
| ✅ | SC-294 | Directory names validated |
| ⬜ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ⬜ | SC-295 | 10 of ~35 SCs enriched — 25 remaining |

## ⬜ Phase 2–5 (NOT STARTED)

## 🔄 Automation (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ✅ | SC-296 | update-project-state.ts exists, --skip-tests under 2s |
| ✅ | SC-297 | Pre-commit hook calls it and stages result |
| ✅ | SC-298 | Updates date, test counts, SC status |
| ✅ | SC-299 | Phase headers auto-flip |
| ✅ | SC-300 | 150-line cap enforced |
| ✅ | SC-301 | Session log archive, max 3 files |
| ⬜ | SC-302 | Scaffold generates PROJECT-STATE.md for consumers |
| ✅ | SC-303 | Pre-commit blocks new .sh files |
| ✅ | SC-304 | CommitEnforcement detects all agents |
| ✅ | SC-305 | Hook registrations use RUNGATE_HOOKS_DIR |
| ✅ | SC-306 | codeAgent() wrapper in workflows |
| ✅ | SC-307 | SC checkboxes auto-flip from test results |
| ✅ | SC-308 | PROJECT-STATE tables auto-flip from spec status |

---

**Session 2026-09-21:**
- Rebuilt project-state system: JSON source of truth + one-way markdown render (497→97 lines)
- Fixed all 12 pre-existing test failures → 0 fail, 959 pass
- Completed Phase 0 (SC-273, SC-276) and Phase 1 (10 SCs: routing, governs, categories)
- Built SC-307: sync-sc-status.ts auto-flips spec checkboxes from test results
- Built create-spec.ts (SC-268), generate-governs.ts (SC-277), detectOversizedSpecs (SC-278)
- Removed external spec scanning — RunGate self-contained
- All hooks prefixed with bun, DocHygiene patched to skip .claude/agents/
- AUDIT: 70% of tests (2,657 lines) are fat hand-wired phase tests bypassing conformity engine
- DECISION: Architecture refactor before Phase 2 — migrate to config-driven testing
- 3 worktrees pending merge (SC-293, SC-295, SC-302) — hold until refactor lands

**Session 2026-09-20 afternoon:**
- Committed 35+ uncommitted files in 6 logical batches
- CommitEnforcement.hook.ts — broadened to all code agents (8 tests)
- update-project-state.ts rewrite with SC sync
- codeAgent() wrapper — mechanical worktree isolation
- 13 new SCs (SC-296–308)
- D-1: PROJECT-STATE.md is scaffold artifact
- D-2: Pre-commit hook ships as scaffold output

**Session 2026-09-20 morning:**
- Global CLAUDE.md trimmed: 41→15 rules
- Bootstrap spec split into 6 files
- matchPattern extended with 5 new matchers
- Fresh agent navigability: 25→2 tool calls

