---
doc-type: spec
status: draft
owner: jason
created: 2026-09-03
updated: 2026-09-03
testable: true
compliance: strict
governs: Skill chaining — how goal → ship → prove → close sequences connect and pass state
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
1. Marcus codes on local dev
2. Unit tests pass (`bun test`), types check (`bunx tsc --noEmit`)
3. Quinn validates locally (for UI tools: browser-based testing; for CLI tools: command execution and output verification)
   - Tests as brand-new user, captures evidence for failures
   - If Quinn fails → back to Marcus → fix → Quinn retests (fast cycle)
4. **GATE: Quinn local PASS before commit**

**Layer 2 — PR + Ship Gate**
5. Commit → push → PR created via `gh pr create`
6. CI runs (typecheck, test suite, harness gates)
7. Rook security scan on changed files (STANDARD+ tiers)
8. Ship gate runs (verify-gate + durability-gate checks)
9. **GATE: Ship gate PASS. PR ready for review.**

**Gate:** verify-gate PASS + ship-gate PASS. Quinn passed locally.

**Artifact:** PR with verified code, ready for Jason to review and merge.

**Scorecard metrics:**
- Iterations to pass verify-gate (iterationCount)
- Quinn verdict (quinn.verdict)
- Gate telemetry (gate-telemetry.jsonl)
- Test/tsc results

### Step 4: PROVE (post-merge — prod data verification)

**Trigger:** Jason reviewed and merged the PR. Code is on main.

**What happens:**
1. Verify fix commit is on main (`git branch --contains {sha} main`)
2. **Validate fix in production-like environment**
   - For libraries: Verify published package version contains fix
   - For CLI tools: Verify installed binary behaves correctly
   - For applications: Verify deployment reflects fix
3. **Quinn validates in target environment**
   - Capture after-state (production evidence)
   - For CLI tools: Execute commands with real data, verify output
   - For libraries: Test integration with dependent projects
4. **Before/after evidence artifact:**
   ```json
   {
     "beforeState": {
       "type": "screenshot|api-response|data-snapshot",
       "capturedAt": "...",
       "path": "~/.rungate/{slug}/evidence/before.png"
     },
     "afterLocal": {
       "type": "screenshot|api-response",
       "capturedAt": "...",
       "path": "~/.rungate/{slug}/evidence/after-local.png"
     },
     "afterProd": {
       "type": "screenshot|api-response",
       "capturedAt": "...",
       "path": "~/.rungate/{slug}/evidence/after-prod.png"
     }
   }
   ```

**Key difference from SHIP test:** SHIP uses test suite with controlled data. PROVE uses production or production-like environment with real data. Not redundant — different environments, different failure classes.

**Gate:** Before/after evidence exists. Quinn passed in production-like environment. **Mechanically enforced (#294):** prove gate FAILs if STANDARD+ tier and `afterEvidence.environment !== "prod"`. LIGHT tier exempted (local-only sufficient).

**Artifact:** prove-evidence.json with before/after comparison + Quinn verdict.

**Scorecard metrics:**
- Before-state captured? (beforeState.captured)
- After-state captured prod? (afterProd.captured)
- Quinn passed prod? (quinn.prod.verdict)
- Verdict: PROVEN/UNPROVEN/INCONCLUSIVE

### Step 5: RELEASE (`/release` — new)

**Trigger:** PROVE passed. Code is verified on prod container.

**What happens:**
1. Version bump (patch/minor/major per semantic versioning)
2. Release validation → tests pass → tag push
3. CI release workflow runs (test suite, build verification)
4. Package publish (npm, GitHub releases, or distribution channel)
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

**Gate:** Release tag exists. CI release workflow passed. Published artifact is accessible.

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
  bun test → All tests pass locally
  Marcus codes + tests. Quinn validates functionality.
  GATE: Quinn local PASS before commit.

Layer 2: CI Pipeline (SHIP step 5-9) — integration verification
  GitHub Actions CI runs on push
  Full test suite, type checking, conformity tests
  GATE: CI passes before PR merge.

Layer 3: Production Validation (PROVE step 2-3) — real environment
  Verify fix in production or production-like environment
  Quinn validates with real usage patterns and data.
  Post-merge only.

Layer 4: Release Pipeline (RELEASE step)
  Version bump → tests → publish → verify accessibility
  Package published to distribution channel (npm, etc.)
```

**Industry alignment:** Google presubmit/postsubmit, trunk-based development with CI gates. Layer 1 is local (fast). Layer 2 is pre-merge (shift left). Layer 3 is post-merge (production verification). Not redundant — different environments, different failure classes.

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

- `specs/HARNESS-STANDARD.md` — current harness loop (this project)
- `specs/HARNESS-GATES.md` — gate documentation (this project)
- `~/.claude/PAI/HARNESS-STANDARD.md` — PAI harness loop (global)
- `~/.claude/skills/ship/SKILL.md` — ship skill v2 (global)
- `~/.claude/skills/goal/SKILL.md` — goal skill (global)
- `~/.claude/skills/testing-and-qa-validation/SKILL.md` — QA workflow (global)
- `workflows/council.js` — council workflow (if exists in project)
