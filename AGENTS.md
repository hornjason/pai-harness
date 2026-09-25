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
- Read docs before writing code — routing table shows where
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
| PROJECT-STATE.md | Live status + handoff (generated from project-state.json — don't edit directly) | Session start, always first after AGENTS.md |
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
| Current project state, priorities, and session history | `PROJECT-STATE.md` |
| Specs — success criteria, constraints, requirements (20 files) | `specs/` |
| ADRs — architecture decisions (0 files) | `docs/adr/` |
| Research — findings, evaluations, competitive analysis (19 files) | `docs/research/` |
| Council — synthesis, design debates (7 files) | `docs/council/` |
| Guides — setup, onboarding, reference (1 files) | `docs/guides/` |
| Reference — historical and inactive docs (0 files) | `reference/` |

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
| Specs | `specs/` | `doc-type: spec`, `testable`, `governs` | SCs auto-generate tests |
| ADRs | `docs/adr/` | `doc-type: adr`, `status`, `created` | Architecture decisions |
| Research | `docs/research/` | `doc-type: research`, `governs` | Tool evaluations, competitive analysis, findings |
| Council | `docs/council/` | `doc-type: council` | Council synthesis, design debates |
| Guides | `docs/guides/` | `doc-type: guide` | Setup, onboarding, reference |
| Reference | `reference/` | — | Historical reference |
| Source code | `src/` | — | Follow existing module structure |
| Tests | `test/` | — | Mirror source structure |

## Specs

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| SESSION-LIFECYCLE-SPEC.md | Session start and end rituals — cold-start context loading, session-end state capture, handoff brief generation | yes |
| harness-automation-matrix.md | Automation strategy — bash scripts vs hooks vs workflows for harness enforcement | yes |
| PROJECT-STATE.md | TODO — describe what this spec governs | no |
| HARNESS-GATES.md | Gate definitions — what checks run at each harness gate and their pass/fail criteria | yes |
| AGENTS-MD-TEMPLATE-SPEC.md | AGENTS.md template structure — what's baked in, what's scanned, how to update | yes |
| INSTRUCTION-COMPLIANCE-SPEC.md | Instruction compliance testing — grading, behavioral verification, and hill climbing template files | yes |
| SESSION-AUDIT-SPEC.md | Session behavioral audit — two feedback loops for instruction quality improvement | no |
| PARALLEL-AGENT-COORDINATION-SPEC.md | Parallel agent coordination — file-claim manifests and module-boundary decomposition to prevent merge conflicts in multi-agent AFK work | yes |
| CONFIG-DRIVEN-TESTING-SPEC.md | Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration | yes |
| HARNESS-STANDARD.md | Harness workflow — the GOAL → DISCOVERY → EXECUTION → VERIFICATION loop and how skills chain | yes |
| HARNESS-SKILL-CONTRACT.md | Skill interface contracts — inputs, outputs, artifacts, and handoff protocols between skills | yes |
| BOOTSTRAP-TEST-PLAN.md | Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content assertions | yes |
| GATE-CONTRACTS-SPEC.md | Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain | yes |
| HOOK-ARCHITECTURE-SPEC.md | Hook architecture — hooks as thin triggers delegating to lib/ modules, not deep logic in hook files | yes |
| AGENT-BRIEF-TEMPLATE-SPEC.md | Agent brief templates — externalized markdown templates with variable substitution, not hardcoded TypeScript strings | yes |
| HARNESS-SKILL-CHAIN.md | Skill chaining — how goal → ship → prove → close sequences connect and pass state | yes |
| SCAFFOLD-DECOMPOSITION-SPEC.md | Scaffold decomposition — extracting scan, generation, and validation from the 1,844-line scaffold-project.ts into focused modules | yes |
| BOOTSTRAP-DATA-FLOW-SPEC.md | TODO | no |
| DA-COMPLIANCE-SPEC.md | TODO | no |

## Tests

```bash
bun test
```

| Category | File | What |
|----------|------|------|
| update project state | update-project-state.test.ts | Auto-detected |
| phase 3 | phase-3.test.ts | Auto-detected |
| prior branch | prior-branch.test.ts | Auto-detected |
| rule registry | rule-registry.test.ts | Auto-detected |
| scaffold conformity | scaffold-conformity.test.ts | Auto-detected |
| phase 2 | phase-2.test.ts | Auto-detected |
| spec discovery | spec-discovery.test.ts | Auto-detected |
| agent brief template | agent-brief-template.test.ts | Auto-detected |
| post fix verify | post-fix-verify.test.ts | Auto-detected |
| test brief roles | test-brief-roles.test.ts | Auto-detected |
| schema canary | schema-canary.test.ts | Auto-detected |
| deep modules | deep-modules.test.ts | Auto-detected |
| directive extractor | directive-extractor.test.ts | Auto-detected |
| phase 0 | phase-0.test.ts | Auto-detected |
| structure | structure.test.ts | Auto-detected |
| phase 1 | phase-1.test.ts | Auto-detected |
| tdd checker | tdd-checker.test.ts | Auto-detected |
| hill climb | hill-climb.test.ts | Auto-detected |
| sync sc status | sync-sc-status.test.ts | Auto-detected |
| brief context parser | brief-context-parser.test.ts | Auto-detected |
| task completion checks | task-completion-checks.test.ts | Auto-detected |
| transcript checker | transcript-checker.test.ts | Auto-detected |
| commit enforcement | commit-enforcement.test.ts | Auto-detected |
| phase 4 | phase-4.test.ts | Auto-detected |
| matcher registry | matcher-registry.test.ts | Auto-detected |
| audit specs | audit-specs.test.ts | Auto-detected |
| split spec | split-spec.test.ts | Auto-detected |
| spec compliance | spec-compliance.test.ts | Auto-detected |
| phase 5 | phase-5.test.ts | Auto-detected |
| contract | contract.test.ts | Auto-detected |
| branch cleanup | branch-cleanup.test.ts | Auto-detected |
| external deps | external-deps.test.ts | Auto-detected |
| audit transcript | audit-transcript.test.ts | Auto-detected |
| anti | anti.test.ts | Auto-detected |
| instruction compliance | instruction-compliance.test.ts | Auto-detected |
| meta sc coverage | meta-sc-coverage.test.ts | Auto-detected |
| worktree cleanup | worktree-cleanup.test.ts | Auto-detected |
| stale issue scanner | stale-issue-scanner.test.ts | Auto-detected |
| phase 1 5 | phase-1-5.test.ts | Auto-detected |
| sc guard | sc-guard.test.ts | Auto-detected |
| contract negative | contract-negative.test.ts | Auto-detected |
| spec compliance auto | spec-compliance-auto.test.ts | Auto-detected |
| spec drift | spec-drift.test.ts | Auto-detected |
| scan stale issues | scan-stale-issues.test.ts | Auto-detected |
| sc drift | sc-drift.test.ts | Auto-detected |
| create sc | create-sc.test.ts | Auto-detected |

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
| Create SC | `bunx rungate create-sc --pattern <name> --params '<json>'` |
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
