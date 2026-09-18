---
doc-type: reference
status: active
owner: jason
updated: 2026-09-18
---

# Ship — Reference Material

## Size Definitions

| Size | Scope | Time | Ceremony |
|------|-------|------|----------|
| **XS** | Single file, obvious fix, clear root cause | <30 min | None — straight to BUILD |
| **S** | 1-2 files, some diagnosis, clear target | <2 hours | None — straight to BUILD |
| **M** | 3+ files, crosses boundaries, architectural | 2-8 hours | grill-with-docs → BUILD |
| **L** | 6+ user stories, new capability | 1-3 days | grill → PRD → issues → triage |

**Boundary crossing = M:** lib/ → dashboard/, scraper → consumer, new external dependency, new API endpoint, new config file.

## Evidence Types

Every acceptance criterion (AC-N) must have exactly one evidence citation in the completion report:

| Type | Format | When to use |
|------|--------|-------------|
| **Code presence** | `→ file.ts:L## [description]` | Asserting code exists at a location |
| **Absence** | `→ grep: "pattern" returned 0 matches in src/` | Asserting something does NOT exist |
| **Screenshot** | `→ screenshot: /tmp/qa-feature.png [description]` | UI/visual assertions |
| **API response** | `→ API: GET /endpoint returned { key: value }` | Behavior assertions |
| **Test pass** | `→ test: test-file.test.ts "test name" PASS` | Test-verified assertions |

## Acceptance Criteria Template

```
## Acceptance Criteria

- [ ] AC-1: [specific, verifiable statement]
- [ ] AC-2: [specific, verifiable statement]
- [ ] AC-A1: [anti-criterion — must NOT happen]
```

Rules:
- One verifiable thing per AC
- If it contains "and" joining two verifiable things → split
- If "all" or "every" → enumerate what "all" means
- Anti-criteria (AC-A prefix): what must NOT happen

**Garbage Test (MANDATORY for every AC):**
After writing each AC, ask: "Could garbage data pass this?" If yes, tighten the AC until the answer is no.

| Bad AC (presence check) | Good AC (measurable threshold) |
|---|---|
| "signals exist for product" | "signal count ≥ 4, each with headline + detail + ≥1 link" |
| "endpoint returns data" | "endpoint returns ≥ 3 items, each with name + non-empty detail" |
| "_enriched.json is produced" | "enrichment extracts ≥ 10 kits with ≥ 80% having actionable steps" |
| "download completes" | "download rate ≥ 50% of page-visible items" |
| "component renders" | "component shows correct data for 3 real customers, no empty sections" |

**Scaling/extending work:** When extending a feature to new data (product #2, customer #2, etc.), ACs must include comparative metrics: "new instance meets or exceeds original's quality bar on [coverage %, signal count, download rate, field completeness]."

## Consumer Output Verification (MANDATORY for consumer changes)

If the change touches any consumer output (morning brief, campaigns, meeting prep, playbooks, email outreach, account plans), run ALL 4 layers:

### Layer 1: API Output
Deploy, hit the endpoint, READ the JSON response.
```bash
curl -s http://localhost:7777/api/morning-summary | python3 -m json.tool
```
Verify: correct field counts, no empty sections, no internal noise, no hallucinated data.

### Layer 2: UI Screenshot
Take a Playwright screenshot of the component rendering the data.
```bash
node -e "const {chromium}=require('playwright'); ..."
```
Verify: labels readable, no broken layout, badges display correctly, no noise items visible.

### Layer 3: Rendered Output
If the change feeds into email HTML, Google Docs, or rendered templates — generate and READ the actual output. Not just the data feeding into it.

### Layer 4: Goal Statement Check
Re-read `project_application_mission.md`. For each output item ask: "Does this help the AE walk into a room with a solution that connects to a business problem?" 100% must be actionable intelligence. Any item that's data without a conversation = not done.

Unit tests verify code structure. These 4 layers verify the product.

## GitHub Issue Templates (standard for all sizes)

### XS/S/M — Direct issue

```markdown
## Context
[1-3 sentences: what exists, what's wrong or missing, why it matters]

## Acceptance Criteria
- [ ] AC-1: [measurable statement] → evidence: [code|grep|screenshot|api|test]
- [ ] AC-2: [measurable statement] → evidence: [type]
- [ ] AC-A1: [anti-criterion — must NOT happen] → evidence: [grep absence]

## Files to modify
- [explicit file list]

## Size: [XS|S|M|L]
```

### L — User story (one per vertical slice, created by `Skill("to-issues")`)

```markdown
## User Story
As a [role], I want [what] so that [why].

## Context
[How this slice fits into the larger goal. Link to parent issue.]

## Acceptance Criteria
- [ ] AC-1: [measurable statement] → evidence: [type]
- [ ] AC-2: [measurable statement] → evidence: [type]
- [ ] AC-A1: [must NOT happen] → evidence: [type]

## Files to modify
- [explicit file list]

## Size: [XS|S|M] (each slice should be independently shippable)
## Parent: #[parent issue number]
```

### Rules (all sizes)
- Title format: `[verb] [what] — [where/context]`
- Every AC gets the garbage test: "Could garbage pass this?" → tighten until no
- Evidence type declared per AC at writing time, not after
- Anti-criteria (AC-A) for anything that must NOT change
- Files to modify = explicit allowlist for Marcus brief
- Post to GitHub via `gh issue comment` before BUILD starts

## Completion Report Template

```
## Done

### Evidence
- AC-1: → file.ts:L45 [function added with correct signature]
- AC-2: → grep: "templateSalesAlignment" returned 0 matches in src/customer.ts
- AC-3: → test: saleshub-filters.test.ts "rejects template text" PASS
- AC-A1: → grep: "HMRC" returned 1 match in config-templates/saleshub-knowledge.json [preserved]

### Consumer output (if applicable)
- API: GET /api/morning-summary → 20 signals, 0 internal noise, 0 generic competitor
- [paste relevant excerpt showing fix works]

### Tests
- `bun test --isolate test/unit/` — 1609 pass, 0 failures (zero tolerance — no "pre-existing" exemptions)
- `npx playwright test test/api/ --project=test` — 36 pass on 7776

### Files changed
- src/lib/foo.ts:L45-L67 — added bar function
- test/unit/foo.test.ts — 4 new tests

### Docs updated
- [x] ARCHITECTURE.md — no update needed
- [x] PROJECT-STATE.md — no update needed
```

## DISCOVERY Artifact Template (MANDATORY — post to GitHub issue before PLANNING)

Post this as a `gh issue comment` after completing DISCOVERY. Every fact must cite a file and line — never DA memory.

```
## Discovery — [issue title]

### Docs read (with last-modified)
- PRINCIPLES.md (modified: YYYY-MM-DD) — [key constraints found]
- ARCHITECTURE.md (modified: YYYY-MM-DD) — [key patterns found]
- PROJECT-STATE.md (modified: YYYY-MM-DD) — [current state relevant to issue]
- [checkpoint if resuming] — [stopped at / next step]

### Constraints (file:line citation required for each)
- [constraint 1] → [file.md:L##]
- [constraint 2] → [file.md:L##]

### Domain-specific (answer ALL that apply)

**Scraper/infrastructure:**
- Where does this run? → [host/container] → [file.md:L##]
- What auth is needed? → [SSO/token/key] → [file.md:L##]
- What prerequisites? → [services/connections] → [file.md:L##]
- Where does output go? → [cache/Drive/both] → [file.md:L##]

**UI:**
- Which component? → [file path] → [file.md:L##]
- What data feeds it? → [API endpoint/source] → [file.md:L##]
- What consumers read it? → [list] → [PRINCIPLES.md:L##]

### Related issues
- #N — [open/closed] — [relationship]

### Unknowns (if any — each becomes RESEARCH input or new issue)
- [unknown 1] → [will research / logged as #N]

### Doc gaps found (if any — logged immediately)
- [gap description] → logged as #N
```

---

## Checkpoint Format (MANDATORY for multi-step work)

`$RUNGATE_WORK_DIR/{slug}/CHECKPOINT.md` must include:
```
**Project root:** [path]
**Session:** [date]
**Status:** [current state]
**Start timestamp:** [ISO-8601 — used by circuit breaker wall clock check]

## Current work
- Issue: #N
- Phase: [GOAL|DISCOVERY|RESEARCH|PLANNING|EXECUTION|VERIFICATION|ITERATION]
- Iteration: [N of max]

## Stopped at
[Exact description of where work stopped and what the next step is]
```

## Stuck Detection Storage

`$RUNGATE_WORK_DIR/{slug}/stuck-detection.json` — updated at each iteration boundary, read at each iteration start:
```json
{
  "iteration_count": 0,
  "start_timestamp": "2026-06-19T16:00:00-04:00",
  "stderr_hashes": [],
  "tool_call_hashes": [],
  "acs_passed_per_iteration": [],
  "goal_audit_events": [],
  "goal_audit_count": 0,
  "baseline_values": {}
}
```

## Diagnostic Template (bugs only)

```
## Diagnosis
- Environment: [read project CLAUDE.md for test/prod ports]
- Logs: [what the logs show]
- State: [cache/config file contents]
- Source: [relevant code at file:line]
- Hypothesis: [single hypothesis]
- Fix: [minimal change]
```
