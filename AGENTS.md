---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# rungate

## Project Identity

Ship harness — conformity tests, scaffold, and agent briefs for AI-first development
**Tech:** Bun, ESM
- **Repo:** https://github.com/hornjason/pai-harness

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (`bun test`) and show real output — no summaries, no skipped files
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — `git status` in final summary, uncommitted = not done

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
| NEXT-SESSION.md | Session handoff brief — priorities, blockers, what NOT to do | Session start, before any work |
| PROJECT-STATE.md | Live status dashboard (generated — don't edit) | Session start, after NEXT-SESSION.md |
| project-state.json | Source of truth for project status | When editing state |
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
| Research findings | `docs/research/` |
| Test architecture, phases, golden fixture | `specs/BOOTSTRAP-TEST-PLAN.md` |
| Conformity engine, matchers, config-driven testing | `specs/CONFIG-DRIVEN-TESTING-SPEC.md` |
| Session audit, behavioral loops, compliance | `specs/SESSION-AUDIT-SPEC.md` |
| Instruction compliance, hill climb, COMP tests | `specs/INSTRUCTION-COMPLIANCE-SPEC.md` |
| Test files, structural tests, phase tests | `test/` directory — NOT `tests/`. Structural: `test/structure.test.ts`. Phase: `test/phase-N.test.ts` |

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

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| harness-automation-matrix.md | Automation strategy — bash scripts vs hooks vs workflows for harness enforcement | yes |
| HARNESS-GATES.md | Gate definitions — what checks run at each harness gate and their pass/fail criteria | yes |
| AGENTS-MD-TEMPLATE-SPEC.md | AGENTS.md template structure — what's baked in, what's scanned, how to update | yes |
| INSTRUCTION-COMPLIANCE-SPEC.md | Instruction compliance testing — grading, behavioral verification, and hill climbing template files | yes |
| HARNESS-STANDARD.md | Harness workflow — the GOAL → DISCOVERY → EXECUTION → VERIFICATION loop and how skills chain | yes |
| HARNESS-SKILL-CONTRACT.md | Skill interface contracts — inputs, outputs, artifacts, and handoff protocols between skills | yes |
| BOOTSTRAP-TEST-PLAN.md | Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content assertions | yes |
| HARNESS-SKILL-CHAIN.md | Skill chaining — how goal → ship → prove → close sequences connect and pass state | yes |
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
| Check findings | `cat .rungate/conformity-findings.json` — structured findings with fix commands |
| Re-scaffold | `bun ~/Projects/rungate/scripts/scaffold-project.ts .` |



## Workflow
- **Repo:** https://github.com/hornjason/pai-harness
- **Test:** `bun test`
- **Conformity:** Imported from rungate. `bun update rungate && bun test` to sync.

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
