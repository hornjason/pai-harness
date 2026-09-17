---
doc-type: reference
status: active
owner: jason
updated: 2026-08-27
---

# Iteration Protocol — Outer Quality Loop

Ship handles one implementation pass (SCOPE→BUILD→VERIFY→CLOSE). This protocol wraps ship in an outer loop that iterates until a quality target is met — driven by a spec, goal SCs, or both.

**When this fires:** After ship's Step 1 (SCOPE), if the work has iteration config (output type `iteration` section or `## Iteration Mode` in issue body), follow this protocol instead of proceeding to BUILD directly.

## Step 0: VALIDATION DESIGN (runs once, council-gated)

Before any implementation, define WHAT we're testing and verify it's sufficient.

### 0a. Identify validation layers

Every iterable task has up to 3 layers. Identify which apply:

| Layer | When it applies | Artifact needed |
|---|---|---|
| Content/API | Always | Spec + validator script OR behavioral SCs with verification commands |
| UI | When UI component exists | New-user walkthrough script for Quinn |
| E2E | When crossing integration boundaries | Cross-layer verification commands |

### 0b. Load or draft artifacts

**If artifacts exist** (repeat run): load from `docs/specs/`, `scripts/validate-*.ts`, `docs/specs/ui/`. Council reviews for gaps against THIS round's changes only.

**If artifacts don't exist** (first run): DA drafts:
- **Spec-driven:** read the governing spec, design validator checks (PASS/WARN/FAIL per field)
- **Goal-driven:** decompose goal into behavioral SCs. Each SC: user action → system result. NO grep-only SCs — must test through the system.
- **UI:** write new-user walkthrough. Each step: navigate → interact → verify visible result. Cover: happy path, empty state, error state, edge cases.
- **E2E:** write cross-boundary checks. Each: state change in layer A → verify effect in layer B.

### 0c. Council reviews ALL artifacts (MANDATORY)

Council evaluates:
1. **Sufficiency** — does this cover the goal?
2. **False-pass check** — could these pass with the feature broken? Rewrite any that could.
3. **Coverage matrix** — cross-layer gap analysis. Every testable behavior covered in at least 2 layers.
4. **Edge cases** — empty state, error state, new user, stale data, concurrent access.
5. **Module→concept mapping** — if the work touches multiple modules, is the boundary defined?
6. **Entity sample selection** — which 3+ entities (customers, products, etc.) will be tested? Select for data diversity: one with full data, one with partial, one with none/edge case. Council approves the sample.
7. **Global data masking** — does any shared/global data source mask per-entity results? Flag any module that returns data regardless of entity parameter.

Council also CREATES missing artifacts:
- No validator script? → council designs check list, Marcus builds it as prerequisite.
- No UI walkthrough? → council writes it from new-user perspective.
- No behavioral SCs? → council decomposes goal into testable assertions.

### 0d. Gate

Cannot enter the loop until:
- [ ] All 3 layers identified (or explicitly marked N/A)
- [ ] Council has reviewed and approved
- [ ] Coverage matrix has no gaps
- [ ] False-pass check passed on every SC/assertion

## The Loop

### AUDIT

Run all verification commands. Record results per layer:

```
═══ ITERATION — AUDIT ═══
Pass: N
Layer: Content/API
  SC-1: [PASS/FAIL] — [command output]
  SC-2: [PASS/FAIL] — [command output]
Layer: UI
  UI-1: [PASS/FAIL] — [Quinn result]
Layer: E2E
  E2E-1: [PASS/FAIL] — [command output]
Baseline: X/Y passing (first pass only)
Delta: +N PASS, -N FAIL since last pass
```

**For spec-driven work:** also run the validator script and quality checks from output type config.

### DECIDE (mechanical — no judgment)

```
All checks PASS on dev?
  └─ YES → DEPLOY TO PROD (see below)
  └─ NO →
      Same check failed 2+ consecutive passes?
        └─ YES → COUNCIL (architectural input needed)
        └─ NO →
            Failure is scope gap (missed integration point, wrong count)?
              └─ YES → RE-AUDIT (re-run Step 0c council review)
              └─ NO → SHIP (fix and retry)
```

**After council:** if same check fails again → ESCALATE to Jason. 3 strikes maximum.

**NO OVERRIDES.** "Root cause is clear" is not a reason to skip council. If the mechanical trigger fires, council runs. Every time the agent thinks "I know the fix, no need for council" and skips it, the fix fails and wastes a pass. The trigger exists BECAUSE the agent's confidence doesn't correlate with fix success.

**Council → SHIP is automatic.** When council returns recommendations, file the issues and start shipping the highest priority immediately. No "Want me to file issues and start?" — YES, always yes. Council output IS the next SHIP input. AFK means the transition is seamless.

### SHIP

Enter ship BUILD with:
- Failing checks as ACs
- Full scope from AUDIT (every file, every count)
- Verification commands to run

Ship runs SCOPE→BUILD→VERIFY→DURABILITY→CLOSE internally. No stops within ship — AFK mode applies.

### VERIFY

After ship CLOSE, re-run ALL checks (not just the ones that were fixed). A fix for SC-3 can break SC-1.

### LEARN (mandatory after every VERIFY, before looping)

After each SHIP→VERIFY cycle, reflect and produce artifacts before looping back to AUDIT:

1. **What gap did we find?** — Name the specific failure that triggered this pass
2. **Why wasn't it caught earlier?** — Root cause of the miss (narrow guard, wrong trigger, skipped step)
3. **What mechanical change prevents this?** — Rule, guard, gate, validator check, or template update
4. **Implement now** — Write the CLAUDE.md rule, update the gate script, add the validator check, or save the feedback memory IN THIS STEP. Not "later", not "follow-up". The learning is only real if it ships as an artifact in the same pass.

Output format:
```
═══ ITERATION — LEARN ═══
Pass: N
Gap: [what failed]
Root cause: [why it wasn't caught]
Mechanical fix: [what changed — file:line or rule name]
Artifact: [CLAUDE.md rule | gate script | validator check | feedback memory]
```

This step is not optional reflection — it's a mechanical step that produces durable artifacts. Skip it and the same gap class recurs on the next campaign or the next customer.

**Post to issue:** After producing the LEARN output, post it as a GitHub issue comment. This creates a permanent audit trail — conversation context evaporates, issue comments don't.

**Final LEARN (all checks pass):** Run LEARN one more time before EXIT. The question shifts: "What did the full iteration teach us?" Not just the last pass — the entire arc. Capture meta-learning about the process itself (briefing gaps, wrong assumptions, wasted passes).

Back to DECIDE.

## Dev → Prod → UI Progression

The loop runs in phases. Each phase must be clean before advancing:

```
PHASE 1: LOCAL DEV (iterate until 0 failures)
  Pass 1: AUDIT → DECIDE → SHIP → VERIFY (content/API)
  Pass 1.5: UI SMOKE CHECK — Quinn verifies component renders in DOM
    If not rendered → fix wiring BEFORE continuing API iteration
    Not a full walkthrough — just "does it appear on the page?"
  Pass 2+: AUDIT → DECIDE → SHIP → VERIFY (content/API + smoke re-check)
  Dev server (7778) — no rebuild between passes
  Exit: all content/API passing + component renders on dev

PHASE 2: PROD DEPLOY (one-time)
  make rebuild → prod (7777)
  DEPLOYMENT VERIFICATION: confirm container serves new build
    Check: JS bundle hash changed, or grep for known-new string in response
    If old build still served → rebuild failed silently → investigate
  Re-run all content/API + behavioral checks against prod
  If prod fails → back to PHASE 1 (new gaps on dev)

PHASE 3: UI ON DEV (if UI layer exists)
  Quinn runs full walkthrough on dev (7778) — all entities in sample
  If failures → fix on dev → Quinn re-runs on ALL entities (not just fixed one)
  Exit: Quinn walkthrough 100% passing on dev for all sample entities

PHASE 4: UI ON PROD (one-time)
  make rebuild → prod
  DEPLOYMENT VERIFICATION (same as Phase 2)
  Quinn runs walkthrough on prod — all entities in sample
  If failures → back to PHASE 3

EXIT: all layers passing on all environments on all sample entities
```

**UI smoke check rationale:** Catching "component doesn't render" on pass 1 costs one quick Quinn check. Missing it costs 4+ wasted passes iterating API against a UI that was never wired up. Cheapest to detect, most expensive to miss.

## Circuit Breakers

- **Stall:** 2 consecutive passes with identical PASS/FAIL counts → council
- **Oscillation:** track WHICH checks fail, not just count. If the failing set changes but count doesn't decrease over 3 passes → council. (SC-1 passes while SC-2 fails, then reverses — count unchanged but different bugs)
- **Regression:** if a SHIP pass INCREASES total failures → immediate `git revert` of that pass + council. Compounding damage is worse than reverting.
- **Max passes (size-scaled):** XS: 3 max. S: 4. M: 6. L: 8. Not a flat number for all sizes.
- **Elapsed time:** XS > 1 hour, S > 2 hours, M > 4 hours, L > 8 hours → council. Exceeding time budget means something is structurally wrong.
- **Post-council limit:** 3 failures on same check after council → escalate to Jason
- **Cost:** stop if token spend exceeds issue budget

## Spec-Driven Extras

When the output type has an `iteration` section with `regenerate` and `validate`:

- After SHIP, run the **regenerate** command (e.g., `curl POST .../generate`)
- Then run the **validate** command (e.g., `bun scripts/validate-*.ts`)
- Then run **quality checks** if defined (e.g., Sapling AI detection)
- Exit criteria from output type config (e.g., `validate_fail: "0"`)

This replaces manual "did you regenerate?" checks with mechanical execution.

## EXIT

```
═══ ITERATION — COMPLETE ═══
Passes: N (Phase 1: X, Phase 2: Y, Phase 3: Z, Phase 4: W)
Baseline: A/B passing → Final: B/B passing
Environments: dev ✓, prod ✓, UI ✓
Council invocations: N
Issues shipped: #NNN, #NNN
Time: X hours
```

### Persist validated artifacts

After a successful exit:
- New spec/validator → already in repo (committed during ship)
- New UI walkthrough → save to `docs/specs/ui/{type}-walkthrough.md`
- New behavioral SCs → update output type JSON `iteration` section
- Coverage matrix → save to issue as closing comment

Next time this output type runs → Step 0 loads existing artifacts. Council reviews for NEW gaps only.

## Verification Questionnaire (run at every AUDIT)

Before reporting AUDIT results, answer every question. Any NO without evidence = BLOCKED.

**Layer depth:**
- [ ] Did you verify via API (curl/command)?
- [ ] Did you verify the UI component renders (not just API)?
- [ ] For consumer outputs: did you generate through the UI and validate the output against spec?
- [ ] Did you check rendered output (Google Doc, email HTML) if applicable?

**Entity coverage:**
- [ ] Did you verify on the primary dev entity?
- [ ] Did you verify on 2+ additional entities from the council-approved sample?
- [ ] Did you verify on the edge-case entity (empty/minimal data)?

**Regression:**
- [ ] Did you re-run ALL checks, not just the fixed ones?
- [ ] Did fixing this increase total failure count? (If yes → revert)

**Tool verification:**
- [ ] Did every agent/skill invocation produce actual output (not "completed in 0s")?
- [ ] Does the deployed container serve the new build (check bundle hash)?

**Data integrity:**
- [ ] Does any "loaded" status reflect actual per-entity data (not global/shared counts)?
- [ ] Do percentages/values match between API and UI?

**Output-change Quinn trigger:**
- [ ] Did this change alter user-visible output (generated content, not just code structure)?
- [ ] If yes: did Quinn walk the UI flow where users see that output (preview modal, detail page, export)?
- [ ] "No .tsx changed" is NOT a valid Quinn skip — the test is "did the user experience change?"

**Quinn briefing completeness:**
- [ ] Does the Quinn brief include exact page location? (sidebar vs main, group name, expand action)
- [ ] Does the Quinn brief include the correct URL format? (display name vs slug — check the router)
- [ ] Does the Quinn brief include exact curl commands with correct identifiers for API verification?

This questionnaire grows with each iteration run. New failure patterns discovered during any session become new questions here.

## API verification is NOT UI verification

Verifying an API endpoint via curl does NOT verify the UI works. The API can return perfect data while:
- The UI component doesn't render at all (import/wiring bug)
- The UI renders but shows stale/wrong data (fetch URL mismatch)
- The UI renders but the layout is broken (CSS/component structure)
- The UI renders on one route but the user navigates a different route

**Rule: Every UI AC requires Quinn to walk through the actual browser.** Marcus cannot claim a UI AC is done with "visual verification requires rebuild" or "component created." A component that exists in code but doesn't render is not done.

**Quinn trigger is "did the user experience change?" — NOT "did .tsx files change."** Backend changes that alter generated content (campaigns, account plans, briefs, emails) change what the user sees in preview modals, detail pages, and exports. Zero .tsx changes does NOT mean zero UI impact. If the output content changed, Quinn walks the UI flow where users see that content.

Examples of backend-only changes that require Quinn:
- Extraction logic changes → campaign content changes → preview modal shows different text
- Signal scoring changes → brief content changes → brief page shows different priorities
- Template changes → account plan structure changes → plan panel shows different sections
- Data source wiring → new data appears in existing UI components

**After every fix that changes user-visible output:** Quinn runs the full UI walkthrough on the flow where the output is consumed. Not optional. Not "if time permits." The walkthrough IS the verification. Verify the fix the same way the bug was found.

**curl ≠ UI.** curl verifies the API layer. Quinn verifies the UI layer. Both must pass independently. A passing curl test with no Quinn walkthrough means the UI layer is UNVERIFIED, not passing.

## Verification must go ALL the way through

Three layers of "stopping too early" that keep recurring:

1. **API check instead of UI** — curl returned clean data, declared done. But the UI renders it wrong or doesn't render at all.
2. **UI rendered instead of output quality** — generation succeeded, declared done. But nobody read the actual output against the spec (orphaned words, truncated openers, metadata leaks).
3. **One entity instead of all affected** — A10 was clean, declared done. But Illumio/Initech had different data that triggered different bugs.

**The rule: verification goes ALL the way down, ALL the way across.**

"All the way down" means: API → UI renders → output generated → output validated against spec. Every layer, not just the first that passes.

"All the way across" means: if the fix affects multiple customers/entities, verify on ALL of them (or a representative sample of 3+), not just the one used during development.

A passing check on one customer with one layer verified is not a passing check. It's one cell in the coverage matrix.

## Mid-loop discoveries (NEW findings during verification)

When Quinn, Rook, or any verification step finds NEW bugs not in the original SCs:

1. **Add them to the check list immediately** — they're new SCs now
2. **SHIP the fix** — don't ask, don't file for later, don't present options
3. **Re-verify ALL checks** (original + new)
4. **Continue the loop**

**NEVER:** "Want me to fix this or save for next session?" — that's a stop. Fix it NOW.
**NEVER:** "Two paths forward: quick fix or file issues" — there's one path: fix and verify.
**EXCEPTION:** If the new finding is out of scope (different feature, different repo, unrelated system) → file as follow-up issue AND continue fixing in-scope findings. Don't stop to ask.

## Verify tool invocations actually ran

When invoking council, workflows, or any agent:
- **"Completed in 0s" = did NOT run.** Re-launch with correct args.
- **"Successfully loaded skill" ≠ "skill executed."** Check for actual output.
- **Agent spawned ≠ agent completed.** Wait for the agent's report before claiming its findings.

Don't declare "council is running" after a Skill() call — verify the workflow/agent actually started and is producing output. Silent failures waste entire loop passes.

## Compaction Durability (checkpoint every pass)

Context compaction can happen mid-loop. Persist iteration state so it survives.

### What to checkpoint

After every AUDIT, write `MEMORY/WORK/{issue-slug}/ITERATION-STATE.json`:

```json
{
  "issue": 27,
  "slug": "27-provenance-panel",
  "currentPass": 3,
  "phase": "DEV",
  "timestamp": "2026-08-27T17:00:00Z",
  "entitySample": ["a10-networks", "confluent", "fake-customer"],
  "checks": {
    "AC-1": { "history": ["FAIL", "FAIL", "PASS"], "lastResult": "PASS" },
    "AC-2": { "history": ["FAIL", "PASS", "PASS"], "lastResult": "PASS" }
  },
  "baseline": { "pass": 2, "fail": 5, "total": 7 },
  "current": { "pass": 5, "fail": 2, "total": 7 },
  "councilInvocations": 1,
  "councilDecisions": ["Rewrite cache detection to use file existence not signal registry"],
  "circuitBreakers": { "consecutiveSameCount": 0, "postCouncilFailures": 0 },
  "validationDesign": {
    "layers": ["Content/API", "UI"],
    "coverageMatrix": "docs/specs/coverage-27.md",
    "questionnaire": ["API verified?", "UI renders?", "3+ entities?"]
  }
}
```

### Recovery after compaction

On session start or after context compression, the recovery hook loads the latest `ITERATION-STATE.json` and injects:
- Current pass number and phase
- Which checks are passing/failing and their history (for stall/oscillation detection)
- Council decisions made (so they're not re-derived)
- Entity sample (so verification stays consistent)

**Rule:** If ITERATION-STATE.json exists but no ship checkpoint does, the iteration loop is the active work — resume from the last AUDIT, not from SCOPE.

### What NOT to checkpoint

- Full AUDIT output (too large; re-run the checks)
- Council transcript (decisions captured, reasoning is in the issue comments)
- Code diffs (git has those)

## Rules

- **Council at Step 0 is mandatory.** No skipping validation design. Bad tests = wasted iteration.
- **ALL checks every pass.** Never verify only the fixed checks.
- **Dev before prod.** No rebuilding between dev passes. Deploy only when dev is clean.
- **UI after API.** Don't test UI until the API layer is stable.
- **AFK throughout.** After Step 0 approval, zero AskUserQuestion calls until EXIT or circuit breaker. No "should I fix this?" — the answer is always yes.
- **Mechanical decisions only.** The DECIDE tree has no judgment branches. Counters and conditions decide, not the agent.
- **New findings are not options.** A bug found during verification is a failing check. Failing checks get fixed. There is no "file for later" path for in-scope failures.
- **Checkpoint every pass.** Write ITERATION-STATE.json after every AUDIT. Compaction without checkpoint = lost state.
