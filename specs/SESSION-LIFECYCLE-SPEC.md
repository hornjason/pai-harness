---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Session start and end rituals — cold-start context loading, session-end state capture, handoff brief generation
testable: true
compliance: permissive
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
  5. Generate/update NEXT-SESSION.md:
     - Current phase and open SCs
     - Priorities (from project-state.json)
     - Blockers and decisions made this session
     - Pending worktrees
     - What NOT to do
  6. Prompt for session notes → append to project-state.json sessions[]
  7. Commit all state files
  8. Print summary
```

## Session Start Flow

```
Agent loads AGENTS.md (automatic)
  → Key Files table directs to NEXT-SESSION.md
  → NEXT-SESSION.md gives priorities, blockers, don'ts
  → PROJECT-STATE.md gives phase status and SC checklist
  → Agent has full context without reading conversation history
```

## Success Criteria

- [ ] SC-309: session-end.ts script exists and runs without errors
- [ ] SC-310: session-end checks for uncommitted changes and warns
- [ ] SC-311: session-end checks for stale worktrees and lists them
- [ ] SC-312: session-end runs sync-sc-status.ts automatically
- [ ] SC-313: session-end runs update-project-state.ts automatically
- [ ] SC-314: session-end generates NEXT-SESSION.md with current priorities and blockers
- [ ] SC-315: session-end appends session notes to project-state.json sessions array
- [ ] SC-316: session-end commits all state files in one commit
- [ ] SC-317: AGENTS.md Key Files table includes NEXT-SESSION.md
- [ ] SC-318: Cold-start agent finds NEXT-SESSION.md within first 3 tool calls
- [ ] SC-319: Scaffold output includes session-end.ts for consumer projects
- [ ] SC-320: NEXT-SESSION.md includes "What NOT to do" section

## Blocked On

Architecture refactor — this spec should land AFTER the test architecture is fixed. It adds new scripts and tests that should flow through the conformity engine, not be hand-wired.
