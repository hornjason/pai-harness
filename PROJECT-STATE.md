---
doc-type: state
status: active
owner: jason
updated: 2026-09-20
---

# Project State

Living checklist aligned to the bootstrap workflow. Updated by DA as work completes.

**Current phase: Phase 1 — 10 routing SCs still open. Phase 1.5 matchers built but Phase 1 gates it.**

**Next session priorities:**
1. Review and commit 35+ uncommitted files from this session
2. Always spawn Marcus with `isolation: "worktree"` — activates existing MarcusCommitCheck.hook.ts
3. Finish Phase 1 routing SCs (SC-268, 269, 271, 277-279, 281, 283-285)
4. Re-scaffold RunGate + fresh agent test after Phase 1 complete
5. Build PROJECT-STATE.md auto-update hook (pre-commit, reads test results)
6. Add worktree isolation + commit enforcement to AGENTS.md template — downstream consumers get these rules baked in via scaffold

**Session 2026-09-20 summary:**
- Global CLAUDE.md trimmed: 41 rules → 15 (research-backed, under sigmoid threshold)
- Rule 7 updated: worktree isolation required for all code agents
- Marcus brief updated: commit is mandatory final step
- MarcusCommitCheck.hook.ts already exists — wasn't firing because no worktree isolation
- Two councils ran (routing design + SC-driven testing) — saved to docs/council/
- Bootstrap spec split into 6 files via split-spec command (mechanical, idempotent)
- matchPattern extended with 5 new matchers + security fix (13 tests passing)
- Full spec audit: 85 discrepancies found and partially fixed (51 DDB items removed)
- Orchestrator research: nobody runs long-lived stateful orchestrators — restart is the pattern
- Fresh agent navigability: 25 tool calls → 2 tool calls (100% direct-hit)

**Uncommitted files:** 35+ across scaffold, split-spec, specs, tests, docs, hooks

---

## ✅ Phase 0 — Scaffold Output (COMPLETE — validating after split)

Scaffold generates correct files with correct content.

| Status | SC | What |
|---|---|---|
| ✅ | SC-1 | CODE-MAP.md exists |
| ✅ | SC-2 | Consumers from scan |
| ✅ | SC-3 | Environment section from rungate.json |
| ✅ | SC-11 | Re-scaffold always regenerates AGENTS.md |
| ✅ | SC-17 | AGENTS.md under 150 lines (140) |
| ✅ | SC-265 | Rules contain "Fix all test failures" |
| ✅ | SC-266 | Tech stack from package.json |
| ✅ | SC-267 | Rules name specific commands |
| ✅ | SC-272 | Single merged specs table |
| ✅ | SC-274 | contextDocs rejects path traversal |
| ✅ | SC-275 | Governs field escaped, capped 120 chars |
| ⬜ | SC-273 | Table bounded by 150-line cap (cap removed, needs test) |
| ⬜ | SC-276 | contextDocs boundary documented |

**Tests:** 145 pass, 0 fail, 5 todo → revalidating after spec split

**Tests:** 950 pass, 1 fail (meta-coverage expected), 87 todo. Verified.

---

## 🔄 Phase 1 — Knowledge Extraction + Doc Hygiene (IN PROGRESS)

Content is accurate, files are right-sized, routing works.

### Spec Audit + Cleanup
| Status | What |
|---|---|
| ✅ | Full audit — 85 discrepancies found |
| ✅ | DDB cleanup — 51 items removed from 5 specs |
| ✅ | Audit documented: docs/research/spec-audit-2026-09-20.md |

### File Splitting
| Status | What |
|---|---|
| ✅ | split-spec command built (scripts/split-spec.ts) |
| ✅ | 29 unit tests passing (TDD red→green) |
| ✅ | Grouping logic — combines sections under 500 lines |
| ✅ | Bootstrap spec → 6 files in specs/bootstrap-data-flow/ |
| ✅ | SC-282: Directory name from filename |
| ✅ | SC-270: All split files under 500 lines |
| ✅ | SC-280: Split files group under one routing entry |

### Routing + Templates
| Status | SC | What |
|---|---|---|
| ⬜ | SC-268 | Governs at spec creation time, deterministic |
| ⬜ | SC-269 | Every spec has governs, WARN if TODO |
| ⬜ | SC-271 | Routing table uses intent language |
| ⬜ | SC-277 | LLM one-pass generates governs for new files |
| ⬜ | SC-278 | split-spec auto-detects files over 500 lines |
| ⬜ | SC-279 | Content not matching governs → create new file |
| ⬜ | SC-281 | Routing filters to non-obvious mappings only |
| ⬜ | SC-283 | Routing and create tables use same categories |
| ⬜ | SC-284 | Permanent categories always in AGENTS.md |
| ⬜ | SC-285 | WARN when create-category has no directory |

**Tests:** 28 pass, 0 fail → revalidating after split

---

## ⬜ Phase 1.5 — Context Quality (BLOCKED — Phase 1 not complete)

**Cannot start until Phase 1 Routing + Templates SCs are done.** Marcus is working on matchers in parallel, but Phase 1.5 is not "NEXT" — Phase 1 is still IN PROGRESS with 10 open SCs.

Specs self-test via matchPattern. Adding a structural check = one SC line, no test file.

| Status | SC | What |
|---|---|---|
| ✅ | SC-286 | resolveAndContain() path validation |
| ✅ | SC-287 | Strict/permissive mode — unmatched SCs FAIL in strict, WARN in permissive |
| ✅ | SC-288 | content-contains matcher [bracket-list] |
| ✅ | SC-289 | content-not-contains matcher |
| ✅ | SC-290 | count-threshold matcher (under [N] lines) |
| ✅ | SC-291 | json-field-equals matcher |
| ✅ | SC-292 | section-exists matcher |
| ⬜ | SC-293 | SPEC-TEMPLATE updated with matchable patterns |
| ✅ | SC-294 | Directory names validated by deriveDirectoryName |
| 🔄 | SC-295 | 10 of ~35 SCs enriched — 25 remaining |

**Council decision:** Extend matchPattern, don't replace. 60/40 split (auto/agent-written). No LLM, no YAML sidecars. See docs/council/2026-09-20-sc-driven-testing.md.

---

## ⬜ Phase 2 — Gate Enforcement (NOT STARTED)
## ⬜ Phase 3 — Parallel Work (NOT STARTED)
## ⬜ Phase 4 — Knowledge Mining (NOT STARTED)
## ⬜ Phase 5 — Instruction Compliance (NOT STARTED)

---

## Live Tracking

### In Progress Now
| Track | Who | Status |
|---|---|---|
| ~~11 test failures~~ | Marcus | ✅ Done — verified |
| ~~matchPattern extension~~ | Marcus | ✅ 8/10 SCs done. SC-293 + SC-295 remaining |
| **Phase 1 routing SCs (10 open)** | Next session | **PRIORITY** |
| PROJECT-STATE.md enforcement hook | Backlog | Build after Phase 1 |
| ~~Agent commit enforcement hook~~ | Solved | `MarcusCommitCheck.hook.ts` already exists — just needed worktree isolation. Rule 7 in global CLAUDE.md now requires it. |

### Fresh Agent Navigability Scores
| Run | Tool calls | Direct-hit | Wasted reads |
|---|---|---|---|
| Before fixes | 25 | 40% | 12 |
| After first fix | 6 | 75% | 2 |
| After table merge | 2 | 100% | 0 |
| After split (pending) | — | — | — |

### Session Artifacts
| Type | File |
|---|---|
| Council: routing | docs/council/2026-09-20-routing-table-design.md |
| Council: testing | docs/council/2026-09-20-sc-driven-testing.md |
| Research: splitting | docs/research/doc-splitting-tools.md |
| Research: audit | docs/research/spec-audit-2026-09-20.md |
| Decisions D-1–D-13 | specs/AGENTS-MD-TEMPLATE-SPEC.md |
