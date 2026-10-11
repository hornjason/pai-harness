---
doc-type: reference
status: active
owner: jason
updated: 2026-10-11
---

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
| PROJECT-STATE.md | Live status + handoff (generated from project-state.json — don't edit directly) | Session start, always first after AGENTS.md |
| project-state.json | Source of truth for project status — **DA-owned, never written from an agent worktree** (#296) | Reading current state |
| .claude/rungate/ | Harness project config (directory) | Shipping through harness |
| package.json | Dependencies and scripts | Adding deps or scripts |
| tsconfig.json | TypeScript configuration | Changing TS settings |
| lib/ | Lib directory | Working on lib |
| gates/ | Gates directory | Working on gates |
| workflows/ | Workflows directory | Working on workflows |
| hooks/ | Hooks directory | Working on hooks |

| `CODE-MAP.md` | Auto-generated codebase map | Understanding codebase structure |
