---
doc-type: research
status: active
owner: jason
updated: 2026-09-21
---

# SC Classification: Static vs Behavioral

Phase A of CONFIG-DRIVEN-TESTING-SPEC. Every SC in testable specs classified for migration routing.

## Summary

| Metric | Count |
|--------|-------|
| Total SCs across testable specs | 339 |
| Static (verifiable by reading files) | 315 |
| Behavioral (requires runtime observation) | 5 |
| Rewritable (behavioral wording → static check) | 19 |
| **After rewrites: static** | **334** |
| **After rewrites: behavioral** | **5** |

## Classification Methodology

- **Static**: The SC's truth can be verified by reading files, checking existence, parsing content, counting lines, or comparing values. Even if the SC describes a process ("scaffold runs X"), if verification means "check the output file exists with correct content," it's static.
- **Behavioral**: Verification requires observing a RUNTIME action — something that only happens during agent execution, git operations, or session workflows. Cannot be verified by reading files alone.
- **Rewritable**: Currently worded as behavioral ("hook calls X," "script runs Y") but can be rewritten as a static check ("hook file contains [X]," "script source contains [Y]").

## Behavioral SCs (5 — require transcript auditor)

| SC | Spec | Current Wording | Why Behavioral |
|----|------|-----------------|----------------|
| SC-264 | AGENTS-MD-TEMPLATE | Fresh agent test — zero-context agent runs Phase 0 + Phase 1 using only scaffold output, navigability score tracked | Requires spawning a real agent and observing its behavior |
| SC-236 | success-criteria | `rungate test-navigability` spawns fresh agent with standard task, auditor scores transcript | Requires spawning agent + reading transcript |
| SC-242 | success-criteria / INSTRUCTION-COMPLIANCE | runBehavioralCompliance spawns fresh agent + auditor | Requires running agent and observing behavior |
| SC-248 | success-criteria | Post-completion auditor spawns after every agent — reads full transcript, classifies each action | Requires observing agent execution |
| SC-318 | SESSION-LIFECYCLE | Cold-start agent finds PROJECT-STATE.md within first 3 tool calls | Requires observing agent behavior in session |

## Rewritable SCs (19 — rewording makes them static)

### SESSION-LIFECYCLE-SPEC (8 rewritable)

| SC | Current Wording | Suggested Rewrite | Verification |
|----|-----------------|-------------------|-------------|
| SC-309 | session-end.ts script exists and runs without errors | scripts/session-end.ts exists and contains [main, async] | file-exists + content-contains |
| SC-310 | session-end checks for uncommitted changes and warns | scripts/session-end.ts contains [git status, uncommitted] | source-contains |
| SC-311 | session-end checks for stale worktrees and lists them | scripts/session-end.ts contains [worktree, stale] | source-contains |
| SC-312 | session-end runs sync-sc-status.ts automatically | scripts/session-end.ts contains [sync-sc-status] | source-contains |
| SC-313 | session-end runs update-project-state.ts automatically | scripts/session-end.ts contains [update-project-state] | source-contains |
| SC-314 | session-end updates project-state.json with current priorities and antipatterns | scripts/session-end.ts contains [project-state.json, priorities, antipatterns] | source-contains |
| SC-315 | session-end appends session notes to project-state.json sessions array | scripts/session-end.ts contains [sessions, push, notes] | source-contains |
| SC-316 | session-end commits all state files in one commit | scripts/session-end.ts contains [git add, git commit] | source-contains |

### AGENTS-MD-TEMPLATE-SPEC (7 rewritable)

| SC | Current Wording | Suggested Rewrite | Verification |
|----|-----------------|-------------------|-------------|
| SC-263 | Re-scaffold on RunGate itself produces correct AGENTS.md with 0 warnings | scaffold-project.ts output for RunGate fixture contains [## Rules, ## Key Files] and has no [WARNING] | integration test (scaffold-produces + content-contains) |
| SC-296 | scripts/update-project-state.ts exists and runs with --skip-tests in under 2 seconds | scripts/update-project-state.ts exists | file-exists |
| SC-297 | Pre-commit hook calls update-project-state.ts and stages the result automatically | .git/hooks/pre-commit contains [update-project-state] | content-contains |
| SC-303 | Pre-commit hook blocks new .sh files — TypeScript only (--diff-filter=A) | hooks/BlockShellScripts.hook.ts exists and contains [.sh, --diff-filter] | file-exists + content-contains |
| SC-304 | CommitEnforcement.hook.ts detects any code agent, not just Marcus | hooks/CommitEnforcement.hook.ts contains [code, agent] and has no [=== "marcus"] | content-contains + content-not-contains |
| SC-306 | codeAgent() wrapper in workflows auto-adds isolation: worktree for code agents | lib/workflow-helpers.ts contains [codeAgent, isolation, worktree] | source-contains |
| SC-308 | PROJECT-STATE.md table rows auto-flip ⬜→✅ based on spec SC checkbox status | scripts/update-project-state.ts contains [✅, ⬜, 🔄, done] | source-contains |

### success-criteria.md (4 rewritable)

| SC | Current Wording | Suggested Rewrite | Verification |
|----|-----------------|-------------------|-------------|
| SC-1 | Bootstrap Phase 1 (CODE-MAP + rungate) completes before Phase 2 (AGENTS.md + agents/) | scaffold-project.ts source contains phase ordering logic [Phase 1, Phase 2] with Phase 1 before Phase 2 | source-contains (ordering in source) |
| SC-178 | Conformity runs ctxlint via Bun.spawnSync | lib/conformity.ts contains [ctxlint, spawnSync] | source-contains |
| SC-179 | Conformity runs agentsmd lint via Bun.spawnSync | lib/conformity.ts contains [agentsmd, spawnSync] | source-contains |
| SC-180 | Conformity runs agnix via Bun.spawnSync | lib/conformity.ts contains [agnix, spawnSync] | source-contains |

Note: SC-181, SC-230 (RepoRails, ccinspect) follow same pattern as SC-178-180.

## Specs With Only Static SCs

| Spec | SC Count | Notes |
|------|----------|-------|
| bootstrap-data-flow/success-criteria.md | 254 | 249 static, 4 rewritable, 1 behavioral (SC-264 via cross-ref) |
| AGENTS-MD-TEMPLATE-SPEC.md | 35 | 27 static, 7 rewritable, 1 behavioral (SC-264) |
| CONFIG-DRIVEN-TESTING-SPEC.md | 17 | All static (self-referential but verifiable) |
| INSTRUCTION-COMPLIANCE-SPEC.md | 21 | 20 static, 1 behavioral (SC-242) |
| SESSION-LIFECYCLE-SPEC.md | 12 | 3 static, 8 rewritable, 1 behavioral (SC-318) |

## Specs With No SCs (testable: true but no criteria)

These specs have `testable: true` but no SC checkboxes — they're templates, plans, or structural docs:

- specs/bootstrap-data-flow/cli-commands-for-file-creation.md
- specs/bootstrap-data-flow/consumer-requirements.md
- specs/bootstrap-data-flow/problem-statement.md
- specs/bootstrap-data-flow/rca-protocol.md
- specs/bootstrap-data-flow/template-architecture.md
- specs/BOOTSTRAP-TEST-PLAN.md
- specs/harness-automation-matrix.md
- specs/HARNESS-GATES.md
- specs/HARNESS-SKILL-CHAIN.md
- specs/HARNESS-SKILL-CONTRACT.md
- specs/HARNESS-STANDARD.md
- specs/SPEC-TEMPLATE.md

## Key Finding

The council's "45% behavioral" estimate was based on 22/49 unmatched SCs. The actual number across ALL 339 SCs is **5 genuinely behavioral (1.5%)** and **19 rewritable (5.6%)**. After rewrites, **98.5% of SCs are static and can be config-driven**.

The "zero fallthrough for static SCs" goal is achievable. The 5 genuinely behavioral SCs all involve spawning agents and observing their behavior — they belong in the navigability/compliance testing system, not the conformity engine.

## Action Items for Phase A

1. Rewrite the 19 rewritable SCs in their spec files (new wording in suggested rewrite column)
2. Tag the 5 behavioral SCs with `verification: behavioral` (mechanism TBD — may be a comment or frontmatter field on the spec)
3. Verify the 12 testable specs with no SCs — should they have `testable: true`?
