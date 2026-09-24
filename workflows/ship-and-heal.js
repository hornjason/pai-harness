export const meta = {
  name: 'ship-and-heal',
  description: 'Ship → RCA on failure → fix → re-verify. One ship + one heal cycle max.',
  whenToUse: 'Ship an issue with automatic failure recovery. Falls back to human on unfixable errors.',
  phases: [
    { title: 'Ship', detail: 'Run ship workflow' },
    { title: 'RCA', detail: 'Analyze failure root cause' },
    { title: 'Fix', detail: 'Implement fix for root cause' },
    { title: 'Re-Verify', detail: 'Verify fix passes tests and gates' },
  ],
}

const RCA_SCHEMA = {
  type: 'object',
  properties: {
    failureClass: { type: 'string', enum: ['HARNESS_BUG', 'CODE_BUG', 'ENV_ISSUE', 'TEST_REGRESSION', 'CONFIG_MISSING', 'UNKNOWN'] },
    rootCause: { type: 'string' },
    affectedFiles: { type: 'array', items: { type: 'string' } },
    fixDescription: { type: 'string' },
    fixable: { type: 'boolean' },
    needsHumanReview: { type: 'boolean' },
  },
  required: ['failureClass', 'rootCause', 'fixDescription', 'fixable'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['success', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    testsPass: { type: 'boolean' },
    testCount: { type: 'number' },
    failCount: { type: 'number' },
    gateResult: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['testsPass', 'summary'],
}

let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs.issue || !parsedArgs.projectRoot || !parsedArgs.harnessRoot) {
  return { status: 'ARGS_ERROR', message: 'Required: issue, projectRoot, harnessRoot' }
}

const ISSUE = parsedArgs.issue
const PROJECT_ROOT = parsedArgs.projectRoot
const HARNESS_ROOT = parsedArgs.harnessRoot
const ISSUE_REPO = parsedArgs.issueRepo || parsedArgs.repo || 'hornjason/pai-config'

// Read test config
const testConfig = await agent(`
Read ${PROJECT_ROOT}/.claude/rungate.json and return the test section.
If no test section or file doesn't exist, return command: "bun test", timeout: 120000.
`, { label: 'test-config', schema: {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeout: { type: 'number' },
  },
  required: ['command', 'timeout'],
}})
const testCommand = testConfig?.command || 'bun test'
const testTimeout = testConfig?.timeout || 120000

// ════════════════════════════════════════════════════════════
// PHASE 1: SHIP — run full ship workflow (single workflow() call)
// ════════════════════════════════════════════════════════════

phase('Ship')
log(`Shipping #${ISSUE} through harness`)

// Try workflow() first; fall back to agent() if nesting limit hit (#576)
let shipResult = null
try {
  shipResult = await workflow(
    { scriptPath: HARNESS_ROOT + '/workflows/ship.js' },
    { ...parsedArgs }
  )
} catch (nestingError) {
  if (String(nestingError).includes('nesting')) {
    log('Workflow nesting limit hit — falling back to direct ship via agent()')
    shipResult = await agent(`
Run the ship workflow for issue #${ISSUE}:
1. cd ${PROJECT_ROOT}
2. Read ${HARNESS_ROOT}/workflows/ship.js to understand the flow
3. Execute the ship lifecycle: GOAL → DISCOVERY → SCOPE → IMPLEMENT → VERIFY → SHIP
4. Use the project at ${PROJECT_ROOT} with harness at ${HARNESS_ROOT}
5. Issue repo: ${ISSUE_REPO}
6. Report the final status and any failures

This is a fallback because workflow nesting was not available.
`, { label: 'ship-fallback', phase: 'Ship', schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        issue: { type: 'number' },
        slug: { type: 'string' },
        workDir: { type: 'string' },
      },
      required: ['status']
    }})
  } else {
    throw nestingError
  }
}

const status = shipResult?.status || 'UNKNOWN'
log(`Ship result: ${status}`)

const FAILURE_STATUSES = ['SHIP_FAILED', 'SCOPE_FAILED', 'VERIFY_FAILED', 'IMPLEMENT_FAILED', 'DISCOVERY_FAILED', 'GOAL_FAILED', 'ARGS_ERROR', 'UNKNOWN']
const isSuccess = !FAILURE_STATUSES.includes(status) && shipResult?.success !== false

if (isSuccess) {
  return {
    status: 'SHIPPED',
    issue: ISSUE,
    shipResult,
    healed: false,
  }
}

// ════════════════════════════════════════════════════════════
// PHASE 2: RCA — analyze why ship failed
// ════════════════════════════════════════════════════════════

phase('RCA')

const failures = shipResult?.failures || shipResult?.detail?.failures || []
const failureText = Array.isArray(failures) ? failures.join('\n') : String(failures)
const workDir = shipResult?.workDir || shipResult?.detail?.workDir || ''

log(`Ship failed: ${status}. Analyzing root cause.`)

const rca = await agent(`
You are a root cause analyst for a ship workflow failure.

## Failure Context
- Issue: #${ISSUE}
- Status: ${status}
- Work directory: ${workDir}
- Failures: ${failureText}

## Your Task
1. Read the workflow-state.json at ${workDir}/workflow-state.json if it exists
2. Analyze the failure messages
3. Classify the failure:
   - HARNESS_BUG: the ship workflow itself has a bug (wrong prompts, missing config reads, etc.)
   - CODE_BUG: Marcus wrote code that doesn't work (test failures, logic errors)
   - ENV_ISSUE: environment problem (server not running, port conflict, DNS)
   - TEST_REGRESSION: existing tests broke by Marcus's changes
   - CONFIG_MISSING: project config missing required fields
   - UNKNOWN: can't determine
4. Describe the root cause concisely
5. Describe what fix is needed
6. Determine if it's automatically fixable
7. For HARNESS_BUG: include BOTH the instance fix (workflow-state.json) AND the generator fix (ship.js or gates/) in affectedFiles. Fixing only workflow-state.json patches the symptom — the same bug will recur on next ship.

Be specific — name files, line numbers, exact error messages.
`, { label: 'rca', phase: 'RCA', schema: RCA_SCHEMA })

if (!rca || !rca.fixable) {
  log(`RCA: ${rca?.failureClass || 'UNKNOWN'} — not auto-fixable: ${rca?.rootCause || 'unknown'}`)
  return {
    status: 'NEEDS_HUMAN',
    issue: ISSUE,
    shipResult,
    rca,
    healed: false,
  }
}

log(`RCA: ${rca.failureClass} — ${rca.rootCause}`)

// ════════════════════════════════════════════════════════════
// PHASE 3: FIX — apply the fix
// ════════════════════════════════════════════════════════════

phase('Fix')
log(`Applying fix: ${rca.fixDescription}`)

const fix = await agent(`
You are a fix engineer. Apply this fix to the codebase.

## Root Cause
${rca.rootCause}

## Fix Required
${rca.fixDescription}

## Affected Files
${(rca.affectedFiles || []).join('\n') || 'Determine from root cause'}

## Instructions
1. Read the affected files
2. Apply the fix — for HARNESS_BUG fixes, patch BOTH:
   a. The instance (workflow-state.json) so this run passes
   b. The generator (ship.js, gates/*.ts) so future runs don't hit the same bug
3. Run: cd ${PROJECT_ROOT} && ${testCommand} 2>&1 | tail -10
   Set the Bash tool's timeout parameter to ${testTimeout}. Do NOT use the shell 'timeout' command.
4. If tests pass, commit with message: "fix: ${rca.fixDescription.slice(0, 60)}"
5. Push to main: git push origin main
6. Report success/failure — list instance fixes AND generator fixes separately

Do NOT introduce new features. Only fix the specific root cause.
`, { label: 'fix', phase: 'Fix', schema: FIX_SCHEMA })

if (!fix?.success) {
  log(`Fix failed: ${fix?.summary || 'unknown error'}`)
  return {
    status: 'FIX_FAILED',
    issue: ISSUE,
    shipResult,
    rca,
    fix,
    healed: false,
  }
}

log(`Fix applied: ${fix.summary}`)

// ════════════════════════════════════════════════════════════
// PHASE 4: RE-VERIFY — lightweight check that fix works
// Uses agent() not workflow() to avoid nesting limitation
// ════════════════════════════════════════════════════════════

phase('Re-Verify')
log('Re-verifying after fix — running tests and gates')

const verify = await agent(`
Verify the fix for issue #${ISSUE} after the heal cycle.

1. Run the test suite:
   cd ${PROJECT_ROOT} && ${testCommand} 2>&1 | tail -10
   Set the Bash tool's timeout parameter to ${testTimeout}. Do NOT use the shell 'timeout' command.

2. Run the ship gate to verify it passes now:
   cd ${PROJECT_ROOT} && TEST_WORK_DIR="${workDir}" bun ${HARNESS_ROOT}/gates/run-gate.ts ship ${workDir}/workflow-state.json 2>&1 | tail -20
   Set timeout to ${testTimeout}.

3. Report:
   - testsPass: true/false
   - testCount and failCount from test output
   - gateResult: the gate's PASS/FAIL output
   - summary: one sentence

If both tests pass AND gate passes, the fix worked.
`, { label: 're-verify', phase: 'Re-Verify', schema: VERIFY_SCHEMA })

const healed = verify?.testsPass === true
log(`Re-verify: ${healed ? 'PASS' : 'FAIL'} — ${verify?.summary || 'no summary'}`)

return {
  status: healed ? 'HEALED' : 'VERIFY_FAILED',
  issue: ISSUE,
  shipResult,
  rca,
  fix,
  verify,
  healed,
}
