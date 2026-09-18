export const meta = {
  name: 'verify',
  description: 'Parallel verification gate: mechanical checks + evidence + Quinn + Rook',
  whenToUse: 'After any code change to verify correctness before merge. Called by ship workflow or standalone.',
  phases: [
    { title: 'Mechanical', detail: 'TypeScript, tests, container freshness, API smoke test' },
    { title: 'Evidence', detail: 'Collect evidence for each acceptance criterion' },
    { title: 'Agents', detail: 'Quinn UI validation + Rook security review in parallel' },
  ],
}

const VERIFY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
    findings: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    acId: { type: 'string' },
    collected: { type: 'boolean' },
    evidenceType: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['acId', 'collected', 'detail'],
}

let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs || !parsedArgs.projectRoot) {
  return {
    status: 'ARGS_ERROR',
    message: 'Missing required args. Usage: Workflow({ name: "verify", args: { projectRoot: "/path", changedFiles: ["src/foo.ts"], acceptanceCriteria: [...], size: "S", environment: "test" } })',
    received: args,
  }
}

const PROJECT_ROOT = parsedArgs.projectRoot
const ACS = parsedArgs.acceptanceCriteria || []
const CHANGED_FILES = parsedArgs.changedFiles || []
const DECLARED_SCOPE = parsedArgs.declaredScope || []
const ENV = parsedArgs.environment || 'test'
const PORT = ENV === 'prod' ? '7777' : '7776'
const SIZE = parsedArgs.size || 'S'

// ════════════════════════════════════════════════════════════
// PHASE 0: FILE-SCOPE VALIDATION (fail-fast gate)
// ════════════════════════════════════════════════════════════

if (DECLARED_SCOPE.length > 0 && CHANGED_FILES.length > 0) {
  const outOfScope = CHANGED_FILES.filter(f => !DECLARED_SCOPE.some(s => f.includes(s)))
  if (outOfScope.length > 0) {
    log(`SCOPE VIOLATION: ${outOfScope.length} file(s) modified outside declared scope`)
    return {
      status: 'FAIL',
      phase: 'scope-validation',
      message: `File-scope violation: ${outOfScope.length} file(s) modified outside declared scope. Update the issue's "Files to modify" section to include these files, then re-run verification.`,
      outOfScopeFiles: outOfScope,
      declaredScope: DECLARED_SCOPE,
    }
  }
  log(`Scope check passed: ${CHANGED_FILES.length} file(s) all within declared scope`)
}

// ════════════════════════════════════════════════════════════
// PHASE 1: MECHANICAL CHECKS (all parallel)
// ════════════════════════════════════════════════════════════

phase('Mechanical')
log('Running mechanical verification: tsc + tests + container + smoke')

const mechanical = await parallel([
  () => agent(`
Run TypeScript type checking on the project:
cd ${PROJECT_ROOT} && npx tsc --noEmit 2>&1 | tail -20
Report PASS if no errors, FAIL with the error output if errors found.
  `, { label: 'tsc', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA }),

  () => agent(`
Run the unit test suite:
cd ${PROJECT_ROOT} && bun test --isolate test/unit/ 2>&1 | tail -30
Report PASS with test count if all pass, FAIL with failing test names.
  `, { label: 'unit-tests', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA }),

  () => agent(`
Verify the running container has current code:
1. podman ps | grep pai-dashboard (check if running)
2. podman inspect pai-dashboard --format '{{.Created}}' (check container age)
3. For changed files, verify they exist in container:
${CHANGED_FILES.slice(0, 5).map(f => `   podman exec pai-dashboard test -f /app/${f} && echo "OK: ${f}" || echo "MISSING: ${f}"`).join('\n')}
Report PASS if current, FAIL if stale or files missing.
  `, { label: 'container', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA }),

  () => agent(`
Smoke test critical API endpoints:
1. curl -s -w "\\n%{http_code}" http://localhost:${PORT}/api/aes | tail -1
2. curl -s -w "\\n%{http_code}" http://localhost:${PORT}/api/action-triggers | tail -1
Report PASS if all return HTTP 200, FAIL if any return 404/500/empty.
  `, { label: 'smoke-test', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA }),
])

const [tsc, tests, container, smoke] = mechanical

log(`tsc: ${tsc?.verdict} | tests: ${tests?.verdict} | container: ${container?.verdict} | smoke: ${smoke?.verdict}`)

const mechanicalFailed = mechanical.filter(Boolean).some(r => r.verdict === 'FAIL')
if (mechanicalFailed) {
  log('MECHANICAL CHECKS FAILED — stopping before agent verification')
  return {
    status: 'MECHANICAL_FAILED',
    tsc: tsc,
    tests: tests,
    container: container,
    smoke: smoke,
    message: 'Fix mechanical failures before running Quinn/Rook.',
  }
}

// ════════════════════════════════════════════════════════════
// PHASE 2: EVIDENCE COLLECTION (pipeline over ACs)
// ════════════════════════════════════════════════════════════

phase('Evidence')

let evidence = []
if (ACS.length > 0) {
  log(`Collecting evidence for ${ACS.length} acceptance criteria`)
  evidence = await pipeline(
    ACS,
    ac => agent(`
Collect evidence for acceptance criterion: ${ac.id} — ${ac.description}
Evidence type required: ${ac.evidenceType}

Instructions by evidence type:
- code: Read the specific file and line, confirm the expected code exists
- grep: Run grep for the expected pattern, report match count
- screenshot: Take a Playwright screenshot of the relevant UI
- api: curl the relevant endpoint and show the response
- test: Run the specific test and confirm it passes

Project root: ${PROJECT_ROOT}
Port: ${PORT}

Return whether evidence was successfully collected and the detail.
    `, { label: `evidence:${ac.id}`, phase: 'Evidence', model: 'haiku', schema: EVIDENCE_SCHEMA })
  )
  log(`Evidence collected for ${evidence.filter(Boolean).filter(e => e.collected).length}/${ACS.length} ACs`)
}

// ════════════════════════════════════════════════════════════
// PHASE 3: AGENT VERIFICATION (Quinn + Rook parallel)
// ════════════════════════════════════════════════════════════

phase('Agents')

const hasUIChanges = CHANGED_FILES.some(f => f.endsWith('.tsx') || f.endsWith('.svelte') || f.endsWith('.jsx'))
const needsRook = ['M', 'L'].includes(SIZE)

log(`Agent verification: Quinn=${hasUIChanges ? 'YES' : 'SKIP'} Rook=${needsRook ? 'YES' : 'SKIP'}`)

const agentResults = await parallel([
  () => hasUIChanges
    ? agent(`
## QA Verification
Environment: port ${PORT}, Playwright project ${ENV === 'prod' ? '--project=ci' : '--project=test'}

Test as a BRAND NEW USER who has never seen this dashboard:
- Every section understandable within 30 seconds?
- Headings in plain language? No dev jargon?
- Helpful empty states? (not just blank)
- All interactive elements functional? (click each one)
- Labels consistent? ("Save Changes" everywhere, not mixed)

Changed files: ${CHANGED_FILES.filter(f => f.endsWith('.tsx') || f.endsWith('.svelte')).join(', ')}

Acceptance criteria:
${ACS.map(ac => `- ${ac.id}: ${ac.description}`).join('\n')}

Report PASS or FAIL per AC with evidence (screenshots, Playwright output).
    `, { label: 'quinn', phase: 'Agents', agentType: 'QATester', schema: VERIFY_RESULT_SCHEMA })
    : Promise.resolve({ verdict: 'SKIP', reason: 'No UI files in changed set', findings: [] }),

  () => needsRook
    ? agent(`
## Security Review
Read ${PROJECT_ROOT}/ARCHITECTURE.md first.

Files changed:
${CHANGED_FILES.map(f => `- ${f}`).join('\n')}

Scope constraints:
- Read-only on production config — NEVER write to .env, credentials, aes.json
- Active probing on port ${PORT} only
- Do not trigger bootstrap, wipe, or reset flows

Check for: injection vulnerabilities, credential exposure, path traversal, XSS, missing input validation.
Also scan pattern siblings (similar files in same directory).

Report: PASS (safe to commit) or BLOCK (must fix first) with findings per file.
    `, { label: 'rook', phase: 'Agents', agentType: 'Pentester', schema: VERIFY_RESULT_SCHEMA })
    : Promise.resolve({ verdict: 'SKIP', reason: 'Size does not require security review', findings: [] }),
])

const [quinn, rook] = agentResults

log(`Quinn: ${quinn?.verdict} | Rook: ${rook?.verdict}`)

const allPassed = ![tsc, tests, container, smoke, quinn, rook]
  .filter(Boolean)
  .some(r => r.verdict === 'FAIL')

// #27 — Log verify results to signals for learning loop feedback
const verifyResult = {
  status: allPassed ? 'ALL_PASSED' : 'SOME_FAILED',
  mechanical: { tsc: tsc?.verdict, tests: tests?.verdict, container: container?.verdict, smoke: smoke?.verdict },
  agents: { quinn: quinn?.verdict, rook: rook?.verdict },
  allPassed: allPassed,
  acCount: ACS.length,
  acPassed: evidence.filter(Boolean).filter(e => e.collected).length,
}

return {
  status: allPassed ? 'ALL_PASSED' : 'SOME_FAILED',
  mechanical: { tsc: tsc, tests: tests, container: container, smoke: smoke },
  evidence: evidence.filter(Boolean),
  agents: { quinn: quinn, rook: rook },
  allPassed: allPassed,
}
