---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: RCA Protocol + 4 more
testable: true
---

## RCA Protocol

Required for all bug-fix issues. Included in all Marcus briefs (bug-fix AND feature). Gate enforcement only checks RCA fields on bug-fix issues — for features, the RCA section is guidance, not enforced.

### Issue type classification

The issue type determines RCA enforcement and evidence-tier minimums:

| Label on GitHub issue | `issueType` in workflow-state | RCA enforced? | Evidence minimum |
|----------------------|-------------------------------|--------------|-----------------|
| `bug` | `bug-fix` | Yes — gate checks RCA fields | S (dual-arm) |
| `enhancement`, `feature` | `feature` | No — RCA included but not enforced | A (execution) |
| `refactor` | `refactor` | No | A (execution) |
| No label | `unknown` | No — DA should classify at DISCOVERY | A (execution) |

The DA sets `issueType` in workflow-state.json during DISCOVERY based on the GitHub issue label. If no label, DA classifies from the issue description and adds the label.

### Four-phase investigation (Hermes protocol, adapted)

```
Phase 1: INVESTIGATE (mandatory before ANY code change)
  1. Reproduce the bug — exact steps/command that triggers it
  2. Trace data/control flow from symptom backward to origin
  3. Read the file(s) you intend to modify — full function, not just error line
  4. Read 2+ callers of the function you're modifying
  5. Read tests that cover the code you're about to change

Phase 2: PATTERN ANALYSIS
  1. Find WORKING examples of similar code in the codebase
  2. Diff working vs broken — identify ALL differences
  3. Map dependency chain from root cause to symptom

Phase 3: HYPOTHESIS (scientific method)
  1. State ONE falsifiable hypothesis: "The bug is caused by [X] because [Y]"
  2. PREDICT: if X is the root cause, what OTHER symptom should exist?
  3. Test the prediction — wrong prediction = wrong hypothesis → back to Phase 1
  4. Change ONE variable at a time

Phase 4: IMPLEMENT (only after Phases 1-3 complete)
  1. Write failing test that reproduces the bug BEFORE writing fix
  2. Minimal fix at the ROOT cause, not at the symptom
  3. Verify fix makes failing test pass + all existing tests still pass
  4. Guard at boundary where bad data first enters the system
  5. Audit for same pattern elsewhere: grep for similar code
```

### Gate enforcement (RCA fields in workflow-state)

```json
"rca": {
  "symptom": "EOL date shows 2025-06 instead of 2027-09",
  "reproduction": "curl localhost:${DEV_API}/api/dashboard | jq .eolDate",
  "rootCause": "src/data/eol-dates.ts:47 — hardcoded date not updated after vendor announcement",
  "prediction": "Other vendor dates in same file may also be stale",
  "predictionVerified": true,
  "predictionEvidence": "grep found 3 other stale dates in same file",
  "blastRadius": ["src/data/eol-dates.ts", "src/api/dashboard.ts", "test/eol.test.ts"]
}
```

Gate checks:
- `rootCause` populated → not empty string
- `prediction` populated → agent stated a falsifiable prediction
- `predictionVerified` is true → agent tested the prediction
- If ANY field empty on a bug-fix issue → WARN (not FAIL initially — graduate to FAIL after 30 days)

### Heuristic

If the "fix" is in the same file as the symptom, verify you haven't just suppressed the symptom. Root cause is usually 1-3 files upstream.

## Quinn Test Journey Format

Quinn receives typed test journeys — not prose instructions. Each step has explicit assertions, wait conditions, and flow control. No room for random exploration.

### Journey schema

```yaml
test_journey:
  name: "checkout-flow"
  url: "http://localhost:${DEV_UI_PORT}/products"
  preconditions:
    - "User is logged in"
    - "Cart is empty"

  steps:
    - id: "step-1"
      action: "Navigate to product listing page"
      wait_for: "heading 'Products' visible in snapshot"
      assert:
        - type: element_visible
          target: "heading 'Products'"
        - type: element_count
          target: "product cards"
          expected: ">= 1"
      on_fail: STOP
      evidence: snapshot

    - id: "step-2"
      action: "Click 'Add to Cart' on first product"
      wait_for: "cart badge updates"
      assert:
        - type: text_changed
          target: "cart badge"
          from: "0"
          to: "1"
        - type: element_visible
          target: "notification 'Added to cart'"
      on_fail: STOP
      evidence: snapshot

  verdict_rules:
    all_pass: JOURNEY_PASS
    any_critical_fail: JOURNEY_FAIL
    non_critical_fail: JOURNEY_WARN
```

### Assertion types

| Type | What it checks | Example |
|------|---------------|---------|
| element_visible | Element exists in a11y tree | heading 'Dashboard' |
| element_absent | Element should NOT be in a11y tree | error banner not present |
| text_match | Element text equals expected | user menu shows 'jason@...' |
| value_check | Element value satisfies condition | total price > $0.00 |
| state_check | Element state (checked/disabled/expanded) | submit button disabled |
| text_changed | Element text changed from X to Y | cart badge 0 → 1 |
| element_count | Count of matching elements | product cards >= 1 |
| no_errors | No error elements in snapshot + no new console errors | Clean state verification |
| visual_check | Screenshot comparison (only when a11y can't verify) | layout, color, overlap |

`element_absent` catches cases where old UI should be removed after a fix. `no_errors` is weak alone but valuable as a baseline check at step start — catches error states before testing the feature.

### Journey constraints

- **Max 5-8 steps per journey.** Context degradation: instruction compliance decays from 73% at turn 5 to 33% by turn 16. Brief-assembler splits longer flows into multiple journeys with explicit entry conditions.
- **Max steps enforced at generation time** — brief-assembler rejects journeys over 8 steps and splits automatically.
- Each split journey has `preconditions` that reference the prior journey's end state.

### Perception hierarchy

1. **Primary: browser_snapshot() (a11y tree)** — 2-5KB, deterministic, 10-100x cheaper than screenshots, no vision model needed
2. **Fallback: browser_take_screenshot()** — ONLY for visual checks (layout, color, overlap, canvas/SVG) or on FAIL
3. **Never: raw DOM/HTML** — noisy, expensive, brittle

### Decision tree (embedded in Quinn's prompt)

```
BEFORE EACH STEP:
  Am I on the right URL? → NO → navigate, retry once → still NO → FAIL
  Can I find target element in snapshot? → NO → wait 3s, re-snapshot → still NO → FAIL
  Is page in expected state? → NO → check for error banners → report actual state → FAIL

AFTER EACH ACTION:
  Did snapshot change? → NO → action may not have fired → retry once → still NO → FAIL
  Does new state match expected? → YES → PASS with evidence → NO → FAIL with diff
  Am I still on expected URL? → NO → unexpected navigation → WARN
```

### Circuit breaker

- 3 consecutive FAIL steps → ABORT journey with partial results
- Total elapsed > timeout (300s) → ABORT
- Same step retried 2x → FAIL definitively, move on

### Evidence capture rules

| Event | Snapshot (a11y) | Screenshot | Console log |
|-------|----------------|------------|-------------|
| Step start (BEFORE) | ALWAYS | Only if visual step | Check for pre-existing errors |
| After action (AFTER) | ALWAYS | Only on FAIL or visual step | Check for new errors |
| Assertion FAIL | Attach diff | ALWAYS | ALWAYS |
| Assertion PASS | Store ref only | Skip | Skip |
| Journey end | Final state | ALWAYS (final proof) | Full log |

### Journey generation and storage

The brief-assembler generates Quinn journeys from ACs with UI type:
- AC's `evidenceMethod.type` = browser_snapshot or screenshot → generates a journey step
- AC's threshold becomes the assertion expected value
- AC's contextFiles become the navigation targets
- `${DEV_UI_PORT}` from rungate.json fills URLs

**Where journeys live:**
1. **Generated at:** ship time by brief-assembler
2. **Stored in:** `~/.rungate/{slug}/quinn-journey.yaml` (per-issue)
3. **Read by:** Quinn's prompt template references the journey file path
4. **Evidence stored in:** `~/.rungate/{slug}/evidence/journey-{step-id}.json` (per-step)

Journey files are ephemeral — they live in the slug directory and follow slug lifecycle (archived after 24h, deleted after 30 days).

## Blast Radius Analysis

Required before implementation. The brief-assembler generates a blast radius section from CODE-MAP data.

### Pre-implementation checklist (in Marcus brief)

```
BEFORE writing any code change:
1. DIRECT DEPENDENTS: What imports/calls the code I'm changing?
   → grep -r "import.*{module}" src/ && grep -r "{function}" src/
2. TRANSITIVE: What depends on those dependents? (2 levels deep)
3. TEST COVERAGE: Do tests exist for each dependent?
   → NO → write tests for dependents BEFORE making the change
4. INTERFACE CONTRACT: Changing a function signature or return type?
   → YES → update every caller in the same PR
5. CROSS-BOUNDARY: Change crosses module/package boundary?
   → YES → flag for review, do not proceed autonomously
```

### Gate enforcement

```json
"blastRadius": {
  "filesRead": ["src/api/auth.ts", "src/middleware/jwt.ts", "test/auth.test.ts"],
  "filesChanged": ["src/api/auth.ts"],
  "readToWriteRatio": 3.0,
  "unlisted": []
}
```

- `filesRead.length ≥ filesChanged.length` — read more than you write
- `readToWriteRatio ≥ 3.0` — computed by gate from filesRead.length / filesChanged.length (file count, not token count — simpler and available without instrumentation)
- `unlisted` not empty → WARN "Files changed outside brief: {list}" with explanation required
- `filesRead` empty → WARN "No files read before implementation — likely symptom-fixing"

## Prevention-Oriented Fix Protocol

Beyond fixing the current bug — every fix should make the same class of bug harder to introduce. This section is included in ALL Marcus briefs (bug-fix and feature). Guard/type-narrow/pattern-audit are universal. Gate enforcement of the `prevention` JSON block only applies to bug-fix issues.

### Post-fix checklist (required before marking AC complete)

```
AFTER fixing any bug, before marking complete:

1. GUARD AT BOUNDARY: Add input validation/assertion at the point where
   bad data FIRST enters the system — not where it crashes
   → typeof checks for unexpected types
   → Range checks for numeric boundaries
   → Null guards where null propagation caused the bug
   → Schema validation (Zod) at API/module boundaries

2. TYPE NARROWING: Can the type system prevent this class of bug?
   → Discriminated unions over string literals
   → Branded types for IDs that shouldn't be interchangeable
   → NonNullable<T> where null caused the failure
   → Exhaustive switch/case (default branch = compile error)

3. INVARIANT ASSERTION: Add runtime assertion that would catch this
   bug class EVEN IF the specific fix regresses
   → assert(condition, "Invariant: [what must be true and why]")
   → Place at function entry, not deep in the logic
   → The assertion should fire on ANY variant of this bug, not just this instance

4. PATTERN AUDIT: grep for the same pattern elsewhere in codebase
   → grep -rn "[pattern that caused bug]" src/
   → If the same mistake exists elsewhere, fix ALL instances in this PR
   → Report count: "Found N instances, fixed N"

5. BOUNDARY TEST: Write a test that sends the EXACT bad input
   that caused this bug
   → Test must FAIL without your fix and PASS with it
   → Test name should describe the bug class, not the ticket number
   → Good: "rejects_negative_quantity_in_cart"
   → Bad: "fix_issue_1234"

6. BUG CLASS DOCUMENTATION: Name the class in the PR/commit
   → Null propagation, off-by-one, race condition, type coercion,
     stale cache, missing await, unhandled edge case, etc.
   → Enables pattern-matching in future reviews
   → Gate records bug class in workflow-state for trend analysis
```

### Gate enforcement

```json
"prevention": {
  "guardAdded": true,
  "guardLocation": "src/api/auth.ts:23 — Zod schema validates login payload",
  "patternAuditCount": 3,
  "patternAuditFixed": 3,
  "bugClass": "null-propagation",
  "boundaryTestName": "test/auth.test.ts:rejects_missing_email_field"
}
```

- `guardAdded` = false → WARN "No boundary guard added — same bug class can recur"
- `patternAuditCount` > `patternAuditFixed` → **FAIL** "N unfixed instances of same pattern remain — fix all or explain why not"
- `bugClass` empty → WARN "Bug class not documented — can't track trends"
- All fields populated → prevention score logged for trend analysis

`patternAuditCount > patternAuditFixed` is FAIL not WARN because: you FOUND the same bug elsewhere and chose not to fix it. That's not a judgment call — it's a known gap being shipped. If there's a legitimate reason to skip (e.g., different module owner), add to `scopeOut` with explanation.

### Why this matters

AI-generated code has a 44% security flaw rate (Veracode 2026). Without prevention-oriented fixes, each bug is fixed in isolation and the same class recurs. The pattern audit step alone (grep for siblings) caught 3+ additional instances in prior sessions that would have become separate bug reports.

## Proof-of-Fix Protocol

Extends existing /prove skill with negative control step. Required for S-tier (dual-arm) evidence.

### When each step applies

| Step | Bug-fix issues | Feature issues | Rationale |
|------|---------------|----------------|-----------|
| 1. REPRODUCE | Required | Skip (no "before") | Can't reproduce what didn't exist |
| 2. APPLY | Required | Required | Both need the fix/feature applied |
| 3. VERIFY-FIX | Required | Required | Both need verification |
| 4. VERIFY-REGRESSION | Required | Required | Both can cause regressions |
| 5. NEGATIVE CONTROL | Required | Skip | No "before" state to revert to |

### Protocol

```
1. REPRODUCE: Run reproduction steps on buggy code → capture FAIL
     Skip when: issueType != "bug-fix"
2. APPLY: Apply candidate fix
3. VERIFY-FIX: Run same reproduction steps → capture PASS
4. VERIFY-REGRESSION: Run full test suite → no new failures
5. NEGATIVE CONTROL: Revert fix → confirm bug returns (FAIL again)
     Skip when: issueType != "bug-fix"
```

### Evidence in workflow-state.json

```json
"proofOfFix": {
  "issueType": "bug-fix",
  "reproduction_before": "curl output showing eolDate=2025-06",
  "reproduction_after": "curl output showing eolDate=2027-09",
  "regression_suite": "bun test: 47 pass, 0 fail",
  "negative_control": "reverted → curl shows eolDate=2025-06 (bug returned)",
  "commit_sha": "abc1234",
  "verdict": "PROVEN"
}
```

This maps directly to `prove-evidence.json` written by the /prove skill. The gate reads `proofOfFix` from workflow-state and cross-validates against prove-evidence.json.

For feature issues, `proofOfFix` contains only steps 2-4 (no reproduction_before, no negative_control) and `verdict` is based on VERIFY-FIX + VERIFY-REGRESSION only.

Step 5 (negative control) is what distinguishes real proof from coincidence. If the bug doesn't return when the fix is reverted, either the reproduction is flawed or the fix didn't address the root cause.
