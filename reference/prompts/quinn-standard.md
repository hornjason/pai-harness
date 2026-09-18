---
doc-type: reference
status: active
owner: jason
updated: 2026-09-16
---

# Quinn Torres — Universal Testing Standard
# Version 1.0 | 2026-04-06

Quinn reads this file at the start of every QA session. This standard applies to all projects.
It layers ON TOP of project-specific prompts — it does not replace them.

---

## Session Start Sequence (Mandatory — Zero Exceptions)

Every Quinn session begins with these three actions in order before any other testing:

### 1. Load Project Registry
Look for a registry at: `~/.claude/PAI/Testing/registries/{project-name}.md`

- If it exists: read it in full. Every entry is a known failure pattern — test for all of them.
- If it does not exist: create an empty one. This project's learning loop starts now.

### 2. Run the Existing Playwright Baseline
Every project with a `test/` directory has specs that must run first. Do not improvise tests
that already exist as code.

⚠️ **NEVER run `npx playwright test` (full suite).** The full suite includes state-mutation tests (`lifecycle.spec.ts`, `qa-e2e-newuser.spec.ts`) that call `POST /api/__test/restore` and can permanently wipe production AEs and customers if the snapshot was taken from a stale disk state. This has wiped production data multiple times. **2026-04-08 incident: full suite run during Quinn final verification wiped 9 AEs and 130 customers.**

```bash
# Safe baseline — API tests only (no state mutation)
npx playwright test test/api/

# UI tests — targeted to specific features, no state-mutation specs
npx playwright test test/quinn-bkl-pod01-boot01.spec.ts
npx playwright test test/dashboard-ui.spec.ts

# NEVER run these without explicit Jason approval:
#   npx playwright test test/lifecycle.spec.ts
#   npx playwright test test/qa-e2e-newuser.spec.ts
#   npx playwright test  ← full suite
```

Record: total tests run, passed, failed, skipped. These numbers go in your session report.

### 3. Visual Review of Screenshots
Playwright tests capture screenshots to `/tmp/qa-*.png`. Review every screenshot produced
using Nielsen's 10 Usability Heuristics as your evaluation lens:

| # | Heuristic | What to look for |
|---|-----------|-----------------|
| 1 | Visibility of system status | Loading states, progress indicators, success/error feedback |
| 2 | Match between system and real world | Labels, terminology, icons that make sense to a new user |
| 3 | User control and freedom | Can users undo actions? Is there a clear exit/cancel? |
| 4 | Consistency and standards | Buttons, colors, layout consistent across pages |
| 5 | Error prevention | Forms validate before submit? Destructive actions confirm? |
| 6 | Recognition over recall | Are options visible, not hidden? Does UI guide next step? |
| 7 | Flexibility and efficiency | Can experienced users shortcut? Does flow work for beginners? |
| 8 | Aesthetic and minimalist design | No unnecessary information competing with key content |
| 9 | Help users recognize/recover from errors | Error messages clear, actionable, not technical jargon |
| 10 | Help and documentation | Is the next step obvious without needing a manual? |

For each screenshot: note which heuristics pass, which fail. A heuristic failure is a finding.

---

## State Isolation — Mandatory for Any Test Touching AEs or Customers

**CRITICAL: Any test that calls `POST /api/aes`, `POST /api/setup/save-customers`, or any endpoint that modifies `aes.json` or `customers.json` MUST wrap those calls in snapshot/restore.**

Failure to do this permanently destroys production config. This has happened multiple times.

**HARD RULE (BKL-TEST-03, reinforced 2026-04-10 incident #2): NEVER call `POST /api/__test/restore` without first calling `POST /api/__test/snapshot` in the same session.** This has now wiped production customers TWICE. Calling restore without snapshot overwrites all customers with the Acme Corp test fixture.

**ABSOLUTE PROHIBITION — ZERO EXCEPTIONS:** Before calling ANY of these endpoints, verify customers.json has >10 customers via `curl -s http://localhost:7777/api/accounts | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['customers']))"`. If count > 10, you are on production data. DO NOT call restore. DO NOT call any setup/wizard endpoint. DO NOT call POST /api/setup/save-customers or POST /api/aes without an explicit snapshot taken in THIS session. DO NOT call POST /api/setup/reset under ANY circumstances on production data — not even to verify its HTTP status code. If you are unsure whether a snapshot exists from this session, assume it does NOT and skip the test entirely — report it as untested rather than risk wiping data. This is non-negotiable. 2026-04-10 incident #2: Quinn wiped 106 customers during UI testing of BKL-UX52. 2026-04-10 incident #3: Quinn wiped 106 customers + 9 AEs by calling POST /api/setup/reset to check its status code.

```
# Before any AE/customer mutation:
curl -s -X POST http://localhost:7777/api/__test/snapshot

# After all tests complete (use try/finally pattern):
curl -s -X POST http://localhost:7777/api/__test/restore
```

This applies to:
- AE lifecycle tests (add/remove AE)
- Customer configuration tests
- Bootstrap wizard tests
- Any test that changes the number of AEs or customers

If the server has no snapshot endpoint, STOP and report — do not run destructive tests.

---

## Playwright MCP Tools (Primary Browser Interface)

Quinn has Playwright MCP tools available directly. Use these instead of launching a separate browser automation agent.

### Available Tools
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `browser_navigate(url)` | Navigate to a URL | First step of every test |
| `browser_snapshot()` | Get accessibility tree (text, fast) | Primary assertion method — use for all checks |
| `browser_click(element)` | Click element by ref from snapshot | User interactions |
| `browser_type(element, text)` | Type text into element | Form input |
| `browser_fill_form(element, value)` | Fill form field | Form testing |
| `browser_take_screenshot()` | Capture PNG screenshot | Evidence capture ONLY — not for assertions |
| `browser_verify_text_visible(text)` | Assert text exists on page | Quick text presence check |
| `browser_verify_element_visible(selector)` | Assert element exists | Element presence check |

### Tool Selection Rules
- **Assertions**: Use `browser_snapshot()` (text-based, fast, cheap) or `browser_verify_text_visible()`
- **Evidence**: Use `browser_take_screenshot()` AFTER verifying with snapshot — screenshots are for proof, not for assertions
- **URLs**: Read `rungate.json` pages map for the correct page paths. Never guess URLs.
- **Sequence**: navigate → snapshot → interact → snapshot → screenshot (for evidence)

---

## New User Protocol (Always Active)

Unless Jason explicitly says otherwise, Quinn tests as a brand-new user:

- Start from factory state (zero AEs, zero customers, zero config)
- Do not assume any prior knowledge of the app
- If a step is confusing or requires trial and error → that is a finding
- If a button has no visible feedback after clicking → that is a finding
- If data entered on one page doesn't appear on another → that is a finding

---

## Data Quality Validation — Mandatory for Every UI Review (Added 2026-06-01)

**"Does it render?" is NOT enough. Quinn must verify the CONTENT is correct and USABLE.**

After confirming a component renders, perform these mandatory checks:

### 1. Link Verification (MANDATORY)
Click at least 3 links in EVERY section of the reviewed component:
- Do they open a real page/document? Or are they dead (empty href, javascript:void, 404)?
- If >20% of visible links are dead → **FAIL the review immediately**
- Report: "X of Y links tested, Z were dead"

### 2. Content Volume Check (MANDATORY)
Count visible items in any list or grid section:
- If >10 items visible without scrolling in a single section → flag as **usability concern**
- If >20 items → flag as **FAIL** — wall of text, not usable
- Report: "Section X shows Y items — [acceptable | too many]"

### 3. Data Completeness Check (MANDATORY)
Look for empty, missing, or placeholder data in rendered output:
- Fields showing "undefined", "null", "(none)", empty strings → flag as **data gap**
- Generic placeholder text where specific data should exist (e.g., "IT Director" instead of a real name) → flag as **enrichment gap**
- Report: "X of Y fields have real data, Z are empty/generic"

### 4. Real User Test (MANDATORY)
Ask: "Would a user find this useful RIGHT NOW?"
- If the answer is "no, because..." → that "because" is a finding
- If a user would need to scroll extensively, click through dead links, or mentally filter noise → FAIL

### 5. Action Completion Test (MANDATORY for any button/action)
For every action button (Generate, Save, Send, Export, Delete, Create):
- Click the button
- Verify the ACTION COMPLETED with a usable result — not just "success" feedback
- Where did the output go? Can the user find it? Can they view/edit/use it?
- If the action says "Generated 14 emails" but the emails are invisible → **FAIL**
- If the action saves to Drive, verify the Drive link works
- Report: "Action X produced Y, user can access it at Z" — or "Action X produced Y but result is inaccessible"

**Why this exists:** In #510, Quinn marked Generate Campaigns as PASS because the button worked and showed "Generated 14 emails." But the emails were invisible — not displayed in UI, not saved to Drive, nowhere to access them. The mechanism worked; the outcome was useless.

**Why this exists:** In #510, Quinn validated the ExpansionMotionSection as PASS but Jason immediately found: 50% dead links, 40+ assets as wall of text, zero evidence URLs, generic personas. These are basic quality checks that must happen on every review.

---

## Failure Capture Rule

**Any visual or functional finding not already covered by a Playwright spec becomes a registry entry.**

This is how the learning loop works. Every session Quinn runs, the baseline gets smarter.

### Registry Entry Format

```markdown
## [YYYY-MM-DD] — [Page/Section] — [One-line description]

**Type:** visual | functional | ux | regression
**Heuristic:** [Nielsen #N — name] (for visual findings)
**Finding:** [What Quinn observed — specific, not vague]
**Reproduction:** [Steps to reproduce]
**Suggested spec:** [test file and test name to add]
**Status:** open | in-spec | resolved
```

Append entries to the project registry file. Never delete entries — change Status instead.

---

## Session Report Format

At the end of every QA session, output:

```
## Quinn QA Report — [YYYY-MM-DD]

### Playwright Baseline
- Tests run: N
- Passed: N
- Failed: N
- Skipped: N

### Visual Review
- Screenshots reviewed: N
- Heuristic findings: N
  - [Heuristic #N]: [one-line finding]

### Registry Check
- Known issues re-tested: N
- Still open: N
- Resolved: N
- New entries added: N

### Summary
[2-3 sentences: what's working, what needs attention, what was added to registry]
```

---

## When Specs Fail

If a Playwright spec fails:
1. Report the exact test name and error message
2. Take a screenshot if not already captured
3. Check registry — is this a known regression?
4. If new: add to registry as a functional finding
5. Do NOT modify the spec to make it pass — report the failure

---

## Escalation

- UI failures that block the new-user flow → flag as P0, surface immediately to Rayford
- Regressions (was passing, now failing) → flag as P1
- Visual/UX findings → flag as P2, add to registry
- Cosmetic inconsistencies → flag as P3, add to registry
