# rungate

## Project Identity

Ship harness — conformity tests, scaffold, and agent briefs for AI-first development
- **Repo:** https://github.com/hornjason/pai-harness

## Rules

- Verify before asserting — try it, then report what actually happened
- Never report PASS with known gaps — list every gap honestly
- Never fake, shortcut, or game test results — if it fails, it fails
- Run full test suite (`bun test`) before reporting done, not just your file
- Show real tool output, not summaries — the raw data is the evidence
- Read docs before writing code — the routing table below tells you where to look

## Governing Spec Routing

| Work area | Governing spec |
|-----------|---------------|
| TODO | `specs/harness-automation-matrix.md` |
| TODO | `specs/HARNESS-GATES.md` |
| Instruction compliance testing — grading, behavioral verification, and hill climbing template files | `specs/INSTRUCTION-COMPLIANCE-SPEC.md` |
| TODO | `specs/HARNESS-STANDARD.md` |
| TODO | `specs/HARNESS-SKILL-CONTRACT.md` |
| Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content assertions | `specs/BOOTSTRAP-TEST-PLAN.md` |
| TODO | `specs/HARNESS-SKILL-CHAIN.md` |
| Bootstrap data flow — scan order, data sources, consumer requirements, re-run behavior | `specs/BOOTSTRAP-DATA-FLOW-SPEC.md` |

Read the governing spec BEFORE making changes in that area.

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
| package.json | Dependencies and scripts | Adding deps or scripts |
| .claude/rungate.json | Harness project config | Shipping through harness |
| lib/ | Lib directory | Working on lib |
| gates/ | Gates directory | Working on gates |
| workflows/ | Workflows directory | Working on workflows |
| hooks/ | Hooks directory | Working on hooks |
| `CODE-MAP.md` | Auto-generated codebase map (routes, components, modules, health) | Understanding codebase structure |

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
| Codebase structure (routes, components, modules, health) | `CODE-MAP.md` |
| research (5 files) | `docs/research/` |

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
| Specs | `specs/` | `doc-type: spec`, `testable`, `governs` | SCs auto-generate tests |
| ADRs | `docs/adr/` | `doc-type: adr`, `status`, `created` | Architecture decisions |
| Research | `docs/research/` | `doc-type: research`, `governs` | Tool evaluations, competitive analysis, findings |
| Council output | `docs/council/` | `doc-type: council` | Council synthesis, design debates |
| Guides | `docs/` | `doc-type: guide` | Setup, onboarding, reference |
| Source code | `src/` | — | Follow existing module structure |
| Tests | `test/` | — | Mirror source structure |

## Specs

All specs live in `specs/` with YAML frontmatter declaring `testable: true/false`.

| Spec | Testable | Governs |
|------|----------|---------|
| harness-automation-matrix.md | TODO | yes |
| HARNESS-GATES.md | TODO | yes |
| INSTRUCTION-COMPLIANCE-SPEC.md | Instruction compliance testing — grading, behavioral verification, and hill climbing template files | yes |
| HARNESS-STANDARD.md | TODO | yes |
| HARNESS-SKILL-CONTRACT.md | TODO | yes |
| BOOTSTRAP-TEST-PLAN.md | Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content assertions | yes |
| HARNESS-SKILL-CHAIN.md | TODO | yes |
| BOOTSTRAP-DATA-FLOW-SPEC.md | Bootstrap data flow — scan order, data sources, consumer requirements, re-run behavior | yes |

## Tests

```bash
bun test
```

| Category | File | What |
|----------|------|------|
| phase 3 | phase-3.test.ts | Auto-detected |
| scaffold conformity | scaffold-conformity.test.ts | Auto-detected |
| phase 2 | phase-2.test.ts | Auto-detected |
| spec discovery | spec-discovery.test.ts | Auto-detected |
| schema canary | schema-canary.test.ts | Auto-detected |
| phase 0 | phase-0.test.ts | Auto-detected |
| structure | structure.test.ts | Auto-detected |
| phase 1 | phase-1.test.ts | Auto-detected |
| phase 4 | phase-4.test.ts | Auto-detected |
| spec compliance | spec-compliance.test.ts | Auto-detected |
| phase 5 | phase-5.test.ts | Auto-detected |
| contract | contract.test.ts | Auto-detected |
| external deps | external-deps.test.ts | Auto-detected |
| anti | anti.test.ts | Auto-detected |
| instruction compliance | instruction-compliance.test.ts | Auto-detected |
| meta sc coverage | meta-sc-coverage.test.ts | Auto-detected |
| phase 1 5 | phase-1-5.test.ts | Auto-detected |
| contract negative | contract-negative.test.ts | Auto-detected |
| spec compliance auto | spec-compliance-auto.test.ts | Auto-detected |
| spec drift | spec-drift.test.ts | Auto-detected |

## Commands

| Action | Command |
|--------|---------|
| Install | `bun install` |
| Test | `bun test` |
| Type check | `bunx tsc --noEmit` |
| Conformity | `bun test test/scaffold-conformity.test.ts` |
| Sync spec tests | `bunx rungate sync-tests .` |
| Create spec | `bunx rungate create-spec "title"` |
| Create ADR | `bunx rungate create-adr "title"` |
| Extract constraints | `bunx rungate extract-constraints .` |
| Check findings | `cat .rungate/conformity-findings.json` |
| Re-scaffold | `bun ~/Projects/rungate/scripts/scaffold-project.ts .` |



## Workflow
- **Repo:** https://github.com/hornjason/pai-harness
- **Test:** `bun test`
- **Conformity:** Imported from rungate. `bun update rungate && bun test` to sync.

## Quick Reference

1. AGENTS.md is the single entry point — everything routes from here
2. CODE-MAP.md has the auto-generated codebase map — routes, components, modules, health
3. Specs in specs/ are source of truth — testable: true specs auto-generate tests
4. `bun test` runs conformity + domain tests
5. Agent briefings in .claude/agents/ are auto-generated — run bootstrap to refresh
6. After test failures, read `.rungate/conformity-findings.json` for structured findings with fix commands

## Harness-Managed Files

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| `.github/workflows/ci.yml` | Set `ci` fields in `.claude/rungate.json` | Don't edit the YAML |
| `.github/workflows/gates.yml` | Settings from `.claude/rungate.json` | Don't edit the YAML |
| `.claude/agents/*.md` | Settings from `.claude/rungate.json` | Don't edit briefs |
| `test/scaffold-conformity.test.ts` | Runs automatically | Don't edit |
| `CODE-MAP.md` | Auto-generated from code scan | Don't edit |

## Reference Files

Historical and inactive docs live in `reference/`.

| File | What |
|------|------|
| specs | Historical reference |
| migration-manifest.json | Historical reference |
| scripts | Historical reference |
| prompts | Historical reference |
