export const meta = {
  name: 'batch-ship',
  description: 'Parallel issue processing with file-overlap detection and wave-based dispatch',
  whenToUse: 'Ship 2+ GitHub issues in parallel. Detects file overlaps, dispatches in waves, creates PRs.',
  phases: [
    { title: 'Intake', detail: 'Read and size each issue, detect file overlaps' },
    { title: 'Plan', detail: 'Group into waves — parallel if independent, sequential if overlapping' },
    { title: 'Dispatch', detail: 'Wave-based parallel execution (max 4 concurrent)' },
    { title: 'Verify', detail: 'Per-issue Quinn verification for UI changes' },
    { title: 'Report', detail: 'Summarize results, create PRs for successes' },
  ],
}

const SIZING_SCHEMA = {
  type: 'object',
  properties: {
    issueNumber: { type: 'number' },
    size: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    filesToModify: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          evidenceType: { type: 'string' },
        },
        required: ['id', 'description'],
      },
    },
    hasUIChanges: { type: 'boolean' },
    briefSummary: { type: 'string' },
  },
  required: ['issueNumber', 'size', 'filesToModify', 'acceptanceCriteria', 'hasUIChanges'],
}

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    issueNumber: { type: 'number' },
    success: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commitSha: { type: 'string' },
    branch: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    testOutput: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['issueNumber', 'success'],
}

let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs || !parsedArgs.projectRoot || !parsedArgs.issues) {
  return {
    status: 'ARGS_ERROR',
    message: 'Missing required args. Usage: Workflow({ name: "batch-ship", args: { projectRoot: "/path", issues: [{number: 1, title: "...", body: "..."}], environment: "test" } })',
    received: args,
  }
}

const PROJECT_ROOT = parsedArgs.projectRoot
const ISSUES = parsedArgs.issues || []
const ENV = parsedArgs.environment || 'test'
const MAX_CONCURRENT = 4

// ════════════════════════════════════════════════════════════
// PHASE 1: INTAKE — Size each issue and detect overlaps
// ════════════════════════════════════════════════════════════

phase('Intake')
log(`Batch intake: ${ISSUES.length} issues`)

const sizings = await pipeline(
  ISSUES,
  (issue) => agent(`
Read GitHub issue #${issue.number}: "${issue.title}"
${issue.body}

Project root: ${PROJECT_ROOT}
Read ${PROJECT_ROOT}/ARCHITECTURE.md for module context.

Size this issue:
- XS: single file, obvious fix, <30 min
- S: 1-2 files, clear target, <2 hours
- M: 3+ files, crosses boundaries — FLAG for separate handling
- L: too large for batch — FLAG for separate handling

List the SPECIFIC files that will need modification.
Will any .tsx/.svelte/.jsx files change? (hasUIChanges)
Write acceptance criteria (AC-1, AC-2...).
  `, {
    label: `intake:${issue.number}`,
    phase: 'Intake',
    schema: SIZING_SCHEMA,
  })
)

const validSizings = sizings.filter(Boolean)
const batchable = validSizings.filter(s => ['XS', 'S'].includes(s.size))
const tooLarge = validSizings.filter(s => ['M', 'L'].includes(s.size))

if (tooLarge.length > 0) {
  log(`${tooLarge.length} issues too large for batch: ${tooLarge.map(s => `#${s.issueNumber} (${s.size})`).join(', ')}`)
}

log(`${batchable.length} issues eligible for batch processing`)

// ════════════════════════════════════════════════════════════
// PHASE 2: PLAN — Detect overlaps, group into waves
// ════════════════════════════════════════════════════════════

phase('Plan')

// Detect file overlaps between issues
const fileToIssues = {}
for (const sizing of batchable) {
  for (const file of sizing.filesToModify) {
    if (!fileToIssues[file]) fileToIssues[file] = []
    fileToIssues[file].push(sizing.issueNumber)
  }
}

const overlaps = Object.entries(fileToIssues)
  .filter(([, issues]) => issues.length > 1)
  .map(([file, issues]) => ({ file, issues }))

if (overlaps.length > 0) {
  log(`File overlaps detected: ${overlaps.map(o => `${o.file} (issues ${o.issues.join(',')})`).join('; ')}`)
}

// Group into waves: overlapping issues go in separate waves
const waves = []
const assigned = new Set()

for (const sizing of batchable) {
  if (assigned.has(sizing.issueNumber)) continue

  // Find a wave where this issue has no file overlap
  let placed = false
  for (const wave of waves) {
    const waveFiles = new Set(wave.flatMap(s => s.filesToModify))
    const hasOverlap = sizing.filesToModify.some(f => waveFiles.has(f))
    if (!hasOverlap && wave.length < MAX_CONCURRENT) {
      wave.push(sizing)
      assigned.add(sizing.issueNumber)
      placed = true
      break
    }
  }

  if (!placed) {
    waves.push([sizing])
    assigned.add(sizing.issueNumber)
  }
}

log(`Planned ${waves.length} waves: ${waves.map((w, i) => `wave ${i + 1}: ${w.length} issues`).join(', ')}`)

// ════════════════════════════════════════════════════════════
// PHASE 3: DISPATCH — Wave-based parallel execution
// ════════════════════════════════════════════════════════════

phase('Dispatch')

const allResults = []

for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
  const wave = waves[waveIdx]
  log(`Wave ${waveIdx + 1}/${waves.length}: dispatching ${wave.length} agents`)

  const waveResults = await parallel(
    wave.map(sizing => () => agent(`
## Context (read in order)
1. ${PROJECT_ROOT}/CLAUDE.md (if exists)
2. ${PROJECT_ROOT}/PRINCIPLES.md (if exists)
3. ${PROJECT_ROOT}/ARCHITECTURE.md (if exists)

## Task — Issue #${sizing.issueNumber}
${sizing.briefSummary}

## Acceptance Criteria
${sizing.acceptanceCriteria.map(ac => `- ${ac.id}: ${ac.description}`).join('\n')}

## Files — modify ONLY these
${sizing.filesToModify.map(f => `- ${f}`).join('\n')}

## Git protocol
- Branch: ${sizing.issueNumber}-batch-fix
- git fetch origin && git rebase origin/main before committing
- Commit ALL changes before reporting
- Push with -u before reporting
- Never commit to main

## Development
- Write regression test FIRST (red), then implement (green)
- Run tsc --noEmit after changes
- Run bun test --isolate test/unit/

## Report
- issueNumber, success (boolean), filesChanged, commitSha, branch
- Evidence for each AC
    `, {
      label: `build:${sizing.issueNumber}`,
      phase: 'Dispatch',
      agentType: 'Engineer',
      ...((PROJECT_ROOT.includes('/.claude/') || PROJECT_ROOT.includes('/rungate/')) && !PROJECT_ROOT.includes('/Projects/') ? { isolation: 'worktree' } : {}),
      schema: BUILD_RESULT_SCHEMA,
    }))
  )

  allResults.push(...waveResults.map((r, i) => r || { issueNumber: wave[i].issueNumber, success: false, error: 'Agent returned null' }))
  log(`Wave ${waveIdx + 1} complete: ${waveResults.filter(r => r && r.success).length}/${wave.length} succeeded`)
}

const succeeded = allResults.filter(r => r.success)
const failed = allResults.filter(r => !r.success)

log(`Build complete: ${succeeded.length} succeeded, ${failed.length} failed`)

// ════════════════════════════════════════════════════════════
// PHASE 4: VERIFY — Quinn for UI changes
// ════════════════════════════════════════════════════════════

phase('Verify')

const uiIssues = succeeded.filter(r => {
  const sizing = batchable.find(s => s.issueNumber === r.issueNumber)
  return sizing && sizing.hasUIChanges
})

let quinnResults = []
if (uiIssues.length > 0) {
  log(`Running Quinn verification for ${uiIssues.length} UI-changing issues`)
  quinnResults = await parallel(
    uiIssues.map(result => () => agent(`
## QA Verification
Port: ${ENV === 'prod' ? '7777' : '7776'}
Playwright project: ${ENV === 'prod' ? '--project=ci' : '--project=test'}

Test changes from issue #${result.issueNumber}.
Files changed: ${(result.filesChanged || []).join(', ')}

Test as brand new user. Report PASS or FAIL with evidence.
    `, {
      label: `quinn:${result.issueNumber}`,
      phase: 'Verify',
      agentType: 'QATester',
      schema: {
        type: 'object',
        properties: {
          issueNumber: { type: 'number' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
          findings: { type: 'array', items: { type: 'string' } },
        },
        required: ['verdict'],
      },
    }))
  )
} else {
  log('No UI changes — skipping Quinn')
}

// ════════════════════════════════════════════════════════════
// PHASE 5: REPORT
// ════════════════════════════════════════════════════════════

phase('Report')

log(`Final report: ${succeeded.length} shipped, ${failed.length} failed, ${tooLarge.length} deferred`)

return {
  totalIssues: ISSUES.length,
  batchProcessed: batchable.length,
  deferredToShip: tooLarge.map(s => ({ number: s.issueNumber, size: s.size })),
  waves: waves.length,
  results: {
    succeeded: succeeded.map(r => ({
      issue: r.issueNumber,
      branch: r.branch,
      commit: r.commitSha,
      filesChanged: r.filesChanged,
    })),
    failed: failed.map(r => ({
      issue: r.issueNumber,
      error: r.error || 'Unknown failure',
    })),
  },
  quinn: quinnResults.filter(Boolean),
  overlapsDetected: overlaps,
}
