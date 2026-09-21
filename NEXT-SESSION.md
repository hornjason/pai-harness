---
doc-type: reference
status: active
owner: jason
updated: 2026-09-21
---

# Next Session Brief

**Read this first. Then read PROJECT-STATE.md.**

## Priority: Architecture Refactor (BLOCKING)

Phase 1.5 has 3 SCs remaining but they are BLOCKED on a test architecture refactor. Do NOT merge the pending worktrees or close Phase 1.5 until this refactor lands.

### The Problem

An audit found that 70% of test logic (2,657 lines across phase-0/1/2/3/4/5.test.ts) is hand-wired — SC IDs copy-pasted into describe blocks, assertions hand-coded. These tests bypass the conformity engine (`lib/conformity.ts`), which is the correct deep module that auto-generates tests from spec content.

When you add an SC today:
- Conformity engine auto-discovers it ✅
- Phase tests — nothing happens, human writes test manually ❌  
- Golden fixture — nothing happens, no staleness check ❌

### The Fix

1. **Serena scopes the refactor** — write an ADR in `docs/adr/` covering:
   - How to migrate phase test assertions into `matchPattern()` matchers
   - How phase tests become thin consumers (call `runScaffoldConformity()` filtered by phase)
   - How to add a fixture staleness check (SCs referencing files the fixture doesn't have = red)
   - Migration strategy: incremental (one phase at a time) vs big bang

2. **Marcus executes** — in worktrees, per the delegation matrix

3. **Merge pending worktrees** — AFTER refactor lands:
   - SC-293 (SPEC-TEMPLATE patterns) — worktree exists, committed
   - SC-295 (SC enrichment) — worktree may exist
   - SC-302 (scaffold generates PROJECT-STATE) — worktree exists, committed

4. **Close Phase 1.5** — run `bun scripts/sync-sc-status.ts` then commit

### Key Files

| File | What | Read When |
|------|------|-----------|
| `PROJECT-STATE.md` | Live status dashboard | Always first after this file |
| `project-state.json` | Source of truth for state | Editing state |
| `lib/conformity.ts` | Deep module — matchPattern, runScaffoldConformity | Architecture refactor |
| `test/scaffold-conformity.test.ts` | Ideal thin consumer (9 lines) | Reference for target pattern |
| `test/phase-0.test.ts` | Fat consumer (949 lines) — migration target | Understanding current state |
| `scripts/sync-sc-status.ts` | Flips spec checkboxes from test results | After tests pass |
| `scripts/update-project-state.ts` | JSON→markdown renderer | Pre-commit hook runs this |

### Current Test Results

959 pass, 0 fail, 8 skip, 45 todo.

### Pending: Session Audit Scoping

The auditor report at `docs/research/auditor-report-2026-09-21.md` covers the **full 16-day session** (12,395 tool calls), not just the post-/clear segment. Jason wanted it scoped to only the work after the last `/clear`. The JSONL transcript doesn't have a clean `/clear` marker — need to find a reliable way to identify the boundary (timestamp, line number, or `"type":"mode"` entries) and re-run the audit on just that slice.

This is also the motivation for building `session-audit.ts` (SESSION-AUDIT-SPEC SC-321) — the script should accept `--from-line` or `--after-clear` flags to scope the analysis window.

### New Specs Created This Session

- **SESSION-LIFECYCLE-SPEC** (`specs/SESSION-LIFECYCLE-SPEC.md`) — 12 SCs (SC-309 through SC-320) for mechanical session start/end rituals
- **SESSION-AUDIT-SPEC** (`specs/SESSION-AUDIT-SPEC.md`) — 10 SCs (SC-321 through SC-330) for transcript-based behavioral audit using agnix + RepoRails + auditor agent

### What NOT To Do

- Do NOT write more hand-wired phase tests — that's the pattern we're migrating away from
- Do NOT merge the pending worktrees before the refactor — they'll land into the wrong architecture
- Do NOT start Phase 2 SCs — the infrastructure needs to be right first
- Do NOT edit PROJECT-STATE.md directly — edit project-state.json, the markdown is generated
