---
doc-type: reference
status: active
owner: jason
updated: 2026-09-17
testable: true
created: 2026-09-20
governs: TODO
---

# Harness Gates
# Source of truth for all gate definitions, enforcement config, and learning state.
# Read by: gate scripts, GateEnforcement.hook.ts, HarnessFailureSurfacing.hook.ts, LearningReview.ts
# Written by: LearningReview.ts (nightly — tighten/loosen/prune), DA (manual edits)

---

## goal-gate
- **Step:** GOAL (optional — only for L-sized work via harness)
- **Fires after:** Skill("goal") completes
- **Script:** `skills/ship/goal-gate.sh --issue NUM`
- **Checks:**
  - [ ] Issue has `## Goal` section
  - [ ] Issue has `## Success Criteria` with SC- or AC- prefixed items
  - [ ] SCs/ACs contain no vague words: exists, works, properly, correct, appropriate, should (without accompanying threshold number)
  - [ ] Issue has `## Scope Boundary` with In + Out items
  - [ ] Issue has `## Circuit Breakers` with iteration + cost limits
  - [ ] Checkpoint written to `$RUNGATE_WORK_DIR/{slug}/`
- **Strike threshold:** 3
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## scope-gate
- **Step:** SCOPE (after sizing + ACs, before BUILD)
- **Fires after:** Ship SCOPE completes
- **Script:** `skills/ship/scope-gate.sh --issue NUM --slug SLUG`
- **Checks:**
  - [ ] Issue has structured DISCOVERY comment with file:line citations (citation count > 0)
  - [ ] PRINCIPLES.md referenced in DISCOVERY comment (if project has one)
  - [ ] ARCHITECTURE.md referenced in DISCOVERY comment (if project has one)
  - [ ] Research decision explicit: findings posted OR "no research needed" with evidence
  - [ ] ACs posted to issue with AC-N IDs (count > 0)
  - [ ] No vague words in AC statements without threshold numbers
  - [ ] Sizing declaration posted: size + reasoning + expected files/time/boundaries
  - [ ] Each AC tagged [CODE] or [OUTCOME]
  - [ ] [OUTCOME] ACs have all 10 fields: Type, Statement, Metric, Threshold, Baseline, Evidence Method, Pass Criteria, Source, User, Conversation, Action
  - [ ] [CODE] ACs have all 7 fields: Type, Statement, Metric, Threshold, Baseline, Evidence Method, Pass Criteria, Source
  - [ ] Brief posted with ## Marcus Brief or ## Implementation Brief marker
  - [ ] Brief contains template markers: ## Context, ## Task, ## Verify, ## Report back
  - [ ] Adversarial goal test: ## Anti-Gaming table posted with defenses for every shortcut (M/L: required, XS/S: recommended)
  - [ ] **QC validator (STANDARD+):** `skill-qc-validator.sh --skill goal` — runs G1-G8 checks from `schemas/skill-qc-checks.json`. Currently WARN; promotes to FAIL after calibration.
- **Strike threshold:** 3
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## verify-gate
- **Step:** VERIFY (after evidence collected, before DURABILITY)
- **Fires after:** Ship VERIFY completes
- **Script:** `skills/ship/verify-gate.sh --issue NUM --slug SLUG`
- **Checks:**
  - [ ] Every AC-N in issue has matching evidence in completion report
  - [ ] [OUTCOME] ACs have live evidence: screenshot URL, curl output block, or browser verification — not code review alone
  - [ ] [CODE] ACs have file:line citation in evidence
  - [ ] Evidence references threshold number from AC (number appears in evidence text)
  - [ ] curl commands use correct test port (read from project CLAUDE.md)
  - [ ] Consumer chain: if consumer files changed (from git diff + PRINCIPLES.md consumer list), 4 artifacts present: curl output, screenshot, rendered output, goal statement reference
  - [ ] Report uses completion template markers from REFERENCE.md
  - [ ] **QC validator (STANDARD+):** `skill-qc-validator.sh --skill ship` — runs S1-S8 checks from `schemas/skill-qc-checks.json`. Currently WARN; promotes to FAIL after calibration.
- **Strike threshold (ceremony checks):** 3
- **Strike threshold (OUTCOME AC failures):** 0 (immediate block, no skip)
- **AC failures:** Must fix — no skip allowed. Iterate until pass or circuit breaker.
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## durability-gate
- **Step:** DURABILITY (after VERIFY, before CLOSE)
- **Fires after:** verify-gate passes
- **Script:** `skills/ship/durability-gate.sh --issue NUM --slug SLUG`
- **Checks:**
  - [ ] Doc cascade: git diff matched against doc-cascade-map.json
  - [ ] Structured findings: FAIL ACs have FINDING: comments posted
  - [ ] Quinn gate: .tsx changed → Quinn verification on issue
  - [ ] Checkpoint freshness: updated within 2 hours
  - [ ] Hedge-grep: zero hedged claims in issue comments (phrases from patterns.json `unverified_claim_phrases`)
  - [ ] Rook gate: M/L size → Rook scan on issue
  - [ ] Boundary crossing: XS/S + 2+ dirs → WARN
  - [ ] ADR status: referenced ADRs not "proposed"
  - [ ] Issue/brief current: if FINDING posted after ACs, ACs updated
  - [ ] Follow-ups logged: TODO/FOLLOWUP markers have corresponding issues
  - [ ] Failure pattern acknowledged: top pattern from HarnessFailureSurfacing referenced
- **Strike threshold:** 3
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## close-gate
- **Step:** CLOSE (after DURABILITY, before next issue)
- **Fires after:** Ship CLOSE actions
- **Script:** `skills/ship/close-gate.sh --issue NUM --slug SLUG`
- **Checks:**
  - [ ] Issue has `## Completion Report` comment
  - [ ] doc-hygiene invoked this session (from signals.jsonl)
  - [ ] Follow-up tracking: Marcus unrelated findings, Quinn/Rook FINDINGs, council scope_change — all have corresponding issues. Parent has `has-follow-ups` label if children exist. Children have `follow-up` + `needs-triage` labels
  - [ ] Sizing outcome posted: `## Sizing Outcome` with actual files/time/dirs vs declared
  - [ ] Checkpoint marked complete
  - [ ] Routing outcomes logged: if ATTEMPT comments exist, routing_outcome entries in signals.jsonl with required fields
  - [ ] Issue labeled `shipped`
- **Strike threshold:** 3
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## iteration-gate
- **Step:** ITERATION (after VERIFY fails, before looping back)
- **Fires at:** Every iteration boundary
- **Script:** `skills/ship/iteration-gate.sh --issue NUM --slug SLUG`
- **Checks:**
  - [ ] ATTEMPT comment posted for this iteration (count > previous)
  - [ ] ATTEMPT has required fields: Approach, Files Changed, Result, Evidence, Why It Failed
  - [ ] Iteration count tracked in stuck-detection.json
  - [ ] Same error hash not repeated 3x (hash "Why it failed" sections)
  - [ ] Iteration count < circuit breaker limit from issue
  - [ ] Wall clock < 90 minutes (or custom limit from issue)
  - [ ] Progress check: ≥1 new AC passed since last iteration, or new information acquired
  - [ ] Goal Audit: no baseline drift >20%, no entity non-existence, no research contradiction
  - [ ] Checkpoint has compaction fields: Current State, Next Action, Files Changed, Gate Status
  - [ ] Squashed commits: ≤1 new commit since last iteration on feature branch
- **Tier 1 threshold:** 3 iterations → auto-escalate via routing-decision.sh
- **Tier 2 threshold:** 6 iterations (3 pre + 3 post-escalation) → hard stop
- **Meta-circuit-breaker:** Max 2 goal amendments per issue
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## Gate Enforcement Model

**Strike escalation (ceremony gates):**
- Strike 1-2: system-reminder injected on every tool call
- Strike 3: hard block on Skill calls (Bash/Read/Agent still work for fixing)
- Escape: fix the failure OR post skip-reason to issue → block clears → skip logged

**AC failures (non-skippable):**
- [CODE] AC fail: iterate, no skip. Circuit breaker is only escape.
- [OUTCOME] AC fail: immediate block, iterate, no skip. Circuit breaker is only escape.

**Self-heal:** DA can use Bash/Read/Agent to resolve gate failures. Only Skill calls are blocked.

**Skip logging:** Every skip gets logged to signals.jsonl with type: "gate_skip". LearningReview reads these nightly.

**De-escalation:** Gates with 0 skips in 60 days → strike threshold resets to default (3). LearningReview manages this.

**Pruning:** Checks with 0 catches in 90 days → retired from gate definition. Skip history older than 30 days → pruned.

---

## Agent Enforcement (PreToolUse on Agent)

**Applies to:** All named agent spawns (Marcus, Quinn, Rook, Serena, Aditi)

- Brief must contain template markers (## Context, ## Task, ## Verify, ## Report back)
- `mode: "bypassPermissions"` must be set
- `max_turns` set by sizing: XS=20, S=30, M=50, L=75
- Single-attempt constraint injected: "STOP on persistent error, report what happened"
- Isolation routing: `.claude/` repo → worktree, external → direct
- Post-report: hedge-grep + spiral detection before accepting
- Brief block: if template markers missing → `{"decision": "block"}`
- bypassPermissions block: if missing → `{"decision": "block"}`

---

## Routing Table

**Decision tree (deterministic — from 109 real failure resolutions):**

1. Did agent read relevant files? (grep ATTEMPT for file reads) → NO: back to agent with file list
2. Did agent run it and check output? (grep for curl/screenshot/test) → NO: back to agent with evidence method
3. Framework/library error? (grep for framework names) → YES: Context7 first, then Research
4. Scope/requirements mismatch? (grep for "doesn't match", "expected") → YES: re-read issue + PRINCIPLES.md, then council
5. 3+ failed attempts? (count ATTEMPTs) → YES: council — approach is wrong
6. DEFAULT: Research — missing information

**Accuracy tracking:** Every routing decision logged to signals.jsonl with route + resolved outcome. LearningReview reorders steps by resolution rate, adds new patterns from successes, removes patterns with 0 matches in 90 days, demotes routes with <30% accuracy.

---

## Scoring

**Per-issue scorecard** (score-issue.sh):
- Gate pass per step (first-pass rate)
- Iteration count
- Sizing accuracy (declared vs actual)
- Time within budget
- Follow-ups created
- Routing used
- Letter grade: A (≥90% first-pass, ≤1 iter), B (≥75%, ≤2), C (≥60%, ≤3), D (<60% or Tier 2), F (hard stop)

**System dashboard** (nightly via LearningReview):
- Gate health: pass rates + top failure + trend per gate
- Issue metrics: avg grade, first-pass, iterations, sizing accuracy
- Routing performance: accuracy per route
- Gate escalation status

---

## Gate Infrastructure (from adversarial council 2026-09-17)

Source: 4-member adversarial council, 3 rounds, unanimous on all findings. Root cause analysis of #1436 6-gate-run failure.

### Error Surfacing

Gate failure detail must include actual Zod validation error paths — not hardcoded "failed" strings. The Zod errors (path + message) are computed at `workflow.test.ts:59` but discarded at `run-gate.ts:291` where `detail` is hardcoded to `"failed"`. The heal agent at `ship.js:152-159` receives failures with no specifics, making single-pass repair impossible.

**Rule:** After matching a `(fail)` test line, `run-gate.ts` must capture subsequent non-result lines as the detail string. Detail must include the Zod error path (e.g., `acs.0.threshold.op: Invalid enum value. Expected '==' | '>=' | ..., received 'equals'`).

### Schema Validation at Write Time

All writes to `workflow-state.json` must go through `writeWorkflowState()` at `orchestrator.ts:414-430` which validates via Zod with enum-specific error formatting. Per ADR-009:417-418: "writeWorkflowState() validates via Zod" — this is a design decision, not optional.

**Rule:** Agent heal prompts (ship.js) must not instruct agents to use the Write tool for workflow-state.json edits. All writes must route through `writeWorkflowState()` (via `bun -e` or equivalent) so agents get immediate Zod error feedback at write time, not opaque gate failures.

### DISCOVERY_SCHEMA Enum Constraints

The DISCOVERY_SCHEMA (JSON Schema for Claude structured output) at `ship.js:44` must constrain `threshold.op` and `evidenceMethod.type` to the same enum values as the Zod schema at `schema.ts:16` and `schema.ts:22-25`. Invalid values must be rejected at LLM structured output time, not deferred to gate time.

**Rule:** Enum values must be exported as const arrays from `schema.ts` and referenced in both the Zod schema and DISCOVERY_SCHEMA. A schema-parity test must assert they match.

### Schema Strictness Consistency

`writeWorkflowState()` at `orchestrator.ts:416` uses `.passthrough()` (allows extra keys) while `workflow.test.ts:57` uses strict `.safeParse()`. State that passes write-time validation can fail gate-time validation if it contains extra keys.

**Rule:** Both validation paths must use the same strictness level. Recommendation: `.passthrough()` in both, since extra keys are harmless and the schema evolves frequently.

### Workflow State Lifecycle

The `~/.rungate/` directory accumulates workflow state slugs with no archival mechanism. As of 2026-09-17: 1,065 slugs, 2 archived, 14 stuck in non-DONE phases, 1,001 with no workflow-state.json.

**Rule:** No background cleanup crons or daemons (unanimously rejected — race conditions with active workflows). Cleanup is lazy: `initWorkflow()` at `orchestrator.ts:467` logs a warning when overwriting non-DONE state. One-shot manual cleanup via Makefile target for accumulated slugs.

### Success Criteria

- [ ] GI-1: Gate failure detail includes actual Zod error path + message (not hardcoded "failed")
- [ ] GI-2: DISCOVERY_SCHEMA threshold.op has enum constraint matching schema.ts values
- [ ] GI-3: DISCOVERY_SCHEMA evidenceMethod.type has enum constraint matching schema.ts values
- [ ] GI-4: Enum values exported as const arrays from schema.ts (single source of truth)
- [ ] GI-5: schema-parity.test.ts asserts DISCOVERY_SCHEMA enums match Zod enums
- [ ] GI-6: Heal agent write prompts in ship.js route through writeWorkflowState() (not Write tool)
- [ ] GI-7: SCHEMA-GUIDE.md references validated write path (not Write tool)
- [ ] GI-8: writeWorkflowState() and workflow.test.ts use same parse strictness
- [ ] GI-9: initWorkflow() warns when overwriting non-DONE workflow state
