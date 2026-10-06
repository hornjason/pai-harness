---
doc-type: spec
status: draft
owner: jason
created: 2026-10-02
updated: 2026-10-06
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
| D-1 | ~~Two-layer architecture: MCP in agent prompts, Octokit in TypeScript~~ **SUPERSEDED by D-9 for workflow prompts (#137)** | The rationale was "Agents can use MCP tools natively". Workflow subagents do not: they get the tools their role names, and no role grants `mcp__github__*`. Still correct for an interactive session with the server connected |
| D-2 | `@octokit/rest` as the TypeScript SDK | GitHub's official SDK, 100% REST API coverage, full TypeScript types |
| D-3 | Auth via `GITHUB_TOKEN`, falling back to `GH_TOKEN` | Works in CI, worktrees, and headless. **Corrected 2026-10-06 (#139):** this originally read "Already set by `gh` CLI auth" and accepted `GITHUB_TOKEN` alone. That premise was false — `gh` reads `GH_TOKEN` and exports nothing, so on a machine authenticated the ordinary way `GITHUB_TOKEN` is unset and every Octokit call threw at construction. Accept both names, `GITHUB_TOKEN` first |
| D-8 | `GITHUB_API_URL` selects the API base when set | The conventional companion to the token variables (gh CLI and Actions both set it). Makes GitHub Enterprise usable, and lets tests point the client somewhere harmless instead of reaching the real API |
| D-4 | Shared Octokit helper in `lib/github.ts` | Single auth point, reusable across hooks/gates/lib, mockable for tests |
| D-5 | `POST /issues/{n}/labels` for label append (not PUT) | POST is additive by design, eliminates read-merge-write race condition |
| D-6 | Remove `gh` CLI from automation code entirely | Keep only for developer interactive use; not in programmatic paths |
| D-7 | ~~MCP fallback to Octokit when MCP server not connected~~ **NEVER IMPLEMENTED; replaced by D-9 (#137)** | Right instinct, no code, and no SC that could notice. "Fallback at the orchestrator level" is also not buildable as written: `workflows/ship.js` runs in a sandbox with no module loading and no filesystem (#69), so the orchestrator cannot call Octokit at all |
| D-9 | Workflow agent prompts invoke `scripts/github-op.ts`; no `mcp__github__*` and no `gh` in a workflow prompt | A workflow step can only run Bash, so the Octokit layer is reached through a script — the same shape as `scripts/collect-worktree-files.ts`, which exists for the same sandbox reason. The agent runs one command and reports the outcome; the script decides what to send, in a process that imports `lib/github.ts`, so there is no second copy of the API logic to drift |

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

**Both criteria below were satisfied by prompts that could never run** — see Phase 6.
They are kept, struck through, because the failure is the point: each one certifies
that a tool NAME is present in a prompt, which is true whether or not the tool exists.

- [x] SC-499: SUPERSEDED by SC-532/SC-534 (#137) — was "workflows/prove.js names the MCP get-issue and add-comment tools". It did, and neither tool existed
- [x] SC-500: SUPERSEDED by SC-532/SC-534 (#137) — was "workflows/prove.js names the MCP update-issue tool". Same defect: a name in a prompt, not a call that lands

### Phase 4 — Handle remaining ship.js gaps

- [x] SC-501: SUPERSEDED by SC-531/SC-534 (#137) — was "workflows/ship.js names the MCP create- and update-pull-request tools". It named both, and opened no PR on any run
- [x] SC-502: No `execSync.*gh ` or `Bun.spawnSync.*gh` patterns in lib/, hooks/, gates/ (behavioral)

### Phase 5 — Auth actually resolves (#139, #140)

Phases 1–4 all reported green while the client could not authenticate at all. Every SC
above asserts that a *name* appears in a file; none asserted that a call could succeed.
That is why a false premise in D-3 survived four phases of "done" — the criteria could
not see it. These are the criteria that can.

Covered by hand-written tests, named here because the generator cannot currently reach
them: `test/github-client.test.ts` (SC-519, SC-520) and
`test/issue-close-guard-fail-closed.test.ts` (SC-521, SC-522, SC-523). Each has a recorded
mutation that turns it red — see the PR for #139/#140. `scripts/sync-spec-tests.ts` reads
`$HARNESS_ROOT/PAI/Specs` and defaults `HARNESS_ROOT` to `~/.claude`, so it has never read
this directory; that divergence is its own issue.

- [x] SC-519: lib/github.ts contains [resolveGitHubToken, GH_TOKEN, resolveApiBaseUrl]
- [x] SC-524: lib/github.ts contains [GITHUB_API_URL, https, loopback] — D-8 refuses to send a token to a plaintext remote host
- [x] SC-525: hooks/lib/utils.ts contains [redactSecrets, REDACTED] — a block reason never carries a credential
- [x] SC-526: hooks/lib/utils.ts contains [GH_REPO, matches.length - 1] — the parser agrees with gh on env fallback and last-flag-wins
- [x] SC-527: hooks/lib/utils.ts contains [parseCloseTarget, ambiguous] — a command the parser cannot read unambiguously is refused, not guessed at
- [x] SC-528: lib/github.ts contains [loopback, url.hostname] — GITHUB_API_URL cannot redirect a bearer token off this machine
- [x] SC-520: test/github-client.test.ts contains [GH_TOKEN alone is sufficient, GITHUB_TOKEN wins when both are set]
- [x] SC-521: hooks/lib/utils.ts contains [parseRepoSlug]
- [x] SC-522: test/issue-close-guard-fail-closed.test.ts contains [block, could not, parseRepoSlug]
- [x] SC-523: hooks/IssueCloseGuard.hook.ts not contains [} catch {}]

### Phase 6 — The agent layer reaches GitHub at all (#137)

Phase 3 and Phase 4 were marked done by prompts naming `mcp__github__*` tools that
no agent in this harness has ever had. Two independent reasons, either sufficient:
no role in `.claude/rungate/roles.json` grants `mcp__github__*`, and the server
`.mcp.json` points at — `@modelcontextprotocol/server-github` — is deprecated on npm
("Package no longer supported") and does not connect. The run that found this
(`wf_43a48428-ab0`) searched for the tool, found nothing, reported the failure
honestly, and the workflow still returned SHIPPED.

Covered by `test/github-op.test.ts` (SC-529..533) and `test/workflow-mcp-tools.test.ts`
(SC-534). The first runs the script as a subprocess against a loopback HTTP server
and asserts the request GitHub would have received — method, path, query and body —
rather than that the source mentions a function name. Loopback is reachable because
D-8 allowlists it; the test seam and the exfiltration guard are the same rule.

- [x] SC-529: scripts/github-op.ts contains [upsertPR, addComment, addLabels, createIssue] — one script, every operation a workflow step needs
- [x] SC-530: lib/github.ts contains [upsertPR, createIssue, updateIssue] — the upsert lives in the library, not in the script, so it is testable without a subprocess
- [x] SC-531: workflows/ship.js contains [scripts/github-op.ts pr-upsert, scripts/github-op.ts comment] and not contains [mcp__github__]
- [x] SC-532: workflows/prove.js contains [scripts/github-op.ts issue-get, scripts/github-op.ts issue-label] and not contains [mcp__github__]
- [x] SC-533: test/github-op.test.ts contains [action: "updated", positive integer, no stub matched] — upsert does not re-create, a malformed issue number is refused rather than coerced, and every request is asserted against a real server
- [x] SC-534: test/workflow-mcp-tools.test.ts contains [grantedServers, mcpServersReferenced] — a workflow prompt may not name an MCP server no role grants

### Phase 7 — The migration does not create what it replaces (#137, security review)

Moving from structured tool arguments to a command line introduced three hazards
that the MCP form did not have. All three were raised by security review of the
first commit and all three were real.

- [x] SC-535: scripts/github-op.ts contains [title-from-issue, title-file] and workflows/ship.js not contains [--title "fix(#] — an issue title is written by whoever files the issue, and it never crosses a shell
- [x] SC-536: hooks/lib/utils.ts contains [OP_CLOSE, github-op] — the close guard follows the harness onto `github-op.ts issue-update --state closed`, instead of being walked around by it
- [x] SC-538: lib/github.ts contains [REPO_SEGMENT, is not a GitHub owner or repository name] — a repo slug cannot steer the request path. Measured, not assumed: `--repo "../x"` reached `GET /x/issues/7`, outside `/repos/` entirely
- [x] SC-537: workflows/prove.js contains [HEREDOC-SAFE-START, heredocSafe] and test/workflow-security-integration.test.ts contains [loadHeredocSafe] — the proof body cannot break out of its quoted heredoc, proven by executing the extracted helper rather than grepping for it

## Constraints

- Auth MUST come from the environment — `GITHUB_TOKEN`, else `GH_TOKEN` — with no hardcoded tokens and no interactive auth. Blank counts as absent (#139)
- `GITHUB_API_URL`, when set, MUST resolve to an allowlisted host — GitHub itself or loopback — compared on exact hostname. It redirects an endpoint that carries a bearer token, so an arbitrary host is an exfiltration primitive. GitHub Actions sets this variable to `https://api.github.com` on every run, which is why the rule is an allowlist rather than loopback-only; a loopback-only version broke the whole suite in CI. GitHub Enterprise needs a host outside the list and is a separate, deliberate decision
- Octokit client MUST be created once per process, not per call
- Label operations MUST use POST (additive), never PUT (replace)
- Workflow agent prompts MUST NOT name an MCP tool whose server no role in `.claude/rungate/roles.json` grants. An instruction to call a tool the agent does not have is not a degraded path, it is a step that silently does nothing (#137)
- Workflow agent prompts MUST reach GitHub through `scripts/github-op.ts` — not `mcp__github__*`, not `gh` (D-9). A step that cannot complete the write MUST exit non-zero; reporting success without the write is the defect this replaced
- Bodies (PR descriptions, issue comments) MUST be passed as `--body-file`, not assembled into a shell argument. They contain newlines, quotes and backticks, and the caller building the command line is a language model
- Text the harness did not author — issue titles and bodies, spec headings, AC evidence — MUST NOT be interpolated into a command line in a workflow prompt. Use `--title-from-issue`, `--title-file` or `--body-file` so the value is read by the process that uses it. An issue title is chosen by whoever files the issue
- Any new way to close an issue MUST be recognised by `parseCloseTarget`. The guard was written against `gh issue close`; a second path that it does not match is not a gap, it is a bypass that still reports as guarded
- Tests MUST NOT reach the real GitHub API. Mocking the client or pointing `GITHUB_API_URL` at loopback both satisfy this; the loopback form is preferred for anything that claims an end-to-end result, because a mocked client cannot catch a wrong path or a wrong verb

## Anti-Criteria

- [x] SC-A1: No `gh` CLI calls remain in lib/, hooks/, or gates/ after Phase 2 complete (behavioral)
- [x] SC-A2: No `PUT /labels` (replace-all) used anywhere — only POST (additive) (behavioral)
