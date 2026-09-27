---
doc-type: research
status: active
owner: marcus
updated: 2026-09-27
governs: []
---

# Feature Parity Audit — Custom Code vs Claude Code Built-ins

Audit of all custom hooks, scripts, lib modules, gates, and workflows in the RunGate codebase.
Cross-references each item against Claude Code built-in features to identify replaceable,
partially-overlapping, and intentionally custom code.

## Methodology

1. Inventory every `.ts` and `.js` file in `lib/`, `hooks/`, `scripts/`, `gates/`, `workflows/`
2. Record file path and line count
3. Assess whether Claude Code provides a built-in equivalent (yes / no / partial)
4. For items with a match, classify coverage (REPLACE / WRAP / KEEP)
5. For items without a match, document retention rationale

## Inventory

### lib/ — Core Modules (27 files, 5452 lines)

| # | File | Lines | Built-in Equivalent | Coverage | Notes |
|---|------|-------|---------------------|----------|-------|
| 1 | lib/eval-criteria.ts | 6 | No built-in equivalent | KEEP | RunGate-specific eval criteria definitions |
| 2 | lib/signal-phrases.ts | 7 | No built-in equivalent | KEEP | RunGate-specific signal phrase matching |
| 3 | lib/paths.ts | 23 | No built-in equivalent | KEEP | Project path resolution, RunGate-specific |
| 4 | lib/brief-context-parser.ts | 35 | No built-in equivalent | KEEP | Parses brief context blocks for agent briefs |
| 5 | lib/stale-issue-scanner.ts | 36 | Partial — Routines can schedule scans | WRAP | Scan logic is custom; scheduling could use Routines |
| 6 | lib/aes-calculator.ts | 66 | No built-in equivalent | KEEP | Intentionally custom — calculates Agent Effectiveness Score, project-specific metric |
| 7 | lib/agent-audit.ts | 74 | Partial — SubagentStop hook fires post-agent | WRAP | Audit logic is custom; trigger could use SubagentStop |
| 8 | lib/rungate-schema.ts | 74 | No built-in equivalent | KEEP | RunGate JSON schema validation |
| 9 | lib/behavioral-cache.ts | 78 | No built-in equivalent | KEEP | Intentionally custom — caches behavioral SC results with 7-day staleness, project-specific |
| 10 | lib/prior-branch.ts | 79 | Partial — Claude Code has session resume but no branch detection | WRAP | See detailed prior-branch assessment below |
| 11 | lib/spec-change-conformity.ts | 80 | No built-in equivalent | KEEP | RunGate-specific spec change tracking |
| 12 | lib/worktree-isolation.ts | 82 | Partial — Claude Code creates worktrees natively | partial-overlap | Claude Code worktree creation exists but lacks transcript-directory persistence |
| 13 | lib/create-brief.ts | 99 | No built-in equivalent | KEEP | Intentionally custom — generates agent briefs from templates, core RunGate feature |
| 14 | lib/canary.ts | 117 | No built-in equivalent | KEEP | Intentionally custom — canary value verification, novel testing approach |
| 15 | lib/rule-registry.ts | 128 | No built-in equivalent | KEEP | RunGate-specific rule tracking and registry |
| 16 | lib/promote-outputs.ts | 156 | No built-in equivalent | KEEP | Promotes gate outputs between pipeline stages |
| 17 | lib/post-fix-verify.ts | 157 | No built-in equivalent | KEEP | Post-fix verification logic |
| 18 | lib/sc-guard.ts | 157 | No built-in equivalent | KEEP | SC guard rails and validation |
| 19 | lib/hill-climb.ts | 164 | No built-in equivalent | KEEP | Intentionally custom — hill-climbing optimization for instruction quality |
| 20 | lib/worktree-cleanup.ts | 166 | Partial — Claude Code manages worktree lifecycle | partial-overlap | See detailed worktree-cleanup assessment below |
| 21 | lib/task-completion-checks.ts | 177 | Partial — TaskCompleted hook exists | WRAP | Check logic is custom; hook trigger is built-in |
| 22 | lib/directive-extractor.ts | 190 | No built-in equivalent | KEEP | Extracts directives from AGENTS.md and briefs |
| 23 | lib/branch-cleanup.ts | 238 | No built-in equivalent | KEEP | Branch lifecycle management beyond what git provides |
| 24 | lib/create-sc.ts | 253 | No built-in equivalent | KEEP | Creates success criteria — core RunGate feature |
| 25 | lib/compliance.ts | 322 | No built-in equivalent | KEEP | Compliance checking engine |
| 26 | lib/transcript-checker.ts | 845 | No built-in equivalent | KEEP | Intentionally custom — cross-references directives against tool calls, 845 lines of RunGate-specific compliance logic |
| 27 | lib/conformity.ts | 1643 | No built-in equivalent | KEEP | Intentionally custom — 1643-line conformity engine, largest module, core RunGate differentiator |

### hooks/ — Event Hooks (19 files, 2378 lines)

| # | File | Lines | Built-in Equivalent | Coverage | Notes |
|---|------|-------|---------------------|----------|-------|
| 28 | hooks/lib/parseStdin.ts | 37 | No built-in equivalent | KEEP | Hook stdin parsing utility |
| 29 | hooks/WorkflowStateGuard.hook.ts | 37 | No built-in equivalent | KEEP | Guards workflow state transitions |
| 30 | hooks/SpecConformityTrigger.hook.ts | 40 | Partial — FileChanged hook could trigger | WRAP | Trigger is replaceable; conformity logic stays custom |
| 31 | hooks/TaskCompleted.hook.ts | 48 | Yes — TaskCompleted hook is a built-in Claude Code hook type | needs-wrapping | Hook type is native but custom quality-gate logic (lib/task-completion-checks.ts) must be preserved |
| 32 | hooks/MergeGuard.hook.ts | 55 | No built-in equivalent | KEEP | Merge prevention logic is RunGate-specific |
| 33 | hooks/PostCompact.hook.ts | 57 | Yes — PostCompact is a built-in Claude Code hook type | full-replace | Hook type is native; re-injection logic could use the built-in PostCompact directly |
| 34 | hooks/lib/agentDetection.ts | 70 | No built-in equivalent | KEEP | Agent detection utilities |
| 35 | hooks/AutoVerifyGate.hook.ts | 76 | No built-in equivalent | KEEP | Auto-verification gate logic |
| 36 | hooks/lib/utils.ts | 81 | No built-in equivalent | KEEP | Hook utility functions |
| 37 | hooks/VerifyPhaseLock.hook.ts | 81 | No built-in equivalent | KEEP | Phase locking for verification |
| 38 | hooks/lib/findWorkflow.ts | 101 | No built-in equivalent | KEEP | Workflow file resolution |
| 39 | hooks/lib/paths.ts | 111 | No built-in equivalent | KEEP | Hook path resolution |
| 40 | hooks/IssueCloseGuard.hook.ts | 116 | No built-in equivalent | KEEP | Issue close prevention logic |
| 41 | hooks/SpecSCGuard.hook.ts | 120 | No built-in equivalent | KEEP | SC guard for spec modifications |
| 42 | hooks/CommitEnforcement.hook.ts | 143 | No built-in equivalent | KEEP | Commit message and content enforcement |
| 43 | hooks/StaleTTLCleanup.hook.ts | 167 | Partial — Routines could schedule cleanup | WRAP | Cleanup logic is custom; scheduling could use Routines |
| 44 | hooks/AgentVerdictCapture.hook.ts | 179 | Yes — SubagentStop hook type is built-in | needs-wrapping | Hook type is native; verdict parsing and behavioral-cache population is custom |
| 45 | hooks/GateEnforcement.hook.ts | 273 | No built-in equivalent | KEEP | Gate enforcement pipeline logic |
| 46 | hooks/AgentBriefGuard.hook.ts | 586 | No built-in equivalent | KEEP | Agent brief validation, largest hook |

### scripts/ — CLI Scripts (25 files, 7111 lines)

| # | File | Lines | Built-in Equivalent | Coverage | Notes |
|---|------|-------|---------------------|----------|-------|
| 47 | scripts/promote-outputs.ts | 17 | No built-in equivalent | KEEP | Output promotion CLI |
| 48 | scripts/generate-spec-template-patterns.ts | 69 | No built-in equivalent | KEEP | Spec template generation |
| 49 | scripts/create-brief.ts | 70 | No built-in equivalent | KEEP | Brief creation CLI |
| 50 | scripts/generate-governs.ts | 74 | No built-in equivalent | KEEP | Governs field generation |
| 51 | scripts/create-sc.ts | 88 | No built-in equivalent | KEEP | SC creation CLI |
| 52 | scripts/scaffold-rungate-config.ts | 91 | No built-in equivalent | KEEP | Config scaffolding |
| 53 | scripts/scan-stale-issues.ts | 110 | Partial — Routines could schedule | WRAP | Scan logic custom; scheduling replaceable |
| 54 | scripts/validate-scorer.ts | 140 | No built-in equivalent | KEEP | Scorer validation |
| 55 | scripts/update-project-state.ts | 142 | No built-in equivalent | KEEP | Project state update CLI |
| 56 | scripts/decision-reconcile.ts | 152 | No built-in equivalent | KEEP | Council decision reconciliation |
| 57 | scripts/detect-sc-drift.ts | 164 | No built-in equivalent | KEEP | SC drift detection |
| 58 | scripts/create-spec.ts | 165 | No built-in equivalent | KEEP | Spec creation CLI |
| 59 | scripts/da-compliance.ts | 214 | No built-in equivalent | KEEP | DA compliance checking |
| 60 | scripts/test-rules.ts | 216 | No built-in equivalent | KEEP | Rule testing CLI |
| 61 | scripts/sync-spec-tests.ts | 236 | No built-in equivalent | KEEP | Spec-to-test synchronization |
| 62 | scripts/compliance-loop.ts | 248 | No built-in equivalent | KEEP | Compliance loop iteration |
| 63 | scripts/audit-transcript.ts | 259 | No built-in equivalent | KEEP | Transcript audit CLI |
| 64 | scripts/extract-constraints.ts | 260 | No built-in equivalent | KEEP | Constraint extraction from specs |
| 65 | scripts/split-spec.ts | 315 | No built-in equivalent | KEEP | Spec splitting utility |
| 66 | scripts/generate-code-map.ts | 339 | No built-in equivalent | KEEP | Code map generation |
| 67 | scripts/analyze-transcript.ts | 347 | No built-in equivalent | KEEP | Intentionally custom — transcript analysis with efficiency metrics |
| 68 | scripts/grade-deterministic.ts | 364 | No built-in equivalent | KEEP | Deterministic grading engine |
| 69 | scripts/sync-sc-status.ts | 394 | No built-in equivalent | KEEP | SC status synchronization |
| 70 | scripts/audit-specs.ts | 469 | No built-in equivalent | KEEP | Spec audit engine |
| 71 | scripts/test-brief.ts | 469 | No built-in equivalent | KEEP | Brief testing CLI |
| 72 | scripts/scaffold-project.ts | 1699 | No built-in equivalent | KEEP | Intentionally custom — project scaffolding, largest script, core RunGate feature |

### workflows/ — Multi-Agent Workflows (5 files, 3537 lines)

| # | File | Lines | Built-in Equivalent | Coverage | Notes |
|---|------|-------|---------------------|----------|-------|
| 73 | workflows/verify.js | 236 | No built-in equivalent | KEEP | Verification workflow |
| 74 | workflows/batch-ship.js | 295 | Partial — /batch command exists | partial-overlap | /batch runs parallel worktree agents but lacks RunGate gate integration |
| 75 | workflows/council.js | 501 | Partial — Agent Teams could replace coordination layer | partial-overlap | See detailed Agent Teams assessment below |
| 76 | workflows/ship-and-heal.js | 534 | No built-in equivalent | KEEP | Ship-and-heal loop is RunGate-specific |
| 77 | workflows/prove.js | 640 | No built-in equivalent | KEEP | Prove workflow with evidence collection |
| 78 | workflows/ship.js | 1331 | No built-in equivalent | KEEP | Ship workflow orchestration, RunGate core |

### gates/ — Quality Gates (21 files, 7831 lines)

| # | File | Lines | Built-in Equivalent | Coverage | Notes |
|---|------|-------|---------------------|----------|-------|
| 79 | gates/test-utils.ts | 43 | No built-in equivalent | KEEP | Gate test utilities |
| 80 | gates/preload.ts | 77 | No built-in equivalent | KEEP | Gate preloading |
| 81 | gates/chain.test.ts | 91 | No built-in equivalent | KEEP | Gate chain tests |
| 82 | gates/error-classifier.ts | 91 | No built-in equivalent | KEEP | Error classification for gate failures |
| 83 | gates/ac-quality.test.ts | 106 | No built-in equivalent | KEEP | AC quality tests |
| 84 | gates/self-heal.ts | 121 | No built-in equivalent | KEEP | Self-healing gate logic |
| 85 | gates/prove.test.ts | 164 | No built-in equivalent | KEEP | Prove gate tests |
| 86 | gates/schema-parity.test.ts | 197 | No built-in equivalent | KEEP | Schema parity tests |
| 87 | gates/e2e-smoke.test.ts | 234 | No built-in equivalent | KEEP | E2E smoke tests |
| 88 | gates/error-classifier.test.ts | 250 | No built-in equivalent | KEEP | Error classifier tests |
| 89 | gates/adversarial.test.ts | 274 | No built-in equivalent | KEEP | Adversarial tests |
| 90 | gates/witness.ts | 220 | No built-in equivalent | KEEP | Witness verification gate |
| 91 | gates/schema.ts | 362 | No built-in equivalent | KEEP | Gate schema definitions |
| 92 | gates/ship-orchestrator.ts | 363 | No built-in equivalent | KEEP | Ship orchestration gate |
| 93 | gates/ship-orchestrator.test.ts | 379 | No built-in equivalent | KEEP | Ship orchestrator tests |
| 94 | gates/brief-assembler.ts | 347 | No built-in equivalent | KEEP | Brief assembly gate |
| 95 | gates/brief-assembler.test.ts | 429 | No built-in equivalent | KEEP | Brief assembler tests |
| 96 | gates/self-heal.test.ts | 511 | No built-in equivalent | KEEP | Self-heal tests |
| 97 | gates/orchestrator.ts | 573 | No built-in equivalent | KEEP | Orchestrator gate logic |
| 98 | gates/orchestrator.test.ts | 956 | No built-in equivalent | KEEP | Orchestrator tests |
| 99 | gates/run-gate.ts | 986 | No built-in equivalent | KEEP | Gate runner, core engine |
| 100 | gates/workflow.test.ts | 1057 | No built-in equivalent | KEEP | Workflow tests |

## Detailed Assessments

### SessionHarvester.ts — Does Not Exist

**Finding:** `SessionHarvester.ts` does not exist in the codebase. No file matching `SessionHarvester` was found in `lib/`, `hooks/`, `scripts/`, `gates/`, or `workflows/`. The closest existing module is `scripts/analyze-transcript.ts` (347 lines), which extracts efficiency metrics from transcripts but does not perform session harvesting in the session-lifecycle sense. The `lib/behavioral-cache.ts` (78 lines) caches behavioral results but is not a session harvester. No migration or deletion needed — the file was never implemented.

### WorkCompletionLearning.hook.ts — Does Not Exist

**Finding:** `WorkCompletionLearning.hook.ts` does not exist in the codebase. No file matching `WorkCompletionLearning` was found in `hooks/` or anywhere else. The closest existing hooks are `hooks/TaskCompleted.hook.ts` (48 lines, quality gate on task completion) and `hooks/AgentVerdictCapture.hook.ts` (179 lines, captures agent verdicts post-run). Neither performs work-completion learning extraction. No migration or deletion needed — the file was never implemented.

### prior-branch.ts — Branch Resumption Assessment

**Module:** `lib/prior-branch.ts` (79 lines)
**Function:** `detectPriorBranch()` — finds branches matching an issue number via regex, picks most recent by git log timestamps, counts commits ahead of main, optionally runs `bun test` in a temporary worktree.

**Claude Code built-in capability:** Claude Code has session resume functionality that can restore context from a previous session, but it does not provide:
- Issue-number-to-branch matching via regex with word-boundary checks
- Commit-count tracking ahead of main
- Test execution in temporary worktrees for prior branch validation

**Assessment:** Partial overlap. Claude Code handles session continuity but not branch detection by issue number. The module's value is in connecting issue tracking to branch state — a RunGate-specific concern. **Coverage: needs-wrapping** — the module should be retained as custom code. If Claude Code adds issue-aware branch detection in the future, the regex matching and test-in-worktree logic would still be custom.

**Retention rationale:** prior-branch.ts bridges issue numbers to git branches with word-boundary matching (e.g., issue 550 matches `550-matcher-registry` but issue 55 does NOT match `550-*`). This precision is RunGate-specific and not covered by any Claude Code built-in.

### worktree-cleanup.ts — Worktree Lifecycle Assessment

**Module:** `lib/worktree-cleanup.ts` (166 lines)
**Function:** Safety-first worktree cleanup — NEVER removes worktrees with uncommitted changes or unmerged branches. Filters by age, checks `git status --porcelain`, verifies branch merge status.

**Claude Code built-in capability:** Claude Code creates and manages worktrees natively for parallel agent execution. It handles basic worktree lifecycle (create, use, remove). However, Claude Code does not provide:
- Age-based filtering (maxAgeMs parameter)
- Safety checks for uncommitted changes before removal
- Branch merge verification before cleanup
- Bulk cleanup with structured reporting (CleanupResult shape)

**Assessment:** Partial overlap. Claude Code manages individual worktree lifecycles but lacks the safety-first bulk cleanup with age filtering that worktree-cleanup.ts provides. **Coverage: partial-overlap** — Claude Code handles creation and basic teardown; RunGate adds the safety layer on top.

**Retention rationale:** worktree-cleanup.ts is a safety module that prevents data loss. Claude Code's native worktree management does not include the "never remove uncommitted changes" or "never remove unmerged branches" guarantees. Removing this module would risk losing work in worktrees. Retain as intentionally custom.

### Council and Parallel Coordination — Agent Teams Assessment

**Modules:**
- `workflows/council.js` (501 lines) — 5-phase council debate workflow
- `workflows/ship.js` (1331 lines) — ship orchestration with parallel agents
- `workflows/batch-ship.js` (295 lines) — batch parallel worktree execution
- `scripts/decision-reconcile.ts` (152 lines) — verifies council decisions in target docs
- `specs/PARALLEL-AGENT-COORDINATION-SPEC.md` — governs file-claim manifests and module-boundary decomposition

**Claude Code Agent Teams capability:**
- Independent teammates with shared task list and direct messaging
- Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- Existing `.claude/agents/*.md` definitions work as teammate definitions
- Cost: 3-5x more tokens per session
- TeammateIdle hook for re-verification

**Assessment:** Agent Teams could replace the coordination LAYER of council.js (how agents communicate) but NOT the domain logic:
- Council's 5-phase structure (Research → R1 → R2 → R3 → Synthesis) is RunGate-specific
- `SYNTHESIS_SCHEMA` with `enforcementClassification` (MECHANICAL vs BEHAVIORAL) is RunGate-specific
- `specAlignment` validation is RunGate-specific
- File-claim manifests (D-1) and module-boundary decomposition (D-2) are RunGate-specific
- Decision reconciliation against target documents is RunGate-specific

**Coverage: partial-overlap** — Agent Teams provides the messaging substrate; RunGate provides the structured debate protocol, schema enforcement, and spec alignment checks on top. The council workflow could be refactored to use Agent Teams as the communication layer while retaining all domain logic.

**Net impact if Agent Teams adopted:** The coordination plumbing in `council.js` (parallel spawning, message passing between rounds) could shrink by an estimated 100-150 lines. The remaining 350+ lines of schema enforcement, phase logic, and synthesis rules would remain custom. `batch-ship.js` could potentially be replaced by `/batch` if gate integration were added.

## Built-in Equivalent Summary

### Items With Built-in Equivalents (10 assessments)

| File | Built-in Feature | Classification |
|------|-----------------|----------------|
| hooks/PostCompact.hook.ts | PostCompact hook | full-replace — hook type is native, logic is re-injection |
| hooks/TaskCompleted.hook.ts | TaskCompleted hook | needs-wrapping — hook type native, quality-gate logic custom |
| hooks/AgentVerdictCapture.hook.ts | SubagentStop hook | needs-wrapping — hook type native, verdict parsing custom |
| hooks/SpecConformityTrigger.hook.ts | FileChanged hook | needs-wrapping — trigger replaceable, conformity logic custom |
| hooks/StaleTTLCleanup.hook.ts | Routines (cron) | needs-wrapping — cleanup logic custom, scheduling replaceable |
| lib/prior-branch.ts | Session resume (partial) | needs-wrapping — branch detection custom, session continuity partial |
| lib/worktree-cleanup.ts | Worktree lifecycle (partial) | partial-overlap — safety layer custom, basic lifecycle native |
| lib/worktree-isolation.ts | Worktree creation (partial) | partial-overlap — transcript persistence custom |
| lib/agent-audit.ts | SubagentStop hook (partial) | needs-wrapping — audit logic custom, trigger native |
| lib/stale-issue-scanner.ts | Routines (partial) | needs-wrapping — scan logic custom, scheduling replaceable |
| lib/task-completion-checks.ts | TaskCompleted hook (partial) | needs-wrapping — check logic custom, trigger native |
| workflows/council.js | Agent Teams (partial) | partial-overlap — messaging replaceable, protocol custom |
| workflows/batch-ship.js | /batch command (partial) | partial-overlap — parallel execution exists, gate integration missing |
| scripts/scan-stale-issues.ts | Routines (partial) | needs-wrapping — scan logic custom, scheduling replaceable |

### Items Intentionally Custom — Retention Rationale (14 entries)

| File | Lines | Rationale |
|------|-------|-----------|
| lib/conformity.ts | 1643 | Core RunGate differentiator — conformity engine is the product. No built-in equivalent exists or could exist. Intentionally custom. |
| lib/transcript-checker.ts | 845 | Intentionally custom — cross-references extracted directives against agent tool calls producing compliance verdicts. Project-specific compliance logic with no built-in equivalent. |
| scripts/scaffold-project.ts | 1699 | Intentionally custom — project scaffolding is core RunGate feature. Generates AGENTS.md, CODE-MAP, CI configs. No equivalent. |
| scripts/analyze-transcript.ts | 347 | Intentionally custom — produces efficiency metrics (file efficiency, tool breakdown, duplicate reads) specific to RunGate's audit methodology. |
| lib/canary.ts | 117 | Intentionally custom — canary value planting and verification is a novel testing approach unique to RunGate. |
| lib/hill-climb.ts | 164 | Intentionally custom — hill-climbing optimization for instruction quality. Novel approach, no equivalent. |
| lib/aes-calculator.ts | 66 | Intentionally custom — Agent Effectiveness Score is a RunGate-specific metric. |
| lib/behavioral-cache.ts | 78 | Intentionally custom — caches behavioral SC results with 7-day staleness. Project-specific caching with no built-in equivalent. |
| lib/create-brief.ts | 99 | Intentionally custom — agent brief generation from templates is core RunGate. |
| gates/run-gate.ts | 986 | Intentionally custom — gate runner is core RunGate pipeline logic. No equivalent. |
| gates/orchestrator.ts | 573 | Intentionally custom — orchestrates gate execution sequence. No equivalent. |
| workflows/ship.js | 1331 | Intentionally custom — ship workflow with gate integration is RunGate's primary workflow. |
| workflows/prove.js | 640 | Intentionally custom — evidence collection and prove workflow is RunGate-specific. |
| lib/create-sc.ts | 253 | Intentionally custom — success criteria creation is core RunGate. |

## Surface Area Summary

### Total Custom Code Baseline

| Directory | Files | Lines | Source Lines (non-test) |
|-----------|-------|-------|------------------------|
| lib/ | 27 | 5,452 | 5,452 |
| hooks/ | 19 | 2,378 | 2,378 |
| scripts/ | 25 | 7,111 | 7,111 |
| workflows/ | 5 | 3,537 | 3,537 |
| gates/ | 21 | 7,831 | 3,183 (4,648 test) |
| **Total** | **97** | **26,309** | **21,661** |

### Net Reduction Analysis

| Category | Files | Lines | Action |
|----------|-------|-------|--------|
| Full-replace (PostCompact) | 1 | 57 | Could be replaced entirely by built-in PostCompact hook |
| Needs-wrapping (hook types native, logic custom) | 8 | ~700 | Hook registration boilerplate reducible; custom logic retained |
| Partial-overlap (worktree, council, batch) | 5 | ~1,044 | Communication/coordination layer replaceable; domain logic retained |
| Intentionally custom (no equivalent) | 83 | ~19,860 | Retain — core RunGate value |

**Estimated reducible surface area:** ~200 lines of hook registration boilerplate + ~150 lines of council coordination plumbing = **~350 lines** (1.6% of total source).

**Net change:** The vast majority of RunGate's 21,661 source lines are intentionally custom with no built-in equivalent. The reducible surface area is minimal because Claude Code built-ins provide triggers and scheduling but not the domain logic that runs inside them. RunGate's value is in the domain logic (conformity, compliance, canary testing, hill climbing, transcript analysis), not in the plumbing.

**Recommendation:** Adopt built-in hook types (PostCompact, TaskCompleted, SubagentStop) as triggers while retaining all custom logic in `lib/` modules. This aligns with the existing hook architecture spec (HOOK-ARCHITECTURE-SPEC.md): hooks are thin triggers delegating to lib/ modules. The built-in hook types make the triggers thinner, not the logic.
