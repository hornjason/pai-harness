---
doc-type: reference
status: active
owner: jason
updated: 2026-09-18
---

# PAI Harness

Agent entry point for the PAI ship/prove/council execution engine. This repo owns all execution machinery — phases, gates, specs, agent prompts, and guard tests.

## Workflow Entry Points

### `workflows/ship.js`
- **Input:** GitHub issue number, rungate.json config
- **Output:** SHIP_PASSED or SHIP_FAILED with gate evidence chain
- **Phases:** SCOPE → BUILD → VERIFY → CLOSE
- **Invocation:** `Workflow({scriptPath: "<HARNESS_ROOT>/workflows/ship.js"})`

### `workflows/prove.js`
- **Input:** GitHub issue number, ship evidence chain
- **Output:** PROVE_PROVEN or PROVE_FAILED with reproduction evidence
- **Phases:** REPRODUCE → VERIFY → ATTEST
- **Invocation:** `Workflow({scriptPath: "<HARNESS_ROOT>/workflows/prove.js"})`

### `workflows/council.js`
- **Input:** Decision prompt, council mode (collaborative/adversarial/research)
- **Output:** Council transcript with convergence points and verdicts
- **Invocation:** `Workflow({scriptPath: "<HARNESS_ROOT>/workflows/council.js"})`

## rungate.json Schema

Each project provides a `.claude/rungate.json` validated by Zod at load time.

**Required fields:**
- `project` — project slug (e.g., "daily-brief-dashboard")
- `repo` — code repo (e.g., "hornjason/asaCommandCenter")
- `issueRepo` — issue tracker repo
- `dev.start` — dev server start command
- `dev.apiBase` — dev API base URL
- `dev.uiBase` — dev UI base URL

**Optional fields:**
- `dev.preStart`, `dev.testCmd`, `dev.typeCheck`
- `test.start`, `test.apiBase`
- `prod.rebuild`, `prod.apiBase`, `prod.uiBase`, `prod.smokeTest`
- `pages`, `codeCommittedPaths`, `consumers`, `contextDocs`

**Dropped:** `harnessRoot` (use `HARNESS_ROOT` env var)

## Running Tests

```bash
bun test                         # all tests
bun test test/structure.test.ts  # migration guard tests
bun test test/external-deps.test.ts  # cross-repo drift detector
```

## Spec Index

Specs in `specs/` govern harness behavior. Each has `testable: true/false` frontmatter.

| Spec | Testable | Purpose |
|------|----------|---------|
| HARNESS-SKILL-CHAIN.md | true | Phase ordering and skill chain contract |
| HARNESS-EXTRACTION-SPEC.md | true | Migration success criteria and guard tests |
| harness-automation-matrix.md | true | Gate automation coverage matrix |
| HARNESS-SKILL-CONTRACT.md | true | Skill I/O contract definitions |
| harness-v3-migration-plan.md | false | Historical migration plan |
| harness-v3-bash-deletion-plan.md | false | Historical bash deletion plan |

## External Dependencies

These CLAUDE.md behavioral rules govern harness execution. The harness does not own them — they live in `~/.claude/CLAUDE.md`. The `test/external-deps.test.ts` drift detector verifies they still exist.

- `OUTCOME ACs require live verification` — SKIP not valid for OUTCOME ACs at ship gate
- `mechanical-enforcement-over-rules` — hard rules don't prevent step-skipping; use code gates
- `AFK means no stops between issues` — execute sequentially without stopping between issues
- `Auto-read template on format failure` — read TEMPLATES.md before fixing format errors
- `Always use scriptPath for workflow invocation` — never use name param; scriptPath reads actual file
- `Batch-diagnose gate failures before fixing` — enumerate ALL failures, batch-fix, then re-run once
- `Check git log for prior commits in DISCOVERY` — ship only the gaps, not the whole issue
- `Verify cwd after worktree merge` — gate runner asserts cwd matches project root

## Repo Boundary

**Owns:** execution machinery (phases, gates, specs, agent prompts, config)
**Does NOT own:** behavioral rules (CLAUDE.md), orchestration mode (Algorithm), project config (rungate.json), PAI-wide routing (DOCS.md)
