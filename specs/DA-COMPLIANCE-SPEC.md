---
doc-type: spec
status: draft
owner: jason
created: 2026-09-22
updated: 2026-09-22
governs: DA and agent compliance auditing — criteria, transcript grading, rule refresh, eval loop
testable: yes
---

# DA & Agent Compliance

## Problem Statement

CLAUDE.md procedural rules don't enforce behavior (proved across 4 tests). Behavioral rules work, procedural rules don't. Agents load ~985 lines of context before starting work — rules compete with reference data. No formal eval criteria exist to grade whether agents follow their briefs during real work.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | Eval criteria derived from briefs, not invented separately | Brief IS the spec. If it's not in the brief, don't grade it. If it should be graded, add it to the brief. |
| D-2 | Yes/no transcript checks, no subjective grading | "Did test run before edit?" is verifiable. "Was code quality good?" is not. |
| D-3 | Grade per-directive, not per-agent | Same directive may pass in one task and fail in another. Track directive compliance, not agent scores. |
| D-4 | Mid-session rule refresh via /refresh skill | Bash cat of rule files moves them to recent context. Compensates for context drift. |
| D-5 | Hooks for mechanical enforcement, rules for behavioral guidance | Council consensus: hooks as floor, /ship for workflow, CLAUDE.md behavioral only. |

## Eval Criteria

### DA (Director Agent)

| # | Criterion | Source | Transcript check |
|---|-----------|--------|-----------------|
| DA-1 | Invoked /ship for implementation work | Project CLAUDE.md Rule 1 | Skill("ship") or Skill("harness") in transcript |
| DA-2 | Updated project-state.json (not .md) at milestone | AGENTS.md Rule 6 "fix source not output" | Write/Edit on project-state.json, not PROJECT-STATE.md |
| DA-3 | Refreshed rules if session > 30 min | /refresh skill | Bash cat of CLAUDE.md or AGENTS.md mid-session |
| DA-4 | Did not Edit/Write lib/, test/, scripts/, gates/, hooks/ | Project CLAUDE.md Rule 2 | No Edit/Write tool calls on restricted paths |
| DA-5 | Delegated to named agents (Marcus/Quinn/Rook) | Project CLAUDE.md Rule 2 | Agent() calls use named subagent_type, not generic |

### Marcus (Coding Agent)

| # | Criterion | Source | Transcript check |
|---|-----------|--------|-----------------|
| M-1 | Read AGENTS.md first | AGENTS.md Key Files "Always first" | First Read is AGENTS.md |
| M-2 | Read governing spec before implementation | AGENTS.md Rule 5 | Read of spec file before first Edit/Write |
| M-3 | Ran tests before coding | Brief "clean suite" | Bash bun test before first Edit |
| M-4 | Wrote failing test first (TDD) | Brief line 70 "write the failing test first" | Write/Edit on test file before Write/Edit on source file |
| M-5 | Ran tests after coding | AGENTS.md Rule 4 | Bash bun test after last Edit |
| M-6 | Committed changes | AGENTS.md Rule 7 | Bash git commit in transcript |

### Quinn (QA Agent)

| # | Criterion | Source | Transcript check |
|---|-----------|--------|-----------------|
| Q-1 | Validated in correct directory (worktree) | Ship workflow #560 fix | cd to worktree path or Read from worktree |
| Q-2 | Checked every AC from issue | Brief methodology | Each AC referenced in output |
| Q-3 | Reported PASS/FAIL with evidence | Brief methodology | Structured verdict with evidence per AC |

## /refresh Skill

Invoked via `/refresh`. Re-reads rule files via Bash cat to move them to recent context:
1. `cat ~/.claude/CLAUDE.md`
2. `cat CLAUDE.md` (project)
3. `head -20 AGENTS.md` (rules section)

## /da-compliance Skill

Invoked via `/da-compliance`. Audits current session against DA criteria:
1. Extract tool calls from session transcript
2. Grade each DA criterion (DA-1 through DA-5)
3. Report compliance score
4. Surface worst violations with fix suggestions

## AFK Autonomy

Three blockers prevent autonomous execution. Each has a mechanical fix:

### 1. Permission Prompts

Tool calls that need approval halt the session. Fix: run `/fewer-permission-prompts` to scan transcripts and build allowlists in settings.json. Most prompts are for commands that run every session.

- SC-423: Permission allowlists cover all standard commands (bun test, git, grep, etc.)

### 2. Decision Ambiguity

DA hits a fork and stops to ask instead of deciding. Fix: specs with clear ACs eliminate judgment calls. When ACs don't cover the case, decide conservatively, note the decision in the issue, keep moving.

- SC-424: AFK sessions make decisions when ACs are clear — no stopping to ask
- SC-425: Decisions made without Jason are logged to the issue with rationale

### 3. Blockers

Something fails and the session stops entirely. Fix: after 3 attempts, log the blocker to the issue, move to the next priority. Summarize all blockers at session end for Jason to review.

- SC-426: Blocked tasks logged to issue after 3 attempts, session moves to next priority
- SC-427: Session-end summary lists all blockers with status and what was tried
- SC-428: Blocker summary presented to Jason on next interactive session

## Success Criteria

- SC-416: Eval criteria table exists per role (DA, Marcus, Quinn) with transcript checks
- SC-417: audit-transcript.ts grades against eval criteria, not hardcoded rules
- SC-418: /refresh skill re-reads rule files via Bash cat mid-session
- SC-419: /da-compliance skill audits current session transcript against DA criteria
- SC-420: Post-ship audit runs automatically — grades agent transcripts from the ship run
- SC-421: Directive compliance tracked per-directive across runs (which directives fail most?)
- SC-422: Brief position optimization — directives that fail move higher in the brief
- SC-423: Permission allowlists cover all standard commands
- SC-424: AFK sessions decide when ACs are clear — no stopping to ask
- SC-425: Decisions made without Jason logged to issue with rationale
- SC-426: Blocked tasks logged after 3 attempts, session moves on
- SC-427: Session-end blocker summary
- SC-428: Blocker summary presented on next interactive session
