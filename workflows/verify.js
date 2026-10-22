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
const SIZE = parsedArgs.size || 'S'

// ──── SHELL-QUOTE-START ────
// Single-quote a shell word. Single quotes are the only shell quoting with
// no interior expansion at all, so a path containing a space, a `$` or a
// backtick all survive. `"${…}"` stops at the space and leaves the rest
// expanding, which is the cheapest wrong fix for #1086 and not accepted.
//
// INLINED, not imported: the workflow sandbox has no require, no dynamic
// import() and no filesystem (#69). `lib/workflow-security.ts` is the
// source of truth; test/workflow-prompt-top-level-cd.test.ts runs every
// copy against the same inputs and fails on any divergence, so changing
// one means changing all of them.
function shellQuote(word) {
  return `'${String(word).replace(/'/g, "'\\''")}'`
}
// ──── SHELL-QUOTE-END ────

// ── #344: four hardcodings, all one consumer's ───────────────────────────
//
// This file was a DailyBriefDashboard script living in the harness. It
// hardcoded that consumer's two ports (`ENV === 'prod' ? '7777' : '7776'`),
// its container name (`pai-dashboard`), its in-container app root (`/app/`),
// its test directory (`test/unit/`) and two of its API routes.
//
// Three of those produce a loud false FAIL for anyone else. The test
// directory produces a false PASS — a `bun test` pointed at a directory that
// does not exist runs zero tests and the agent reports PASS with a count of
// nothing, which is the worst of the four and the quietest.
//
// Everything now comes from the consumer's own config. Each reader states
// what its absence means, and absence never silently becomes a pass: a check
// with nothing to look at reports SKIP with the missing key named, so the
// gap is visible rather than inferred from a green run.
const HARNESS = parsedArgs.harness || {}
const baseFor = (env) => (env === 'prod' ? HARNESS.prod : HARNESS.dev) || {}
const API_BASE = baseFor(ENV).apiBase || null
const UI_BASE = baseFor(ENV).uiBase || null
const CONTAINER = HARNESS.container || {}
const CONTAINER_NAME = CONTAINER.name || null
const CONTAINER_APP_ROOT = CONTAINER.appRoot || null
const SMOKE_ROUTES = Array.isArray(HARNESS.smokeRoutes) ? HARNESS.smokeRoutes : []
const TEST_CMD = (HARNESS.dev && HARNESS.dev.testCmd) || null
const TYPECHECK_CMD = (HARNESS.dev && HARNESS.dev.typeCheck) || 'npx tsc --noEmit'

const skip = (label, why) => () => Promise.resolve({
  verdict: 'SKIP',
  reason: `${why} This is UNMEASURED, not PASS (#344).`,
  findings: [],
})

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
( cd ${shellQuote(PROJECT_ROOT)} && ${TYPECHECK_CMD} ) 2>&1 | tail -20
Report PASS if no errors, FAIL with the error output if errors found.
  `, { label: 'tsc', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA }),

  // The false-PASS one. `bun test --isolate test/unit/` against a project
  // with no `test/unit/` runs nothing and reports PASS with a count of zero.
  TEST_CMD
    ? () => agent(`
Run the unit test suite:
( cd ${shellQuote(PROJECT_ROOT)} && ${TEST_CMD} ) 2>&1 | tail -30
Report PASS with the test count if all pass, FAIL with failing test names.
If the command ran ZERO tests, report FAIL — a suite that matched nothing has
not passed, it has not run.
  `, { label: 'unit-tests', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA })
    : skip('unit-tests', 'The project sets no `dev.testCmd`, so no suite was run.'),

  CONTAINER_NAME && CONTAINER_APP_ROOT
    ? () => agent(`
Verify the running container has current code:
1. podman ps | grep ${CONTAINER_NAME} (check if running)
2. podman inspect ${CONTAINER_NAME} --format '{{.Created}}' (check container age)
3. For changed files, verify they exist in container:
${CHANGED_FILES.slice(0, 5).map(f => `   podman exec ${CONTAINER_NAME} test -f ${CONTAINER_APP_ROOT.replace(/\/+$/, '')}/${f} && echo "OK: ${f}" || echo "MISSING: ${f}"`).join('\n')}
Report PASS if current, FAIL if stale or files missing.
  `, { label: 'container', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA })
    : skip('container', 'The project sets no `container.name` / `container.appRoot`, so container freshness was not checked.'),

  API_BASE && SMOKE_ROUTES.length > 0
    ? () => agent(`
Smoke test critical API endpoints:
${SMOKE_ROUTES.map((r, i) => `${i + 1}. curl -s -w "\\n%{http_code}" ${API_BASE.replace(/\/+$/, '')}${r} | tail -1`).join('\n')}
Report PASS if all return HTTP 200, FAIL if any return 404/500/empty.
  `, { label: 'smoke-test', phase: 'Mechanical', model: 'haiku', schema: VERIFY_RESULT_SCHEMA })
    : skip('smoke-test', `The project sets no ${API_BASE ? '`smokeRoutes`' : `\`${ENV === 'prod' ? 'prod' : 'dev'}.apiBase\``}, so no endpoint was probed.`),
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
API base: ${API_BASE || "(not configured — do not guess one)"}

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
Environment: ${UI_BASE || API_BASE || "(no base URL configured)"}, Playwright project ${ENV === 'prod' ? '--project=ci' : '--project=test'}

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
Read ${PROJECT_ROOT}/ARCHITECTURE.md first (if it exists; many projects have no such file — do not treat its absence as a blocker).

Files changed:
${CHANGED_FILES.map(f => `- ${f}`).join('\n')}

Scope constraints:
- Read-only on production config — NEVER write to .env, credentials, aes.json
- Active probing against ${API_BASE || "(no apiBase configured — do not probe)"} only
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
