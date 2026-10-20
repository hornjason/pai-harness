---
doc-type: reference
status: active
owner: jason
updated: 2026-09-17
testable: true
compliance: strict
created: 2026-09-20
governs: Gate definitions — what checks run at each harness gate and their pass/fail criteria
---

# Harness Gates
# Source of truth for all gate definitions, enforcement config, and learning state.
# Read by: gate scripts, GateEnforcement.hook.ts, HarnessFailureSurfacing.hook.ts, LearningReview.ts
# Written by: LearningReview.ts (nightly — tighten/loosen/prune), DA (manual edits)

---

## goal-gate
- **Step:** GOAL (optional — only for L-sized work via harness)
- **Fires after:** Skill("goal") completes
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
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
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
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
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
- **Checks:**
  - [ ] Every AC-N in issue has matching evidence in completion report
  - [ ] [OUTCOME] ACs have live evidence: screenshot URL, curl output block, or browser verification — not code review alone
  - [ ] [CODE] ACs have file:line citation in evidence
  - [ ] Evidence references threshold number from AC (number appears in evidence text)
  - [ ] curl commands use correct test port (read from project CLAUDE.md)
  - [ ] Consumer chain: if consumer files changed (from git diff + PRINCIPLES.md consumer list), 4 artifacts present: curl output, screenshot, rendered output, goal statement reference
  - [ ] Report uses completion template markers from REFERENCE.md
  - [ ] `tsc-pass`: when `projectRoot/tsconfig.json` exists, the gate RUNS `bunx tsc --noEmit` in the project root and compares the diagnostic count against `projectRoot/.claude/typecheck-baseline.json`. Above the baseline is a FAIL; below it is a WARN telling you to bank the progress; a baseline file that is missing counts as zero, and one that is unreadable is a FAIL rather than "no baseline". Until #176 this check did none of that — it returned early when `environments.local.tests` was PASS or SKIP and ended with no assertion, so the gate asked the agent under test whether it needed to run.
  - [ ] `local-api-validated` / `local-ui-validated`: the verdict must come from whoever measured the environment. `workflows/ship.js` no longer derives `--api PASS` from `projectConfig.apiUrl` being truthy, and `scripts/record-build-commit.ts` no longer defaults either field to SKIP or overwrites a verdict already in the file. A configured `dev.apiBase`/`dev.uiBase` with nothing recorded is now a FAIL, which is the branch these checks did not previously have (#176).
  - [ ] **QC validator (STANDARD+):** `skill-qc-validator.sh --skill ship` — runs S1-S8 checks from `schemas/skill-qc-checks.json`. Currently WARN; promotes to FAIL after calibration.

  **What was broken to prove these three can fail:** `test/gate-vacuous-checks.test.ts` plants a project with one bad assignment and a baseline of 0 and watches `tsc-pass` go red, then removes the error and watches it go green; it plants a configured `apiBase`/`uiBase` with no recorded verdict and watches the other two go red, then records a verdict and watches them go green. `test/record-build-commit.test.ts` mutates `PRESERVE_MEASURED_ENVIRONMENTS` to `false` and asserts the overwrite comes back.
- **Strike threshold (ceremony checks):** 3
- **Strike threshold (OUTCOME AC failures):** 0 (immediate block, no skip)
- **AC failures:** Must fix — no skip allowed. Iterate until pass or circuit breaker.
- **Escalated:** false
- **Skip history (30d):** 0 skips

---

## durability-gate
- **Step:** DURABILITY (after VERIFY, before CLOSE)
- **Fires after:** verify-gate passes
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
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
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
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
- **Implementation:** `gates/run-gate.ts` (TypeScript gate runner)
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

Gate failure detail must include actual Zod validation error paths — not hardcoded "failed" strings. The Zod errors (path + message) are computed at `gates/workflow.test.ts:59` but discarded at `gates/run-gate.ts:291` where `detail` is hardcoded to `"failed"`. The heal agent at `workflows/ship.js:152-159` receives failures with no specifics, making single-pass repair impossible.

**Rule:** After matching a `(fail)` test line, `run-gate.ts` must capture subsequent non-result lines as the detail string. Detail must include the Zod error path (e.g., `acs.0.threshold.op: Invalid enum value. Expected '==' | '>=' | ..., received 'equals'`).

### Schema Validation at Write Time

All writes to `workflow-state.json` must go through `writeWorkflowState()` at `gates/orchestrator.ts:414-430` which validates via Zod with enum-specific error formatting. Per ADR-009:417-418: "writeWorkflowState() validates via Zod" — this is a design decision, not optional.

**Rule:** Agent heal prompts (ship.js) must not instruct agents to use the Write tool for workflow-state.json edits. All writes must route through `writeWorkflowState()` (via `bun -e` or equivalent) so agents get immediate Zod error feedback at write time, not opaque gate failures.

### DISCOVERY_SCHEMA Enum Constraints

The DISCOVERY_SCHEMA (JSON Schema for Claude structured output) at `workflows/ship.js:44` must constrain `threshold.op` and `evidenceMethod.type` to the same enum values as the Zod schema at `gates/schema.ts:16` and `gates/schema.ts:22-25`. Invalid values must be rejected at LLM structured output time, not deferred to gate time.

**Rule:** Enum values must be exported as const arrays from `schema.ts` and referenced in both the Zod schema and DISCOVERY_SCHEMA. A schema-parity test must assert they match.

### Schema Strictness Consistency

`writeWorkflowState()` at `gates/orchestrator.ts:416` uses `.passthrough()` (allows extra keys) while `gates/workflow.test.ts:57` uses strict `.safeParse()`. State that passes write-time validation can fail gate-time validation if it contains extra keys.

**Rule:** Both validation paths must use the same strictness level. Recommendation: `.passthrough()` in both, since extra keys are harmless and the schema evolves frequently.

### Workflow State Lifecycle

The `~/.rungate/` directory accumulates workflow state slugs with no archival mechanism. As of 2026-09-17: 1,065 slugs, 2 archived, 14 stuck in non-DONE phases, 1,001 with no workflow-state.json.

**Rule:** No background cleanup crons or daemons (unanimously rejected — race conditions with active workflows). Cleanup is lazy: `initWorkflow()` at `gates/orchestrator.ts:467` logs a warning when overwriting non-DONE state. One-shot manual cleanup via Makefile target for accumulated slugs.

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

## #183 — the audit of the rest of the ported-check list

#176 fixed three checks that could not fail. This is Phase 2: whole-repo
verification of those changes, and the audit of the remaining ported checks
for the same two shapes — **an early return with no tail**, and **a field read
as a verdict that only configuration writes** — reported even where no fix is
made.

### Verification (AC-7 of #176)

| Reading | Result |
|---|---|
| `bun scripts/typecheck.ts` | 0 errors, matching baseline |
| `bun scripts/test-clean-env.ts` | 0 failures — **after two fixes below**; it reported 2 on first run |
| CI on the merged Phase 1 commit | `test` and `gates` green |

**`bun scripts/test-clean-env.ts` did not report 0 on the first run**, and
neither failure was Phase 1's. Both were the modelled environment differing
from CI in a way that made a correct test fail — the inversion that module
exists to prevent — so both were fixed rather than recorded:

- `test/worktree-repo.test.ts` SC-1444 asks which repository the checkout is
  of. `ciCheckoutPlan` repoints `origin` at `file://source` so the replayed
  fetches resolve offline, and then left it there. `actions/checkout@v4`
  leaves `origin` on the GitHub repository, so the test read a filesystem path
  under the model and `github.com/owner/name` in CI. The plan now restores the
  source's own `origin` as its **last** command, after the fetches that need
  the `file://` URL. A source with no remote restores nothing, which is also
  what CI would have, and that is the control.
- `test/scaffold-ownership.test.ts` copies the working tree's dirty paths into
  a clone. `--untracked-files=all` descends into untracked directories but
  reports a **symlink** to one as a single entry, and the CI-shaped checkout
  symlinks `node_modules` in — so `readFileSync` hit `EISDIR` and the case
  died for a reason unrelated to scaffolding. Filtered on what the path *is*
  rather than on its name; a name filter would be the hand-kept list that
  comment already rejects.

- [x] SC-1471: lib/ci-checkout.ts contains [originUrl] — the modelled checkout ends with the source's own remote rather than the temp path it cloned from so a test cannot pass in CI and fail in the model

### Shape 1 — checks with no assertion

`gates/workflow.test.ts` holds **79** `test(...)` calls. Seven are the
`skipped — no active workflow (standalone run)` placeholder, which is a stub
and not a check; all seven have empty bodies. Of the remaining 72, **four**
contain no `expect` anywhere:

| Check | Documented decision? |
|---|---|
| `quinn-container-port` | **Yes** — #344 states the warning is deliberate and that making it refuse needs its own measurement |
| `spec-decision-compliance` | **Yes** — #409 Decision #9 placed it in the WARN tier |
| `outcome-evidence-behavioral` | **No** — `tsc-pass`'s shape with a `console.warn` where the assertion should be. Its sibling two tests above, `outcome-acs-no-skip`, does assert |
| `ac-issue-alignment` | **No** — found by this audit. Computes a stopword-filtered keyword coverage ratio and warns under 50% |

**The finding is not the four. It is that nothing could tell them apart.** Two
were deliberate, two were not, and from outside the file they were
indistinguishable — which is the gap `tsc-pass` lived in for its whole life.
So the audit is a binding rather than a paragraph: `WARN_TIER_CHECKS` in
`lib/gate-check-audit.ts` names all four with a reason, and the list fails in
**both** directions. A new warn-only check fails the suite; a listed check
that gains an assertion fails the suite until its entry is deleted.

The two undocumented checks are **reported, not fixed**. Tightening either
changes what blocks live runs, which is a behaviour change with its own
measurement, and #183's AC asks for the audit rather than the fix.

### Shape 2 — a verdict nobody measured

Thirteen `environments` fields are read by the gate suite. Tracing each to its
writer:

| Field | Writer | Verdict |
|---|---|---|
| `local.api` / `local.ui` | whoever measured the environment | clean — #176 |
| `local.tests` | a real suite run | clean — #173 |
| `local.quinn.port` | Quinn's own run | clean |
| `prod.quinn` / `prod.quinnSpot` | always `SKIP` with a reason on every arm | no false verdict, but also no path to anything else |
| **`prod.rebuild`** | **a health curl** | **the defect** |
| `prod.smoke` | the same health curl | honest — a 200 from the configured health path *is* a smoke test |

`workflows/ship.js`'s "container is up (200)" arm wrote
`s.environments.prod.rebuild = 'PASS'`. A health check says a container is
**answering**; it says nothing about whether that container was built from
this commit, and during a ship run it has not been — the rebuild happens after
merge.

That literal did not merely sit in the file. `container-has-fix`
(`gates/workflow.test.ts:636`) reads it and passes it to
`classifyContainerProvenance` as `prodRebuild`, where `"PASS"` turns a
**measured** `BEHIND` verdict non-blocking. So a container that merely
responded switched off the one check that compares the container's image
revision against HEAD — the check added by #341 for exactly this.

This one **is** fixed, to the standard #176 AC-3 already set: *SKIP with a
reason is acceptable; PASS without a measurement is not.* The arm now records
`rebuild = 'SKIP'` with a reason naming what was and was not measured, and
leaves `smoke = 'PASS'`, which is the one thing the curl does establish.

- [x] SC-1466: test/gate-check-audit.test.ts contains [no check warns without being on the list, no name on the list has quietly gained an assertion] — the warn-tier list fails in both directions so it cannot outlive what it describes
- [x] SC-1467: lib/gate-check-audit.ts contains [WARN_TIER_CHECKS, STANDALONE_STUB_NAME] — one binding for the list and a separate category for the placeholder stub whose emptiness is asserted rather than assumed
- [x] SC-1468: test/gate-check-audit.test.ts contains [the parse count matches the number of test( lines] — the positive control: a parser returning nothing would satisfy the whole audit vacuously
- [x] SC-1469: workflows/ship.js not contains [s.environments.prod.rebuild = 'PASS'] — a container that answers a health check is recorded as SKIP with a reason rather than as a rebuild that happened
- [x] SC-1470: test/gate-check-audit.test.ts contains [the same reading does NOT block when the rebuild says PASS] — the suppression the false verdict was switching off is executed from both sides

### What was broken to prove it

Measured over `test/gate-check-audit.test.ts` (18 tests):

| Mutation | Red |
|---|---|
| `WARN_TIER_CHECKS` emptied | 2 of 18 — the unlisted check and the two-shapes mix |
| an entry left in after its check gained an assertion | 1 of 18 — the other direction |
| the parser's `expect` regex narrowed back to `\bexpect\s*\(` | 2 of 18 — the generic-form case and the unlisted-check case, because `workflow-state.json validates` reappears |
| `gateChecks` short-circuited to `return []` | 8 of 18 — every assertion about the file at once, which is what the count control is for: without it the two SC-1466 cases would both go green over an empty list |
| `s.environments.prod.rebuild = 'PASS'` restored in ship.js | **1 of 18** |
| `classifyContainerProvenance` stops suppressing on `PASS` | 1 of 18 — the pair is not two views of one branch |

The **1 of 18** is a finding, not a comfortable number. The second SC-1469
case asserts that the file contains `rebuild = 'SKIP'` and a
`rebuildSkipReason`, and the *container-down* arm contains both — so restoring
the false PASS in the container-up arm leaves that case green. A substring
test over a file with two similar arms cannot tell which arm it matched. The
case that does catch it is the `not contains` one, which is why SC-1469 is
written as an absence; the positive case is there to stop an arm that records
`SKIP` for everything and is honest about being the weaker half.

### What this does NOT fix

- **`outcome-evidence-behavioral` and `ac-issue-alignment` still only warn.**
  Named, reasoned, and ratcheted; not tightened. *(Settled by #423 below, in
  opposite directions.)*
- **`prod.quinn` has no path to PASS.** Every arm writes `SKIP` with a reason,
  so `prod-quinn-pass` can never report anything else for a configured
  project. Reported, not changed — giving it a real verdict means deciding
  what measures it. *(Settled by #423 below: the thing that measures it
  already existed.)*
- **#341 criterion 1 is still unmet.** Only a measured `BEHIND` blocks. The
  fix above restores that block on a path where it had been suppressed; it
  does not widen which outcomes block.

## #423 — the three checks that were counted and could not fail

#183's remainder. Three checks sat in the gate's pass total contributing
nothing: two that warn where a verdict was promised, and one whose only
reachable outcome was `SKIP`. All three are settled here, and they do **not**
all go the same way — which is the point. "Make every warning an assertion"
is a policy, not an answer; what each one needed was evidence.

### `outcome-evidence-behavioral` — asserts

It was `tsc-pass`'s shape: a name promising a verdict over a body that could
only `console.warn`, with its sibling two tests above it (`outcome-acs-no-skip`)
asserting all along. An OUTCOME AC records that a user-visible outcome was
*observed*; a bare number cannot establish one, and a `0` that reads as success
is the *Silent Default Substitution* anti-pattern this repo already names.

The reading moved to `outcomeEvidenceViolations` in `lib/ac-quality.ts`, and it
is **wider than the body it replaces**. The inline `/^\d+$/` read `3` as a bare
number and `3/3`, `12%`, `0.0` and `-1` as behavioural evidence — the second
shape in `.claude/rules/checks-must-be-able-to-fail.md`, where a reformat of
the same non-answer walks straight through. The question is whether the
evidence contains a *word*, so that is what is asked.

Absent evidence stays out of scope, deliberately: `all-acs-have-evidence`
exempts OUTCOME ACs from mechanical evidence at ship time by design, and
answering that question here too would be two deciders on one question.

### `ac-issue-alignment` — stays a warning, on a number

ADR-009 C4 asks that ACs cover the goal's keywords. Measured over the **153**
`workflow-state.json` files under `~/.rungate` carrying a goal:

| Population | n | Would refuse (<50%) | Median coverage |
|---|---|---|---|
| every state with a goal | 153 | 108 (**71%**) | 38% |
| ACs carry real statements (>80 chars) | 131 | 87 (66%) | 41% |
| ACs substantial (>300 chars) | 101 | 74 (73%) | 39% |
| goals with ≥8 keywords | 106 | 75 (71%) | 41% |

The figure does not move under any slice. A check that would refuse two runs
in three is an outage, not a gate, and a stopword-filtered substring match over
prose is the same basis #409 Decision #9 already rejected for
`spec-decision-compliance`. So the `WARN_TIER_CHECKS` entry is rewritten from
**"#183 — reported, not fixed"** to a decision carrying that measurement, and
the warn-tier list now holds no deferrals at all — which is itself asserted,
because a deferral is an honest thing to write once and a bad thing to leave.

### `prod.quinn` — the measurement already existed

Every arm of `workflows/ship.js`'s record-env step wrote `quinn = 'SKIP'`. The
reasons were honest; the consequence was that `prod-quinn-pass` had no
reachable path to PASS for any project configuring `prod.rebuild`.

Container Quinn runs in the Verify phase against the rebuilt container,
returns a `GATE_RESULT_SCHEMA` verdict, and is held in `quinnContainerResult`
so the ship-phase recommit can report it — while the record-env prompt four
hundred lines below ignored it and wrote a constant. `prodQuinnRecord` reads
it, through **`quinnVerdictFor`, the same binding the recommit uses**: two
functions deciding what one agent's reply said would be two deciders agreeing,
and the artefact and the recorder could then disagree with nothing to see it.

- [x] SC-1572: test/gate-check-audit.test.ts contains [no entry is still a deferral — every one is a decision] — the replaced assertion counted deferrals and required exactly two, so it could only be satisfied by not fixing them; it is inverted rather than retuned
- [x] SC-1573: test/gate-check-audit.test.ts contains [the warning that survived on a measurement cites the measurement] — a decision to keep a check warning forever is indistinguishable from never having looked unless it says what blocking would have cost
- [x] SC-1574: test/gate-check-audit.test.ts contains [outcome-evidence-behavioral is no longer warn-tier] — named from this side too, so re-adding the entry has to argue with the issue rather than with a list length
- [x] SC-1575: test/ac-quality.test.ts contains [a bare number is refused and behavioral evidence beside it is not] — AC-2's red and green in one shape, and every violating AC is reported rather than the first
- [x] SC-1576: test/ac-quality.test.ts contains [a reformatted non-answer is still a non-answer] — nine forms the `/^\d+$/` body read as behavioural, with a six-case positive control so a detector that called everything bare could not pass
- [x] SC-1577: test/ac-quality.test.ts contains [the check looks at OUTCOME ACs that passed, and nothing else] — a CODE AC's evidence IS often a count, and widening to those would turn a fix into an outage
- [x] SC-1578: test/ac-quality.test.ts contains [outcome-evidence-behavioral is read as asserting by the #183 parser] — asked of `gateChecks` rather than read by hand, so both directions go through one binding
- [x] SC-1579: test/ac-quality.test.ts contains [the parser reads it as warn-only, which is the decision] — the same binding, asserting the opposite, so one check cannot quietly become the other
- [x] SC-1580: test/ac-quality.test.ts contains [a goal whose keywords ARE covered scores above the threshold] — AC-3's control: without it a coverage function returning 0 for everything satisfies every firing case
- [x] SC-1581: test/ac-quality.test.ts contains [nothing to ask is null, which is not the same as zero coverage] — a goal of nothing but short words has not been measured at 0%, it has not been measured
- [x] SC-1582: test/ac-quality.test.ts contains [the reading is case-insensitive and ignores punctuation, as the goal is prose]
- [x] SC-1583: test/prod-quinn-record.test.ts contains [a container Quinn PASS records PASS — the arm that did not exist] — and carries no skip reason, because a reason explains an absence
- [x] SC-1584: test/prod-quinn-record.test.ts contains [a FAIL is a FAIL, and a SKIP from the agent keeps its own reason] — an unusable reply is a FAIL, which comes from the injected `quinnVerdictFor` rather than a reimplementation
- [x] SC-1585: test/prod-quinn-record.test.ts contains [no container Quinn is a SKIP that says which case it was] — unreachable and unconfigured are different facts and the reasons are asserted distinguishable
- [x] SC-1586: test/prod-quinn-record.test.ts contains [every reachable record satisfies prod-quinn-pass's contract] — asserted over the whole input matrix with PASS and FAIL both required to occur in it, because "the cases I thought of pass" is the wrong evidence for a check whose defect was that one outcome was reachable

### What was broken to prove it (SC-1572..1586)

Measured over `test/ac-quality.test.ts`, `test/prod-quinn-record.test.ts`,
`test/gate-check-audit.test.ts`, `test/record-build-commit.test.ts`,
`gates/workflow.test.ts` and `test/gate-vacuous-checks.test.ts` — 142 tests,
baseline 0 red. None of the fifteen is left in the tree; all were run and
reverted.

| Mutation | Red |
|---|---|
| nothing is a bare measurement | 3 of 142 — the refusal, the multi-AC report, and the nine reformatted non-answers |
| everything is a bare measurement | 4 of 142 — the positive controls, which is what they are for: a detector that refused everything satisfies every refusal case above |
| the detector narrows back to `/^\d+$/` | 1 of 142 — `3/3`, `12%`, `0.0` and `-1` go back to reading as behavioural evidence |
| every AC is judged, not only OUTCOME ones that passed | 2 of 142 — a CODE AC's count, and an OUTCOME AC that did not pass being reported twice under the wrong reason |
| absent evidence becomes this check's business too | 1 of 142 — the second decider `all-acs-have-evidence` already owns |
| `outcome-evidence-behavioral` goes back to warning | 2 of 142 — the parser reads it as warn-only, AND #183's own ratchet fires because it is warning without being on the list. The two halves of the same fact, from both sides |
| `ac-issue-alignment` starts refusing | 2 of 142 — the parser, and the ratchet's stale-entry direction |
| goal coverage is never measurable | 3 of 142 — both thresholds and the prose case |
| goal coverage is always full | 2 of 142 — the under-threshold control and the measured zero |
| `prod.quinn` is a constant SKIP again — #423 verbatim | 3 of 142 — the PASS arm, the FAIL arm, and the matrix control that requires PASS to occur at all |
| a SKIP stops carrying a reason | 2 of 142 — `prod-quinn-pass` refuses a SKIP without one |
| unreachable and unconfigured stop being different facts | 1 of 142 — a reader who cannot tell them apart cannot say which to fix |
| one record-env arm goes back to a literal | 1 of 142 — the `not contains` half; the count of interpolations is the weaker one and is there so deleting all three cannot read as success |
| the `ac-issue-alignment` entry goes back to a deferral | 2 of 142 — the no-deferrals assertion and the cites-a-measurement one |
| `outcome-evidence-behavioral` re-added to the warn-tier list | 2 of 142 — the named case and the generic stale-entry case |

One prediction missed, and it is worth recording because the lesson from #420
is that a row lower than predicted is a finding until shown otherwise:
"a SKIP stops carrying a reason" was predicted at 3 and measured 2. The
no-container reason lives in a different branch than the one the mutation
emptied, so SC-1585 never saw it. The mutation was narrower than the
prediction, not the test weaker — confirmed by mutating the other branch,
which is the row above it.
