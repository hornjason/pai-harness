---
doc-type: research
status: active
owner: jason
updated: 2026-09-24
---

# Claude Code Feature Audit — 2026-09-24

Features available in Claude Code that RunGate isn't using yet, evaluated for harness impact.

## Tier 1: Adopt Now

### SubagentStop Hook
- Fires when any spawned agent completes
- Use: mechanical auditor pattern — auto-grade every agent after completion
- Maps to agent-agnostic concept: "grade agents post-run"
- Enables behavioral feedback loop: agent completes → hook spawns auditor → auditor grades transcript → results feed back to SC tracking

### PostCompact Hook
- Fires after context window compaction
- Use: re-inject critical rules that get lost in long sessions
- Maps to agent-agnostic concept: "rules survive context loss"
- Fixes rule drift in AFK sessions (session 5 finding: procedural rules don't stick)

### TaskCompleted Hook
- Gates task completion — exit code 2 blocks completion
- Use: quality gate before agent marks work done
- Maps to agent-agnostic concept: "quality gate before done"
- Could block agent from completing unless conformity passes

## Tier 2: Adopt Soon

### Routines (research preview)
- Cloud-scheduled tasks: cron, GitHub trigger, API
- Use: post-merge conformity sync, nightly stale-issue audit
- Runs when laptop is closed — replaces unreliable session-end trigger
- GitHub trigger on PR merge → auto-run conformity checks

### FileChanged Hook
- Fires when a file is modified
- Use: auto-run conformity when specs are edited, checkboxes flip immediately
- Maps to agent-agnostic concept: "watch + react"

### Agent Teams (experimental)
- Independent teammates with shared task list, direct messaging
- Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Council pattern becomes native — teammates debate directly
- `TeammateIdle` hook can force re-verification before idle
- Existing `.claude/agents/*.md` definitions work as teammate definitions
- Cost: 3-5x more tokens (each teammate has own context window)
- File structure: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- Display modes: in-process, tmux, iterm2

### Plugin Eval (`claude plugin eval`)
- Test plugins with graded eval suites
- We have one eval (`reads-agents-md`) — could expand to test all agent briefs
- Format is Claude-specific, concept (eval suites for rule compliance) is generic

## Tier 3: Watch

- `/batch` — 5-30 parallel worktree agents (mass SC rewrites)
- `/goal` — work until condition met (convergence tasks)
- Channels — push events from Telegram/iMessage/webhooks (AFK monitoring)
- `subagentPromptCacheTtl: "1h"` — extended cache for teammates
- Cross-session messaging — parallel workflows notify each other
- `/design` — draft editable UI artboards

## Agent-Agnostic Architecture Note

All features above are Claude Code implementation details. RunGate core (specs, SCs, conformity engine) must remain agent-agnostic. The concepts these features enable (post-run grading, rule survival, quality gates, team coordination) should be modeled generically in RunGate specs, with Claude Code as one adapter implementation.
