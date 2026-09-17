---
doc-type: reference
status: active
owner: jason
updated: 2026-09-17
---

# PAI Harness

## Project Identity

Implementation quality framework for PAI (Personal AI Infrastructure). Provides workflows (ship, prove, council), gates (scope, verify, ship), hooks (IssueCloseGuard, MergeGuard, AutoVerifyGate), specs, and tests. Built with Bun/TypeScript.

- **Issues:** github.com/hornjason/pai-config (not this repo)
- **Code:** github.com/hornjason/pai-harness

## Key Files

| File | What | When to Read |
|------|------|--------------|
| [.claude/project-harness.json](.claude/project-harness.json) | Project config | When shipping through harness |
| [gates/orchestrator.ts](gates/orchestrator.ts) | Gate runner + workflow state | When debugging gates |
| [gates/schema.ts](gates/schema.ts) | Zod schemas for workflow-state.json | When adding fields |
| [gates/brief-assembler.ts](gates/brief-assembler.ts) | Generates Marcus briefs from state | When changing brief format |
| [workflows/ship.js](workflows/ship.js) | Ship lifecycle workflow | When modifying ship process |
| [workflows/prove.js](workflows/prove.js) | Prove lifecycle workflow | When modifying prove process |
| [workflows/council.js](workflows/council.js) | Council debate workflow | When modifying council |
| [hooks/IssueCloseGuard.hook.ts](hooks/IssueCloseGuard.hook.ts) | Blocks premature issue close | When changing close rules |
| [hooks/AutoVerifyGate.hook.ts](hooks/AutoVerifyGate.hook.ts) | Auto-triggers verify after Marcus | When changing verify flow |
| [hooks/MergeGuard.hook.ts](hooks/MergeGuard.hook.ts) | Blocks merge without verify gate | When changing merge rules |
| [config/ceremony-profiles.json](config/ceremony-profiles.json) | LIGHT/STANDARD/THOROUGH tiers | When changing ceremony levels |
| [scripts/scaffold-project.ts](scripts/scaffold-project.ts) | Bootstrap any project to conformity | When onboarding a new project |
| [lib/conformity.ts](lib/conformity.ts) | Exportable conformity test functions | When projects import tests |
| [gates/self-heal.ts](gates/self-heal.ts) | Prove self-healing loop | When debugging prove iterations |

## Specs

All specs live in `specs/` with YAML frontmatter declaring `testable: true/false`.

| Spec | Testable | Governs |
|------|----------|---------|
| HARNESS-STANDARD.md | true | Agentic harness lifecycle and AFK rules |
| HARNESS-SKILL-CHAIN.md | true | Phase ordering and skill chain contract |
| HARNESS-SKILL-CONTRACT.md | true | Skill I/O contract definitions |
| HARNESS-GATES.md | true | Gate definitions and enforcement config |
| harness-automation-matrix.md | true | Gate automation coverage matrix |
| SPEC-TEMPLATE.md | false | Template for creating new specs |

New specs: copy `specs/SPEC-TEMPLATE.md`, follow the SC patterns documented in it. Tests auto-generate from `- [ ] SC-N:` lines.

## Tests

Run all tests:

```bash
bun test
```

| Category | File | What |
|----------|------|------|
| Structure | structure.test.ts | ST-1..ST-7 migration guards |
| Spec discovery | spec-discovery.test.ts | Frontmatter validation |
| Spec compliance | spec-compliance.test.ts | Manual compliance checks |
| Spec compliance (auto) | spec-compliance-auto.test.ts | Auto-generated compliance |
| Schema canary | schema-canary.test.ts | Zod schema drift detection |
| Scaffold conformity | scaffold-conformity.test.ts | REPO-SCAFFOLD-SPEC conformity |
| External deps | external-deps.test.ts | Cross-repo CLAUDE.md drift |
| Contract | contract.test.ts | Skill contract validation |

## Workflow

Issues live on **hornjason/pai-config**; code lives here. The harness enforces a deterministic lifecycle:

```
GOAL → DISCOVERY → SCOPE → BUILD → VERIFY → SHIP → PROVE
                                ↑                    |
                                └── self-heal ───────┘
```

- **Gates** enforce quality mechanically at each transition
- **Self-healing**: gates fail → classify error → fix → re-run (max 3 attempts per gate)
- **Prove iteration**: UNPROVEN → spawn Marcus to fix → re-prove (circuit breaker at 3)
- **Witness-verdict cross-validation**: AC verdicts must have matching witness chain entries
- **Hooks** prevent premature closure (IssueCloseGuard) and unverified merges (MergeGuard)
- **Ceremony profiles** (LIGHT/STANDARD/THOROUGH) control how much ceremony each gate demands
- **workflow-state.json** is the spine — every phase reads/writes it

Workflow invocation always uses `scriptPath`, never `name`:

```js
Workflow({ scriptPath: "~/Projects/pai-harness/workflows/ship.js" })
```

## Quick Reference

1. Always use `scriptPath` for workflow invocation — `name` resolves to cached snapshots
2. `project-harness.json` is the thin interface each project provides to the harness
3. Gates are the enforcement layer — behavioral rules alone don't work
4. Specs self-describe via YAML frontmatter (`testable`, `status`, `doc-type`)

## Repo Boundary

- **Owns:** execution machinery (workflows, gates, hooks, specs, config, tests)
- **Does NOT own:** behavioral rules (CLAUDE.md), algorithm mode, project configs, PAI routing
- **Reference:** See [HARNESS.md](HARNESS.md) for workflow schema details and external dependency list
