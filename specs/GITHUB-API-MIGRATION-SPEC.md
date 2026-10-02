---
doc-type: spec
status: draft
owner: jason
created: 2026-10-02
updated: 2026-10-02
governs: GitHub API access — two-layer architecture replacing gh CLI with MCP (agent prompts) and Octokit (TypeScript infrastructure)
testable: true
compliance: strict
---

# GitHub API Migration

## Context

The harness uses `gh` CLI for all GitHub interactions — issue reads, comments, PR creation, label management, and issue closing. This works but has 3 structural problems:

1. **String parsing brittleness** — CLI output is untyped text. Changes in `gh` output format silently break downstream logic
2. **Shell spawning overhead** — every `gh` call forks a process, loads a Go binary, authenticates, and serializes to text
3. **No separation of concerns** — agent prompts and TypeScript infrastructure code both shell out to the same CLI, but have different capabilities (agents can use MCP tools; TypeScript code cannot)

Research (session 25) identified 16 `gh` CLI calls across 7 files, with 3 gaps that `gh` CLI solves but MCP cannot: PR updates, atomic label append, and lib-level TypeScript access. The industry standard is a two-layer architecture: MCP for agent-to-service communication, Octokit SDK for infrastructure code.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Two-layer architecture: MCP in agent prompts, Octokit in TypeScript | Agents can use MCP tools natively; TypeScript code needs a library. Clean separation |
| D-2 | `@octokit/rest` as the TypeScript SDK | GitHub's official SDK, 100% REST API coverage, full TypeScript types |
| D-3 | Auth via `GITHUB_TOKEN` environment variable | Already set by `gh` CLI auth, works in CI, worktrees, and headless |
| D-4 | Shared Octokit helper in `lib/github.ts` | Single auth point, reusable across hooks/gates/lib, mockable for tests |
| D-5 | `POST /issues/{n}/labels` for label append (not PUT) | POST is additive by design, eliminates read-merge-write race condition |
| D-6 | Remove `gh` CLI from automation code entirely | Keep only for developer interactive use; not in programmatic paths |
| D-7 | MCP fallback to Octokit when MCP server not connected | Headless/CI environments may lack MCP; Octokit always works |

## Architecture

```
┌─────────────────────────────────────────────┐
│              Agent Prompts                   │
│  (ship.js, prove.js workflow agents)         │
│                                             │
│  mcp__github__get_issue                     │
│  mcp__github__add_issue_comment             │
│  mcp__github__create_pull_request           │
│  mcp__github__update_issue (close)          │
└──────────────────┬──────────────────────────┘
                   │ Fallback if MCP unavailable
┌──────────────────▼──────────────────────────┐
│           lib/github.ts (Octokit)            │
│  (hooks, gates, lib, scripts)                │
│                                             │
│  getIssue(), addComment(), closeIssue()     │
│  createPR(), updatePR()                      │
│  addLabels() — POST, additive               │
│  listPRs(), searchPRs()                      │
└─────────────────────────────────────────────┘
```

### Layer 1: MCP (Agent Prompts)

Used in workflow agent prompts (ship.js, prove.js) where agents interact with GitHub during execution. MCP provides structured tool calls with typed JSON responses.

**Scope:** issue read, comment, close, PR create, PR list

### Layer 2: Octokit (TypeScript Infrastructure)

Used in lib/, hooks/, gates/, and scripts/ where TypeScript code needs GitHub access. Replaces `execSync("gh ...")` and `Bun.spawnSync(["gh", ...])` with typed async function calls.

**Scope:** everything MCP does, plus PR update, atomic label append, and any future GitHub API need

### Migration Inventory

| File | Current | Target Layer | Calls |
|------|---------|-------------|-------|
| workflows/ship.js | gh CLI → partial MCP | MCP (done: 2, remaining: 2 PR edit) | 4 |
| workflows/prove.js | gh CLI | MCP (5 direct maps) + Octokit (2 label append) | 7 |
| gates/gate-executor.ts | execSync gh | Octokit | 2 |
| gates/orchestrator.ts | execSync gh | Octokit | 2 |
| lib/prior-branch.ts | execSync gh | Octokit | 1 |
| lib/branch-cleanup.ts | execSync gh | Octokit | 1 |
| hooks/IssueCloseGuard | Bun.spawnSync gh | Octokit | 1 |

## Success Criteria

### Phase 1 — Foundation (lib/github.ts + Octokit)

- [x] SC-488: package.json contains [@octokit/rest]
- [x] SC-489: lib/github.ts contains [createGitHubClient, getIssue, addComment, addLabels]
- [x] SC-490: lib/github.ts contains [createPR, updatePR, listPRs, closeIssue]
- [x] SC-491: lib/github.ts contains [GITHUB_TOKEN, Octokit, issues.addLabels]
- [x] SC-492: test/github-client.test.ts contains [createGitHubClient, addLabels, updatePR, mock]
- [x] SC-493: lib/github.ts contains [POST, additive, labels]

### Phase 2 — Migrate infrastructure code (hooks, gates, lib)

- [x] SC-494: hooks/IssueCloseGuard.hook.ts contains [github, getIssue] and not contains [Bun.spawnSync, gh issue]
- [x] SC-495: gates/gate-executor.ts contains [github, getIssue] and not contains [execSync, gh issue]
- [x] SC-496: gates/orchestrator.ts contains [github, addLabels, addComment] and not contains [execSync, gh issue]
- [x] SC-497: lib/prior-branch.ts contains [github, listPRs] and not contains [execSync, gh pr]
- [x] SC-498: lib/branch-cleanup.ts contains [github, listPRs] and not contains [execSync, gh pr]

### Phase 3 — Migrate workflow agent prompts (prove.js)

- [x] SC-499: workflows/prove.js contains [mcp__github__get_issue, mcp__github__add_issue_comment] and not contains [gh issue view, gh issue comment]
- [x] SC-500: workflows/prove.js contains [mcp__github__update_issue] for issue close, not contains [gh issue close]

### Phase 4 — Handle remaining ship.js gaps

- [x] SC-501: workflows/ship.js contains [mcp__github__create_pull_request, mcp__github__update_pull_request] and not contains [gh pr edit, gh pr create, gh pr list]
- [x] SC-502: No `execSync.*gh ` or `Bun.spawnSync.*gh` patterns in lib/, hooks/, gates/ (behavioral)

## Constraints

- Auth MUST use `GITHUB_TOKEN` env var — no hardcoded tokens, no interactive auth
- Octokit client MUST be created once per process, not per call
- Label operations MUST use POST (additive), never PUT (replace)
- MCP calls in agent prompts MUST NOT have Octokit fallback inline — fallback is at the workflow orchestrator level
- Tests MUST mock HTTP calls, never hit real GitHub API

## Anti-Criteria

- [x] SC-A1: No `gh` CLI calls remain in lib/, hooks/, or gates/ after Phase 2 complete (behavioral)
- [x] SC-A2: No `PUT /labels` (replace-all) used anywhere — only POST (additive) (behavioral)
