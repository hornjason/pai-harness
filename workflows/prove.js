export const meta = {
  name: 'prove',
  description: 'Standalone verification: prove a fix solves the user problem. GOAL → VERIFY-DEPLOYED → VALIDATE → VERDICT → OUTPUT',
  whenToUse: 'After /ship to prove the fix works. Standalone on any issue. Replaces reading prove SKILL.md manually.',
  phases: [
    { title: 'Goal', detail: 'Read issue, extract what was fixed, load chain context' },
    { title: 'Verify-Deployed', detail: 'Confirm fix commit is on main' },
    { title: 'Validate', detail: 'Spawn B3 reproducer + optional Quinn for UI' },
    { title: 'Verdict', detail: 'Mechanical verdict from criteriaResults' },
    { title: 'Output', detail: 'Write prove-evidence.json, post proof comment, add label, telemetry' },
  ],
}

// ── Structured output schemas ────────────────────────────────

const PROVE_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    issueNumber: { type: 'number' },
    verdict: { type: 'string', enum: ['PROVEN', 'UNPROVEN', 'INCONCLUSIVE'] },
    commitSHA: { type: 'string' },
    capturedAt: { type: 'string' },
    criteriaResults: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scId: { type: 'string' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
          evidence: { type: 'string' },
        },
        required: ['scId', 'verdict'],
      },
    },
    reproduced: { type: 'boolean' },
  },
  required: ['issueNumber', 'verdict', 'commitSHA', 'criteriaResults'],
}

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    issueGoal: { type: 'string' },
    issueTitle: { type: 'string' },
    issueBody: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    successCriteria: { type: 'array', items: { type: 'string' } },
    hasUIACs: { type: 'boolean' },
  },
  required: ['issueGoal', 'issueTitle', 'issueBody'],
}

const DEPLOY_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    deployed: { type: 'boolean' },
    commitSHA: { type: 'string' },
    branch: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['deployed', 'commitSHA'],
}

const REPRODUCER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PROVEN', 'UNPROVEN', 'INCONCLUSIVE'] },
    criteriaResults: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scId: { type: 'string' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
          evidence: { type: 'string' },
        },
        required: ['scId', 'verdict'],
      },
    },
    reproduced: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } },
    quinnNeeded: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'criteriaResults', 'reproduced'],
}

const QUINN_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: { type: 'array', items: { type: 'string' } },
    criteriaResults: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scId: { type: 'string' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
          evidence: { type: 'string' },
        },
        required: ['scId', 'verdict'],
      },
    },
  },
  required: ['verdict'],
}

// ── Args ─────────────────────────────────────────────────────

let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs.issue) {
  return { status: 'ARGS_ERROR', message: 'Usage: Workflow({ name: "prove", args: { issue: N, projectRoot: "/path" } })' }
}

const ISSUE = parsedArgs.issue
const REPO = parsedArgs.repo || 'hornjason/asaCommandCenter'
const ISSUE_REPO = parsedArgs.issueRepo || REPO
const PROJECT_ROOT = parsedArgs.projectRoot || ''
const HARNESS_ROOT = parsedArgs.harnessRoot || '/Users/jhorn/Projects/pai-harness'
const HOME = parsedArgs.home || PROJECT_ROOT.split('/Projects/')[0] || '/Users/jhorn'
const SLUG = parsedArgs.slug || `ddb-${ISSUE}`
const WORK_DIR = `${HOME}/.pai-work/${SLUG}`
const PROVE_PROMPT = `${HARNESS_ROOT}/gates/prompts/prove-reproducer.md`

// ── Chain detection ──────────────────────────────────────────

const GOAL_RECORD_PATH = `${WORK_DIR}/goal-record.json`
const SHIP_EVIDENCE_PATH = `${WORK_DIR}/ship-evidence.json`

// ════════════════════════════════════════════════════════════
// PHASE 1: GOAL — Read issue, extract what was fixed
// ════════════════════════════════════════════════════════════

phase('Goal')
log(`Prove #${ISSUE}: reading issue and chain context`)

const issueData = await agent(`
Read this GitHub issue and extract the goal:
gh issue view ${ISSUE} --repo ${ISSUE_REPO} --json title,body,labels

Also check for chain artifacts:
1. test -f ${GOAL_RECORD_PATH} && echo "GOAL_RECORD: exists" || echo "GOAL_RECORD: none"
2. test -f ${SHIP_EVIDENCE_PATH} && echo "SHIP_EVIDENCE: exists" || echo "SHIP_EVIDENCE: none"

If goal-record.json exists, read it and extract the structured SCs.
If ship-evidence.json exists, read it and extract mergeCommitSha.

Extract:
1. issueGoal — main goal statement
2. issueTitle — the title
3. issueBody — full body text
4. labels — label names
5. successCriteria — each SC/AC (from goal-record.json if chain mode, else from issue body)
6. hasUIACs — true if any AC mentions UI, screenshot, visual, page, component, render
`, { label: 'read-issue', phase: 'Goal', schema: ISSUE_SCHEMA })

if (!issueData) return { status: 'GOAL_FAILED', message: `Could not read issue #${ISSUE}` }
log(`Goal: "${issueData.issueTitle}" — UI ACs: ${issueData.hasUIACs ? 'yes' : 'no'}`)

// ════════════════════════════════════════════════════════════
// PHASE 2: VERIFY-DEPLOYED — Confirm fix is on main
// ════════════════════════════════════════════════════════════

phase('Verify-Deployed')
log('Checking fix is deployed to main')

const deployCheck = await agent(`
Verify the fix for issue #${ISSUE} is on main:

1. Check for ship-evidence.json: test -f ${SHIP_EVIDENCE_PATH}
   If it exists, read it and extract mergeCommitSha.

2. If mergeCommitSha exists:
   cd ${PROJECT_ROOT || '.'} && git branch --contains <sha> | grep -q main && echo "ON_MAIN" || echo "NOT_ON_MAIN"

3. If no mergeCommitSha (standalone mode):
   cd ${PROJECT_ROOT || '.'} && git log --oneline --all --grep="#${ISSUE}" | head -5
   Use the latest commit SHA found.
   Verify it's on main: git branch --contains <sha> | grep -q main

4. Get current HEAD:
   cd ${PROJECT_ROOT || '.'} && git rev-parse HEAD

Report: deployed (boolean), commitSHA (the fix commit or HEAD), branch, reason.
`, { label: 'deploy-check', phase: 'Verify-Deployed', schema: DEPLOY_CHECK_SCHEMA })

if (!deployCheck || !deployCheck.deployed) {
  log(`VERIFY-DEPLOYED FAILED: ${deployCheck?.reason || 'fix not on main'}`)
  return {
    status: 'DEPLOY_FAILED',
    issue: ISSUE, slug: SLUG,
    reason: deployCheck?.reason || 'Fix commit not found on main',
    workDir: WORK_DIR,
  }
}

const COMMIT_SHA = deployCheck.commitSHA || 'unknown'
log(`Fix deployed: ${COMMIT_SHA.slice(0, 8)} on main`)

// ════════════════════════════════════════════════════════════
// PHASE 3: VALIDATE — Spawn B3 reproducer + optional Quinn
// ════════════════════════════════════════════════════════════

phase('Validate')

// Ensure dev server is running for OUTCOME AC evidence collection
if (PROJECT_ROOT) {
  log('Checking dev server availability')
  await agent(`
Check if the dev server is running. Read ${PROJECT_ROOT}/.claude/project-harness.json to get dev.apiBase and dev.start.

1. Try: curl -sf $(dev.apiBase)/api/health -o /dev/null && echo "DEV_UP" || echo "DEV_DOWN"
2. If DEV_DOWN and dev.start exists:
   - Run: cd ${PROJECT_ROOT} && $(dev.start) &
   - Wait 10 seconds, then retry the health check
   - Report: started (boolean), apiBase, command used
3. If DEV_UP: report already running

Report the dev server status.
`, { label: 'ensure-dev-server', phase: 'Validate' })
}

log('Spawning B3 Prove Reproducer')

// Read before-state context for the reproducer
const beforeContext = await agent(`
Check for before-state evidence:
1. test -f ${WORK_DIR}/workflow-state.json && echo "WF_STATE: exists" || echo "WF_STATE: none"
2. If workflow-state.json exists, read it and extract beforeState field.
3. Read the issue body for reproduction steps.

Check project harness for API/UI bases:
4. test -f ${PROJECT_ROOT}/.claude/project-harness.json && cat ${PROJECT_ROOT}/.claude/project-harness.json || echo "NO_HARNESS"

Report the before-state description, reproduction steps, apiBase, and uiBase.
Return as a string summary.
`, { label: 'before-context', phase: 'Validate' })

// Spawn B3 reproducer agent
const reproducerResult = await agent(`
You are a prove reproducer for issue #${ISSUE}.
Read the prove reproducer prompt at ${PROVE_PROMPT} for your full instructions.

## Issue
Title: ${issueData.issueTitle}
Body (first 2000 chars): ${(issueData.issueBody || '').slice(0, 2000)}

## Success Criteria
${(issueData.successCriteria || []).map((sc, i) => `${i + 1}. ${sc}`).join('\n') || 'Derive from issue body'}

## Before State
${beforeContext || 'No before-state captured. Derive from issue description.'}

## Fix Commit
${COMMIT_SHA}

## Environment
Project root: ${PROJECT_ROOT || 'not set'}

## Instructions
1. Read ${PROVE_PROMPT} for your full protocol.
2. For CODE ACs: run evidence commands (grep, bun test, curl) against current code.
3. For UI/OUTCOME ACs: output SKIP with reason "B3 limitation: no browser tools — requires Quinn".
4. Compare before-state against current after-state.
5. Capture real evidence for each criterion.

Output your verdict, criteriaResults, reproduced, gaps, and quinnNeeded (list of AC IDs needing Quinn).
`, { label: 'b3-reproducer', phase: 'Validate', schema: REPRODUCER_SCHEMA })

let allCriteriaResults = reproducerResult?.criteriaResults || []
let quinnResults = null

// Spawn Quinn for UI ACs if needed
const needsQuinn = issueData.hasUIACs ||
  (reproducerResult?.quinnNeeded && reproducerResult.quinnNeeded.length > 0)

if (needsQuinn) {
  log('UI ACs detected — starting prove container with prod data, then spawning Quinn')

  // Start prove container with prod data (make prove-up = build + rsync prod data + start on :7776)
  await agent(`
You have ONE task: start the prove container with prod data. Run this EXACT command and report the output:

cd ${PROJECT_ROOT} && make prove-up 2>&1 | tail -20

This rebuilds the container image, rsyncs prod data to data-test/, and starts the container on port 7776.
After it completes, verify the container is up: curl -s -o /dev/null -w "%{http_code}" http://localhost:7776/api/aes
Report the output.
  `, { label: 'prove-container-up', phase: 'Validate' })

  const quinnACs = (reproducerResult?.quinnNeeded || []).join(', ') ||
    (issueData.successCriteria || []).filter(sc =>
      /ui|screenshot|visual|page|component|render|display|show/i.test(sc)
    ).join('\n')

  quinnResults = await agent(`
Read ~/.claude/PAI/Testing/QUINN-STANDARD.md first.

You are Quinn Torres, QA specialist. You have Playwright MCP tools available.

## Issue #${ISSUE}: ${issueData.issueTitle}
Fix commit: ${COMMIT_SHA}

## Available Playwright MCP Tools (use these, NOT manual browser)
- browser_navigate(url) — go to URL
- browser_snapshot() — get accessibility tree (text, fast, preferred over screenshots)
- browser_click(element) — click by ref from snapshot
- browser_type(element, text) — type text into element
- browser_take_screenshot() — capture PNG evidence
- browser_verify_text_visible(text) — assert text on page

## Target URLs
Read ${PROJECT_ROOT}/.claude/project-harness.json for page paths.
Prove container base: http://localhost:7776

## ACs to verify (UI/OUTCOME — skipped by B3)
${quinnACs}

## Test Plan for #${ISSUE} on PROVE CONTAINER
1. Verify fix deployed: cd ${PROJECT_ROOT} && git rev-parse --short HEAD should match ${COMMIT_SHA.slice(0, 8)}
2. For each AC:
   a. browser_navigate("http://localhost:7776" + page path from project-harness.json)
   b. browser_snapshot() — verify page loaded
   c. Perform action (browser_click, browser_type, etc.)
   d. browser_snapshot() or browser_verify_text_visible() to verify
   e. browser_take_screenshot() for evidence
3. Test as a brand-new user — use a customer that HAS contacts (prod data on :7776)
4. Report PASS/FAIL per AC with tool output as evidence

IMPORTANT: Test on port 7776 (prove container with prod data), NOT dev server (port 5173/7778).
Report verdict and criteriaResults.
  `, { label: 'quinn-prove', phase: 'Validate', schema: QUINN_SCHEMA })

  // Merge Quinn results into allCriteriaResults (replace SKIPs from B3)
  if (quinnResults?.criteriaResults) {
    const quinnMap = new Map(quinnResults.criteriaResults.map(cr => [cr.scId, cr]))
    allCriteriaResults = allCriteriaResults.map(cr => {
      if (cr.verdict === 'SKIP' && quinnMap.has(cr.scId)) {
        return quinnMap.get(cr.scId)
      }
      return cr
    })
    // Add any Quinn results for ACs not in B3 output
    for (const qr of quinnResults.criteriaResults) {
      if (!allCriteriaResults.some(cr => cr.scId === qr.scId)) {
        allCriteriaResults.push(qr)
      }
    }
  }
  log(`Quinn: ${quinnResults?.verdict || 'no result'}`)
}

// ════════════════════════════════════════════════════════════
// PHASE 4: VERDICT — Mechanical computation + self-heal loop
// ════════════════════════════════════════════════════════════

phase('Verdict')

const MAX_SELF_HEAL_ATTEMPTS = 3

function computeVerdict(criteriaResults) {
  const fc = criteriaResults.filter(cr => cr.verdict === 'FAIL').length
  const psc = criteriaResults.filter(cr => cr.verdict === 'PASS' || cr.verdict === 'SKIP').length
  let v
  if (criteriaResults.length === 0) {
    v = 'INCONCLUSIVE'
  } else if (fc > 0) {
    v = 'UNPROVEN'
  } else {
    v = 'PROVEN'
  }
  return { verdict: v, failCount: fc, passSkipCount: psc }
}

let { verdict, failCount, passSkipCount } = computeVerdict(allCriteriaResults)
log(`Verdict: ${verdict} — ${passSkipCount} PASS/SKIP, ${failCount} FAIL, ${allCriteriaResults.length} total`)

// ── Self-heal loop: on UNPROVEN, spawn Marcus to fix, re-prove ──
let selfHealIteration = 0

while (verdict === 'UNPROVEN' && selfHealIteration < MAX_SELF_HEAL_ATTEMPTS) {
  selfHealIteration++
  log(`Self-heal iteration ${selfHealIteration}/${MAX_SELF_HEAL_ATTEMPTS} — spawning fix agent`)

  const failedCriteria = allCriteriaResults.filter(cr => cr.verdict === 'FAIL')
  const failSummary = failedCriteria.map(cr => `${cr.scId}: ${cr.evidence || 'FAIL'}`).join('\n')

  // Spawn Marcus to fix the failures
  await agent(`
You are Marcus Webb, senior engineer. Prove found UNPROVEN criteria for issue #${ISSUE}.

## Failed Criteria (iteration ${selfHealIteration}/${MAX_SELF_HEAL_ATTEMPTS})
${failSummary}

## Issue
Title: ${issueData.issueTitle}
Body (first 2000 chars): ${(issueData.issueBody || '').slice(0, 2000)}

## Instructions
1. Read the failed criteria above.
2. cd ${PROJECT_ROOT || '.'} and investigate why each criterion failed.
3. Fix the code to address each failure.
4. Run tests: bun test, tsc --noEmit.
5. Commit and push the fix: git add -A && git commit -m "fix(#${ISSUE}): prove self-heal iteration ${selfHealIteration}" && git push

Report what you fixed and evidence that each failed criterion is now addressed.
  `, { label: `self-heal-fix-${selfHealIteration}`, phase: 'Verdict', agentType: 'Engineer' })

  log(`Self-heal fix ${selfHealIteration} complete — re-validating`)

  // Re-run B3 reproducer to check if fixes resolved the failures
  const revalidateResult = await agent(`
You are a prove reproducer for issue #${ISSUE} (self-heal re-validation, iteration ${selfHealIteration}).

## Issue
Title: ${issueData.issueTitle}
Body (first 2000 chars): ${(issueData.issueBody || '').slice(0, 2000)}

## Success Criteria
${(issueData.successCriteria || []).map((sc, i) => `${i + 1}. ${sc}`).join('\n') || 'Derive from issue body'}

## Previously Failed Criteria
${failSummary}

## Fix Commit
Run: cd ${PROJECT_ROOT || '.'} && git rev-parse --short HEAD

## Instructions
1. For CODE ACs: run evidence commands (grep, bun test, curl) against current code.
2. For UI/OUTCOME ACs: output SKIP with reason "B3 limitation: no browser tools — requires Quinn".
3. Focus on the previously failed criteria — verify the fix resolved them.

Output your verdict, criteriaResults, reproduced, gaps.
  `, { label: `self-heal-validate-${selfHealIteration}`, phase: 'Verdict', schema: REPRODUCER_SCHEMA })

  if (revalidateResult?.criteriaResults) {
    allCriteriaResults = revalidateResult.criteriaResults
  }

  const recomputed = computeVerdict(allCriteriaResults)
  verdict = recomputed.verdict
  failCount = recomputed.failCount
  passSkipCount = recomputed.passSkipCount

  log(`Self-heal iteration ${selfHealIteration} verdict: ${verdict} — ${passSkipCount} PASS/SKIP, ${failCount} FAIL`)
}

if (selfHealIteration >= MAX_SELF_HEAL_ATTEMPTS && verdict === 'UNPROVEN') {
  log(`CIRCUIT BREAKER: prove self-heal exhausted ${MAX_SELF_HEAL_ATTEMPTS} iterations — still UNPROVEN`)
}

// ════════════════════════════════════════════════════════════
// PHASE 5: OUTPUT — Write evidence, post comment, label, telemetry
// ════════════════════════════════════════════════════════════

phase('Output')

const proveEvidence = {
  contractVersion: '1.0',
  issueNumber: ISSUE,
  verdict,
  commitSHA: COMMIT_SHA,
  capturedAt: 'AGENT_FILL_TIMESTAMP',
  criteriaResults: allCriteriaResults,
  reproduced: reproducerResult?.reproduced ?? false,
  source: 'prove-workflow',
}

// Write prove-evidence.json
await agent(`
mkdir -p ${WORK_DIR}
Write this JSON to ${WORK_DIR}/prove-evidence.json using the Write tool.
Replace the capturedAt value "AGENT_FILL_TIMESTAMP" with the current ISO timestamp (run: date -u +%Y-%m-%dT%H:%M:%SZ).

${JSON.stringify(proveEvidence, null, 2)}
`, { label: 'write-evidence', phase: 'Output' })

log('prove-evidence.json written')

// Post proof comment to issue
const proofComment = [
  '## Proof',
  '',
  `- **Fix:** commit ${COMMIT_SHA.slice(0, 8)}`,
  `- **Reproduced:** ${proveEvidence.reproduced ? 'yes' : 'no'}`,
  ...allCriteriaResults.map(cr => `- **${cr.scId}:** ${cr.verdict}${cr.evidence ? ' — ' + cr.evidence.slice(0, 100) : ''}`),
  quinnResults ? `- **Quinn:** ${quinnResults.verdict}` : '',
  `- **Verdict:** ${verdict}`,
].filter(Boolean).join('\n')

await agent(`
Post this comment to issue #${ISSUE}:
gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body ${JSON.stringify(proofComment)}
`, { label: 'post-comment', phase: 'Output' })

log('Proof comment posted')

// Add proven label + close issue (chain mode only) if PROVEN
if (verdict === 'PROVEN') {
  const chainMode = await agent(`
test -f ${GOAL_RECORD_PATH} && echo "CHAIN" || echo "STANDALONE"
  `, { label: 'chain-check', phase: 'Output' })

  await agent(`
Add the "proven" label to issue #${ISSUE}:
gh issue edit ${ISSUE} --repo ${ISSUE_REPO} --add-label "proven" 2>&1 || echo "label add failed"

${String(chainMode).includes('CHAIN') ? `
Also close the issue (chain mode — goal-record.json exists):
gh issue close ${ISSUE} --repo ${ISSUE_REPO} 2>&1 || echo "close failed"
gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body "Issue closed by /prove — verdict: PROVEN"
` : '# Standalone mode — do NOT close the issue'}
  `, { label: 'label-close', phase: 'Output' })

  log(String(chainMode).includes('CHAIN') ? 'Issue labeled + closed (chain mode)' : 'Issue labeled proven (standalone)')
} else if (verdict === 'UNPROVEN') {
  await agent(`
Post a re-investigation comment:
gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body "Prove verdict: UNPROVEN — issue remains open for re-investigation"
  `, { label: 'unproven-comment', phase: 'Output' })
  log('UNPROVEN — issue remains open')
} else {
  await agent(`
Post an inconclusive comment:
gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body "Prove verdict: INCONCLUSIVE — could not reproduce. Manual investigation needed."
  `, { label: 'inconclusive-comment', phase: 'Output' })
  log('INCONCLUSIVE — manual investigation needed')
}

// Telemetry — agent handles timestamps since workflow sandbox bans Date.now()
await agent(`
Append a telemetry entry to ${HOME}/.claude/MEMORY/LEARNING/SIGNALS/harness-telemetry.jsonl.
Use Bash to echo a single JSON line with: ts (current ISO timestamp), skill: "prove", issue: ${ISSUE}, check: "verdict", result: "${verdict}".
Create the directory if it doesn't exist: mkdir -p ${HOME}/.claude/MEMORY/LEARNING/SIGNALS
`, { label: 'telemetry', phase: 'Output' })

log(`Telemetry logged — prove #${ISSUE}: ${verdict}`)

// Cleanup: stop prove container
await agent(`
Run: cd ${PROJECT_ROOT} && make prove-down 2>&1 || true
Report output.
`, { label: 'prove-container-down', phase: 'Output' })

return {
  status: verdict,
  issue: ISSUE,
  slug: SLUG,
  verdict,
  commitSHA: COMMIT_SHA,
  criteriaResults: allCriteriaResults,
  reproduced: proveEvidence.reproduced,
  quinnVerdict: quinnResults?.verdict || null,
  selfHealIterations: selfHealIteration,
  circuitBroken: selfHealIteration >= MAX_SELF_HEAL_ATTEMPTS && verdict === 'UNPROVEN',
  workDir: WORK_DIR,
}
