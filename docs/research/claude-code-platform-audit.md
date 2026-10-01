---
doc-type: research
status: active
owner: jason
updated: 2026-09-30
---

# Claude Code Platform Audit — Features Rungate Should Adopt

Systematic audit of 26 Claude Code documentation pages cross-referenced against rungate's current architecture (6 agents, 14 hooks, 42 lib files, 5 rules, 6 workflows).

## Top 10 Actions (ranked by impact)

1. **Add `memory: project` to Marcus** — cross-session compliance learning, replaces manual hill-climb
2. **Create `.worktreeinclude`** — 3 lines, replaces 82 lines of `worktree-isolation.ts`
3. **Set `promptCacheTtl` + `subagentPromptCacheTtl` to `"1h"`** — immediate cost savings
4. **Add `Stop` hook to Marcus** — mechanical test enforcement, replaces brief-level instructions
5. **Add `/goal` to pipeline** — replaces `AutoVerifyGate.hook.ts` + parts of `gate-enforcement.ts`
6. **Create `.claude/commands/ship-issue.md`** — `/ship-issue 123` with `$ARGUMENTS`
7. **Add `disable-model-invocation: true` to heavy skills** — saves context every session
8. **Add `effort`, `maxTurns`, `omitClaudeMd` to agent frontmatter** — per-agent optimization
9. **Run `/doctor prompt-audit` regularly** — catches rule conflicts automatically
10. **Create `.claude/output-styles/pai.md`** — replace PAI mode headers with native output style

## Category 1: Missing from .claude/ directory

| Feature | What it does | Impact | Priority |
|---------|-------------|--------|----------|
| `.worktreeinclude` | Copies gitignored files (.env, config) into worktrees | Replaces `worktree-isolation.ts` (82 lines) with 3-line file | HIGH |
| `.claude/commands/` | Single-file `/name` commands with `$ARGUMENTS` and `!` shell injection | `/ship-issue 123` simpler than skill chain | HIGH |
| `.claude/skills/` (project) | Skill dirs with SKILL.md + bundled files | Bundle brief + prompts + checklist. `disable-model-invocation` keeps heavy skills out of context | HIGH |
| `.claude/output-styles/` | Custom output style files | Replace PAI mode headers (~50 lines CLAUDE.md), save context tokens | MEDIUM |
| `.claude/agent-memory/` | Per-agent persistent memory | Marcus learns compliance patterns across sessions without manual hill-climb | HIGH |
| `.claude/workflows/` | Saved workflow scripts as `/name` commands | Our workflows/ at project root — move to .claude/workflows/ for discoverability | LOW |

## Category 2: Missing agent frontmatter fields

| Field | What it does | Which agents | Priority |
|-------|-------------|-------------|----------|
| `memory: project` | Persistent cross-session memory | Marcus, Quinn, Discovery | HIGH |
| `effort: low/high` | Per-agent effort level | Rook/Discovery low, Marcus high | MEDIUM |
| `maxTurns: N` | Cap agentic turns (spiral prevention) | Marcus: 30 | MEDIUM |
| `omitClaudeMd: true` | Skip global CLAUDE.md | Marcus/Quinn/Rook save ~2K tokens each | MEDIUM |
| `experimental.cacheTtl: "1h"` | 1-hour prompt cache | Marcus (runs 15-20 min) | HIGH |
| `isolation: worktree` | Always isolated worktree | Marcus (currently per-invocation) | MEDIUM |
| `hooks` | Per-agent lifecycle hooks | Marcus Stop hook: exit 2 if bun test fails | HIGH |
| `disallowedTools` | Deny specific tools mechanically | Serena/Aditi: [Write, Edit, Bash] | MEDIUM |
| `background: true` | Force background execution | Discovery | LOW |
| `permissionMode` | Per-agent permission mode | Marcus acceptEdits, Rook dontAsk | LOW |

## Category 3: Missing settings.json keys

| Setting | What it does | Priority |
|---------|-------------|----------|
| `subagentPromptCacheTtl: "1h"` | 1-hour cache for ALL subagents | HIGH |
| `promptCacheTtl: "1h"` | 1-hour cache for main conversation | HIGH |
| `worktree.baseRef: "head"` | Worktrees branch from HEAD not main | HIGH |
| `outputStyle` | Select custom output style | MEDIUM |
| `skillListingBudgetFraction` | Control context for skill descriptions | LOW |
| `autoCompactWindow` | Set compaction threshold | LOW |
| `bashOutputMaxChars` | Cap command output size | LOW |
| `includeGitInstructions: false` | Skip built-in git instructions | LOW |

## Category 4: Automation features not used

| Feature | What it does | Replaces | Priority |
|---------|-------------|----------|----------|
| `/goal` condition | Persistent evaluator, Claude works until met | `AutoVerifyGate.hook.ts` (79 lines), parts of `gate-enforcement.ts` (227 lines) | HIGH |
| `Stop` hook with exit 2 | Block turn ending if check fails | Brief-level "run tests" instructions | HIGH |
| Routines (cloud) | Scheduled automated runs | Nightly conformity, auto PR review, weekly drift scan | MEDIUM |
| `/batch` command | Fan-out 5-30 subagents in worktrees | `parallel-ship.ts` custom code | MEDIUM |
| Agent teams (experimental) | Shared task list + messaging + TeammateIdle | Pipeline subagent coordination | MEDIUM |
| Channels with webhooks | Push external events into session | Mac Mini → DA via webhook vs polling | MEDIUM |

## Category 5: Skill frontmatter not used

| Field | What it does | Priority |
|-------|-------------|----------|
| `disable-model-invocation: true` | User-only invoke, description NOT in context | HIGH |
| `allowed-tools` | Auto-approve tools for skill's turn | MEDIUM |
| `context: fork` | Run in isolated subagent | MEDIUM |

## Category 6: Diagnostic commands not used

| Command | What it does | Priority |
|---------|-------------|----------|
| `/doctor prompt-audit` | Checks instruction files for conflicts | HIGH |
| `/context` | Shows what's loaded, token costs | HIGH |
| `/skill-doctor` | Skill listing cost and usage | MEDIUM |
| `/usage` | Per-session cache hit ratio | MEDIUM |

## Category 7: Hook events not used

| Event | What it does | Priority |
|-------|-------------|----------|
| `Stop` | Exit 2 keeps agent working | HIGH |
| `InstructionsLoaded` | Track which rules load and when | MEDIUM |
| `PostToolBatch` | Checkpoint after parallel edits | LOW |
| `TeammateIdle` (teams) | Verify gate for agent teams | MEDIUM |

## Category 8: Prompt caching optimizations

| Optimization | Impact | Priority |
|-------------|--------|----------|
| `promptCacheTtl: "1h"` | DA idle >5m between steps | HIGH |
| `subagentPromptCacheTtl: "1h"` | Marcus cache expires mid-run | HIGH |
| Avoid mid-session model switches | Each switch rebuilds entire cache | LOW |
