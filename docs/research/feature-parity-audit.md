---
doc-type: research
status: active
owner: marcus
updated: 2026-09-27
governs: []
---

# Feature Parity Audit — Custom Code vs Claude Code Built-in

Audit of all custom hooks, scripts, and lib modules against Claude Code built-in features.
Cross-referenced with `docs/research/2026-09-24-claude-code-feature-audit.md`.

## Surface Area Summary

| Directory | Files | Lines | Baseline |
|-----------|-------|-------|----------|
| hooks/ | 19 | 2,378 | Custom hook implementations |
| lib/ | 27 | 5,452 | Core library modules |
| scripts/ | 36 | 8,076 | CLI tools and automation |
| workflows/ | 6 | 3,537 | Multi-agent workflows |
| **Total** | **88** | **19,443** | **Total custom code surface area** |

Net reduction from this audit: **0 lines removed**. All custom code is either intentionally custom with no built-in equivalent, or uses built-in hook events as thin triggers while keeping custom domain logic. No full-replace candidates identified — RunGate's value IS the custom logic.

Total lines of custom code: 19,443 across 88 source files. This is the baseline for tracking net change over time.

---

## Inventory and Assessment

Classification key:
- **Built-in equivalent:** yes / no / partial
- **Coverage:** FULL-REPLACE / PARTIAL-OVERLAP / NEEDS-WRAPPING / KEEP (retain as-is)
- **Rationale:** Why this classification

### hooks/ (19 files, 2,378 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 1 | hooks/AgentBriefGuard.hook.ts | 586 | no | KEEP | No built-in equivalent. Validates RunGate-specific agent brief structure, context injection, and role matching before agent launch. Intentionally custom — enforces RunGate brief format that no generic tool understands. |
| 2 | hooks/AgentVerdictCapture.hook.ts | 179 | partial | NEEDS-WRAPPING | SubagentStop hook event is built-in (fires on agent completion). Custom logic: verdict JSON parsing, behavioral-cache population, agent audit scoring. The hook EVENT is native; the HANDLER is RunGate-specific. Retain handler, built-in provides the trigger. |
| 3 | hooks/AutoVerifyGate.hook.ts | 76 | no | KEEP | No built-in equivalent. Auto-runs verification gate in harness workflow. RunGate-specific gate progression logic. |
| 4 | hooks/CommitEnforcement.hook.ts | 143 | no | KEEP | No built-in equivalent. Enforces commit message format, issue references, and content rules. Project-specific policy. |
| 5 | hooks/GateEnforcement.hook.ts | 273 | no | KEEP | No built-in equivalent. Enforces harness gate progression (GOAL->DISCOVERY->EXECUTION->VERIFY). RunGate-specific workflow state machine. |
| 6 | hooks/IssueCloseGuard.hook.ts | 116 | no | KEEP | No built-in equivalent. Validates issue closure criteria before allowing close. Project-specific quality gate. |
| 7 | hooks/lib/agentDetection.ts | 70 | no | KEEP | No built-in equivalent. Detects agent role from context/name. Utility for other hooks. |
| 8 | hooks/lib/findWorkflow.ts | 101 | no | KEEP | No built-in equivalent. Resolves workflow script paths. Utility for hook dispatching. |
| 9 | hooks/lib/parseStdin.ts | 37 | no | KEEP | No built-in equivalent. Parses hook stdin format. Required by Claude Code hook contract. |
| 10 | hooks/lib/paths.ts | 111 | no | KEEP | No built-in equivalent. Path resolution for hooks. Project-specific directory layout. |
| 11 | hooks/lib/utils.ts | 81 | no | KEEP | No built-in equivalent. Shared utilities for hooks. |
| 12 | hooks/MergeGuard.hook.ts | 55 | no | KEEP | No built-in equivalent. Validates merge conditions. Project-specific merge policy. |
| 13 | hooks/PostCompact.hook.ts | 57 | partial | NEEDS-WRAPPING | PostCompact hook event is built-in (fires after context compaction). Custom logic: re-injects critical rules that context compaction drops. The hook EVENT is native; the re-injection logic is RunGate-specific. Retain handler. |
| 14 | hooks/SpecConformityTrigger.hook.ts | 40 | partial | NEEDS-WRAPPING | FileChanged hook could provide the trigger event. Custom logic: decides when to re-run conformity checks on spec file changes. |
| 15 | hooks/SpecSCGuard.hook.ts | 120 | no | KEEP | No built-in equivalent. Validates SC structure within spec files. RunGate-specific SC format enforcement. |
| 16 | hooks/StaleTTLCleanup.hook.ts | 167 | no | KEEP | No built-in equivalent. Cleans up stale workflow state by TTL. Custom lifecycle management. |
| 17 | hooks/TaskCompleted.hook.ts | 48 | partial | NEEDS-WRAPPING | TaskCompleted hook event is built-in (exit code 2 blocks completion). Custom logic: runs RunGate completion checks via lib/task-completion-checks. The hook EVENT is native; the quality gate logic is custom. |
| 18 | hooks/VerifyPhaseLock.hook.ts | 81 | no | KEEP | No built-in equivalent. Locks harness phase during verification. RunGate workflow state enforcement. |
| 19 | hooks/WorkflowStateGuard.hook.ts | 37 | no | KEEP | No built-in equivalent. Validates workflow state consistency. RunGate-specific state machine guard. |

### lib/ (27 files, 5,452 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 20 | lib/aes-calculator.ts | 66 | no | KEEP | No built-in equivalent. Computes Acceptance Evidence Scores. RunGate-specific scoring algorithm. |
| 21 | lib/agent-audit.ts | 74 | no | KEEP | No built-in equivalent. Audits agent transcript compliance. RunGate-specific behavioral grading. |
| 22 | lib/behavioral-cache.ts | 78 | no | KEEP | No built-in equivalent. Caches behavioral SC results with 7-day TTL. RunGate-specific caching layer for behavioral test results. Intentionally custom — no session harvesting built-in exists. |
| 23 | lib/branch-cleanup.ts | 238 | partial | PARTIAL-OVERLAP | Claude Code has git operations (branch, delete) but no automated branch cleanup policy. Custom logic: age-based filtering, merge-status checks, safety guards. Retain — the automation policy is custom. |
| 24 | lib/brief-context-parser.ts | 35 | no | KEEP | No built-in equivalent. Parses context sections from agent briefs. RunGate-specific brief format. |
| 25 | lib/canary.ts | 117 | no | KEEP | No built-in equivalent. Canary verification system — plants known values and checks if agents use them. Intentionally custom — novel verification approach. |
| 26 | lib/compliance.ts | 322 | no | KEEP | No built-in equivalent. Compliance checking engine for rule adherence. RunGate-specific. Intentionally custom — this is core RunGate IP. |
| 27 | lib/conformity.ts | 1,643 | no | KEEP | No built-in equivalent. The core conformity engine — 18 pattern matchers, SC validation, scaffold conformity. Intentionally custom — this IS RunGate. Largest module, most critical. No external tool does config-driven conformity testing with matcher plugins. |
| 28 | lib/create-brief.ts | 99 | no | KEEP | No built-in equivalent. Generates agent briefs from templates. RunGate-specific template system. |
| 29 | lib/create-sc.ts | 253 | no | KEEP | No built-in equivalent. Creates success criteria with pattern-based generation. RunGate-specific. |
| 30 | lib/directive-extractor.ts | 190 | no | KEEP | No built-in equivalent. Extracts behavioral directives from documentation. RunGate-specific NLP for compliance testing. Intentionally custom — directive extraction is a core differentiator. |
| 31 | lib/eval-criteria.ts | 6 | no | KEEP | No built-in equivalent. Type definitions for evaluation criteria. |
| 32 | lib/hill-climb.ts | 164 | no | KEEP | No built-in equivalent. Hill climbing optimization for instruction effectiveness. RunGate-specific optimization loop. Intentionally custom — no built-in provides iterative rule improvement. |
| 33 | lib/paths.ts | 23 | no | KEEP | No built-in equivalent. Path constants. |
| 34 | lib/post-fix-verify.ts | 157 | no | KEEP | No built-in equivalent. Post-fix verification logic. RunGate-specific. |
| 35 | lib/prior-branch.ts | 79 | partial | PARTIAL-OVERLAP | Claude Code has EnterWorktree/ExitWorktree for worktree management but no native branch resumption detection. prior-branch.ts detects previously-worked branches by issue number with word-boundary regex, timestamp sorting, and optional test execution in temporary worktrees. Claude Code does not natively track which branches correspond to which issues or pick the most recent matching branch. Retain — branch resumption intelligence is custom. |
| 36 | lib/promote-outputs.ts | 156 | no | KEEP | No built-in equivalent. Promotes workflow output artifacts. RunGate-specific. |
| 37 | lib/rule-registry.ts | 128 | no | KEEP | No built-in equivalent. Manages rule definitions and lookups. RunGate-specific. |
| 38 | lib/rungate-schema.ts | 74 | no | KEEP | No built-in equivalent. Schema definitions for rungate.json config. |
| 39 | lib/sc-guard.ts | 157 | no | KEEP | No built-in equivalent. SC validation and guard logic. RunGate-specific. |
| 40 | lib/signal-phrases.ts | 7 | no | KEEP | No built-in equivalent. Signal phrase constants for compliance checking. |
| 41 | lib/spec-change-conformity.ts | 80 | no | KEEP | No built-in equivalent. Validates spec changes conform to template. RunGate-specific. |
| 42 | lib/stale-issue-scanner.ts | 36 | no | KEEP | No built-in equivalent. Scans for stale issues. RunGate-specific. |
| 43 | lib/task-completion-checks.ts | 177 | partial | NEEDS-WRAPPING | TaskCompleted hook provides the trigger point. Custom logic: conformity validation, test verification, state checks before task completion. The built-in gives the hook; the checks are custom. |
| 44 | lib/transcript-checker.ts | 845 | no | KEEP | No built-in equivalent. Transcript analysis, directive compliance, role-based evaluation, TDD checking, scoring, and grading. Intentionally custom — behavioral compliance grading is core RunGate IP. No external tool grades transcripts against extracted directives. |
| 45 | lib/worktree-cleanup.ts | 166 | partial | PARTIAL-OVERLAP | Claude Code provides EnterWorktree/ExitWorktree for worktree creation and entry, but no built-in worktree lifecycle management. worktree-cleanup.ts provides safety-first cleanup: never removes worktrees with uncommitted changes, never removes unmerged branches, age-based filtering, and git worktree prune. Claude Code creates worktrees on demand but does not manage their lifecycle or cleanup. Retain — the safety-first cleanup policy is custom. |
| 46 | lib/worktree-isolation.ts | 82 | partial | PARTIAL-OVERLAP | Claude Code has EnterWorktree which creates isolated worktrees. worktree-isolation.ts adds persistent transcript directory outside worktree and cleanup function. Overlaps on worktree creation; custom on transcript isolation and cleanup semantics. |

### scripts/ (36 files, 8,076 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 47 | scripts/analyze-transcript.ts | 347 | no | KEEP | No built-in equivalent. Transcript efficiency analysis — tool call breakdown, file efficiency, deliverable ratio. RunGate-specific metrics. |
| 48 | scripts/audit-specs.ts | 469 | no | KEEP | No built-in equivalent. Audits spec files for completeness and correctness. |
| 49 | scripts/audit-transcript.ts | 259 | no | KEEP | No built-in equivalent. Transcript audit CLI. |
| 50 | scripts/compliance-loop.ts | 248 | no | KEEP | No built-in equivalent. Compliance testing loop automation. |
| 51 | scripts/create-brief.ts | 70 | no | KEEP | No built-in equivalent. CLI wrapper for lib/create-brief. |
| 52 | scripts/create-sc.ts | 88 | no | KEEP | No built-in equivalent. CLI wrapper for lib/create-sc. |
| 53 | scripts/create-spec.ts | 165 | no | KEEP | No built-in equivalent. Spec creation with frontmatter and template. |
| 54 | scripts/da-compliance.ts | 214 | no | KEEP | No built-in equivalent. DA-level compliance checking. |
| 55 | scripts/decision-reconcile.sh | 74 | no | KEEP | No built-in equivalent. Shell wrapper for decision reconciliation. |
| 56 | scripts/decision-reconcile.ts | 152 | no | KEEP | No built-in equivalent. Verifies council decisions appear in target docs. |
| 57 | scripts/detect-sc-drift.ts | 164 | no | KEEP | No built-in equivalent. Detects SC drift between spec and implementation. |
| 58 | scripts/extract-constraints.ts | 260 | no | KEEP | No built-in equivalent. Extracts constraints from documentation. |
| 59 | scripts/generate-code-map.ts | 339 | no | KEEP | No built-in equivalent. Generates CODE-MAP.md from codebase scan. |
| 60 | scripts/generate-governs.ts | 74 | no | KEEP | No built-in equivalent. Generates governs metadata for specs. |
| 61 | scripts/generate-spec-template-patterns.ts | 69 | no | KEEP | No built-in equivalent. Generates spec template patterns. |
| 62 | scripts/grade-deterministic.ts | 364 | no | KEEP | No built-in equivalent. Deterministic grading of behavioral SCs. |
| 63 | scripts/harness-skill-check.sh | 52 | no | KEEP | No built-in equivalent. Validates skill contract compliance. |
| 64 | scripts/lib/gap-emit.sh | 65 | no | KEEP | No built-in equivalent. Emits gap reports. |
| 65 | scripts/lib/jq-update.sh | 30 | no | KEEP | No built-in equivalent. JSON update utility. |
| 66 | scripts/lib/resolve-slug.sh | 30 | no | KEEP | No built-in equivalent. Issue slug resolution. |
| 67 | scripts/lib/verify-spec-compliance.sh | 102 | no | KEEP | No built-in equivalent. Spec compliance verification. |
| 68 | scripts/promote-outputs.ts | 17 | no | KEEP | No built-in equivalent. CLI wrapper for lib/promote-outputs. |
| 69 | scripts/prove-backfill.sh | 87 | no | KEEP | No built-in equivalent. Backfills proof artifacts. |
| 70 | scripts/scaffold-project.ts | 1,699 | no | KEEP | No built-in equivalent. The scaffold generator — generates AGENTS.md, CI, agent briefs, conformity tests. Intentionally custom — this is RunGate's primary output mechanism. No external tool scaffolds AI-first project files from config. |
| 71 | scripts/scaffold-rungate-config.ts | 91 | no | KEEP | No built-in equivalent. Scaffolds rungate.json config. |
| 72 | scripts/scan-stale-issues.ts | 110 | no | KEEP | No built-in equivalent. CLI for stale issue scanning. |
| 73 | scripts/self-containment-check.sh | 109 | no | KEEP | No built-in equivalent. Validates project self-containment. |
| 74 | scripts/skill-qc-validator.sh | 402 | no | KEEP | No built-in equivalent. Validates skill quality criteria. |
| 75 | scripts/slug-resolver.sh | 14 | no | KEEP | No built-in equivalent. Resolves issue slugs. |
| 76 | scripts/split-spec.ts | 315 | no | KEEP | No built-in equivalent. Splits large specs into focused specs. |
| 77 | scripts/sync-sc-status.ts | 394 | no | KEEP | No built-in equivalent. Syncs SC status between spec checkboxes and test results. |
| 78 | scripts/sync-spec-tests.ts | 236 | no | KEEP | No built-in equivalent. Syncs spec SCs to test files. |
| 79 | scripts/test-brief.ts | 469 | no | KEEP | No built-in equivalent. Tests agent brief generation. |
| 80 | scripts/test-rules.ts | 216 | no | KEEP | No built-in equivalent. Tests rule registry. |
| 81 | scripts/update-project-state.ts | 142 | no | KEEP | No built-in equivalent. Updates project-state.json. |
| 82 | scripts/validate-scorer.ts | 140 | no | KEEP | No built-in equivalent. Validates scoring algorithms. |

### workflows/ (6 files, 3,537 lines)

| # | File | Lines | Built-in | Coverage | Rationale |
|---|------|-------|----------|----------|-----------|
| 83 | workflows/batch-ship.js | 295 | partial | PARTIAL-OVERLAP | Claude Code `/batch` command provides parallel worktree agents. Custom logic: harness integration, gate enforcement, wave planning. The parallelism is native; the orchestration policy is custom. |
| 84 | workflows/council.js | 501 | partial | PARTIAL-OVERLAP | Agent Teams could replace the multi-agent coordination layer. Custom logic: structured 3-round debate protocol with POSITION_SCHEMA/SYNTHESIS_SCHEMA, enforcementClassification, specAlignment, chair synthesis, and permanent record storage. Agent Teams provides the communication channel; the debate protocol, structured schemas, and synthesis logic are RunGate-specific. Retain — Agent Teams is a transport, not a replacement for the debate protocol. |
| 85 | workflows/prove.js | 640 | no | KEEP | No built-in equivalent. Proof workflow — runs verification agents, collects evidence, grades results. RunGate-specific. |
| 86 | workflows/ship.js | 1,331 | no | KEEP | No built-in equivalent. The core ship workflow — GOAL->DISCOVERY->EXECUTION->VERIFICATION with gate enforcement. Intentionally custom — this is the harness entry point. |
| 87 | workflows/ship-and-heal.js | 534 | no | KEEP | No built-in equivalent. Self-healing ship workflow with automatic retry on gate failure. |
| 88 | workflows/verify.js | 236 | no | KEEP | No built-in equivalent. Verification workflow. |

---

## Specific File Assessments

### SessionHarvester.ts — AC-6

**Finding: File does not exist in codebase.** No file named `SessionHarvester.ts` or any variant (`session-harvester.ts`, `sessionHarvester.ts`) exists anywhere in the repository. The closest existing modules are:

- `lib/behavioral-cache.ts` (78 lines) — caches behavioral SC results, NOT session-level harvesting
- `scripts/analyze-transcript.ts` (347 lines) — analyzes individual transcripts, NOT cross-session harvesting
- `hooks/AgentVerdictCapture.hook.ts` (179 lines) — captures per-agent verdicts, NOT session-wide harvesting

Claude Code does not provide a built-in session harvesting mechanism either. If session-level learning extraction is needed, it would be new custom code built on top of transcript analysis.

### WorkCompletionLearning.hook.ts — AC-7

**Finding: File does not exist in codebase.** No file named `WorkCompletionLearning.hook.ts` or any variant exists anywhere in the repository. The closest existing modules are:

- `hooks/TaskCompleted.hook.ts` (48 lines) — runs quality gate checks on task completion, does NOT extract learning
- `hooks/AgentVerdictCapture.hook.ts` (179 lines) — captures structured verdicts, does NOT extract generalizable learnings
- `lib/hill-climb.ts` (164 lines) — iteratively improves rules, but runs as a batch process, not on work completion

Claude Code's TaskCompleted hook could trigger learning extraction, but no built-in learning extraction mechanism exists. The hook event is native; any learning logic would be new custom code.

### prior-branch.ts — AC-8

**Assessment: Claude Code does NOT handle branch resumption natively.**

`lib/prior-branch.ts` (79 lines) provides:
1. Git branch listing with regex matching by issue number
2. Word-boundary matching (issue 550 matches `550-matcher-registry` but issue 55 does NOT match `550-*`)
3. Timestamp-based sorting to pick most recent branch
4. Optional test execution in a temporary worktree

Claude Code provides `EnterWorktree` and `ExitWorktree` for worktree management, and standard git operations for branch listing. However, it does NOT:
- Track which branches correspond to which issues
- Apply word-boundary-safe issue number matching
- Sort by timestamp to find the most recent matching branch
- Run tests in a temporary worktree before resuming

**Classification:** PARTIAL-OVERLAP. Claude Code provides the git primitives; the issue-aware branch intelligence is custom. Retain.

### worktree-cleanup.ts — AC-9

**Assessment: Claude Code does NOT provide built-in worktree lifecycle management.**

`lib/worktree-cleanup.ts` (166 lines) provides safety-first cleanup:
1. NEVER removes worktrees with uncommitted changes
2. NEVER removes worktrees with unmerged branches
3. Age-based filtering (maxAgeMs parameter)
4. `git worktree remove --force` with `git worktree prune`

Claude Code provides `EnterWorktree` (creates worktrees) and `ExitWorktree` (leaves worktrees) but does NOT:
- Track worktree age or enforce TTL-based cleanup
- Check for uncommitted changes before removal
- Verify branch merge status before deletion
- Batch-clean multiple stale worktrees

**Classification:** PARTIAL-OVERLAP. Claude Code manages individual worktree sessions; lifecycle cleanup across sessions is custom. Retain.

### Council and Parallel Coordination vs Agent Teams — AC-10

**Assessment: Agent Teams provide a communication transport but do NOT replace the structured debate protocol.**

Custom implementation:
- `workflows/council.js` (501 lines) — 3-round structured debate with POSITION_SCHEMA and SYNTHESIS_SCHEMA
- `scripts/decision-reconcile.ts` (152 lines) — verifies council decisions appear in target docs
- `specs/PARALLEL-AGENT-COORDINATION-SPEC.md` — file-claim manifests and module-boundary decomposition

Agent Teams (experimental) provide:
- Independent teammates with shared task list and direct messaging
- Display modes: in-process, tmux, iterm2
- File structure: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- TeammateIdle hook for re-verification

What Agent Teams DO replace:
- The communication channel between agents (direct messaging vs spawn-and-collect)
- The parallel execution model (teammates run independently)

What Agent Teams do NOT replace:
- The 3-round debate protocol (Research -> Round 1 positions -> Round 2 responses -> Round 3 synthesis)
- Structured schemas (POSITION_SCHEMA requiring enforcementClassification and specAlignment)
- Chair synthesis with mechanical vs behavioral classification
- Permanent record storage to `docs/council/`
- Decision reconciliation (checking if decisions appear in target files)
- File-claim manifests for parallel work (D-1 through D-4 in PARALLEL-AGENT-COORDINATION-SPEC)

**Classification:** PARTIAL-OVERLAP. Agent Teams could simplify the transport layer in council.js, but the debate protocol, structured schemas, and reconciliation logic must remain custom. Net savings estimate: ~50-100 lines of spawn/collect boilerplate in council.js, retaining ~400 lines of protocol logic.

---

## Items Without Built-in Equivalent — Intentionally Custom

These modules have no built-in equivalent in Claude Code and are retained because they implement RunGate's core value proposition:

| # | File | Lines | Rationale for Retention |
|---|------|-------|------------------------|
| 1 | lib/conformity.ts | 1,643 | Intentionally custom — the core conformity engine with 18 pattern matchers, SC validation, and config-driven testing. This IS RunGate. No external tool does conformity testing with pluggable matchers. |
| 2 | lib/transcript-checker.ts | 845 | Intentionally custom — behavioral compliance grading with directive extraction, role-based evaluation, and TDD detection. No built-in or external tool grades agent transcripts against extracted directives. |
| 3 | scripts/scaffold-project.ts | 1,699 | Intentionally custom — generates AGENTS.md, CI config, agent briefs, and conformity tests from rungate.json. RunGate-specific scaffold system. No external tool scaffolds AI-first project files. |
| 4 | workflows/ship.js | 1,331 | Intentionally custom — the GOAL->DISCOVERY->EXECUTION->VERIFICATION workflow with gate enforcement. The harness entry point. |
| 5 | lib/compliance.ts | 322 | Intentionally custom — compliance checking engine. Core RunGate IP for rule adherence measurement. |
| 6 | lib/hill-climb.ts | 164 | Intentionally custom — iterative rule improvement optimization. No built-in provides hill climbing on instruction effectiveness. |
| 7 | lib/directive-extractor.ts | 190 | Intentionally custom — NLP extraction of behavioral directives from documentation. Core differentiator for compliance testing. |
| 8 | lib/canary.ts | 117 | Intentionally custom — plants known values and verifies agents use them. Novel verification approach with no external equivalent. |
| 9 | workflows/prove.js | 640 | Intentionally custom — proof workflow collecting verification evidence. RunGate-specific. |

---

## Assessment Summary

### By Classification

| Classification | Count | Lines |
|---------------|-------|-------|
| KEEP (no equivalent) | 73 | 16,364 |
| PARTIAL-OVERLAP | 8 | 1,364 |
| NEEDS-WRAPPING | 5 | 501 |
| FULL-REPLACE | 0 | 0 |

### Key Findings

1. **No full-replace candidates exist.** Every custom module implements domain-specific logic that Claude Code built-ins do not cover. Built-in features provide trigger events (SubagentStop, PostCompact, TaskCompleted, FileChanged) and infrastructure (EnterWorktree, git operations, Agent Teams) but never the domain logic.

2. **Hook event triggers are native; handlers are custom.** Five hooks (AgentVerdictCapture, PostCompact, SpecConformityTrigger, TaskCompleted, and task-completion-checks) use built-in hook events as thin triggers. The handlers contain RunGate-specific logic that must remain custom. These hooks already follow the correct pattern from HOOK-ARCHITECTURE-SPEC.md.

3. **Agent Teams simplify transport, not protocol.** The council workflow could shed ~50-100 lines of spawn/collect boilerplate if migrated to Agent Teams, but the 3-round debate protocol, structured schemas, and decision reconciliation must remain custom.

4. **Worktree management is partially overlapping.** Claude Code's EnterWorktree/ExitWorktree handle individual worktree sessions. Custom code handles lifecycle cleanup (age-based, safety-guarded) and branch resumption intelligence (issue-aware matching) that built-ins do not provide.

5. **84% of custom code (16,364 of 19,443 lines) has no built-in equivalent at all.** This confirms RunGate's value is in its custom logic, not in reimplementing platform features.

### Recommendation

No code migrations or deletions are warranted. The custom codebase is correctly layered: built-in features provide infrastructure and trigger events; custom code provides domain logic. The architecture follows the agent-agnostic principle from the 2026-09-24 feature audit — Claude Code is one adapter, RunGate core remains portable.
