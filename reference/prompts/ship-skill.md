---
name: Ship
description: Unified implementation — bugs, enhancements, features. SCOPE -> BUILD -> VERIFY with 31 machine-state gate checks.
version: 2.0.0
doc-type: reference
status: active
owner: jason
updated: 2026-09-06
contract:
  input: "GitHub issue number with ACs"
  gateIn: "Issue exists with ACs (from /goal)"
  gateOut: "verify-gate PASS, code on main, mergeCommitSha set in workflow-state.json"
  artifact: "Merged code + workflow-state.json with gate results"
  outputSchema: "schemas/ship-evidence.schema.json"
  telemetry: "harness-telemetry.jsonl with skill=ship"
  errorRecovery:
    timeout_seconds: 3600
    failure_mode: BLOCK
    cleanup_action: "Worktree cleanup, partial commits reverted"
    resumable: true
---

# Ship v2

One loop. One JSON file. Config-driven ceremony.

## Trigger conditions

- When: `/ship`, "ship issue #N", "implement this", "fix this bug"
- Standalone: yes — can self-bootstrap from GitHub issue if no /goal ran
- Chain position: after /goal, before /prove
- Skip when: no issue exists (run /goal first)

## Workflow

See phases below for the full workflow. GOAL -> DISCOVERY -> SCOPE GATE -> BUILD -> VERIFY -> SHIP GATE -> DONE.

```
GOAL → DISCOVERY → scope-gate ⛩→ BUILD → verify-gate ⛩→ ship-gate ⛩→ DONE
                                    ↑                          |
                                    └── iterate on failure ────┘
```

**State file:** `$PAI_WORK_DIR/{slug}/workflow-state.json` — the single source of truth. All gates read it. All phases write to it. Schema: `skills/ship/workflow-schema.json`.

**Ceremony profiles:** `skills/ship/ceremony-profiles.json` — LIGHT/STANDARD/THOROUGH tiers. The harness selects the tier mechanically based on size + unknowns + file count.

**Project config:** `.claude/project-harness.json` in each project repo — dev/prod environments, commands, consumers.

**Gates:** `bun run gates/run-gate.ts --gate scope|verify|ship --slug {slug}`

**Briefs:** The DA hand-writes Marcus briefs with these 5 required fields:
1. **Goal** — issue goal verbatim from workflow-state.json
2. **ACs** — acceptance criteria with thresholds and evidence commands
3. **Files** — specific files to read/modify with line numbers
4. **Scope boundaries** — what NOT to touch
5. **Verify commands** — exact commands to run after changes

## Phase 1: GOAL

The GitHub issue is read and the goal is extracted.

**Initialize workflow-state.json:**
```bash
mkdir -p "$PAI_WORK_DIR/{slug}"
cat > "$PAI_WORK_DIR/{slug}/workflow-state.json" << EOF
{
  "schemaVersion": 2,
  "issue": NUM,
  "repo": "owner/repo",
  "issueRepo": "",
  "projectRoot": "",
  "slug": "{slug}",
  "phase": "GOAL",
  "issueGoal": "",
  "acs": [],
  "gates": {},
  "changelog": []
}
EOF
```

**Issue goal capture:** The issue goal is extracted verbatim from `gh issue view NUM --json body` and written to the `issueGoal` field. The goal is never paraphrased.

### Standalone Bootstrap (when no /goal ran)

When `/ship N` is invoked and `$PAI_WORK_DIR/{slug}/workflow-state.json` does NOT exist:

1. The slug is resolved from the repo name (e.g., `pai-config` → `pai`, `asaCommandCenter` → `ddb`)
2. The issue is read: `gh issue view N --json title,body,labels`
3. The issueGoal is extracted from issue title + first paragraph of body
4. ACs are extracted from issue body (looking for `## Success Criteria` or `- [ ]` patterns)
5. workflow-state.json is created with extracted data:
   ```json
   {
     "schemaVersion": 2,
     "issue": N,
     "repo": "owner/repo",
     "issueRepo": "",
     "projectRoot": "",
     "slug": "{slug}",
     "phase": "GOAL",
     "issueGoal": "[extracted from issue]",
     "acs": [/* extracted from issue body */],
     "gates": {},
     "changelog": [],
     "bootstrappedFrom": "github-issue"
   }
   ```
6. A warning is logged: `echo "WARN: Self-bootstrapped from GitHub issue — no /goal ran. ACs may need garbage testing." >&2`
7. DISCOVERY proceeds as normal

**Key constraint:** The bootstrapped workflow-state.json conforms to the same schema the Bun gate tests validate. The `bootstrappedFrom` field is informational — gates don't check it.

### Chain Detection

At skill entry, the runner checks for upstream artifacts in the slug directory:

1. **GoalRecord check:**
   ```bash
   GOAL_RECORD="$PAI_WORK_DIR/{slug}/goal-record.json"
   if [[ -f "$GOAL_RECORD" ]]; then
     echo "INFO: Chain mode — GoalRecord found. Inheriting success criteria."
     # Read successCriteria from GoalRecord and use as AC source
     # GoalRecords are TTL-exempt — no staleness check needed here
   else
     echo "INFO: Standalone mode — no GoalRecord. ACs from issue body."
   fi
   ```
2. Chain mode benefits: SCs have structured thresholds + evidenceType. Standalone mode: ACs extracted from issue markdown (less structured).
3. **File presence only** — `test -f`, no parsing until confirmed present. No env vars, no flags.

## Phase 2: DISCOVERY

**Project docs gate:** The project root is checked for a DOCS.md routing table. Only the pointed-to doc is loaded. Fallback: MODEL.md -> PRINCIPLES.md + ARCHITECTURE.md.

**project-harness.json** is read from the project root — it provides dev/prod environments, test commands, consumers.

**Auto-scaffold:** If `.claude/project-harness.json` does not exist, `bun ~/.claude/scripts/scaffold-project-harness.ts "$PROJECT_ROOT"` runs automatically to generate a starter config. The generated config is reviewed and paths adjusted before proceeding.

**issueRepo:** If `project-harness.json` has `issueRepo` different from `repo`, it is written to `issueRepo` in workflow-state.json. If not present, `repo` is copied to `issueRepo`.

**Source specs.** If the issue references visual specs (HTML, screenshots, Figma), design docs, or architecture files:
1. **The DA reads the spec** and describes its structure in 3 sentences.
2. The spec is written to `sourceSpecs[]` with path, `citedInDiscovery: true`, and `specElements[]` listing key structural elements.

**Sizing:**
- **XS** — single file, clear target, <30 min -> ceremony tier: LIGHT
- **S** — 1-3 files, clear target, <2 hours -> ceremony tier: STANDARD
- **M** — multi-file, crosses boundaries -> ceremony tier: STANDARD, `Skill("grill-with-docs")` runs first
- **L** — 6+ stories -> ceremony tier: THOROUGH, grill -> PRD -> sub-issues

`sizing.predicted` and `sizing.ceremonyTier` are written to workflow-state.json.

**Escalation:** XS/S that crosses a feature boundary is re-scoped as M.

**Research gate:** External API/library/pattern not in codebase triggers a researcher spawn before BUILD.

**Acceptance criteria** are written to `acs[]` in workflow-state.json. Each AC has:
- `id`, `type` (CODE/OUTCOME), `statement`
- `threshold` with op/value/unit
- `evidenceMethod` with type enum + command
- `specElement` tracing to a sourceSpec element (if spec exists)

**Anti-rationalization check:** Before ACs are written, evidence is verified for each claim. "The logic does X" -> cite file:line. "X doesn't exist" -> grep output.

**GitHub issue post:** DISCOVERY + ACs are posted as a single comment. For LIGHT tier: inline ACs only (no separate DISCOVERY comment).

**Phase update:** `phase: "SCOPE"` is set in workflow-state.json.

## Phase 3: SCOPE GATE

```bash
bun run gates/run-gate.ts --gate scope --slug {slug}
```

LIGHT tier: scope gate is skipped (checks run inside ship-gate instead).

On FAIL -> `gates.scope.failures[]` is read from JSON, the specific issue is fixed, and the gate is re-run.

On PASS -> phase advances to BUILD automatically.

## Phase 4: BUILD

**Context isolation rule:** The DA does NOT run implementation tools directly (Read source, Edit, Write, Bash for tests). All implementation goes through Marcus via Agent(). The DA may only: (1) generate the brief, (2) run gates, (3) read Marcus's report.

**Brief generation:**
The DA hand-writes the Marcus brief with: issueGoal verbatim, sourceSpecs paths, ACs with thresholds, dev/prod environments from project-harness.json, specific files to modify with line numbers, scope boundaries (what NOT to touch), and verify commands. Marcus is then spawned.

**Brief capture (ADR-009 C2):** Before spawning Marcus, the DA writes the brief text to `~/.pai-work/{slug}/marcus-brief.md`. The verify gate reads this file for brief-AC alignment validation.

**Marcus spawn rules:**
- `.claude` repo -> `isolation: "worktree"`, `mode: "bypassPermissions"`
- External project -> `mode: "bypassPermissions"`, NO worktree
- `mode: "bypassPermissions"` is MANDATORY for all Marcus spawns

**Build steps** (Marcus executes, exemptions apply for non-code output types):
1. **TDD** — red-green-refactor. *Exempt:* config-only, pure doc, JSON data, UI copy.
2. **Architecture check** (M+ only)
3. **Simplify** — 3-agent code review
4. **Fallow** — runs automatically on commit via hook

**`make rebuild`** is run by the DA only — agents never run it. The command comes from project-harness.json `prod.rebuild`.

**Agent tracking:** `agents.marcus.spawned`, `agents.marcus.verdict`, `agents.marcus.branch` are written to JSON.

**Auto-verify trigger:** Immediately after `agents.marcus.verdict` is written to workflow-state.json, the verify gate runs mechanically:
```bash
bun run gates/run-gate.ts --gate verify --slug {slug}
```
This is automatic — no waiting, no prompting. The orchestrator advances the phase automatically on PASS.
If verify-gate FAILs, the ITERATION loop is entered (failures are read, fixed, and the gate re-run).
This replaces the manual "Phase 5: VERIFY" step — the gate call IS the verify step.

**Environment tracking:** After local testing, `environments.local.api`, `environments.local.ui`, `environments.local.tests` are written to JSON.

## Phase 5: VERIFY

**Quinn and Rook are spawned in parallel** (STANDARD/THOROUGH tiers):
Quinn/Rook briefs are written inline with: what to test, which URLs/ports, what to compare against (sourceSpec paths), pass/fail criteria. Both are launched simultaneously via parallel Agent() calls.

**Quinn URL routing (#481):** The DA reads `project-harness.json` `pages` map and provides the exact URL as line 1 of Quinn's test plan (`Navigate to: {url}`). Quinn must never guess which page to test — the harness tells it.

Quinn receives sourceSpec paths and compares built output against them. If structural mismatch -> FAIL regardless of AC results.

Rook scans changed files for security issues.

**Agent tracking:** quinn/rook spawned, verdict, comparedToSpec, screenshots are written to JSON.

**Environment (prod) tracking:** After container rebuild + smoke tests, `environments.prod.rebuild`, `environments.prod.smoke`, `environments.prod.quinn` are written to JSON.

**DA edit tracking:** The harness tracks direct DA edits to project source files in `daDirectEdits`. Delegating to Marcus is preferred; direct edits above 3 trigger a WARN at verify-gate.

**AC updates:** For each AC, `evidence` and `verdict` (PASS/FAIL) are written to JSON.

**Verify gate:**
```bash
bun run gates/run-gate.ts --gate verify --slug {slug}
```

On FAIL -> `gates.verify.failures[]` is read, failures are fixed, and the gate iterates. Circuit breaker at 3 iterations.

On PASS -> phase advances to SHIP.

## Phase 6: SHIP GATE

```bash
bun run gates/run-gate.ts --gate ship --slug {slug}
```

Ship gate checks: all gates pass, branch merged, prod validated, docs updated, follow-ups created.

On PASS -> phase advances to DONE. The issue is closed.

### Artifact Output

After ship-gate passes (phase = DONE), the ship evidence artifact is written:

1. `~/.pai-work/{slug}/ship-evidence.json` is created with:
   ```json
   {
     "contractVersion": "1.0",
     "issueNumber": N,
     "gateOut": {
       "status": "PASS",
       "evidence": [/* one entry per AC: {criterion, result, detail} */]
     },
     "mergeCommitSha": "[from workflow-state.json]",
     "capturedAt": "[ISO timestamp]",
     "iterationCount": N,
     "sizing": {"predicted": "S", "actual": "S"}
   }
   ```
2. Validation runs via Zod schema in `gates/schema.ts` — `writeWorkflowState()` validates at write time.
3. If validation fails, the error lists valid enum values — fix and re-write.

**Post-ship:**
1. A completion summary is posted to the GitHub issue (using issueRepo from workflow-state.json)
2. Follow-up issues are created for any gaps found during verify
3. **Close behavior depends on chain mode:**
   - **Chain mode** (goal-record.json exists in slug directory): The issue is NOT closed. The `shipped` label is added only. The issue stays open for `/prove` to verify and close.
   - **Standalone mode** (no goal-record.json): The issue is closed: `gh issue close NUM --repo {issueRepo}` + `shipped` label added
4. Sizing outcome is recorded: `sizing.actualFiles`, `sizing.actualMinutes`

## ITERATION (when gates fail)

When verify-gate or ship-gate FAILs:

1. `gates.{gate}.failures[]` is read from JSON — exact failure reasons
2. `iterationCount` is incremented in JSON
3. The specific failures are fixed (Marcus is re-briefed, or fixed directly for XS)
4. The gate is re-run
5. Circuit breaker: `iterationCount > 3` -> escalation (Context7, Research, council, or stop)
6. Hard stop at 6 iterations — issue stays open with full report

**AFK enforcement:** After initial approval, the loop runs autonomously. Zero AskUserQuestion calls. The loop iterates until gates pass or circuit breaker fires.

**Convergence budget (council loops):** When running ship->council->ship cycles, findings count is tracked per round. The loop stops if findings don't decline after 3 rounds. See `skills/ship/convergence.md`.

## Ceremony Tier Summary

| | LIGHT (XS) | STANDARD (S/M) | THOROUGH (L) |
|---|---|---|---|
| Gates | 1 (ship only) | 3 (scope+verify+ship) | 3 (scope+verify+ship) |
| Agents | Marcus optional | Marcus + Quinn | Marcus + Quinn + Rook |
| Quinn+Rook | skip | Quinn only | Quinn + Rook parallel |
| GitHub comments | 2 | 3 | 5 |
| STOP markers | 0 | 0 | 0 |
| Read() calls | 2 | 4 | 6 |
| Anti-gaming | skip | WARN | required |

## Bug Protocol

1. Batch diagnostic read — environment is confirmed (using project-harness.json ports), all logs + errors + source are read
2. Single hypothesis -> single change
3. Regression test required
4. Wrong hypothesis? -> batch-read with failed-fix context

## Mid-session Bugs

New bug found during work -> re-enters ship:
1. The bug is logged (GitHub issue or BACKLOG.md)
2. Sizing: 1-line typo (inline OK) or real fix (ship required)
3. If >1 line of logic -> ACs are written and the fix is sent to Marcus through ship

**The 1-line rule:** Only exempt: single character fixes, config value swaps, obvious typos.

## User-Opened Issue Protocol

User-reported bugs require a different approach than internally-filed issues:

1. **Reproduce first** — The user's configuration is set up and their exact experience is reproduced BEFORE code is read. "Code exists" does not mean "feature works."
2. **Enumerate every sentence** — Each sentence in the issue body becomes a test case. The title alone is not sufficient scope.
3. **Screenshots are visual specs** — Screenshots in user issues go into `sourceSpecs[]`. Quinn compares current UI against them.
4. **Test with user's data shape** — If they have 5 pods, testing uses 5 pods. 1-pod local data does not verify a multi-pod bug.
5. **Council when uncertain** — If the DA is not confident about root cause, council runs BEFORE ACs are written. Prompt: "Here's what the user reported. Here's what the code does. Does the code actually solve the user's complaint?"
6. **User impact statement at close** — Required field in completion report: "What the user does to see the fix" (e.g., run upgrade.sh, refresh page, etc.).

## Anti-patterns

- Chain-calling other implementation skills — Ship is the only implementation skill
- Reporting done without evidence for every AC
- Skipping TDD for code changes
- Running `make rebuild` from agents — only the DA runs it
- Fixing bugs inline without re-entering ship (1-line rule is the only exception)
- Running individual gate scripts — `bun run gates/run-gate.ts` is the single entry point
- Editing workflow-state.json manually — the ship skill and Bun gate orchestrator handle it mechanically
