---
doc-type: spec
status: draft
owner: jason
created: 2026-09-03
updated: 2026-09-03
testable: true
---

# Harness Skill Chain Spec
# Version 0.1 — Draft from audit data

## Problem Statement

The harness is good at committing code and running tests. It is bad at proving the right problem was solved. Audit of 30+ ship cycles shows:

- Reproduce-first: almost never done (#82 closed 3x without reproducing)
- Before/after evidence: never captured structurally
- Quinn skipped with wrong logic (file-type based, not UX-change based)
- No bug-specific E2E tests
- No artifact linking before→commit→after→release tag

The harness enforces "code is correct" but not "user's problem is solved."

## Design Principle

**Skills as a chain, not a monolith.** Each skill has one job, one gate, one artifact. The harness validates handoffs between skills.

**Every step has a scorecard.** Telemetry tracks success/failure per skill, per step. No more "unknown" categories — if a step runs, it's measured.

## The Chain

```
INTAKE → DEFINE → SHIP → PROVE → RELEASE
  ↑                                  |
  └──── council review + iterate ────┘
```

### Step 1: INTAKE (`/goal`)

**Trigger:** Jason brings observation, screenshot, email, link, verbal description.

**What happens:**
1. Research the observation — reproduce it, trace the data source
2. Capture before-state (screenshot, API response, or data snapshot)
3. Create GitHub issue with measurable ACs
4. Garbage-test every AC

**Gate:** Issue exists with ACs. Before-state captured.

**Artifact:** GitHub issue + before-state evidence file in workflow-state.json

**Scorecard metrics:**
- Did we reproduce before defining? (reproduce_attempted: true/false)
- Did we capture before-state? (beforeState.captured: true/false)
- Did ACs survive garbage test? (acsGarbageTested: true/false)

### Step 2: DEFINE (optional — for M/L work)

**Trigger:** Goal is complex enough to need spec, ADR, or council.

**What happens:**
1. `/council` on the findings — is this the right problem? Right fix?
2. Write spec or ADR if architectural
3. Break into sub-issues if L-sized

**Gate:** Council ran (if uncertain). Spec exists (if M/L).

**Artifact:** Council synthesis + spec/ADR link on issue

**Scorecard metrics:**
- Council ran when uncertain? (councilRan: true/false)
- Spec written for M/L? (specWritten: true/false)

### Step 3: SHIP (`/ship`)

**Trigger:** Issue exists with ACs. Scope gate passes.

**What happens (3-layer verification before PR):**

**Layer 1 — Local Dev (fast feedback)**
1. Marcus codes on local dev (make dev-all, :7778 API / :5173 UI)
2. Unit tests pass (`bun test`), types check (`tsc --noEmit`)
3. Quinn validates on local dev (:5173 UI, :7778 API)
   - Tests as brand-new user, captures screenshots for UI bugs
   - If Quinn fails → back to Marcus → fix → Quinn retests (fast cycle)
4. **GATE: Quinn local PASS before container build**

**Layer 2 — Container Verification (deployment correctness)**
5. `make test-rebuild` → rebuilds container image from current code, starts on :7776 with seed data
6. Quinn validates on container (:7776)
   - Same tests as local dev, against containerized app
   - Verifies deployment artifact matches dev behavior
   - container-has-fix gate validates container has the commit SHA
7. Rook security scan on changed files (STANDARD+ tiers)
8. If Quinn/Rook fail → back to Marcus → fix → rebuild → retest
9. **GATE: Quinn container PASS before PR is opened**

**Layer 3 — PR + Ship Gate**
10. Commit → push → PR created via `gh pr create`
11. CI runs on Mac Mini (typecheck, build, container E2E, harness gates)
12. Ship gate runs (verify-gate + ship-gate checks)
13. **GATE: Ship gate PASS. PR ready for review.**

**Gate:** verify-gate PASS + ship-gate PASS. Quinn passed on both local and container.

**Artifact:** PR with verified code, ready for Jason to review and merge.

**Scorecard metrics:**
- Iterations to pass verify-gate (iterationCount)
- Quinn local verdict (quinn.local.verdict)
- Quinn container verdict (quinn.container.verdict)
- Gate telemetry (gate-telemetry.jsonl)
- Test/tsc results

### Step 4: PROVE (post-merge — prod data verification)

**Trigger:** Jason reviewed and merged the PR. Code is on main.

**What happens:**
1. Verify fix commit is on main (`git branch --contains {sha} main`)
2. **Rebuild image + spin up isolated prove container** (`make prove-up`, port 7776)
   - Rebuilds the container image (includes `build` dependency — ensures fix code is in the image)
   - Rsyncs PROD data to data-test/, starts test container with ALLOW_RESET=true
   - Container uses real prod data but is isolated from live container
   - P11 (container-has-fix) FAILs if image was built before fix commit
3. **Quinn validates on prove container** (port 7776, prod data)
   - Capture after-state (prod). The prove container with rsynced prod data IS prod evidence.
   - For UI bugs: navigate to affected page, verify fix with real customer data
4. **Before/after evidence artifact:**
   ```json
   {
     "beforeState": {
       "type": "screenshot|api-response|data-snapshot",
       "capturedAt": "...",
       "path": "~/.pai-work/{slug}/evidence/before.png"
     },
     "afterLocal": {
       "type": "screenshot|api-response",
       "capturedAt": "...",
       "path": "~/.pai-work/{slug}/evidence/after-local.png"
     },
     "afterProd": {
       "type": "screenshot|api-response",
       "capturedAt": "...",
       "path": "~/.pai-work/{slug}/evidence/after-prod.png"
     }
   }
   ```

**Key difference from SHIP container test:** SHIP uses `make test-rebuild` (seed data — catches deployment bugs). PROVE uses `make prove-up` (prod data — catches data-shape bugs). Not redundant — different data, different failure classes.

**Gate:** Before/after evidence exists. Quinn passed on prove container with prod data. **Mechanically enforced (#294):** prove gate FAILs if STANDARD+ tier and `afterEvidence.environment !== "prod"`. LIGHT tier exempted (local-only sufficient). Prove container lifecycle: make prove-up (start) / make prove-down (auto on prove gate PASS).

**Artifact:** prove-evidence.json with before/after comparison + Quinn verdict.

**Scorecard metrics:**
- Before-state captured? (beforeState.captured)
- After-state captured prod? (afterProd.captured)
- Quinn passed prod? (quinn.prod.verdict)
- Verdict: PROVEN/UNPROVEN/INCONCLUSIVE

### Step 5: RELEASE (`/release` — new)

**Trigger:** PROVE passed. Code is verified on prod container.

**What happens:**
1. `make release-dry-run` (optional confidence check)
2. `make release-patch` → version bump → release-test → tag push
3. Gate 4 runs on GitHub Actions (E2E on seeded server)
4. Draft release → upload assets → verify → publish
5. Post release proof to issue:
   ```
   ## Release Proof
   - Before: [screenshot] — bug visible in v1.7.6.0
   - Fix: commit abc123
   - After (local): [screenshot] — bug fixed on dev
   - After (prod): [screenshot] — bug fixed on prod
   - Release: v1.7.6.1 — Gate 4 PASS
   - Download: setup.sh verified 200 OK
   ```

**Gate:** Release tag exists. Gate 4 passed. Asset URLs return 200.

**Artifact:** Published GitHub release with proof comment on issue.

**Scorecard metrics:**
- Release-dry-run passed? (releaseDryRun.result)
- Gate 4 passed? (gate4.result)
- Asset verification passed? (assetVerification.result)
- Proof posted to issue? (releaseProof.posted)

## Convergence Loop

After PROVE or RELEASE:

```
Post-ship council → findings? → file issues → SHIP them → council again → clean? → DONE
```

**Council-recommended signal (advisory, not auto-triggered):** After STANDARD+ tier ships, the harness emits a `council-recommended` signal. DA reads the signal and decides whether to run council. Council is NOT auto-triggered — auto-triggering costs 200-400K tokens without human judgment. If council finds issues, they become new issues that enter the chain at DEFINE. *(Updated 2026-09-04: council decision overrode original "auto-trigger" to advisory-only.)*

**Stall in ship:** Same verify failures 2x → DA decides whether to run council on the failures → ship mechanical recommendations → re-verify.

## QC Validation (automatic at gates)

`skill-qc-validator.sh` runs automatically at each gate, checking the skill's output against `schemas/skill-qc-checks.json`:
- **scope gate** → goal QC (G1-G8) at STANDARD+ tiers
- **verify gate** → ship QC (S1-S8) at STANDARD+ tiers
- **prove gate** → prove QC (P1-P9) at all tiers

Currently WARN severity (2-week calibration). Manual: `bash scripts/skill-qc-validator.sh --skill NAME --issue N --slug SLUG`

## Validation Layers (reconciled 2026-09-15, aligned with CI-ENFORCEMENT-SPEC)

```
Layer 1: Local Dev (SHIP step 1-4) — fast feedback
  make dev-all → :7778 (API) + :5173 (UI)
  Marcus codes + tests. Quinn validates on dev server.
  GATE: Quinn local PASS before container build.

Layer 2: Test Container (SHIP step 5-9) — deployment correctness
  make test-rebuild → :7776 (seed data, isolated)
  container-has-fix gate (P11 FAIL if stale). Quinn re-validates.
  GATE: Quinn container PASS before PR is opened.

Layer 3: Prove Container (PROVE step 2-3) — prod data correctness
  make prove-up → :7776 (rsynced PROD data, isolated from live)
  Quinn validates with real customer data shapes.
  Post-merge only. make prove-down auto-runs on PASS.

Layer 4: Release Pipeline (RELEASE step)
  make release-dry-run → make release-patch → Gate 4
  E2E on seeded server. Asset verification.
```

**Industry alignment:** Google presubmit/postsubmit, Dagger "same pipeline everywhere", Vercel preview deployments. Layer 2 is pre-merge (shift left). Layer 3 is post-merge (prod data verification). Not redundant — different data, different failure classes.

## Per-Skill Scorecard

Every skill appends to `~/.claude/state/skill-telemetry.jsonl`:

```json
{
  "ts": "2026-09-03T...",
  "skill": "goal|research|council|ship|prove|release",
  "issue": 1229,
  "metrics": {
    "reproduced": true,
    "beforeCaptured": true,
    "councilRan": false,
    "iterations": 2,
    "quinnLocal": "PASS",
    "quinnProd": "PASS",
    "gate4": "PASS"
  }
}
```

Monthly audit: query telemetry, find skills with low success rates, council on improvements.

## What This Replaces

- Ship skill still handles SCOPE → BUILD → VERIFY (Step 3)
- PROVE replaces the manual "did you test it?" question
- RELEASE connects to CI-RELEASE-PIPELINE.md (DDB docs/)
- Council convergence replaces manual "should we run council?"
- Skill telemetry replaces "unknown" category from gate audit

## Open Questions

1. ~~Should PROVE be a separate skill or integrated into ship's VERIFY phase?~~ **RESOLVED: Separate skill.** /prove is standalone, produces prove-evidence.json. (ADR-007)
2. ~~Should /release be a skill or a Makefile-only step?~~ **RESOLVED: Separate skill.** /release validates, generates changelog, monitors Gate 4. (ADR-007)
3. How does Quinn capture screenshots programmatically? (Playwright? Browser agent?) **OPEN**
4. Where do before/after evidence files live long-term? (workflow-state.json gets TTL'd) **OPEN** — GoalRecords are TTL-exempt per ADR-007; evidence files need similar treatment
5. Should the convergence loop have a budget cap? **OPEN**

## Related Specs

- `~/.claude/PAI/HARNESS-STANDARD.md` — current harness loop
- `~/.claude/PAI/HARNESS-GATES.md` — gate documentation
- `~/Projects/DailyBriefDashboard/docs/CI-RELEASE-PIPELINE.md` — 3-layer validation + release flow
- `~/.claude/skills/ship/SKILL.md` — ship skill v2
- `~/.claude/skills/goal/SKILL.md` — goal skill
- `~/.claude/skills/testing-and-qa-validation/SKILL.md` — QA workflow (15 steps)
- `~/.claude/workflows/council.js` — council workflow with enforcement classification
