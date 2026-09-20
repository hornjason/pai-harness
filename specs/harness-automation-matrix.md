---
doc-type: spec
status: active
owner: jason
created: 2026-09-07
updated: 2026-09-07
tracks: "#353"
council: "2026-09-07 — bash vs hooks vs workflows (D-001 through D-009)"
testable: true
governs: Automation strategy — bash scripts vs hooks vs workflows for harness enforcement
---

# Harness v2 Automation Matrix

Living document tracking every step in the ship cycle — what's mechanical, what's behavioral, and the fix plan. Updated each session.

## Ship Cycle Steps

### Chain Entry (goal → ship → prove)

| Step | Current | Issue | Status |
|---|---|---|---|
| Auto-chain: goal artifact → invoke /ship | PostToolUse on Write (AutoChainTrigger.hook.ts) | #352 | **DONE** |
| Auto-chain: ship artifact → invoke /prove | PostToolUse on Write (AutoChainTrigger.hook.ts) | #352 | **DONE** |
| Block /ship without goal-record | skill-runner.sh SUGGEST WARN | #350 | **DONE** |
| Block Marcus spawn without /ship | AgentBriefGuard Bypass 3 fix | #328 | **DONE** |
| Batch chain: /goal on umbrella cascades to children | skill-runner.sh goal pre-phase | #362 | **DONE** |

### Ship SCOPE Phase

| Step | Current | Issue | Status |
|---|---|---|---|
| Initialize workflow-state.json | skill-runner.sh pre-phase for ship | #356 | **DONE** |
| Write .ship-active marker | skill-runner.sh pre-phase for ship | #357 | **DONE** |
| Size the work (XS/S/M/L) | **DA decides** | — | DEFERRED |
| Post DISCOVERY comment | **DA writes** | #358 | **DONE** (auto-post on gate PASS) |

### Ship BUILD Phase

| Step | Current | Issue | Status |
|---|---|---|---|
| Write Marcus brief | **DA writes** | — | BY DESIGN |
| Validate brief (5 fields) | AgentBriefGuard template markers only | #345 | OPEN — council: brief-policies.json |
| Marcus commits changes | MarcusCommitCheck.hook.ts + tripwire signal | #361 | **DONE** |
| Merge worktree branch | **DA runs git merge** | — | DEFERRED |
| Run verify gate after Marcus | AutoVerifyGate nudge | #360 | **DONE** (phase advancement) |

### Ship VERIFY Phase

| Step | Current | Issue | Status |
|---|---|---|---|
| Fill AC verdicts | gate-runner auto-populates from evidenceMethod | #354 | **DONE** |
| Spawn Quinn on UI changes | **DA must remember** | #343 | OPEN — council: FileChanged + tripwire |
| Record environment results | **DA writes** | — | DEFERRED |

### Ship GATE Phase

| Step | Current | Issue | Status |
|---|---|---|---|
| Generate ship-evidence.json | gate-runner auto-generates on PASS | #355 | **DONE** |
| Post completion comment | gate-runner auto-posts on PASS | #358 | **DONE** |
| Add shipped label | gate-runner auto-adds on PASS | #360 | **DONE** |
| Advance phase to DONE | gate-runner advances on all gate PASS | #360 | **DONE** |
| Push to remote | gate-runner auto-pushes on ship PASS | #374 | **DONE** |

### Prove Phase

| Step | Current | Issue | Status |
|---|---|---|---|
| Compute verdict mechanically | skill-runner.sh post-phase counts FAILs | #344 | **DONE** |
| Post proof comment | skill-runner.sh post-phase | — | **DONE** |
| Close issue (chain mode) | skill-runner.sh prove post-phase auto-closes on PROVEN | #373 | **DONE** |

## Automation Score

- **Total steps in ship cycle:** 33 (expanded with D-016–D-020 checks)
- **Mechanical (DONE):** 28 (85%)
- **By design (DA's job):** 1 (3%)
- **Behavioral (OPEN):** 1 (3%)
- **Deferred:** 3 (9%)

**Target:** 80%+ mechanical. Session start: 30%. Prior session: 75%. QC session: 82%. Current: **85%** ✅ target exceeded.

**QC session (2026-09-07/08) added:** D-019 ceremony tier (#397), D-017 HMAC provenance (#398), D-018 chain advancement (#399), D-020 decision-ID tracing (#400), D-016 evidence classification (#401). Plus 8 infrastructure fixes (Wave 8).

## Waves (Implementation Plan)

### Wave 1: Foundation (COMPLETE — this session)

| Issue | What | Commit | Status |
|---|---|---|---|
| #328 | Engineer spawn gate fix | ccd8d43d | **Proven** ✅ |
| #350 | Auto-chain trigger | 5f127abb | **Proven** ✅ |
| #352 | Unified work dir + auto-chain on Write | e4551ab7 | **Proven** ✅ |

### Wave 2: Gate-Runner Automation (COMPLETE — this session)

| Issue | What | Commit | Status |
|---|---|---|---|
| #354 | AC verdicts auto-populated | b38a98f6 | **Proven** ✅ |
| #355 | ship-evidence.json auto-generated | b38a98f6 | **Proven** ✅ |
| #360 | Phase advancement + shipped label | b38a98f6 | **Proven** ✅ |
| #356 | workflow-state.json auto-initialized | a4549427 | **Proven** ✅ |
| #357 | .ship-active auto-written | a4549427 | **Proven** ✅ |
| #358 | Completion comment auto-posted | 8aa829e5 | **Proven** ✅ |
| #344 | Prove verdict mechanical | 8aa829e5 | **Proven** ✅ |

### Wave 3: Architecture (COMPLETE)

**Pattern:** Tripwire — hooks detect + write signals, bash reads + enforces (D-005)

| Issue | What | Commit | Status |
|---|---|---|---|
| #361 | Marcus commit enforcement | (prior session) | **Proven** ✅ |
| #343 | Quinn auto-spawn on UI changes | (prior session) | **Proven** ✅ |
| #345 | Brief content validation | (prior session) | **Proven** ✅ |
| D-006 | Split gate-runner.sh | Moved to Wave 4 (#376) | **Proven** ✅ |

### Wave 4: Chain Orchestration (umbrella #375)

| Issue | What | Commit | Status |
|---|---|---|---|
| #373 | Auto-close issue on PROVEN | (prior session) | **Proven** ✅ |
| #329 | Evidence commands in issue body | 01244560 | **Proven** ✅ |
| #374 | Auto-push on ship gate PASS | 73e2ad40 | **Proven** ✅ |
| #376 | Split gate-runner.sh into modules | d28ff318 | **Proven** ✅ |
| #362 | Batch chain mode | 43f2993f | **Proven** ✅ |

### Wave 5: Shared Lib Extraction (umbrella #369)

| Issue | What | Commit | Status |
|---|---|---|---|
| #372 | Path constants (BASE_DIR/WORK_DIR) | 4fe21eab | **Proven** ✅ |
| #371 | Agent detection (Marcus/Quinn/Rook) | 32e7ad2d | **Proven** ✅ |
| #368 | Slug resolution | ff830082 | **Proven** ✅ |
| #370 | Stdin JSON parsing (34 hooks) | 1cb2fe68 | **Proven** ✅ |

### Wave 6: Gate Architecture

| Issue | What | Mechanism | Effort |
|---|---|---|---|
| #308 | Registry-based universal gating | 136fc1d1 | **Proven** ✅ |
| #377 | Scope gate: validate SCs follow spec principles | e37f8925 | **Proven** ✅ |
| #366 | Completion comment evidence format | gate-runner SC table | XS |
| #331 | chain-state.json for resume | 29513c78 | **Proven** ✅ |
| #334 | Chain YAML skip-list for sizing | Superseded by ceremony-profiles + #331 | **Closed** (wontfix) |
| #336 | Council signal after STANDARD+ ships | Already in skill-runner.sh:1005 | **Closed** ✅ |
| #378 | Fix code-pushed circular dependency in pre-push | 7844db37 | **Proven** ✅ |
| #307 | Doc-hygiene: format stamping → content alignment | Global, project-agnostic | M |
| #379 | Extract spec-alignment patterns to spec-policies.json | 07093bb7 | **Proven** ✅ |
| #380 | Post-ship drift audit: verify impl follows spec decisions | 98b9f144 | **Proven** ✅ |
| #381 | Pre-push uses stale gate results from prior issues | 20f3a7ce | **Proven** ✅ |
| #382 | Data-driven agent detection config | 00d56ee0 | **Proven** ✅ |
| #384 | Prove coverage count + cached issueSCs (D-010, D-011) | Coverage check before auto-close | S |
| #385 | Expand batch mode scope checks (D-012) | a411ed10 | **Proven** ✅ |

### Wave 7: Precision + Promotion (data-gated)

| Issue | What | Decision | Effort |
|---|---|---|---|
| #386 | Improve acs-no-skillmd-enforcement regex precision | D-013 | S |
| — | WARN→FAIL promotion (after D-013 validates) | D-014 | XS (gated) |
| — | Evidence-target-alignment (if D-010 data insufficient) | D-015 | M (gated) |

### Wave 8: Gaps from QC Session (2026-09-07)

| Issue | What | Severity | Effort |
|---|---|---|---|
| #390 | .ship-active markers never cleaned after prove/close | eec3c723 | **Fixed** ✅ |
| #391 | SecurityValidator blocks JSON config writes to hooks/lib/ | c5f5528f | **Fixed** ✅ |
| #392 | gate-checks.sh line 313 syntax error on scope gate | Fixed by #379 refactor | **Closed** ✅ |
| #387 | ac-populate.sh crashes under set -e pre-BUILD | 7e5470a2 | **Fixed** ✅ |
| #388 | Pre-push symlink broken for resolve-slug.sh | 7e5470a2 | **Fixed** ✅ |
| #389 | Goal skill missing decomposed label on umbrellas | 7e5470a2 | **Fixed** ✅ |
| #393 | Pre-push validates against wrong issue's .ship-active | 9d0bb23c — commit-message resolution | **Fixed** ✅ |
| #394 | AgentBriefGuard error message references stale path | cbf80eaf | **Fixed** ✅ |

### Wave 9: Council Decisions (D-016 through D-020)

| Issue | What | Decision | Status |
|---|---|---|---|
| #397 | Default STANDARD + mechanical tier computation + one-way ratchet | D-019 | **Proven** ✅ |
| #398 | HMAC provenance on gate PASS — blocks fake workflow-states | D-017 | **Proven** ✅ |
| #399 | Chain advancement via successors in skill-registry.json | D-018 | **Proven** ✅ |
| #400 | Decision-ID tracing + evidence-target validation in gate checks | D-020 | **Proven** ✅ |
| #401 | Evidence-type classification (pattern/unit/behavioral) + ratio check | D-016 | **Proven** ✅ |

### Deferred

| Issue | What | Priority |
|---|---|---|
| #310 | Research workflows vs bash | p2 (council decided hybrid) |
| #330 | L3 cross-skill compatibility | p3 |
| #295 | Council structured decisions | p2 |
| #281 | Framework repo extraction | p3 |
| #337 | /audit skill implementation | p3 |
| #338-341 | AgentGrit integration | p4 |
| #312 | Council frontmatter protection | p4 |
| #342 | Doc archival: prune stale docs from DOCS.md/INDEX.md | p2 |

## Council Decisions (2026-09-07)

| ID | Decision | Status |
|---|---|---|
| D-001 | #361 via SubagentStop hook + tripwire signal | **SHIPPED** (#361) |
| D-002 | #343 via FileChanged hook + tripwire signal | **SHIPPED** (#343) |
| D-003 | #345 via brief-policies.json in AgentBriefGuard | **SHIPPED** (#345) |
| D-004 | #362 via sequential Skill + chain-state.json | **SHIPPED** (#362) |
| D-005 | **Tripwire pattern**: hooks detect, bash enforces | ACCEPTED (architectural — no issue) |
| D-006 | **Split gate-runner.sh** into 4 modules + orchestrator | **SHIPPED** (#376) |
| D-007 | GitHub posting stays as module, not hook | ACCEPTED (architectural — no issue) |
| D-008 | Migrate verdict threshold logic to TS | DEFERRED |
| D-009 | Full bash-to-TS migration | REJECTED |
| D-010 | **prove-coverage-count**: compare GoalRecord SC count vs criteriaResults count before auto-close | **SHIPPED** (#384) |
| D-011 | **Cache issueSCs** in goal-record.json at goal time | **SHIPPED** (#384) |
| D-012 | **Batch mode scope expansion**: add acs-no-skillmd-enforcement + acs-no-behavioral-language | **SHIPPED** (#385) |
| D-013 | **Improve acs-no-skillmd-enforcement regex**: distinguish enforcement vs documentation refs | ACCEPTED (Wave 7, #386) |
| D-014 | **WARN→FAIL promotion**: conditional on D-013 precision >80% over 10+ ship cycles | CONDITIONAL (data-gated) |
| D-015 | **Defer evidence-target-alignment**: monitor D-010 coverage data first | DEFERRED |
| D-016 | **SC evidence classification**: `evidenceType` enum (pattern/unit/behavioral). STANDARD+ WARNs if >50% pattern | **SHIPPED** (#401, 29019fc8) |
| D-017 | **Gate result provenance via HMAC**: gate-runner computes hash, IssueCloseGuard validates. Blocks fake PASS | **SHIPPED** (#398, b51ac2b1) |
| D-018 | **Chain advancement in orchestrator**: skill-runner.sh drives chain (not Write-tool hook). AutoChainTrigger as fallback | **SHIPPED** (#399, 1a81cf4e) |
| D-019 | **Ceremony tier mechanical computation**: Default STANDARD. Compute from AC+file count. One-way ratchet | **SHIPPED** (#397, b9df31b4) |
| D-020 | **Structural spec alignment via decision-ID tracing**: SCs cite spec decision IDs. Gate validates IDs exist in spec | **SHIPPED** (#400, cb991c4f) |

### Council Decisions (2026-09-08 — QC systemic + viability)

| ID | Decision | Priority | Status |
|---|---|---|---|
| D-021 | **Gate-salt rotation**: gitignore, generate per-machine, chmod 600 | Wave 1 (security) | ACCEPTED |
| D-022 | **IssueCloseGuard v1 removal** + silent catch-block signal-writing | Wave 1 (security) | ACCEPTED |
| D-023 | **safe_grep wrapper** + inherit_errexit + shellcheck | Wave 1 (security) | ACCEPTED |
| D-024 | **AgentBriefGuard marker validation** with diagnostic catches | Wave 1 (security) | ACCEPTED |
| D-025 | **Pre-push verify-only** + commit-prefix fast-path (solves Gap #19 + circular dep) | Wave 2 (infra) | ACCEPTED |
| D-026 | **Per-project ceremony overrides** with protected-checks | Wave 2 (infra) | ACCEPTED |
| D-027 | **HOTFIX bypass hardening**: rate-limit, format validation, GitHub logging | Wave 2 (infra) | ACCEPTED |
| D-028 | **jq_update extraction** to scripts/lib/jq-update.sh | Wave 2 (infra) | ACCEPTED |
| D-029 | **Gate output grouping** with per-category rollups (EVIDENCE/BUILD/ENV/SPEC) | Wave 3 (UX) | ACCEPTED |
| D-030 | **D-008 amendment** — second TS extraction trigger | Wave 3 (governance) | ACCEPTED |
| D-031 | **Pre-push path resolution** for cross-project symlinks | Wave 3 (infra) | ACCEPTED |
| D-032 | **Spec #378 contradiction** cleanup (OPEN→Proven) | Wave 3 (hygiene) | **SHIPPED** (#417) |

### Council Decisions (2026-09-08 — mechanical learning loop)

| ID | Decision | Status |
|---|---|---|
| D-033 | **No new gaps.jsonl** — use existing harness-telemetry.jsonl + gate-runs.jsonl | ACCEPTED (unanimous) |
| D-034 | **Enrich emit()** with gap_type field in gate-runner.sh (3 lines) | ACCEPTED |
| D-035 | **Hybrid filing**: prompted in interactive, auto-file in AFK (capped at 5/cycle) | ACCEPTED |
| D-036 | **Session-end gap summary** with progressive disclosure, not a new skill | ACCEPTED |
| D-037 | **Self-modification firewall**: no automated path from gap data to gate enforcement | ACCEPTED (unanimous) |
| D-038 | **Deprecate feedback_emit()**: dead code in skill-runner.sh:76, zero call sites | ACCEPTED |
| D-039 | **AgentGrit reads, PAI emits**: PAI thin (5 lines/skill), AgentGrit thick (patterns, correlation) | ACCEPTED (per CLAUDE.md rule) |

### Infrastructure Fixes (discovered during Wave 3)

| Issue | What | Fix | Status |
|---|---|---|---|
| #363 | evidence-type-valid crashes on string evidence | `select(type == "object")` guard | **DONE** |
| #364 | Gate-runner hangs (recursive QC → gate-runner loop) | `GATE_RUNNER_ACTIVE` env guard + tsc-pass tsconfig check | **DONE** |
| #365 | Prod checks FAIL for non-containerized projects | `check_skip()` detects null `prod.rebuild` | **DONE** |
| #367 | Pre-push nested slug resolution | `${path#${WORK_DIR}/}` preserves relative path | **DONE** |

## Key Architectural Decisions

1. **Unified work dir:** All hooks read from RUNGATE_WORK_DIR (~/.rungate/). MEMORY/WORK is legacy. (#352)
2. **Auto-chain on Write:** PostToolUse on Write detects artifact creation. (#352)
3. **Data-driven enforcement:** skill-registry.json + enforcement-policies.json. Adding enforcement = adding JSON, not code. (#306)
4. **SKILL.md is docs-only:** Skills run on runner + gates, not on instructions. (#349)
5. **Tripwire pattern:** Hooks own detection (thin tripwires writing signals). Bash owns enforcement (reads signals, gates). (Council D-005)
6. **TS migration threshold:** When a bash function needs >2 jq pipes with conditional field access, extract that function to TS. Not whole files. (Council D-008/D-009)
7. **Deep modules, thin consumers:** Shared logic lives in `scripts/lib/` (bash) and `hooks/lib/` (TS). Consumers source the lib and call one function. If a pattern appears in 2+ files, extract to a lib. Prevents duplicate-fix bugs like #367 (slug resolution fixed 4 times). Audit: #369.
8. **Spec-alignment at scope gate:** SCs must target scripts/hooks/gates for enforcement, never SKILL.md (docs-only). Behavioral language ("DA should", "remember to") in SCs triggers WARN — mechanical enforcement required. #377.
9. **WARN→data→FAIL ladder:** New checks ship as WARN. Run 10+ ship cycles. Measure false positive rate. Promote to FAIL only if precision >80%. Document promotion decision with data. (Council 2026-09-07)
10. **Prove coverage count:** Prove must verify criteriaResults count matches GoalRecord SC count before auto-close. WARN on mismatch — prevents closing with incomplete proof. (Council D-010, #384)
11. **Cache issue SCs at goal time:** GoalRecord stores `issueSCs[]` extracted from issue body at creation. Prove reads cache — no API call at prove time. (Council D-011, #384)

## Verification Gaps (Council 2026-09-07)

| Gap | Description | Fix | Issue |
|---|---|---|---|
| A | No cross-check between GoalRecord SCs and issue body SCs | D-010 + D-011 | #384 |
| B | Evidence command scope not validated against assertion text | D-015 (deferred, monitor D-010) | — |
| C | LIGHT tier skips scope gate entirely | By design (XS ceremony) | — |
| D | Prove gate checks verdict but not criteria completeness | D-010 | #384 |
| F | Auto-close fires on PROVEN without coverage check | D-010 | #384 |
| G | Batch mode scope checks limited to acs-measurable only | D-012 | new issue |

## Shared Lib Extraction Plan (#369 audit, 2026-09-07)

| Priority | Pattern | Sites | Target Lib |
|---|---|---|---|
| HIGH | Stdin JSON parsing | 27 hooks | `hooks/lib/parseStdin.ts` |
| HIGH | Agent detection | 2+ | `hooks/lib/agentDetection.ts` |
| HIGH | Path construction | 4+ | `hooks/lib/paths.ts` |
| MEDIUM | Issue extraction | 1 outlier | Fix import in AutoChainTrigger |
| MEDIUM | Atomic write | 2 | `hooks/lib/atomicWrite.ts` |
| MEDIUM | Signal write | 2+ | `hooks/lib/signals.ts` |
| MEDIUM | Telemetry append | 3 | `scripts/lib/telemetry.sh` |
| MEDIUM | Slug resolution | 4 (fixed) | `scripts/lib/resolve-slug.sh` (#368) |

## Hook Events (21 available, using 8)

| Event | Hooks | New Uses (council-approved) |
|---|---|---|
| PreToolUse | 13 | #345: brief-policies.json validation |
| PostToolUse | 10 | Auto-chain on Write (done) |
| PostToolBatch | 0 | Future: stronger nudge pattern |
| Stop | 4 | — |
| SessionStart | 7 | — |
| SessionEnd | 11 | — |
| UserPromptSubmit | 5 | — |
| **SubagentStop** | **0** | **#361: Marcus commit check + tripwire** |
| **FileChanged** | **0** | **#343: UI file detection + tripwire** |
| Others (12) | 0 | Not planned |
