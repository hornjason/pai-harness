---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Session start and end rituals — cold-start context loading, session-end state capture, handoff brief generation
testable: true
compliance: strict
---

# Session Lifecycle

## Problem

Every AI session starts cold — no memory of what happened last time. Context lives in conversation, which evaporates on /clear. Today's workaround is manual: update PROJECT-STATE.md, write a handoff brief, commit. This is error-prone and gets skipped. When it's skipped, the next session wastes time re-deriving state, makes wrong assumptions, or repeats work.

RunGate consumer projects need a mechanical session lifecycle that captures state at session end and loads it at session start — without relying on memory, conversation history, or the human remembering to do it.

## Design Constraints

- Must work for cold-start agents with zero prior context
- Must be repo-resident (not in memory, not in conversation)
- AGENTS.md is always auto-loaded — that's the only guaranteed entry point
- Must not depend on the architecture refactor (but should benefit from it once landed)
- Session-end must handle: uncommitted work, stale worktrees, test failures, state sync
- Session-start must handle: reading priorities, understanding blockers, knowing what NOT to do

## Session End Flow

```
session-end.ts
  1. Check for uncommitted changes → WARN or auto-commit
  2. Check for stale worktrees → list pending merges
  3. Run sync-sc-status.ts → flip spec checkboxes
  4. Run update-project-state.ts → regenerate state
  5. Append session notes to project-state.json sessions[]
  6. Add antipatterns to project-state.json if any identified
  7. Commit all state files
  8. Print summary
```

## Session Start Flow

```
Agent loads AGENTS.md (automatic)
  → Key Files table directs to PROJECT-STATE.md
  → PROJECT-STATE.md gives priorities, blockers, phase status, SC checklist, antipatterns
  → Agent has full context without reading conversation history
```

## Success Criteria

- [ ] SC-309: scripts/session-end.ts exists
- [ ] SC-310: scripts/session-end.ts contains [uncommitted changes, warns]
- [ ] SC-311: scripts/session-end.ts contains [stale worktrees, lists]
- [ ] SC-312: scripts/session-end.ts contains [sync-sc-status]
- [ ] SC-313: scripts/session-end.ts contains [update-project-state]
- [ ] SC-314: session-end updates project-state.json with current priorities and antipatterns (behavioral)
- [ ] SC-315: session-end appends session notes to project-state.json sessions array (behavioral)
- [ ] SC-316: session-end commits all state files in one commit (behavioral)
- [x] SC-317: AGENTS.md contains [PROJECT-STATE.md]
- [ ] SC-318: Cold-start agent finds PROJECT-STATE.md within first 3 tool calls (behavioral)
- [ ] SC-319: scaffold output scripts/session-end.ts exists
- [ ] SC-320: PROJECT-STATE.md has section [Antipatterns]

## Blocked On

Architecture refactor — this spec should land AFTER the test architecture is fixed. It adds new scripts and tests that should flow through the conformity engine, not be hand-wired.
