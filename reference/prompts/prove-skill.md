---
name: Prove
description: Standalone verification that a fix solves the user's problem. Reproduces bug, captures before/after evidence, runs Quinn. Works standalone or in harness chain.
version: 1.0.0
doc-type: reference
status: active
owner: jason
updated: 2026-09-06
contract:
  input: "Issue number OR workflow-state.json path"
  gateIn: "Code merged to main (mergeCommitSha exists) OR standalone (no prior /ship required)"
  gateOut: "prove-evidence.json exists with verdict (PROVEN/UNPROVEN/INCONCLUSIVE)"
  artifact: "prove-evidence.json + evidence files in ~/.rungate/{slug}/evidence/"
  outputSchema: "skills/prove/prove-evidence.schema.json"
  telemetry: "harness-telemetry.jsonl with skill=prove"
  errorRecovery:
    timeout_seconds: 600
    failure_mode: BLOCK
    cleanup_action: "rm -f evidence/partial-*.json"
    resumable: true
---

# Prove

Standalone verification skill. Proves a fix actually solves the user's problem — not just that tests pass.

## Trigger conditions

- When: `/prove 1229`, "prove this fix works", "verify the fix", "before and after"
- Standalone: can run independently on any issue, any time
- Chain position: after /ship, before /release
- Skip when: pure infrastructure changes with no user-visible impact

## Interface

```
/prove 1229                     — prove fix works for issue #1229
/prove 1229 --prod              — prove on isolated container with prod data (7776 via make prove-up)
/prove 1229 --before-only       — capture before-state only (pre-fix)
/prove 1229 --local             — local dev only (7776), skip prod
```

## Environment Semantics

- **"local"** = local dev server (make dev-all, port 7776/5173), no container
- **"prod"** = isolated container with rsynced prod data (make prove-up, port 7776), NOT the live container on 7777
- The live prod container (7777) is never touched by prove agents
- `prove-evidence.json` field `afterEvidence.environment: "prod"` means prod data was used in an isolated test container, not that the live container was tested

<!-- gates/prove.test.ts checks afterEvidence.environment === "prod" — the isolated prove container satisfies this because it runs prod data. The prove skill sets environment: "prod" when using the isolated container with rsynced prod data. -->

### Chain Detection

At skill entry, the runner checks for upstream artifacts in the slug directory:

1. **GoalRecord check:**
   ```bash
   GOAL_RECORD="$RUNGATE_WORK_DIR/{slug}/goal-record.json"
   if [[ -f "$GOAL_RECORD" ]]; then
     echo "INFO: Chain mode — GoalRecord found. Using structured SCs for criteriaResults."
     # Each SC from GoalRecord becomes a criteriaResult entry
   else
     echo "INFO: Standalone mode — no GoalRecord. Derive criteria from issue ACs."
   fi
   ```

2. **Ship evidence check:**
   ```bash
   SHIP_EVIDENCE="$RUNGATE_WORK_DIR/{slug}/ship-evidence.json"
   if [[ -f "$SHIP_EVIDENCE" ]]; then
     echo "INFO: Ship evidence found. Using mergeCommitSha for verification."
     # Read mergeCommitSha — verify it matches git rev-parse main
   else
     echo "INFO: No ship evidence. Using HEAD as commit reference."
   fi
   ```

3. **Standalone graceful degradation:** Missing upstream = standalone mode, not error. The skill works independently with reduced context.
4. **File presence only** — `test -f`, no parsing until confirmed present. No env vars, no flags.

## Workflow

### Step 1 — Load context

1. workflow-state.json is read for the issue (from ~/.rungate/ by issue number)
2. If not found: the GitHub issue is read directly (standalone mode)
3. issueGoal, mergeCommitSha, beforeState, ACs are extracted
4. Environment is determined: local dev (7776/5173) or prod (7776 isolated with prod data via make prove-up)

### Step 2 — Verify fix is deployed

1. mergeCommitSha is checked against main: `git branch --contains {sha} main`
2. If --prod: make prove-up runs (rebuild image + rsync prod data + start isolated container on 7776), container-has-fix is checked (P11 FAILs if image predates fix commit)
3. If neither: FAIL — "fix not deployed to target environment"

### Step 3 — Reproduce (before-state)

If beforeState exists from /goal:
  - The before-state evidence file is read
  - The bug's appearance is noted

If beforeState doesn't exist (standalone mode):
  - The issue description is read for reproduction steps
  - Reproduction is attempted on the target environment
  - If bug is NOT reproducible: verdict = INCONCLUSIVE (fix may have already deployed)
  - Current state is captured as "before equivalent" from issue description

### Step 4 — Validate fix (after-state)

**For API/data issues:**
1. The same API call or data check that showed the bug is run
2. The response is captured as after-state evidence
3. Comparison: does the response match the expected AC threshold?

**For UI issues:**
1. **Fix deployment verification:** Before testing, Quinn verifies the container/server has the fix commit:
   - `git log --oneline -1` is run on the target environment to get current HEAD
   - HEAD is compared against `mergeCommitSha` from workflow-state.json or ship-evidence.json
   - If mismatch: FAIL with "Testing wrong version — container HEAD {actual} != fix commit {expected}"
   - Verified commit SHA is reported in QA report header: `**Container:** {SHA} (verified)`
2. Quinn is spawned with browser agent to navigate to the affected page
3. Quinn captures a screenshot of the fixed state
4. Comparison: does the UI match the expected behavior from the ACs?
5. Quinn tests as a brand-new user

**For both:**
- Evidence is captured to `~/.rungate/{slug}/evidence/after-{environment}.{ext}`
- Evidence types: text (API response), screenshot (UI), data snapshot (JSON)

### Step 5 — Compare and verdict

1. Before-state and after-state are compared
2. Each AC threshold is checked: does the fix meet the acceptance criteria?
3. Verdict is determined:
   - **PROVEN** — bug reproduced, fix verified, ACs met
   - **UNPROVEN** — fix did not resolve the issue (AC threshold not met)
   - **INCONCLUSIVE** — could not reproduce (bug may be intermittent or already fixed)

### Step 6 — Write evidence artifact

`~/.rungate/{slug}/prove-evidence.json` is written conforming to `prove-evidence.schema.json`:

```json
{
  "issueNumber": 1229,
  "verdict": "PROVEN",
  "commitSHA": "abc123",
  "capturedAt": "2026-09-03T...",
  "beforeEvidence": {
    "type": "screenshot",
    "path": "evidence/before.png",
    "capturedAt": "2026-09-03T...",
    "description": "EOL date shows 2025-06 for OCP Virt"
  },
  "afterEvidence": {
    "type": "screenshot",
    "path": "evidence/after-local.png",
    "capturedAt": "2026-09-03T...",
    "environment": "local",
    "description": "EOL date now shows 2027-09 for OCP Virt"
  },
  "comparisonSummary": "EOL date corrected from 2025-06 to 2027-09",
  "quinnVerdict": "PASS",
  "reproduced": true
}
```

### Step 7 — Post proof to issue

A proof comment is posted to the GitHub issue:

```markdown
## Proof

- **Before:** [description] — bug visible
- **Fix:** commit {sha}
- **After ({environment}):** [description] — bug resolved
- **Quinn:** {PASS/FAIL/SKIP} (tested on {verified_commit_sha})
- **Verdict:** {PROVEN/UNPROVEN/INCONCLUSIVE}
```

### Step 8 — Log telemetry

Telemetry is appended to harness-telemetry.jsonl:
```json
{"ts":"...","skill":"prove","issue":1229,"check":"verdict","result":"PROVEN","duration_ms":45000}
```

### Step 9 — Close issue (chain mode)

In chain mode (goal-record.json exists), /prove owns issue closure:

1. If `verdict == "PROVEN"`:
   - The issue is closed: `gh issue close {issueNumber} --repo {issueRepo}` + `proven` label added
   - Posted: "Issue closed by /prove — verdict: PROVEN"
2. If `verdict == "UNPROVEN"`:
   - The issue is NOT closed
   - Posted: "Prove verdict: UNPROVEN — issue remains open for re-investigation"
   - A follow-up issue is created if gaps[] has actionable items
3. If `verdict == "INCONCLUSIVE"`:
   - The issue is NOT closed
   - Posted: "Prove verdict: INCONCLUSIVE — could not reproduce. Manual investigation needed."

In standalone mode (no goal-record.json), /prove does NOT close the issue — only the proof comment (Step 7) is posted.

## Ceremony tiers

| Tier | What /prove does |
|------|-----------------|
| LIGHT (XS) | API check or text comparison only. No screenshots. |
| STANDARD (S/M) | Quinn on local dev + isolated prove container (make prove-up). Screenshots for UI issues. Mechanically enforced: prove.test.ts FAILs without prod evidence (#294, ported to Bun in #484). |
| THOROUGH (L) | Quinn on local + isolated prove container. Full before/after with screenshots. |

**B3 limitation:** The B3 prove reproducer (`gates/prompts/prove-reproducer.md`) has Bash and Read tools only -- it cannot verify UI/OUTCOME ACs. CODE ACs are verified via evidence commands (grep, bun test, curl). OUTCOME/UI ACs require Quinn at prove time. The gate (`gates/prove.test.ts`) auto-SKIPs OUTCOME-type and UI-related ACs so they do not count as FAIL (#486).

## Error handling

- Timeout: 600 seconds per environment
- Quinn subprocess timeout: 300 seconds
- On timeout: partial evidence is written, verdict = INCONCLUSIVE
- Cleanup: partial-*.json files are removed
- Resumable: yes — re-running /prove picks up from last completed step

### Artifact Output

After all verification steps complete, the prove evidence artifact is written:

1. `~/.rungate/{slug}/prove-evidence.json` is created with:
   ```json
   {
     "contractVersion": "1.0",
     "issueNumber": N,
     "verdict": "[COMPUTED — PROVEN only if ALL criteriaResults are PASS|SKIP]",
     "commitSHA": "[git rev-parse main]",
     "capturedAt": "[ISO timestamp]",
     "criteriaResults": [/* one per SC: {scId, verdict, evidence} */],
     "reproduced": true|false
   }
   ```
2. **Verdict computation (MECHANICAL — not LLM-asserted):**
   - FAIL entries in criteriaResults are counted
   - If any FAIL -> verdict = "UNPROVEN"
   - If all PASS|SKIP -> verdict = "PROVEN"
   - If no criteriaResults -> verdict = "INCONCLUSIVE"
3. Validation runs via Zod schema in `gates/schema.ts` — cross-field consistency is enforced by superRefine (PROVEN + any FAIL entry = validation failure).
4. `writeWorkflowState()` in `gates/orchestrator.ts` validates at write time.

## AFK Mode: Auto-file Follow-ups

When running in AFK batch mode (no interactive user) and prove-evidence.json contains non-empty `gaps[]`:

1. For each gap with `priority` != null:
   ```bash
   gh issue create --repo {repo} \
     --title "Follow-up: {gap.ac} — {gap.detail}" \
     --label "needs-triage" \
     --body "Auto-filed by /prove AFK mode.\n\nSource: #{issueNumber}\nGap: {gap.ac}\nStatus: {gap.status}\nDetail: {gap.detail}"
   ```
2. The created issue number is written back to `gaps[].followUpIssue` in prove-evidence.json
3. Re-validation runs via Zod schema at write time
4. Logged: `echo "INFO: Filed {N} follow-up issues from gaps[]"`

**Skip conditions:**
- If `gaps[]` is empty or not present -> skip
- If not in AFK mode -> skip (DA decides whether to file manually)
- If `gap.priority` is null -> skip (low-priority gaps don't auto-file)

## Prove Gate (ADR-009 B3)

The prove gate (`bun run gates/run-gate.ts --gate prove --slug {slug} --issue {N}`) is the primary verification path. The DA invokes `/prove`, which triggers the gate, which spawns the B3 Prove Reproducer agent.

**Key design:** The reproducer reads the issue independently from GitHub (`gh issue view N --json body`), derives its own test plan, and writes prove-evidence.json via the gate-runner. The DA orchestrates but does not author evidence.

```bash
bun run gates/run-gate.ts --gate prove --slug {slug} --issue {N}
```

## Anti-patterns

- Skipping reproduction — "code looks fixed" is not proof
- Using /prove as a substitute for unit tests — /prove validates user experience, not code correctness
- Capturing after-state without verifying fix is deployed first
- Marking PROVEN without comparing against AC thresholds
