---
doc-type: reference
status: active
owner: jason
updated: 2026-07-28
---

# Ship Templates

Structured templates for artifacts produced during ship. Gates validate these structures exist on the issue.

---

## AC Template — CODE (8 required fields + 1 optional)

```markdown
## AC-N
- **Type:** REPLACE:CODE_OR_OUTCOME
- **Statement:** REPLACE:specific_verifiable_statement
- **Call Site:** REPLACE:file_and_line_where_this_is_called_from_and_trigger_event
- **Metric:** REPLACE:measurable_count_or_boolean
- **Threshold:** REPLACE:number_or_explicit_boolean
- **Baseline:** REPLACE:current_measured_value
- **Evidence Method:** REPLACE:grep_curl_screenshot_or_test
- **Pass Criteria:** REPLACE:exact_condition_that_proves_pass
- **Source:** REPLACE:architecture_adr_or_issue_reference
- **Data Flow:** REPLACE:state_file_path | verification_command (OPTIONAL — for wiring/integration ACs only)
```

> **Data Flow rule:** For ACs that wire cross-system pipelines (hook A calls function B, pipeline feeds downstream state), include the Data Flow field. Format: `state_file_path | shell_command_that_returns_0_on_success`. verify-gate runs the command and checks the state file was modified. Omit for pure logic, test, or config ACs. Example: `~/.agentgrit/state/rule-stats.json | bun -e 'require("./src/capture/rating").parseRating("/rate M:4 S:4 Q:4")' `

> **Call Site rule:** Every new function must specify WHERE it is called from (file:line) and WHEN it fires (trigger event). A function with tests but no call site is dead code. Evidence must show the call site exists via grep. If the AC is for a test-only or config change with no new callable function, use `Call Site: N/A — no new function`.

## AC Template — OUTCOME (10 required fields)

```markdown
## AC-N
- **Type:** REPLACE:CODE_OR_OUTCOME
- **Statement:** REPLACE:what_user_sees_or_gets
- **Metric:** REPLACE:count_percentage_time_or_field_presence
- **Threshold:** REPLACE:specific_number_or_condition
- **Baseline:** REPLACE:current_state_or_NA_for_new
- **Evidence Method:** REPLACE:curl_command_screenshot_or_playwright
- **Pass Criteria:** REPLACE:what_evidence_output_must_show
- **Source:** REPLACE:principles_goal_or_issue_reference
- **User:** REPLACE:who_uses_this
- **Conversation:** REPLACE:what_this_enables
- **Action:** REPLACE:specific_verb_and_context
```

---

## ATTEMPT Comment Template

Posted to issue after every failed iteration. Required fields enforced by iteration-gate.

```markdown
## ATTEMPT N
- **Approach:** REPLACE:specific_files_and_changes
- **Files Changed:** REPLACE:list_of_files_with_changes
- **Result:** FAIL
- **Evidence:** REPLACE:curl_output_screenshot_or_error
- **Why It Failed:** REPLACE:root_cause_or_unknown
```

---

## Sizing Declaration Template

Posted to issue during SCOPE. Compared to actuals at CLOSE.

```markdown
## Sizing Declaration
- **Predicted:** REPLACE:XS_S_M_or_L
- **Files:** REPLACE:count_and_names
- **Reasoning:** REPLACE:why_this_size
- **Expected time:** REPLACE:hours
- **Expected boundaries:** REPLACE:directories_or_none
```

---

## Sizing Outcome Template

Posted to issue at CLOSE. Compared to declaration for accuracy tracking.

```markdown
## Sizing Outcome
- **Declared:** REPLACE:size_from_declaration
- **Actual:** REPLACE:actual_files_changed_count
- **Actual directories:** REPLACE:unique_top_level_dir_count
- **Actual time:** REPLACE:hours_from_checkpoint
- **Mismatch:** REPLACE:YES_or_NO
- **Docs read:** REPLACE:count_and_names
- **Lines loaded:** REPLACE:total_lines_across_all_docs
```

---

## Completion Report Template

Posted to issue at CLOSE. score-issue.sh generates the scorecard section.

```markdown
## Completion Report

### Evidence per AC
- AC-1: → REPLACE:evidence_type REPLACE:evidence_detail
- AC-2: → REPLACE:evidence_type REPLACE:evidence_detail

### Ship Scorecard
| Step | Score | Detail |
|------|-------|--------|
| SCOPE | REPLACE:score | REPLACE:detail |
| BUILD | REPLACE:score | REPLACE:detail |
| VERIFY | REPLACE:score | REPLACE:detail |
| DURABILITY | REPLACE:score | REPLACE:detail |
| CLOSE | REPLACE:score | REPLACE:detail |

| Metric | Value |
|--------|-------|
| First-pass rate | REPLACE:percentage |
| Iterations | REPLACE:count |
| Sizing accuracy | REPLACE:match_or_mismatch |
| Time | REPLACE:hours |
| Grade | REPLACE:letter_grade |

### Files changed
- REPLACE:file_line_description

### Follow-ups created
- REPLACE:issue_refs_or_NONE
```

---

## DISCOVERY Comment Template

Posted to issue during SCOPE. scope-gate validates this exists.

```markdown
## DISCOVERY

### Docs read
- REPLACE:doc_name (modified: REPLACE:date) — REPLACE:key_constraints
- REPLACE:doc_name (modified: REPLACE:date) — REPLACE:relevant_modules

### Source spec
- REPLACE:path_and_section_or_none

### Issue context
- Related: REPLACE:issue_references
- Checkpoint: REPLACE:resuming_or_fresh

### Research decision
- REPLACE:unknowns_or_no_unknowns

### Constraints
- REPLACE:constraint_with_citation
```

---

## Anti-Gaming Table Template

Posted to issue during SCOPE after writing ACs. scope-gate validates defenses exist. DA creates this manually or via quick adversarial agent -- gate validates, doesn't create.

~~~markdown
## Anti-Gaming

| # | Shortcut | Why It Games | Defense Command | Expected |
|---|---|---|---|---|
| AG-1 | REPLACE:shortcut_description | REPLACE:why_it_games | REPLACE:defense_command | REPLACE:expected_result |
| AG-2 | REPLACE:shortcut_description | REPLACE:why_it_games | REPLACE:defense_command | REPLACE:expected_result |
~~~

> **Defense Command** should use a known ag-test-runner pattern or a raw shell command:
>
> Known patterns (run via `bash skills/ship/ag-test-runner.sh --type PATTERN ...`):
> - `GREP_CHECK --file FILE --pattern PAT --op (eq|gte|lte) --count N` — count grep matches
> - `CURL_API --url URL --jq FILTER --op (eq|gte|contains) --expected VAL` — check API response
> - `FILE_EXISTS --path PATH` — verify file/glob exists
> - `TEST_RUN --command CMD` — run command, check exit 0
> - `HARDCODE_CHECK --file FILE --pattern PAT` — verify pattern has 0 matches
> - `CHANGE_DETECT --add FILE --endpoint URL --jq FIELD` — verify endpoint detects file changes
> - `THRESHOLD_CHECK --command CMD --op OP --value N` — verify numeric output meets threshold
>
> Raw shell commands (grep, curl, ls, bun, etc.) are also accepted. verify-gate Check 10 executes these at VERIFY time.

> **Prompt for adversarial agent (optional):** "Given this goal statement and these ACs, list every way someone could claim success without actually delivering the goal. For each shortcut, propose a mechanical defense command. You must NOT see the implementation code -- attack from the 'lazy implementer' perspective."

---

## Checkpoint Compaction Template

Required fields for context recovery. iteration-gate validates these exist.

```markdown
## Current State
- Phase: [SCOPE | BUILD | VERIFY | ITERATION]
- ACs: N/M passed (AC-1 ✓, AC-2 ✗, AC-3 pending)
- Last failure: [AC-N — what failed and why]
- Iterations: N (Tier 1 at 3, Tier 2 at 6)

## Next Action
[Exact next step — not vague, not a plan, one specific action]

## Files Changed
- [file:line — what changed]

## Gate Status
- scope-gate: [PASS | FAIL (which check)]
- verify-gate: [PASS | FAIL | not yet run]
- durability-gate: [PASS | FAIL | not yet run]
```
