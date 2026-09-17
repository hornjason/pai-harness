---
doc-type: spec
status: ready
owner: jason
updated: 2026-09-08
testable: true
---

# Harness v3 — Bash Deletion Plan

## Status: Ready to delete after validation period

Run both systems in parallel for 1-2 more issues. If Bun gates catch everything bash caught, delete bash.

## Files to delete

| File | Lines | Replaced by | Validated |
|---|---|---|---|
| `scripts/skill-runner.sh` | 1120 | Workflow scripts + post-agent.sh | #1333 shipped without it |
| `skills/ship/gate-runner.sh` | 294 | gates/workflow.test.ts + e2e-smoke.test.ts | #1333 gates passed |
| `skills/ship/gate-checks.sh` | 547 | gates/workflow.test.ts + e2e-smoke.test.ts | 28/28 tests |
| `scripts/git-hooks/pre-push` | 240 | Advisory — IssueCloseGuard enforces | D-025 made advisory |
| `scripts/lib/gap-emit.sh` | 88 | gates/learn.ts | #423 shipped |
| `skills/ship/gate-smoke-test.sh` | ~100 | gates/chain.test.ts + prove.test.ts | #1333 proven |
| `skills/ship/gate-smoke-test-e2e.sh` | ~80 | gates/chain.test.ts | Seeded tests pass |
| `scripts/prove-backfill.sh` | ~60 | gates/prove.test.ts | #1333 proven |
| `skills/ship/ceremony-profiles.json` | ~50 | Sizing logic in workflow.test.ts | — |
| `skills/ship/spec-policies.json` | ~30 | e2e-smoke.test.ts reads actual spec | ADR-050 validated |
| **Total** | **~2609** | **662 lines Bun** | |

## Files to KEEP

| File | Why |
|---|---|
| `skills/ship/SKILL.md` | Documentation — describes the workflow |
| `skills/ship/workflow-schema.json` | Reference — Zod schema is canonical now but keep for docs |
| `scripts/slug-resolver.sh` | Used by multiple systems, not just gates |
| `scripts/validate-skill-output.sh` | Used by goal/ship/prove skills |
| `hooks/AgentBriefGuard.hook.ts` | Modified (#420) — still active |
| `hooks/IssueCloseGuard.hook.ts` | Still enforces issue close — not replaced |

## Deletion command

```bash
git rm scripts/skill-runner.sh
git rm skills/ship/gate-runner.sh
git rm skills/ship/gate-checks.sh
git rm scripts/git-hooks/pre-push
git rm scripts/lib/gap-emit.sh
git rm skills/ship/gate-smoke-test.sh
git rm skills/ship/gate-smoke-test-e2e.sh
git rm scripts/prove-backfill.sh
git rm skills/ship/ceremony-profiles.json
git rm skills/ship/spec-policies.json
git commit -m "chore: delete bash harness — replaced by Bun gates (ADR-008)"
```

## Validation checklist (before deleting)

- [x] #1333 shipped through Bun gates (goal→ship→prove→close)
- [x] #420 AgentBriefGuard accepts workflow-state.json
- [x] #422 Phase advancement mechanical
- [x] #423 Learning capture working
- [ ] Ship 1-2 more DDB issues through Bun gates without bash fallback
- [ ] Verify no other scripts source/call the deleted files
