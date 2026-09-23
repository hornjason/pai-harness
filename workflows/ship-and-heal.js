export const meta = {
  name: 'ship-and-heal',
  description: 'Closed-loop: ship → RCA on failure → fix → re-ship. Circuit breaker at 3 iterations.',
  whenToUse: 'When shipping an issue that may need harness-level fixes to pass. Self-improving loop.',
  phases: [
    { title: 'Ship', detail: 'Run ship workflow' },
    { title: 'RCA', detail: 'Analyze failure root cause' },
    { title: 'Fix', detail: 'Implement fix for root cause' },
    { title: 'Re-Ship', detail: 'Re-run ship with fix applied' },
  ],
}

const MAX_ITERATIONS = 3

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
const SHIP_ARGS = { ...parsedArgs }

const iterations = []

for (let i = 0; i < MAX_ITERATIONS; i++) {
  const iterLabel = i === 0 ? '' : ` (iteration ${i + 1})`
  phase(i === 0 ? 'Ship' : 'Re-Ship')
  log(`Ship attempt ${i + 1}/${MAX_ITERATIONS}${iterLabel}`)

  const shipResult = await workflow(
    { scriptPath: HARNESS_ROOT + '/workflows/ship.js' },
    SHIP_ARGS
  )

  const status = shipResult?.status || 'UNKNOWN'
  log(`Ship result: ${status}`)

  const FAILURE_STATUSES = ['SHIP_FAILED', 'SCOPE_FAILED', 'VERIFY_FAILED', 'IMPLEMENT_FAILED', 'DISCOVERY_FAILED', 'GOAL_FAILED', 'ARGS_ERROR', 'UNKNOWN']
  const isSuccess = !FAILURE_STATUSES.includes(status) && shipResult?.success !== false
  if (isSuccess) {
    iterations.push({ attempt: i + 1, status, action: 'COMPLETED' })
    return {
      status: 'SHIPPED',
      issue: ISSUE,
      iterations,
      totalAttempts: i + 1,
      finalResult: shipResult,
    }
  }

  const failures = shipResult?.failures || shipResult?.detail?.failures || []
  const failureText = Array.isArray(failures) ? failures.join('\n') : String(failures)

  iterations.push({ attempt: i + 1, status, failures: failureText })

  if (i >= MAX_ITERATIONS - 1) {
    log(`Circuit breaker: ${MAX_ITERATIONS} attempts exhausted`)
    break
  }

  phase('RCA')
  log(`Analyzing failure: ${status}`)

  const workDir = shipResult?.workDir || shipResult?.detail?.workDir || ''

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
   - ENV_ISSUE: environment problem (server not running, port conflict)
   - TEST_REGRESSION: existing tests broke by Marcus's changes
   - CONFIG_MISSING: project config missing required fields
   - UNKNOWN: can't determine
4. Describe the root cause concisely
5. Describe what fix is needed
6. Determine if it's automatically fixable

Be specific — name files, line numbers, exact error messages.
  `, { label: 'rca-' + (i + 1), phase: 'RCA', schema: RCA_SCHEMA })

  if (!rca || !rca.fixable) {
    log(`RCA: ${rca?.failureClass || 'UNKNOWN'} — not auto-fixable: ${rca?.rootCause || 'unknown'}`)
    iterations[iterations.length - 1].rca = rca
    iterations[iterations.length - 1].action = 'NEEDS_HUMAN'
    break
  }

  log(`RCA: ${rca.failureClass} — ${rca.rootCause}`)
  iterations[iterations.length - 1].rca = rca

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
2. Apply the fix
3. Run: cd ${PROJECT_ROOT} && bun test 2>&1 | tail -5
4. If tests pass, commit with message: "fix: ${rca.fixDescription.slice(0, 60)}"
5. Push to main: git push origin main
6. Report success/failure

Do NOT introduce new features. Only fix the specific root cause.
  `, { label: 'fix-' + (i + 1), phase: 'Fix', schema: FIX_SCHEMA })

  if (!fix?.success) {
    log(`Fix failed: ${fix?.summary || 'unknown error'}`)
    iterations[iterations.length - 1].action = 'FIX_FAILED'
    break
  }

  log(`Fix applied: ${fix.summary}`)
  iterations[iterations.length - 1].action = 'FIXED'
  iterations[iterations.length - 1].fix = fix
}

const lastIteration = iterations[iterations.length - 1]
const finalStatus = lastIteration?.action === 'COMPLETED' ? 'SHIPPED' :
  lastIteration?.action === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN' :
  lastIteration?.action === 'FIX_FAILED' ? 'FIX_FAILED' :
  'CIRCUIT_BREAKER'

return {
  status: finalStatus,
  issue: ISSUE,
  iterations,
  totalAttempts: iterations.length,
}
