---
doc-type: research
status: active
owner: marcus
updated: 2026-09-29
issue: "#583"
governs: []
---

# Feature Parity Audit — PAI/RunGate vs Claude Code Built-ins

Inventory of all custom code across hooks, lib, scripts, gates, and workflows directories.
Each entry is classified against Claude Code built-in equivalents and given a migration recommendation.
Cross-referenced with `docs/research/2026-09-24-claude-code-feature-audit.md`.

## Classification Key

| Classification | Meaning |
|---------------|---------|
| **REPLACE** (full-replace) | Claude Code built-in fully covers this functionality. Custom code can be removed. |
| **WRAP** (needs-wrapping) | Claude Code provides the hook point/trigger, but custom logic must be preserved inside it. |
| **KEEP** | No built-in equivalent. Intentionally custom -- RunGate's core differentiator or domain-specific logic. |
| **partial-overlap** | Some overlap with built-in features but custom logic adds significant value beyond what is built in. |

---

## Surface Area Summary

| Directory | Files | Lines | Baseline |
|-----------|-------|-------|----------|
| hooks/ (including lib/) | 19 | 1,514 | Custom hook implementations + shared utilities |
| lib/ (including generators, validators, scaffold) | 42 | 9,940 | Core library modules |
| scripts/ (including lib/, git-hooks/) | 39 | 7,060 | CLI tools, shell scripts, git hooks |
| gates/ (including prompts/) | 26 | 8,229 | Gate execution engine + tests + prompts |
| workflows/ | 6 | 3,716 | Multi-agent workflow orchestration |
| **Total** | **132** | **30,459** | **Total custom code surface area** |

Net reduction from this audit: **0 lines removed**. All custom code is either intentionally custom with no built-in equivalent, or uses built-in hook events as thin triggers while keeping custom domain logic. No full-replace candidates identified -- RunGate's value IS the custom logic.

---

## Inventory and Assessment

### hooks/ (14 hook files + 5 lib files = 1,514 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 1 | hooks/AgentBriefGuard.hook.ts | 64 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger is built-in. Custom brief-validation logic (template compliance, ship-active marker enforcement) has no built-in equivalent and must be preserved inside the handler. |
| 2 | hooks/AgentVerdictCapture.hook.ts | 87 | partial | WRAP (needs-wrapping) | SubagentStop hook trigger is built-in (fires on agent completion per 2026-09-24 feature audit). Custom logic: verdict JSON parsing, workflow-state writes, transcript audit invocation, behavioral-cache population. The hook EVENT is native; the HANDLER is entirely RunGate-specific. |
| 3 | hooks/AutoVerifyGate.hook.ts | 79 | partial | WRAP (needs-wrapping) | PostToolUse hook trigger is built-in. Custom DA-nudge logic for verify gate after agent completion is RunGate workflow-specific. |
| 4 | hooks/CommitEnforcement.hook.ts | 146 | partial | WRAP (needs-wrapping) | PostToolUse hook trigger is built-in. Custom logic detecting uncommitted changes and UI file modifications in agent worktrees is RunGate enforcement policy. |
| 5 | hooks/GateEnforcement.hook.ts | 97 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger is built-in. Custom nag-on-failure counting, strike tracking, and Skill-call blocking are RunGate gate state machine logic. |
| 6 | hooks/IssueCloseGuard.hook.ts | 119 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger (Bash matcher) is built-in. HMAC validation and ship-gate PASS verification before `gh issue close` are security/workflow logic with no built-in parallel. |
| 7 | hooks/MergeGuard.hook.ts | 58 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger (Bash matcher) is built-in. Early warning on unverified merge to main is RunGate workflow policy. |
| 8 | hooks/PostCompact.hook.ts | 60 | partial | WRAP (partial-overlap) | PostCompact hook trigger is built-in. Custom logic extracts rules sections from CLAUDE.md and AGENTS.md via regex parsing and re-injects them as system-reminder after context compaction. The trigger mechanism is built-in but the rule extraction and re-injection logic is custom. Cannot be full-replace because the built-in PostCompact only fires the hook -- it does not know which rules to re-inject or how to extract them from markdown. |
| 9 | hooks/SpecConformityTrigger.hook.ts | 43 | partial | WRAP (needs-wrapping) | PostToolUse hook trigger (Edit\|Write matcher) is built-in. FileChanged hook (Tier 2 per feature audit) could also trigger on spec file changes. Custom logic decides when to re-run conformity checks. |
| 10 | hooks/SpecSCGuard.hook.ts | 123 | partial | WRAP (needs-wrapping) | PostToolUse hook trigger is built-in. SC pattern validation logic is entirely RunGate domain enforcement. |
| 11 | hooks/StaleTTLCleanup.hook.ts | 63 | partial | WRAP (needs-wrapping) | SessionStart hook trigger is built-in. Stale workflow-state.json and ship-active file cleanup with TTL-based expiration is RunGate lifecycle management. |
| 12 | hooks/TaskCompleted.hook.ts | 51 | partial | WRAP (needs-wrapping) | TaskCompleted hook trigger is built-in (exit code 2 blocks task completion). Custom quality gate logic (test suite verification, uncommitted changes warning, conformity check) must be preserved. The built-in only provides the gating mechanism; all check logic lives in `lib/task-completion-checks.ts`. |
| 13 | hooks/VerifyPhaseLock.hook.ts | 84 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger (Bash matcher) is built-in. Phase-lock logic blocking `gh issue create` during VERIFY is RunGate workflow state management. |
| 14 | hooks/WorkflowStateGuard.hook.ts | 40 | partial | WRAP (needs-wrapping) | PreToolUse hook trigger (Write\|Edit matcher) is built-in. Direct Write/Edit blocking of workflow-state.json is RunGate integrity enforcement. |
| 15 | hooks/lib/parseStdin.ts | 37 | no | KEEP | Intentionally custom -- parses Claude Code hook stdin JSON format. Adapter layer between Claude Code's hook protocol and RunGate's hook handlers. |
| 16 | hooks/lib/agentDetection.ts | 70 | no | KEEP | Intentionally custom -- identifies agent roles from tool input payloads for RunGate's multi-agent workflow. No built-in equivalent for role detection. |
| 17 | hooks/lib/findWorkflow.ts | 101 | no | KEEP | Intentionally custom -- locates active workflow-state.json files for RunGate's stateful ship workflow. Workflow state management is RunGate's core orchestration layer. |
| 18 | hooks/lib/paths.ts | 111 | no | KEEP | Intentionally custom -- resolves RunGate-specific paths (harness root, project root, work dir). Path resolution for RunGate's multi-project scaffold architecture. |
| 19 | hooks/lib/utils.ts | 81 | no | KEEP | Intentionally custom -- shared hook utilities (JSON parsing, config loading) for RunGate hooks. |

**Hooks Summary:** All 14 hooks use Claude Code hook points as triggers (WRAP) but contain RunGate-specific logic that has no built-in equivalent. Zero hooks are full-replace candidates. The 5 hooks/lib/ files are KEEP -- internal utilities with no external equivalent.

---

### lib/ (42 files = 9,940 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 20 | lib/conformity.ts | 1,826 | no | KEEP | Intentionally custom -- RunGate's core conformity engine. 18+ pattern matchers, SC validation, scaffold conformity tests, spec discovery, spec drift detection, SC checkbox auto-flip. This IS RunGate's primary differentiator. No agent platform provides automated spec conformity testing with pluggable matchers. 1,826 lines of domain logic with zero overlap with any built-in feature. |
| 21 | lib/scaffold/steps.ts | 1,286 | no | KEEP | Intentionally custom -- scaffold generation step definitions producing AGENTS.md, agent briefs, CI workflows, CODE-MAP.md, and conformity tests from project config. Core scaffold pipeline with no built-in equivalent. |
| 22 | lib/transcript-checker.ts | 845 | no | KEEP | Intentionally custom -- transcript compliance checker cross-referencing extracted directives against agent tool calls. Produces FOLLOWED/IGNORED/VIOLATED verdicts per directive. Includes role-based evaluation criteria, TDD detection, scoring, and grading. Novel instruction-compliance verification with no equivalent in any agent platform. |
| 23 | lib/scanner.ts | 677 | no | KEEP | Intentionally custom -- codebase scanner discovering specs, tests, routes, components, and generating structural metadata. Feeds into scaffold generation and CODE-MAP.md. |
| 24 | lib/agent-brief-validation.ts | 357 | no | KEEP | Intentionally custom -- validates agent brief templates against RunGate's template spec (AGENT-BRIEF-TEMPLATE-SPEC). No built-in brief validation exists. |
| 25 | lib/compliance.ts | 322 | no | KEEP | Intentionally custom -- compliance scoring, DA compliance grading, and behavioral compliance assessment. Core part of RunGate's instruction effectiveness measurement system. |
| 26 | lib/rule-health-pipeline.ts | 264 | no | KEEP | Intentionally custom -- rule health scoring pipeline tracking which rules are followed vs ignored across sessions. Feeds hill-climb optimization. No equivalent in any agent platform. |
| 27 | lib/create-sc.ts | 253 | no | KEEP | Intentionally custom -- success criteria creation with pattern-based templates and frontmatter validation. SC authoring is a RunGate-specific concept. |
| 28 | lib/branch-cleanup.ts | 238 | partial | partial-overlap | Claude Code has git operations (branch, delete) but no automated branch cleanup policy. Custom logic: age-based filtering, PR merge-status checks via `gh pr list`, safety guards preventing deletion of unmerged branches. The git primitives overlap; the automation policy is custom. |
| 29 | lib/gate-enforcement.ts | 227 | no | KEEP | Intentionally custom -- gate enforcement state machine tracking strikes, nag messages, and Skill-call blocking after max failures. RunGate's quality gate mechanism. |
| 30 | lib/directive-extractor.ts | 190 | no | KEEP | Intentionally custom -- extracts structured directives (read, run, never, always) from agent brief markdown using pattern matching. Feeds transcript compliance checking. Novel NLP-like extraction with no built-in equivalent. |
| 31 | lib/evidence-prevalidator.ts | 179 | no | KEEP | Intentionally custom -- pre-validates acceptance criteria evidence commands match threshold operators before execution. Prevents false gate failures from mismatched operators (>=, ==, !=). |
| 32 | lib/task-completion-checks.ts | 177 | partial | WRAP (needs-wrapping) | Claude Code's TaskCompleted hook provides the gating mechanism (exit 2 blocks). The custom quality checks (test suite pass, uncommitted changes warning, conformity validation) run inside that gate. The checks themselves are RunGate-specific; the blocking mechanism is built-in. |
| 33 | lib/generators/types.ts | 177 | no | KEEP | Intentionally custom -- TypeScript types for RunGate's scaffold generator pipeline. Domain-specific type definitions. |
| 34 | lib/worktree-cleanup.ts | 166 | partial | partial-overlap | See detailed assessment in Section 7 below. Claude Code manages worktree lifecycle natively (EnterWorktree/ExitWorktree) but RunGate's `cleanupWorktrees` adds custom stale-detection logic: age filtering via maxAgeMs, uncommitted-change safety checks, unmerged-branch protection via `git branch --merged main`, detached HEAD handling, git worktree prune, and structured CleanupResult reporting. |
| 35 | lib/hill-climb.ts | 164 | no | KEEP | Intentionally custom -- hill-climb optimization for agent brief compliance. Iteratively tweaks brief directives based on 7 compliance factors (position, language, specificity, deduplication, section, evidence, consolidation). Five-iteration max with target score convergence. Novel optimization approach with no equivalent in any agent platform. |
| 36 | lib/rule-health-trend.ts | 161 | no | KEEP | Intentionally custom -- tracks rule health trends over time for compliance degradation detection. |
| 37 | lib/generators/agents-md.ts | 161 | no | KEEP | Intentionally custom -- generates AGENTS.md content from scanned project metadata (specs, tests, commands, documentation). |
| 38 | lib/prior-branch.ts | 160 | partial | partial-overlap | See detailed assessment in Section 6 below. Claude Code's session resume overlaps minimally. RunGate's `detectPriorBranch` provides issue-number-based branch detection with word-boundary regex, multi-branch timestamp disambiguation, and test verification in temporary worktrees. `detectExistingPR` queries GitHub PR API for issue-linked PRs. Both functions contain custom logic that would be lost in any migration. |
| 39 | lib/create-brief.ts | 160 | no | KEEP | Intentionally custom -- creates agent brief markdown from templates with variable substitution. RunGate's brief generation system. |
| 40 | lib/sc-guard.ts | 157 | no | KEEP | Intentionally custom -- validates new SC lines in spec files have matching patterns in the conformity engine. Spec integrity enforcement. |
| 41 | lib/post-fix-verify.ts | 157 | no | KEEP | Intentionally custom -- re-runs verification after fixes to confirm resolution. Post-fix quality assurance. |
| 42 | lib/promote-outputs.ts | 156 | no | KEEP | Intentionally custom -- promotes workflow outputs (council synthesis, research findings) to persistent locations. |
| 43 | lib/agent-audit.ts | 139 | no | KEEP | Intentionally custom -- post-completion agent audit grading transcript compliance against brief directives. Core of RunGate's behavioral feedback loop. |
| 44 | lib/instruction-effectiveness.ts | 131 | no | KEEP | Intentionally custom -- cross-references instruction language quality with auditor compliance results to determine which specific words and phrasings produce agent behavior. Novel instruction-effectiveness measurement. |
| 45 | lib/generators/agent-briefs.ts | 129 | no | KEEP | Intentionally custom -- generates agent brief files from externalized markdown templates with variable substitution. |
| 46 | lib/rule-registry.ts | 128 | no | KEEP | Intentionally custom -- registry of all rules across specs and briefs for compliance tracking and rule-health scoring. |
| 47 | lib/canary.ts | 117 | no | KEEP | Intentionally custom -- canary testing system that plants known values in generated files and checks if agents USE them. Five-layer measurement model. Novel verification approach with no external equivalent. |
| 48 | lib/validators/spec-validators.ts | 115 | no | KEEP | Intentionally custom -- spec file validators (frontmatter fields, SC format, governs field presence, testable flag). |
| 49 | lib/stale-cleanup.ts | 100 | no | KEEP | Intentionally custom -- stale workflow-state.json and ship-active file cleanup with TTL-based expiration. |
| 50 | lib/worktree-isolation.ts | 82 | partial | partial-overlap | Claude Code creates worktrees natively via EnterWorktree for agent spawning. RunGate's custom worktree-isolation adds transcript directory persistence outside the worktree (survives cleanup) and branch-name conventions (prefix + timestamp + random). The worktree creation overlaps; the transcript management and naming conventions are custom. |
| 51 | lib/spec-change-conformity.ts | 80 | no | KEEP | Intentionally custom -- detects spec changes and triggers conformity re-validation. |
| 52 | lib/behavioral-cache.ts | 78 | no | KEEP | Intentionally custom -- caches behavioral compliance data from agent audits with 7-day TTL for cross-session learning. No session harvesting built-in exists. |
| 53 | lib/rungate-schema.ts | 75 | no | KEEP | Intentionally custom -- JSON schema for rungate.json configuration validation. |
| 54 | lib/verdict-capture.ts | 73 | no | KEEP | Intentionally custom -- extracts structured verdict blocks (verdict, testedSha, testedPaths, blockers) from agent output text. |
| 55 | lib/aes-calculator.ts | 66 | no | KEEP | Intentionally custom -- Agent Effectiveness Score calculator combining compliance, efficiency, and quality metrics. |
| 56 | lib/generators/code-map.ts | 60 | no | KEEP | Intentionally custom -- generates CODE-MAP.md from scanned codebase structure (routes, components, modules, health). |
| 57 | lib/stale-issue-scanner.ts | 36 | no | KEEP | Intentionally custom -- scans for stale GitHub issues based on TTL thresholds. |
| 58 | lib/brief-context-parser.ts | 35 | no | KEEP | Intentionally custom -- parses context sections from agent brief files for ordering and validation. |
| 59 | lib/paths.ts | 23 | no | KEEP | Intentionally custom -- path constants for RunGate's directory structure. |
| 60 | lib/signal-phrases.ts | 7 | no | KEEP | Intentionally custom -- signal phrase regex patterns for directive extraction. |
| 61 | lib/eval-criteria.ts | 6 | no | KEEP | Intentionally custom -- re-exports evaluation criteria types for transcript checking. |

**Lib Summary:** 42 files, 9,940 lines. 37 files (8,933 lines) are KEEP -- core RunGate domain logic with no built-in equivalent. 4 files (646 lines) are partial-overlap with some built-in feature coverage. 1 file (177 lines) is WRAP. Zero files are full-replace.

---

### scripts/ (27 .ts + 10 .sh + 2 git hooks = 39 files, 7,060 lines)

#### TypeScript Scripts

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 62 | scripts/test-brief.ts | 469 | no | KEEP | Intentionally custom -- test-brief runner that spawns agents in worktrees and grades transcript compliance. Core of RunGate's compliance testing system. |
| 63 | scripts/audit-specs.ts | 469 | no | KEEP | Intentionally custom -- audits spec files for completeness, SC coverage, frontmatter correctness, and structural issues. |
| 64 | scripts/sync-sc-status.ts | 394 | no | KEEP | Intentionally custom -- syncs SC checkbox status between spec files and GitHub issues. |
| 65 | scripts/grade-deterministic.ts | 386 | no | KEEP | Intentionally custom -- deterministic grading of agent transcripts against directive compliance. Produces machine-readable scores. |
| 66 | scripts/analyze-transcript.ts | 347 | no | KEEP | Intentionally custom -- transcript analysis producing compliance reports, tool call breakdowns, and behavioral data. |
| 67 | scripts/generate-code-map.ts | 339 | no | KEEP | Intentionally custom -- generates CODE-MAP.md from codebase scans. |
| 68 | scripts/split-spec.ts | 315 | no | KEEP | Intentionally custom -- splits monolithic specs into focused spec files with correct frontmatter. |
| 69 | scripts/extract-constraints.ts | 260 | no | KEEP | Intentionally custom -- extracts constraint candidates from codebase documentation for SC promotion. |
| 70 | scripts/audit-transcript.ts | 259 | no | KEEP | Intentionally custom -- audits individual transcripts for compliance violations. CLI wrapper. |
| 71 | scripts/compliance-loop.ts | 248 | no | KEEP | Intentionally custom -- runs the compliance hill-climb loop iterating on brief improvements. |
| 72 | scripts/sync-spec-tests.ts | 236 | no | KEEP | Intentionally custom -- syncs spec SCs to test file assertions. |
| 73 | scripts/test-rules.ts | 216 | no | KEEP | Intentionally custom -- tests individual rules for behavioral compliance. |
| 74 | scripts/da-compliance.ts | 214 | no | KEEP | Intentionally custom -- DA (directing agent) compliance auditing. |
| 75 | scripts/fresh-eyes-test.ts | 181 | no | KEEP | Intentionally custom -- fresh-eyes testing that verifies agents can navigate without prior context. |
| 76 | scripts/create-spec.ts | 165 | no | KEEP | Intentionally custom -- spec file creation with frontmatter and SC templates. |
| 77 | scripts/detect-sc-drift.ts | 164 | no | KEEP | Intentionally custom -- detects drift between spec SCs and implementation. |
| 78 | scripts/decision-reconcile.ts | 152 | no | KEEP | Intentionally custom -- reconciles council decisions with spec changes and target documents. |
| 79 | scripts/update-project-state.ts | 142 | no | KEEP | Intentionally custom -- updates project-state.json from codebase analysis. |
| 80 | scripts/validate-scorer.ts | 140 | no | KEEP | Intentionally custom -- validates scoring functions for compliance grading. |
| 81 | scripts/scaffold-project.ts | 133 | no | KEEP | Intentionally custom -- entry point for project scaffolding (delegates to lib/scaffold/steps.ts). |
| 82 | scripts/scan-stale-issues.ts | 110 | no | KEEP | Intentionally custom -- scans GitHub issues for staleness based on TTL thresholds. |
| 83 | scripts/scaffold-rungate-config.ts | 91 | no | KEEP | Intentionally custom -- generates initial rungate.json configuration. |
| 84 | scripts/create-sc.ts | 88 | no | KEEP | Intentionally custom -- SC creation CLI wrapper for lib/create-sc. |
| 85 | scripts/generate-governs.ts | 74 | no | KEEP | Intentionally custom -- generates governs field mappings for specs. |
| 86 | scripts/create-brief.ts | 70 | no | KEEP | Intentionally custom -- brief creation CLI wrapper. |
| 87 | scripts/generate-spec-template-patterns.ts | 69 | no | KEEP | Intentionally custom -- generates spec template patterns for SC creation. |
| 88 | scripts/promote-outputs.ts | 17 | no | KEEP | Intentionally custom -- CLI wrapper for lib/promote-outputs. |

#### Shell Scripts

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 89 | scripts/skill-qc-validator.sh | 402 | no | KEEP | Intentionally custom -- validates skill quality against RunGate standards. |
| 90 | scripts/self-containment-check.sh | 109 | no | KEEP | Intentionally custom -- verifies project self-containment (no broken references). |
| 91 | scripts/prove-backfill.sh | 87 | no | KEEP | Intentionally custom -- backfills proof evidence for existing SCs. |
| 92 | scripts/decision-reconcile.sh | 74 | no | KEEP | Intentionally custom -- shell wrapper for decision reconciliation. |
| 93 | scripts/harness-skill-check.sh | 52 | no | KEEP | Intentionally custom -- validates harness skill contract compliance. |
| 94 | scripts/slug-resolver.sh | 14 | no | KEEP | Intentionally custom -- resolves issue slugs for workflow state. |
| 95 | scripts/lib/verify-spec-compliance.sh | 102 | no | KEEP | Intentionally custom -- spec compliance verification shell functions. |
| 96 | scripts/lib/gap-emit.sh | 65 | no | KEEP | Intentionally custom -- emits gap findings in structured format. |
| 97 | scripts/lib/resolve-slug.sh | 30 | no | KEEP | Intentionally custom -- slug resolution utilities. |
| 98 | scripts/lib/jq-update.sh | 30 | no | KEEP | Intentionally custom -- jq-based JSON update utilities. |

#### Git Hooks

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 99 | scripts/git-hooks/pre-commit | 76 | partial | partial-overlap | Claude Code has its own pre-commit hook support. RunGate's pre-commit adds custom conformity checks beyond standard linting. |
| 100 | scripts/git-hooks/pre-push | 271 | partial | partial-overlap | Claude Code has its own pre-push support. RunGate's pre-push adds gate verification and SC compliance checks. |

**Scripts Summary:** 39 files, 7,060 lines. 37 files (6,713 lines) are KEEP. 2 files (347 lines) are partial-overlap with standard git hook support.

---

### gates/ (23 source files + 3 prompts = 26 files, 8,229 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 101 | gates/gate-executor.ts | 1,146 | no | KEEP | Intentionally custom -- gate execution engine running quality gates in sequence with pass/fail verdicts and structured output. Core of RunGate's quality assurance pipeline. No agent platform provides a gate execution framework. |
| 102 | gates/workflow.test.ts | 1,057 | no | KEEP | Intentionally custom -- workflow integration tests. |
| 103 | gates/orchestrator.test.ts | 956 | no | KEEP | Intentionally custom -- orchestrator unit tests. |
| 104 | gates/orchestrator.ts | 587 | no | KEEP | Intentionally custom -- orchestrates gate execution order and dependency resolution. |
| 105 | gates/self-heal.test.ts | 511 | no | KEEP | Intentionally custom -- self-heal mechanism tests. |
| 106 | gates/brief-assembler.test.ts | 429 | no | KEEP | Intentionally custom -- brief assembler tests. |
| 107 | gates/ship-orchestrator.test.ts | 379 | no | KEEP | Intentionally custom -- ship orchestrator tests. |
| 108 | gates/schema.ts | 373 | no | KEEP | Intentionally custom -- gate schema definitions and validation. |
| 109 | gates/ship-orchestrator.ts | 370 | no | KEEP | Intentionally custom -- ship workflow orchestration with gate chaining and state management. |
| 110 | gates/brief-assembler.ts | 355 | no | KEEP | Intentionally custom -- assembles agent briefs from templates, context, and workflow state. |
| 111 | gates/adversarial.test.ts | 274 | no | KEEP | Intentionally custom -- adversarial testing of gate robustness. |
| 112 | gates/error-classifier.test.ts | 250 | no | KEEP | Intentionally custom -- error classifier tests. |
| 113 | gates/witness.ts | 237 | no | KEEP | Intentionally custom -- witness pattern for gate execution auditing and evidence collection. |
| 114 | gates/e2e-smoke.test.ts | 234 | no | KEEP | Intentionally custom -- end-to-end smoke tests for gate pipeline. |
| 115 | gates/schema-parity.test.ts | 197 | no | KEEP | Intentionally custom -- schema parity tests ensuring gate schemas match implementation. |
| 116 | gates/prove.test.ts | 164 | no | KEEP | Intentionally custom -- prove gate tests. |
| 117 | gates/self-heal.ts | 125 | no | KEEP | Intentionally custom -- self-healing logic that classifies gate failures and suggests fixes. |
| 118 | gates/ac-quality.test.ts | 106 | no | KEEP | Intentionally custom -- acceptance criteria quality tests. |
| 119 | gates/error-classifier.ts | 99 | no | KEEP | Intentionally custom -- classifies gate errors for self-healing (transient vs structural vs config). |
| 120 | gates/chain.test.ts | 91 | no | KEEP | Intentionally custom -- gate chain tests. |
| 121 | gates/preload.ts | 89 | no | KEEP | Intentionally custom -- preloads gate dependencies for faster execution. |
| 122 | gates/run-gate.ts | 62 | no | KEEP | Intentionally custom -- gate runner entry point. |
| 123 | gates/test-utils.ts | 43 | no | KEEP | Intentionally custom -- test utilities for gate testing. |
| 124 | gates/prompts/ac-adversary.md | 20 | no | KEEP | Intentionally custom -- adversarial prompt for AC quality testing. |
| 125 | gates/prompts/evidence-validator.md | 22 | no | KEEP | Intentionally custom -- evidence validation prompt template. |
| 126 | gates/prompts/prove-reproducer.md | 53 | no | KEEP | Intentionally custom -- proof reproduction prompt template. |

**Gates Summary:** 26 files, 8,229 lines. All KEEP -- RunGate's gate execution engine and quality assurance pipeline is entirely custom domain logic with no built-in equivalent in any agent platform.

---

### workflows/ (6 files = 3,716 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 127 | workflows/ship.js | 1,510 | no | KEEP | Intentionally custom -- the ship workflow orchestrating GOAL -> DISCOVERY -> EXECUTION -> VERIFICATION with gate enforcement. Core harness workflow. No agent platform provides a multi-phase shipping workflow with quality gates. |
| 128 | workflows/prove.js | 640 | no | KEEP | Intentionally custom -- prove workflow spawning verification agents, collecting evidence, and grading results against acceptance criteria. |
| 129 | workflows/ship-and-heal.js | 534 | no | KEEP | Intentionally custom -- ship workflow with self-healing retry loop on gate failure. Classifies failures and adjusts retry strategy. |
| 130 | workflows/council.js | 501 | partial | partial-overlap | See detailed assessment in Section 8. Overlaps with Claude Code's experimental Agent Teams feature for multi-agent coordination, but council.js implements structured multi-round debate with progressive transcript passing, structured JSON schemas (POSITION_SCHEMA, SYNTHESIS_SCHEMA), enforcement classification (MECHANICAL/BEHAVIORAL), and spec alignment checking. Agent Teams provides the teammate communication channel; the structured debate protocol is custom. |
| 131 | workflows/batch-ship.js | 295 | partial | partial-overlap | Claude Code's `/batch` command provides parallel worktree agent execution. RunGate's batch-ship adds gate verification, SC tracking, and wave planning to the batch pattern. The parallelism mechanism overlaps; the quality gates and orchestration policy are custom. |
| 132 | workflows/verify.js | 236 | no | KEEP | Intentionally custom -- verification workflow running checks against acceptance criteria with evidence collection. |

**Workflows Summary:** 6 files, 3,716 lines. 4 files (2,920 lines) are KEEP. 2 files (796 lines) are partial-overlap with experimental built-in features.

---

## 6. Detailed Assessment: prior-branch.ts vs Claude Code Session Resume

**File:** `lib/prior-branch.ts` (160 lines)
**Classification:** partial-overlap

### What Claude Code Provides Natively

Claude Code has native session resume capabilities:
- Resumes prior conversation context when reopening a project
- Tracks which branch was active in the previous session
- Can detect and offer to continue work on an existing branch
- Session resume focuses on the most recent session, not arbitrary issues

### What RunGate's prior-branch.ts Provides

The module exports two functions with custom logic that has no built-in equivalent:

1. **`detectPriorBranch(opts: DetectOptions)`** (lines 36-91) -- Searches ALL local and remote branches for ones matching an issue number pattern using word-boundary regex (`(^|[^\d])${issueNumber}([^\d]|$)`). When multiple branches match, it sorts by most recent commit timestamp from `git log --format=%ct %D` to find the best candidate. It then creates a temporary worktree via `git worktree add`, runs the full test suite (`bun test`), and reports whether tests pass. This issue-number-based `detectPriorBranch` logic with test verification is entirely custom -- Claude Code's session resume does not search branches by issue number, disambiguate multiple matches, or verify test health before resuming.

2. **`detectExistingPR(opts: DetectExistingPROptions)`** (lines 113-153) -- Uses `gh pr list --search` to find open PRs referencing a specific issue number in their title. Applies word-boundary pattern matching to avoid false positives (issue 55 should not match PR titled "issue-550"). Returns the PR number and head branch name as a structured `ExistingPR` object. This `detectExistingPR` function has zero overlap with Claude Code -- no built-in feature queries GitHub's PR API for issue-linked PRs or performs word-boundary filtering on results.

### Overlap Analysis

| Capability | Claude Code Native | prior-branch.ts Custom | Overlap |
|-----------|-------------------|----------------------|---------|
| Resume last session | Yes | No (different goal) | None |
| Find branch by issue number | No | Yes (`detectPriorBranch`) | None |
| Word-boundary regex matching | No | Yes (prevents false positives) | None |
| Multi-branch timestamp disambiguation | No | Yes (picks most recent) | None |
| Test verification on prior branch | No | Yes (worktree + bun test) | None |
| Find open PR for issue | No | Yes (`detectExistingPR`) | None |
| Branch resumption after session restart | Partial (last branch only) | Yes (any issue's branch) | Minimal |

**Conclusion:** Claude Code's session resume and RunGate's prior-branch detection solve fundamentally different problems. Session resume continues the last conversation; `detectPriorBranch` finds prior work on a specific issue across all branches with test verification. The `detectExistingPR` function has zero overlap -- it queries GitHub's PR API for issue-linked PRs, which Claude Code does not do natively. Both `detectPriorBranch` and `detectExistingPR` contain custom logic that would be entirely lost in any migration. **Migration is not warranted.** The module should remain KEEP for its two exported functions.

---

## 7. Detailed Assessment: worktree-cleanup.ts vs Claude Code Worktree Lifecycle

**File:** `lib/worktree-cleanup.ts` (166 lines)
**Classification:** partial-overlap

### What Claude Code Provides Natively

Claude Code manages worktree lifecycle for agent spawning:
- Creates worktrees via EnterWorktree when spawning agents
- Removes worktrees via ExitWorktree when agents complete
- Automatically cleans up worktrees for no-change agents ("cleaned up automatically if you made no changes")
- The `/batch` command manages worktree lifecycle for parallel agents
- Worktree lifecycle management happens at agent completion, not on a schedule

### What RunGate's worktree-cleanup.ts Provides

The `cleanupWorktrees(opts: CleanupOptions)` function (lines 35-131) implements a safety-first batch cleanup with custom stale-detection logic that goes beyond Claude Code's per-agent worktree lifecycle:

1. **Age-based filtering** (`maxAgeMs` parameter, line 63-67) -- only cleans worktrees older than a threshold. Claude Code's worktree lifecycle does not have age-based cleanup; it cleans at agent completion or not at all. Stale worktrees from crashed agents or interrupted sessions accumulate without this.

2. **Uncommitted-change safety** (lines 73-82) -- runs `git status --porcelain` on each worktree and NEVER removes worktrees with uncommitted changes. Claude Code's automatic cleanup also preserves changed worktrees, but RunGate's `cleanupWorktrees` check is explicit, logged to the `kept[]` array, and applies across batch cleanup.

3. **Unmerged-branch protection** (lines 91-106) -- checks `git branch --merged main` and skips worktrees whose branches have not been merged. This prevents accidental loss of work that has not been merged to main. Claude Code's worktree lifecycle does not check merge status before cleanup.

4. **Detached HEAD handling** (lines 84-89) -- explicitly skips worktrees in detached HEAD state with a logged reason. Defensive logic not present in Claude Code's built-in worktree lifecycle management.

5. **Git worktree prune** (lines 116-122) -- runs `git worktree prune` after batch cleanup to remove stale worktree references from `.git/worktrees/`. Built-in worktree lifecycle does not prune orphaned references.

6. **Structured reporting** (lines 38-42, 124-128) -- returns `CleanupResult` with `removed[]`, `kept[]` (with reason), and `errors[]` arrays for audit logging and operational visibility. Built-in cleanup is silent.

### Overlap Analysis

| Capability | Claude Code Native | worktree-cleanup.ts Custom | Overlap |
|-----------|-------------------|---------------------------|---------|
| Create worktrees for agents | Yes (EnterWorktree) | No | N/A |
| Remove worktrees at completion | Yes (ExitWorktree) | No (batch cleanup) | None |
| Age-based stale detection | No | Yes (`maxAgeMs`) | None |
| Uncommitted-change safety | Partial (preserves changes) | Yes (explicit check + log) | Partial |
| Unmerged-branch protection | No | Yes (`git branch --merged`) | None |
| Detached HEAD handling | No | Yes (skip + log) | None |
| Batch cleanup across all worktrees | No (per-agent only) | Yes (scans `.claude/worktrees/`) | None |
| Git worktree prune | No | Yes | None |
| Structured cleanup reporting | No | Yes (`CleanupResult`) | None |

**Conclusion:** Claude Code's worktree lifecycle management and RunGate's `cleanupWorktrees` solve complementary problems. The built-in handles per-agent lifecycle (create on spawn, remove on completion). RunGate's `cleanupWorktrees` handles batch cleanup of stale worktrees that survived agent completion -- crashed agents, interrupted sessions, or agents that made changes but whose branches were later merged. The custom stale-detection logic (age filtering, merge-status checking, structured reporting) has no built-in equivalent. **Migration is not warranted.** The module should KEEP its current implementation.

---

## 8. Detailed Assessment: council.js vs Agent Teams

**File:** `workflows/council.js` (501 lines)
**Classification:** partial-overlap

### What Claude Code Agent Teams Provides

Agent Teams is an experimental feature (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
- Independent teammates with shared task list and direct messaging
- Each teammate has its own context window (3-5x token cost)
- `TeammateIdle` hook for re-verification before idle
- Existing `.claude/agents/*.md` definitions work as teammate definitions
- Display modes: in-process, tmux, iterm2
- File structure: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- Free-form collaboration between teammates with no structured protocol

### What RunGate's council.js Provides

The council workflow implements structured multi-round parallel debate with features Agent Teams does not replicate:

1. **Research Phase** -- Dedicated codebase scan producing `RESEARCH_SCHEMA` output (relevantFiles, existingPatterns, priorArt, keyFindings, warnings) before debate begins. Agent Teams has no structured research phase.

2. **Three-Round Debate Protocol** -- Round 1 (independent positions from each teammate), Round 2 (responses that must reference Round 1 points), Round 3 (synthesis identifying convergence and disagreement). Agent Teams provides free-form messaging without structured rounds or progressive constraints.

3. **Progressive Transcript Passing** -- Each round's output is passed to the next round as context, ensuring debate builds on prior points. Agent Teams uses shared task lists and direct messaging, not structured transcript passing.

4. **Structured Output Schemas** -- `POSITION_SCHEMA` and `SYNTHESIS_SCHEMA` enforce structured JSON output from each agent at each round. Agent Teams has no schema enforcement on teammate output.

5. **Enforcement Classification** -- Synthesis output classifies each recommendation as MECHANICAL or BEHAVIORAL with mechanism descriptions and `whyNotMechanical` rationale. This feeds directly into RunGate's enforcement pipeline.

6. **Spec Alignment** -- Synthesis output includes `specAlignment` checking (specRef, aligned, divergenceReason). Ensures council recommendations do not contradict existing specs.

7. **Configurable Debate Members** -- Supports architect, engineer, designer, security, product, devops roles with role-specific prompts (MEMBER_PROMPTS). Agent Teams uses `.claude/agents/*.md` definitions but without debate-specific role prompts.

### Adoption Recommendation

| Factor | Assessment |
|--------|-----------|
| **Maturity** | Agent Teams is experimental and requires an environment flag (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Not production-ready. Council.js has been running in production for months with proven structured output quality. Migration to an experimental feature risks regression. |
| **Token Cost** | Agent Teams costs 3-5x more tokens because each teammate maintains its own full context window. Council.js uses sequential agent spawning with transcript passing, which is significantly more token-efficient for structured debate. For a 4-member council with 3 rounds, Agent Teams would consume roughly 12-20x the base context cost vs council.js's sequential approach. |
| **Structured Output** | Council.js enforces JSON schemas (`POSITION_SCHEMA`, `SYNTHESIS_SCHEMA`) on every round, guaranteeing machine-parseable output with enforcementClassification and specAlignment fields. Agent Teams provides free-form collaboration with no schema enforcement. Migrating would lose output structure guarantees unless schema validation is reimplemented on top of Agent Teams. |
| **Debate Protocol** | Council.js implements a specific debate methodology (research -> independent positions -> responses referencing prior points -> synthesis with convergence/disagreement tracking). Agent Teams provides generic teammate collaboration. The debate protocol would need to be entirely reimplemented on top of Agent Teams messaging, negating any migration benefit. |
| **Enforcement Pipeline Integration** | Council.js output feeds directly into RunGate's enforcement classification (MECHANICAL/BEHAVIORAL) and spec alignment checking pipelines. Agent Teams output would need post-processing to match this structured format. |

**Conclusion:** Agent Teams and council.js serve fundamentally different purposes. Agent Teams provides free-form multi-agent collaboration (a communication transport); council.js implements a specific structured debate protocol with schema-enforced output and enforcement pipeline integration. Migrating to Agent Teams would require reimplementing the entire debate protocol, schema enforcement, enforcement classification, and spec alignment on top of the Agent Teams primitive -- adding complexity rather than reducing it. The token cost increase (3-5x per teammate, potentially 12-20x total for a full council) provides no offsetting benefit since council.js's sequential spawning already works well. **Migration is not recommended** until Agent Teams matures past experimental status AND adds native support for structured multi-round protocols with schema enforcement. Monitor Agent Teams for future adoption when it graduates to stable.

---

## 9. Non-Existent Files Assessment

### SessionHarvester.ts

**Finding:** `SessionHarvester.ts` does not exist in the RunGate codebase. A search across all directories (hooks/, lib/, scripts/, gates/, workflows/) found zero files matching this name or any variant (session-harvester.ts, sessionHarvester.ts). SessionHarvester.ts was referenced in earlier discussions but was never implemented as a RunGate module. No migration assessment is possible for a file that does not exist -- there is no custom code to compare against built-in features. The closest existing modules are `lib/behavioral-cache.ts` (session data caching, not harvesting) and `scripts/analyze-transcript.ts` (individual transcript analysis, not cross-session harvesting).

### WorkCompletionLearning.hook.ts

**Finding:** `WorkCompletionLearning.hook.ts` does not exist in the RunGate codebase. A search across all directories found zero files matching this name or any variant. WorkCompletionLearning.hook.ts was proposed conceptually but never created as a RunGate hook. No migration assessment is possible for a file that does not exist -- there is no custom implementation to evaluate for built-in equivalence. The closest existing module is `hooks/TaskCompleted.hook.ts` (runs quality gates on task completion, but does NOT extract generalizable learnings from completed work).

Both SessionHarvester.ts and WorkCompletionLearning.hook.ts are confirmed absent from the RunGate codebase as of 2026-09-29.

---

## 10. Action Recommendations

### Action 1: Monitor Agent Teams for Council Migration (WATCH -- do not migrate)

**Items:** `workflows/council.js` (501 lines)
**Current Classification:** partial-overlap
**Recommendation:** Do NOT migrate now. Agent Teams is experimental with 3-5x token cost per teammate and no structured debate protocol. Continue using council.js. Re-evaluate when Agent Teams graduates to stable and adds schema enforcement or round-based protocols.
**Rationale:** Migration would require reimplementing 501 lines of debate logic on top of Agent Teams, increasing both complexity and token cost with no functional gain. Net negative value today.

### Action 2: Evaluate batch-ship.js Against /batch Command (EVALUATE)

**Items:** `workflows/batch-ship.js` (295 lines)
**Current Classification:** partial-overlap
**Recommendation:** Investigate whether Claude Code's `/batch` command can replace batch-ship.js's parallel worktree execution while preserving RunGate's gate verification and SC tracking. If `/batch` supports post-completion hooks (via SubagentStop), RunGate's gate checks could run via existing hooks rather than workflow-internal logic.
**Rationale:** The parallelism mechanism is the primary overlap. If hooks can provide the gate enforcement after `/batch` agents complete, up to 295 lines of custom orchestration could potentially be simplified. However, batch-ship.js also handles wave planning and cross-agent dependency ordering which `/batch` does not provide. Full replacement is unlikely; partial simplification is worth investigating.

### Action 3: Consolidate Worktree Management Modules (SIMPLIFY)

**Items:** `lib/worktree-cleanup.ts` (166 lines), `lib/worktree-isolation.ts` (82 lines), `lib/branch-cleanup.ts` (238 lines)
**Current Classification:** partial-overlap
**Recommendation:** These three modules handle related concerns (worktree creation, worktree cleanup, branch cleanup). While none can be replaced by built-ins, they could be consolidated into a single `lib/worktree-manager.ts` module to reduce maintenance surface and ensure consistent safety checks. The built-in EnterWorktree/ExitWorktree handle per-agent lifecycle; the custom code handles batch operations, stale detection, and safety checks.
**Rationale:** Three separate files for worktree/branch management creates maintenance burden and potential for inconsistent safety logic. Consolidation (not elimination) would reduce cognitive load without losing any functionality.

### Action 4: PostCompact Hook Verification (VERIFY)

**Items:** `hooks/PostCompact.hook.ts` (60 lines)
**Current Classification:** WRAP (partial-overlap)
**Recommendation:** Verify that Claude Code's PostCompact hook trigger provides all the context needed (project root path, working directory). The current implementation reads CLAUDE.md and AGENTS.md to extract rules sections via regex. Confirm the hook receives sufficient environment context to locate these files in all scenarios (worktrees, multi-project). If Claude Code adds native rule persistence across compaction in a future release, this hook becomes a full-replace candidate.
**Rationale:** PostCompact.hook.ts is the closest to full-replace of any hook file, but the rule extraction logic (regex parsing of markdown `## Rules` sections) remains custom. The trigger is built-in; only the extraction logic could potentially be replaced if Claude Code adds native rule re-injection.

---

## 11. Summary Statistics

| Directory | Files | Lines | KEEP | WRAP | partial-overlap | REPLACE |
|-----------|-------|-------|------|------|-----------------|---------|
| hooks/ | 19 | 1,514 | 5 | 14 | 0 | 0 |
| lib/ | 42 | 9,940 | 37 | 1 | 4 | 0 |
| scripts/ | 39 | 7,060 | 37 | 0 | 2 | 0 |
| gates/ | 26 | 8,229 | 26 | 0 | 0 | 0 |
| workflows/ | 6 | 3,716 | 4 | 0 | 2 | 0 |
| **Total** | **132** | **30,459** | **109** | **15** | **8** | **0** |

### Key Findings

1. **Zero files qualify for full-replace.** Every custom module implements domain-specific logic that Claude Code built-ins do not cover. Built-in features provide trigger events (SubagentStop, PostCompact, TaskCompleted, FileChanged) and infrastructure (EnterWorktree, git operations, Agent Teams) but never the domain logic.

2. **83% of files (109 of 132) are KEEP with no built-in equivalent at all.** This confirms RunGate's value is in its custom conformity, compliance, and gate logic -- not in reimplementing platform features.

3. **All 14 hooks use built-in trigger points but contain custom handlers.** The hook architecture correctly separates platform triggers from domain logic, following HOOK-ARCHITECTURE-SPEC.md.

4. **Agent Teams is not a council.js replacement.** It provides a communication transport, not a structured debate protocol. Token cost is 3-5x higher with no functional benefit. Watch for maturity improvements.

5. **Worktree management is complementary, not duplicative.** Built-in handles per-agent lifecycle; custom handles batch cleanup, stale detection, and safety guards for cross-session worktree accumulation.

6. **SessionHarvester.ts and WorkCompletionLearning.hook.ts do not exist.** These were proposed but never implemented. No migration assessment applies.

This validates the agent-agnostic architecture principle from the 2026-09-24 feature audit: RunGate core (specs, SCs, conformity engine, compliance grading, gate pipeline) is intentionally independent of any specific agent platform. Claude Code provides hook trigger points and worktree infrastructure; RunGate provides the quality assurance, compliance testing, and behavioral optimization layers.
