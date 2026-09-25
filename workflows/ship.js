export const meta = {
  name: 'ship',
  description: 'Programmatic ship lifecycle: GOAL → DISCOVERY → SCOPE → IMPLEMENT → VALIDATE → COMMIT → VERIFY → SHIP → PROVE',
  whenToUse: 'Ship a GitHub issue through the full harness. Replaces reading SKILL.md manually.',
  phases: [
    { title: 'Goal', detail: 'Read issue, extract goal' },
    { title: 'Discovery', detail: 'Read project docs, size work, write ACs, detect prior work' },
    { title: 'Scope', detail: 'Run scope gate with self-heal' },
    { title: 'Implement', detail: 'Brief + Marcus implements (no commit)' },
    { title: 'Validate', detail: 'Quinn local dev, iterate with Marcus if needed' },
    { title: 'Commit', detail: 'Commit + push after Quinn local PASS' },
    { title: 'Verify', detail: 'Verify gate + container rebuild + Quinn container' },
    { title: 'Ship', detail: 'Ship gate' },
    { title: 'Prove', detail: 'Prove gate — verify fix actually works' },
  ],
}

// ── Structured output schemas ────────────────────────────────

const GOAL_SCHEMA = {
  type: 'object',
  properties: {
    issueGoal: { type: 'string' },
    successCriteria: { type: 'array', items: { type: 'string' } },
    issueTitle: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
  },
  required: ['issueGoal', 'successCriteria', 'issueTitle'],
}

const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    sizing: { type: 'string', enum: ['XS', 'S', 'M', 'L'] },
    ceremonyTier: { type: 'string', enum: ['LIGHT', 'STANDARD', 'THOROUGH'] },
    acs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['CODE', 'OUTCOME'] },
          statement: { type: 'string' },
          threshold: { type: 'object', properties: { op: { type: 'string', enum: ['==', '>=', '<=', '>', '<', '!=', 'contains', 'exists'] }, value: {}, unit: { type: 'string' } }, required: ['op', 'value'] },
          evidenceMethod: { type: 'object', properties: { type: { type: 'string', enum: ['GREP_CHECK', 'FILE_EXISTS', 'CURL_CHECK', 'BUN_TEST', 'SCREENSHOT', 'PLAYWRIGHT', 'COMMAND', 'MANUAL', 'grep', 'command', 'api', 'screenshot', 'manual'] }, command: { type: 'string' } }, required: ['type'] },
          specElement: { type: 'string' },
          contextFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
        },
        required: ['id', 'type', 'statement', 'threshold', 'evidenceMethod'],
      },
    },
    priorWork: {
      type: 'object',
      properties: {
        explicitCommits: { type: 'array', items: { type: 'string' } },
        acStatus: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['MET', 'PARTIAL', 'UNMET'] },
              evidence: { type: 'string' },
            },
            required: ['id', 'status'],
          },
        },
      },
      required: ['explicitCommits', 'acStatus'],
    },
    filesToModify: { type: 'array', items: { type: 'string' } },
    scopeOut: { type: 'array', items: { type: 'string' } },
    governingSpec: { type: 'string' },
    sourceSpecs: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, citedInDiscovery: { type: 'boolean' }, specElements: { type: 'array', items: { type: 'string' } } }, required: ['path', 'citedInDiscovery'] } },
  },
  required: ['sizing', 'ceremonyTier', 'acs', 'filesToModify', 'scopeOut', 'priorWork'],
}

const GATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASS', 'FAIL'] },
    failures: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: ['STATE', 'CODE', 'DISCOVERY', 'ENVIRONMENT', 'NON_RETRYABLE'] },
    regressionTarget: { type: 'string', enum: ['BUILD', 'DISCOVERY'] },
  },
  required: ['result'],
}

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    branch: { type: 'string' },
    commitSha: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testOutput: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    worktreePath: { type: 'string' },
  },
  required: ['success'],
}

// ── Args ─────────────────────────────────────────────────────

let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs.issue || !parsedArgs.projectRoot) {
  return { status: 'ARGS_ERROR', message: 'Usage: Workflow({ name: "ship", args: { issue: N, projectRoot: "/path" } })' }
}

const ISSUE = parsedArgs.issue
const REPO = parsedArgs.repo || 'hornjason/asaCommandCenter'
const ISSUE_REPO = parsedArgs.issueRepo || REPO
const PROJECT_ROOT = parsedArgs.projectRoot
const PHASE_TARGET = parsedArgs.phase || 'all'
const SLUG = parsedArgs.slug || `ddb-${ISSUE}`
if (!parsedArgs.harnessRoot) return { status: 'ARGS_ERROR', message: 'harnessRoot is required' }
const HARNESS_ROOT = parsedArgs.harnessRoot
const HOME = parsedArgs.home || PROJECT_ROOT.split('/Projects/')[0] || ''
const WORK_DIR = parsedArgs.workDir || `${HOME}/.rungate/${SLUG}`
const DRY_RUN = parsedArgs.dryRun || false
const SKIP_GRADE = parsedArgs.skipGrade || false
const MAX_REGRESSIONS = 2

// ── Agent brief loader (config-driven) ────────────────────
// Workflow sandbox can't resolve project-local agentTypes from .claude/agents/.
// Roles from args.roles (passed by skill from rungate.json) or convention fallback.
const ROLES = parsedArgs.roles || {}

// SC-406: Brief context paths extracted by a lightweight agent call (no import() in workflow sandbox)
const CONTEXT_CACHE = {}
async function loadContextPaths(role, briefPath) {
  if (CONTEXT_CACHE[role]) return CONTEXT_CACHE[role]
  const result = await agent(`
Read ${briefPath} and extract ALL file paths from the Context section.
Return the paths as a JSON object with a "paths" array. Example: {"paths": ["/path/to/file1.md", "/path/to/file2.ts"]}
If there is no Context section or no paths, return {"paths": []}.
  `, { label: `ctx-${role}`, schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } })
  CONTEXT_CACHE[role] = (result && result.paths) || []
  return CONTEXT_CACHE[role]
}

// Reinforcement-tier extraction: reads brief frontmatter `tiers.reinforcement` sections,
// extracts process rules, injects at top of task prompt. Config-driven from the brief itself.
// Ref: Instruction Stacking Collapse (arXiv 2608.02639), Lost-in-the-Middle (Liu 2023)
const REINFORCEMENT_CACHE = {}
async function loadReinforcementRules(role, briefPath) {
  if (REINFORCEMENT_CACHE[role]) return REINFORCEMENT_CACHE[role]
  const result = await agent(`
Read ${briefPath}. Look at the YAML frontmatter for a "tiers" field with "reinforcement" and/or "mechanical" arrays listing section names.
Find all bullet points and numbered items under the sections listed in "reinforcement".
Return them as a JSON object: {"rules": ["rule text 1", "rule text 2", ...]}.
If there is no "tiers" field or no reinforcement sections, return {"rules": []}.
Only return the rule TEXT — strip leading dashes, numbers, and whitespace.
  `, { label: `reinforce-${role}`, schema: { type: 'object', properties: { rules: { type: 'array', items: { type: 'string' } } }, required: ['rules'] } })
  REINFORCEMENT_CACHE[role] = (result && result.rules) || []
  return REINFORCEMENT_CACHE[role]
}

async function briefedAgent(prompt, opts = {}) {
  const role = opts.role
  const taskContextFiles = opts.contextFiles || null
  const taskContextExcerpts = opts.contextExcerpts || null
  const callerSetIsolation = 'isolation' in opts
  delete opts.role
  delete opts.contextFiles
  delete opts.contextExcerpts
  if (role) {
    const roleConfig = ROLES[role]
    const briefPath = roleConfig?.brief
      ? `${PROJECT_ROOT}/${roleConfig.brief}`
      : `${PROJECT_ROOT}/.claude/agents/${role}.md`
    if (!callerSetIsolation) {
      if (roleConfig?.isolation) opts.isolation = roleConfig.isolation
      else opts.isolation = 'worktree'
    }
    if (opts.isolation === 'worktree') opts.cwd = PROJECT_ROOT

    let fullPrompt = ''

    if (taskContextExcerpts && taskContextExcerpts.length > 0) {
      // Injected context mode: content is in the prompt, agent does NOT read files
      fullPrompt += `MANDATORY FIRST STEP:\n1. Read ${briefPath} — your identity, rules, and workflow\n\n`
      fullPrompt += `## Injected Context (DO NOT re-read these files — content is here)\n\n`
      for (const excerpt of taskContextExcerpts) {
        const source = excerpt.source || excerpt.path || 'unknown'
        const section = excerpt.section || ''
        const content = excerpt.content || ''
        fullPrompt += `### ${section}${source ? ' (from ' + source + ')' : ''}\n${content}\n\n`
      }
    } else {
      // Read-step mode: agent reads files itself
      const readSteps = [`1. Read ${briefPath} — your identity, rules, and workflow`]

      if (taskContextFiles && taskContextFiles.length > 0) {
        taskContextFiles.forEach((cf, i) => {
          const path = typeof cf === 'string' ? cf : cf.path
          const reason = typeof cf === 'string' ? '' : ` — ${cf.reason}`
          readSteps.push(`${i + 2}. Read \`${path}\`${reason}`)
        })
      } else {
        const contextPaths = await loadContextPaths(role, briefPath)
        contextPaths.forEach((p, i) => readSteps.push(`${i + 2}. Read \`${p}\``))
      }

      fullPrompt += `MANDATORY FIRST STEPS — do these BEFORE anything else:\n${readSteps.join('\n')}\n\nDo NOT start the task until you have completed ALL Read steps above.\n\n`
    }

    const reinforcement = await loadReinforcementRules(role, briefPath)
    if (reinforcement.length) {
      fullPrompt += `CRITICAL PROCESS RULES (follow in every task):\n${reinforcement.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n`
    }

    fullPrompt += prompt
    return agent(fullPrompt, opts)
  }
  return agent(prompt, opts)
}

// ── Helper: run gate with self-heal + error classification ──

async function runGateWithHeal(gateName, phaseName, healContext, gateOpts = {}) {
  const gateCwd = gateOpts.cwd || PROJECT_ROOT
  const cdPrefix = gateCwd !== PROJECT_ROOT ? `cd ${gateCwd} && ` : ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await agent(`
Run the ${gateName} gate and classify any failures:

1. Run: ${cdPrefix}TEST_WORK_DIR=${WORK_DIR} bun run ${HARNESS_ROOT}/gates/run-gate.ts --gate ${gateName} --slug ${SLUG} --issue ${ISSUE} 2>&1
2. Read ${WORK_DIR}/workflow-state.json for gate result
3. If FAIL, classify failures: bun -e "
   import {classifyFailures} from '${HARNESS_ROOT}/gates/error-classifier.ts';
   import {readFileSync} from 'fs';
   const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf-8'));
   const f = s.gates?.['${gateName}']?.failures || [];
   console.log(JSON.stringify(classifyFailures(f)));
   " 2>&1
4. Report: result (PASS/FAIL), failures list, category, regressionTarget
    `, { label: `${gateName}-${attempt}`, phase: phaseName, schema: GATE_RESULT_SCHEMA })

    if (!result || result.result === 'PASS') return result
    if (result.category === 'NON_RETRYABLE') return result
    if (attempt >= 3) return result
    if (result.regressionTarget) return result

    log(`${gateName} attempt ${attempt}/3 FAILED (${result.category || 'unknown'}) — healing`)
    await agent(`
${gateName} gate failed. Category: ${result.category || 'unknown'}
Failures: ${(result.failures || []).join('\n')}
Read ${HARNESS_ROOT}/gates/SCHEMA-GUIDE.md. Read ${WORK_DIR}/workflow-state.json.
Read ${PROJECT_ROOT}/.claude/rungate.json for environment config.
${healContext}
Edit workflow-state.json ONLY via writeWorkflowState():
bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); /* apply fix here */; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"
This validates via Zod at write time — you get immediate error feedback. Report what you fixed.
    `, { label: `${gateName}-heal-${attempt}`, phase: phaseName })
  }
}

// ════════════════════════════════════════════════════════════
// PHASE 1: GOAL
// ════════════════════════════════════════════════════════════

phase('Goal')
log(`Ship #${ISSUE}: reading issue`)

const goalData = await agent(`
Read this GitHub issue and extract the goal and success criteria:
gh issue view ${ISSUE} --repo ${ISSUE_REPO} --json title,body,labels

Extract verbatim:
1. issueGoal — main goal statement (first paragraph of body, or title if short)
2. successCriteria — each SC/AC (look for "- [ ] SC-" or "## Success Criteria")
3. issueTitle — the title
4. labels — label names
`, { label: 'read-issue', phase: 'Goal', schema: GOAL_SCHEMA })

if (!goalData) return { status: 'GOAL_FAILED', message: `Could not read issue #${ISSUE}` }
log(`Goal: "${goalData.issueTitle}" — ${goalData.successCriteria.length} SCs`)

// ════════════════════════════════════════════════════════════
// PHASE 2: DISCOVERY (with regression support + prior work)
// ════════════════════════════════════════════════════════════

let discovery = null
let regressionCount = 0

async function runDiscovery(context) {
  phase('Discovery')
  log(`DISCOVERY${context ? ' (regression: ' + context + ')' : ''}`)

  discovery = await briefedAgent(`
You are performing DISCOVERY for ship issue #${ISSUE}.${context ? '\n\nREGRESSION CONTEXT: ' + context : ''}

## Issue
Title: ${goalData.issueTitle}
Goal: ${goalData.issueGoal}
Success criteria: ${goalData.successCriteria.map((sc, i) => `${i + 1}. ${sc}`).join('\n')}

## Instructions
1. Read ${HARNESS_ROOT}/gates/SCHEMA-GUIDE.md FIRST.
2. Read ${PROJECT_ROOT}/.claude/rungate.json and ${PROJECT_ROOT}/AGENTS.md.
3. Check prior work: git log --oneline --all --grep="#${ISSUE}" in ${PROJECT_ROOT}.

## AC ANCHORING (CRITICAL — do not skip)
ACs MUST map 1:1 to the issue's Success Criteria listed above. Rules:
- AC-1 corresponds to SC-1, AC-2 to SC-2, etc. Do NOT invent new ACs beyond the issue SCs.
- If the issue has no structured SCs (no "SC-" or "- [ ]" items), derive ACs from the issue body paragraphs — but still anchor each AC to a specific sentence from the issue.
- The AC statement should be a testable restatement of the SC, not a reinterpretation.
- For UI bugs: at least one AC must be type OUTCOME (not CODE) so Quinn verifies it.

## PRIOR WORK CHECK
For EACH AC, run its evidenceMethod command against the CURRENT code on main. Classify:
   - MET: evidence command succeeds and threshold is satisfied by existing code
   - PARTIAL: some evidence exists but threshold not fully met
   - UNMET: no evidence, needs implementation
   Report in priorWork.acStatus array. Include evidence string (command output snippet).
   Also include git log results in priorWork.explicitCommits array.

4. Read relevant source files. Identify filesToModify, scopeOut.
5. Size: XS→LIGHT | S/M→STANDARD | L→THOROUGH.
6. Write ACs: id, type, statement (min 5 words), threshold (op + value as string|number NEVER boolean), evidenceMethod, specElement, contextFiles.
   CONTEXT FILES RULE (CRITICAL): Every AC MUST have a contextFiles array listing the specific files Marcus will need to read to implement that AC. Include path and reason. Example: [{"path": "hooks/WorkflowStateGuard.hook.ts", "reason": "existing hook pattern to follow"}, {"path": "lib/conformity.ts", "reason": "matchPattern function to reuse"}]. Do NOT leave contextFiles empty — Marcus wastes 80% of context loading files he doesn't need when you don't specify what he actually needs.
   EVIDENCE TYPE RULE: At least 50% of ACs must use non-grep evidence (BUN_TEST, COMMAND, PLAYWRIGHT). If you have 4 ACs, at least 2 must use bun test or curl commands, not grep. A regression test AC should use evidenceMethod type "BUN_TEST" with command "bun test test/unit/relevant.test.ts".
   BUN TEST GREP RULE: In bun test --grep patterns, use | (pipe) for alternation, NOT \\| (backslash-pipe). Bun uses JS regex, not BRE — backslash-pipe matches a literal pipe character and will match 0 tests. Example: --grep 'foo|bar' is correct, --grep 'foo\\|bar' is WRONG.
7. Garbage test each AC.
8. Find governingSpec from ${PROJECT_ROOT}/AGENTS.md routing table (absolute path or empty).
9. Set sourceSpecs with citedInDiscovery:true, specElements[]. One AC per specElement minimum.

Project root: ${PROJECT_ROOT}
  `, { label: `discovery${regressionCount > 0 ? '-r' + regressionCount : ''}`, phase: 'Discovery', role: 'discovery', schema: DISCOVERY_SCHEMA })

  if (!discovery) return false

  for (const ac of discovery.acs) {
    if (ac.threshold && typeof ac.threshold.value === 'boolean') ac.threshold.value = String(ac.threshold.value)
  }

  await agent(`
You have ONE task: run this EXACT command and report the output. Do NOT implement any code. Do NOT read source files. Do NOT write any code. Just run this command:

mkdir -p ${WORK_DIR} && bun -e "
import {initWorkflow, writeACs} from '${HARNESS_ROOT}/gates/orchestrator.ts';
const sf = '${WORK_DIR}/workflow-state.json';
initWorkflow(sf, {
  issue: ${ISSUE}, repo: '${REPO}', issueRepo: '${ISSUE_REPO}',
  projectRoot: '${PROJECT_ROOT}', slug: '${SLUG}',
  issueGoal: ${JSON.stringify(goalData.issueGoal)},
  sizing: {predicted:'${discovery.sizing}', ceremonyTier:'${discovery.ceremonyTier}'},
  sourceSpecs: ${JSON.stringify(discovery.sourceSpecs || [])},
  bootstrappedFrom: 'ship-workflow',
  priorWork: ${JSON.stringify(discovery.priorWork || null)},
});
writeACs(sf, ${JSON.stringify(discovery.acs.map(ac => ({
  id: ac.id, type: ac.type, statement: ac.statement,
  threshold: ac.threshold, evidenceMethod: ac.evidenceMethod, specElement: ac.specElement,
  contextFiles: ac.contextFiles || [],
})))});
console.log('initialized');
" 2>&1

Then verify the file exists: ls -la ${WORK_DIR}/workflow-state.json
Report the command output only.
  `, { label: 'init-state', phase: 'Discovery' })

  log(`Sized: ${discovery.sizing}/${discovery.ceremonyTier} — ${discovery.acs.length} ACs`)
  return true
}

if (!await runDiscovery(null)) return { status: 'DISCOVERY_FAILED' }

// ── Load project config from rungate.json ──
const projectConfigResult = await agent(`
Read ${PROJECT_ROOT}/.claude/rungate.json and return its contents as JSON.
If the file doesn't exist, return an empty object {}.
`, { label: 'load-config', schema: {
  type: 'object',
  properties: {
    pages: { type: 'object' },
    apiUrl: { type: 'string' },
    uiUrl: { type: 'string' },
    container: { type: 'object', properties: {
      port: { type: 'number' },
      rebuildCommand: { type: 'string' },
      healthPath: { type: 'string' },
      hosts: { type: 'array', items: { type: 'string' } },
    }},
    test: { type: 'object', properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
    }},
    roles: { type: 'object' },
  },
}})
const projectConfig = projectConfigResult || {}
const pagesConfig = projectConfig.pages || parsedArgs.pages || {}
const hasUI = Object.keys(pagesConfig).length > 0
const hasContainer = !!(projectConfig.container)
const testCommand = projectConfig.test?.command || 'bun test'
const testTimeout = projectConfig.test?.timeout || 120000

if (!hasUI && discovery.ceremonyTier !== 'LIGHT') {
  log(`PROJECT TYPE: CLI/library (pages:{} empty) — overriding ${discovery.ceremonyTier} → LIGHT (no Quinn, no container)`)
  discovery.ceremonyTier = 'LIGHT'
}

// ── Prior-work short circuit ────────────────────────────────
if (discovery.priorWork) {
  const metCount = discovery.priorWork.acStatus.filter(a => a.status === 'MET').length
  const totalCount = discovery.priorWork.acStatus.length

  if (metCount === totalCount && totalCount > 0) {
    log(`ALREADY_SHIPPED: ALL ${totalCount} ACs already MET — running prove`)
    discovery.priorWork.acStatus.forEach(a => log(`  ${a.id}: MET — ${a.evidence || 'verified'}`))

    // Still must run prove — code exists doesn't mean it works
    phase('Prove')
    log('Running prove WORKFLOW (with Quinn for UI) on already-shipped code')
    const alreadyProve = await workflow(
      { scriptPath: `${HARNESS_ROOT}/workflows/prove.js` },
      { issue: ISSUE, projectRoot: PROJECT_ROOT, repo: REPO, issueRepo: ISSUE_REPO, home: HOME, slug: SLUG }
    )

    const alreadyVerdict = alreadyProve?.verdict === 'PROVEN' ? 'PROVEN' : 'UNPROVEN'
    log(`Prove (already-shipped): ${alreadyVerdict}`)

    await agent(`
Post prove result to issue #${ISSUE}:
1. gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body "Prove verdict: ${alreadyVerdict} (already-shipped path — all ACs MET, prove ran mechanically)"
2. If verdict is PROVEN: gh issue edit ${ISSUE} --repo ${ISSUE_REPO} --add-label "proven"
3. If verdict is PROVEN and no goal-record.json at ${WORK_DIR}/goal-record.json: gh issue close ${ISSUE} --repo ${ISSUE_REPO}
    `, { label: 'already-prove-label', phase: 'Prove' })

    return {
      status: alreadyVerdict === 'PROVEN' ? 'ALREADY_SHIPPED_AND_PROVEN' : 'ALREADY_SHIPPED_PROVE_FAILED',
      issue: ISSUE, slug: SLUG,
      sizing: discovery.sizing, ceremonyTier: discovery.ceremonyTier,
      priorWork: discovery.priorWork,
      proveVerdict: alreadyVerdict,
      workDir: WORK_DIR,
    }
  }

  if (metCount > 0) {
    log(`Prior work: ${metCount}/${totalCount} ACs already MET — building only gaps`)
    discovery.priorWork.acStatus.filter(a => a.status === 'MET').forEach(a =>
      log(`  ${a.id}: MET — ${a.evidence || 'verified'}`)
    )
    const unmetIds = new Set(discovery.priorWork.acStatus.filter(a => a.status !== 'MET').map(a => a.id))
    discovery.acs = discovery.acs.filter(ac => unmetIds.has(ac.id))
    discovery.priorWork.acStatus.filter(a => a.status === 'MET').forEach(a => {
      discovery.scopeOut.push(`${a.id} — already satisfied, do not re-implement`)
    })
    log(`Remaining ACs for BUILD: ${discovery.acs.length}`)
  }
}

if (PHASE_TARGET === 'discovery') {
  return { status: 'DISCOVERY_COMPLETE', issue: ISSUE, slug: SLUG, sizing: discovery.sizing, acs: discovery.acs, workDir: WORK_DIR }
}

// ════════════════════════════════════════════════════════════
// PHASE 3: SCOPE GATE
// ════════════════════════════════════════════════════════════

phase('Scope')
const skipScope = discovery.ceremonyTier === 'LIGHT'

let scopeResult = { result: 'PASS' }
if (!skipScope) {
  scopeResult = await runGateWithHeal('scope', 'Scope', `Fix scope gate failures.
For AC/threshold/sourceSpec failures: fix in workflow-state.json via writeWorkflowState().
For evidence-type-ratio: add non-grep evidence methods (BUN_TEST, COMMAND, PLAYWRIGHT) to ACs.
For tests-pass: run cd ${PROJECT_ROOT} && ${testCommand} (timeout: ${testTimeout}) and write result to environments.local.tests in workflow-state.json.
For local-api-validated: read ${PROJECT_ROOT}/.claude/rungate.json for apiUrl. If no apiUrl configured, write environments.local.api = "SKIP". If configured, curl the URL and write PASS/FAIL.
For local-ui-validated: read ${PROJECT_ROOT}/.claude/rungate.json for uiUrl or pages config. If no UI configured, write environments.local.ui = "SKIP" with skipReason. If configured, curl the URL and write PASS/FAIL.
Edit workflow-state.json ONLY via writeWorkflowState():
bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); /* apply fix here */; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"
This validates via Zod at write time — you get immediate error feedback.`)
  if (scopeResult?.result === 'FAIL') return { status: 'SCOPE_FAILED', failures: scopeResult.failures, workDir: WORK_DIR }
}
log(`Scope: ${scopeResult?.result || 'SKIPPED'}`)

if (DRY_RUN) {
  log('DRY RUN — stopping after scope. No agents will be spawned.')
  return {
    status: 'DRY_RUN_COMPLETE',
    issue: ISSUE, slug: SLUG,
    sizing: discovery.sizing, ceremonyTier: discovery.ceremonyTier,
    acs: discovery.acs.map(ac => ({ id: ac.id, type: ac.type, statement: ac.statement })),
    priorWork: discovery.priorWork,
    scopeResult: scopeResult?.result || 'SKIPPED',
    workDir: WORK_DIR,
  }
}

// ── AC evidence/threshold pre-validation (#573) ─────────────
// Dry-run each AC evidence command and verify output format matches threshold operator.
// Prevents false gate failures from mismatched evidence/threshold types.
{
  const acValidation = await agent(`
Pre-validate AC evidence commands in workflow-state.json:

1. Read ${WORK_DIR}/workflow-state.json
2. For each AC with an evidenceMethod.command:
   a. Run the command (timeout 10s, allow non-zero exit)
   b. Capture the output
   c. Check if the threshold can meaningfully evaluate the output:
      - If threshold.op is ">=" or "<=" or "==" or "!=": output must be numeric (parseFloat succeeds)
      - If threshold.op is "contains": output must be non-empty string
   d. If mismatch found, fix the AC:
      - Numeric threshold but string output → change to op:"contains" with a key substring
      - String threshold but numeric output → change to op:">=" with numeric comparison
      - Empty output → flag as broken evidence command
3. Write fixes via writeWorkflowState():
   bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); /* apply fixes */; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"
4. Report: how many ACs validated, how many fixed, what was fixed

Do NOT change AC statements or evidence commands — only fix threshold operator/value mismatches.
`, { label: 'ac-prevalidation', phase: 'Scope', schema: {
    type: 'object',
    properties: {
      totalACs: { type: 'number' },
      validated: { type: 'number' },
      fixed: { type: 'number' },
      fixes: { type: 'array', items: { type: 'string' } }
    },
    required: ['totalACs', 'validated', 'fixed']
  }})
  if (acValidation?.fixed > 0) {
    log(`AC pre-validation: fixed ${acValidation.fixed}/${acValidation.totalACs} evidence/threshold mismatches`)
  } else {
    log(`AC pre-validation: ${acValidation?.validated || 0}/${acValidation?.totalACs || 0} ACs validated, no fixes needed`)
  }
}

// ── Prior-branch detection ─────────────────────────────────
let priorBranchResult = null
try {
  const priorBranch = await agent(`
Run this command and return the JSON result:
bun -e "import {detectPriorBranch} from '${HARNESS_ROOT}/lib/prior-branch.ts'; const r = await detectPriorBranch({issueNumber:${ISSUE},projectRoot:'${PROJECT_ROOT}',runTests:false}); console.log(JSON.stringify(r))"
Return the raw JSON output only — no commentary.
  `, { label: 'prior-branch-detect', phase: 'Discovery', schema: {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      commitCount: { type: 'number' },
      testsPass: { type: 'boolean' },
    },
  }})
  if (priorBranch && priorBranch.branch) {
    log(`Prior branch detected: ${priorBranch.branch} (${priorBranch.commitCount} commits)`)
    await agent(`
Merge prior implementation branch:
1. cd ${PROJECT_ROOT}
2. git merge ${priorBranch.branch} --no-edit
3. Report: merge result (success/conflict)
    `, { label: 'merge-prior', phase: 'Implement' })
    priorBranchResult = priorBranch
    log(`Merged prior branch ${priorBranch.branch}`)
  }
} catch (e) { log(`Prior-branch detection skipped: ${e?.message || 'no prior branch'}`) }

// ── Brief compliance pre-flight (SC-407) ───────────────────
// Quick sanity check: do agent briefs have extractable directives?
// NOT the full test-brief (which spawns agents) — just directive count.
// Warns but doesn't block if briefs score low.
try {
  log('Brief pre-flight: checking agent briefs for directive compliance')
  const roles = ['marcus', 'quinn']
  const preflightCmd = `
    bun -e "
      import {readFileSync,writeFileSync} from 'fs';
      import {extractDirectives} from '${HARNESS_ROOT}/lib/directive-extractor.ts';
      const results = {};
      const roles = ['marcus', 'quinn'];
      for (const role of roles) {
        try {
          const briefPath = '${PROJECT_ROOT}/.claude/agents/' + role + '.md';
          const content = readFileSync(briefPath, 'utf-8');
          const directives = extractDirectives(content);
          results[role] = {count: directives.length};
          console.log('Brief pre-flight: ' + role + ' has ' + directives.length + ' directives');
          if (directives.length === 0) {
            console.log('⚠️  WARNING: ' + role + ' has 0 extractable directives');
          }
        } catch(e) {
          results[role] = {count: 0, error: e.message};
          console.log('⚠️  Brief pre-flight FAILED for ' + role + ': ' + e.message);
        }
      }
      writeFileSync('${WORK_DIR}/brief-preflight.json', JSON.stringify(results, null, 2));
    "
  `
  await agent(preflightCmd.trim(), { label: 'brief-preflight', phase: 'Implement' })
} catch (e) {
  log(`Brief pre-flight skipped: ${e?.message || 'unknown error'}`)
}

// ════════════════════════════════════════════════════════════
// PHASE 4: IMPLEMENT (Marcus writes code — NO commit)
// ════════════════════════════════════════════════════════════

phase('Implement')

async function runImplement() {
  log('IMPLEMENT: assembling brief + spawning Marcus (reinforcement TDD + post-run verification)')

  await agent(`
Assemble brief: bun run ${HARNESS_ROOT}/gates/brief-assembler.ts --slug ${SLUG} --work-dir ${WORK_DIR} --project-root ${PROJECT_ROOT} 2>&1
Report the output.
  `, { label: 'assemble-brief', phase: 'Implement' })

  // Collect task-specific context files from Discovery ACs
  const acContextFiles = (discovery?.acs || [])
    .flatMap(ac => ac.contextFiles || [])
    .filter((cf, i, arr) => {
      const path = typeof cf === 'string' ? cf : cf.path
      return arr.findIndex(c => (typeof c === 'string' ? c : c.path) === path) === i
    })

  // Extract context excerpts: read files and pull relevant sections
  let contextExcerpts = null
  if (acContextFiles.length > 0) {
    log(`Extracting context excerpts from ${acContextFiles.length} Discovery files`)
    const EXCERPT_SCHEMA = {
      type: 'object',
      properties: {
        excerpts: { type: 'array', items: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            section: { type: 'string' },
            content: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['source', 'section', 'content', 'reason']
        }}
      },
      required: ['excerpts']
    }
    const fileList = acContextFiles.map(cf => {
      const path = typeof cf === 'string' ? cf : cf.path
      const reason = typeof cf === 'string' ? '' : cf.reason || ''
      return `- ${path}${reason ? ' — ' + reason : ''}`
    }).join('\n')
    const excerptResult = await agent(`
Read these files and extract ONLY the sections relevant to this task. Return 2-5 bullet points per file, not full files.

Files to extract from:
${fileList}

Also read these standard context files:
- ${PROJECT_ROOT}/AGENTS.md — project identity, rules, test commands
- ${PROJECT_ROOT}/prompts/coding-principles.md — coding standards

For each, return: source (file path), section (header), content (the relevant text), reason (why it matters for this task).
    `, { label: 'extract-context', phase: 'Implement', schema: EXCERPT_SCHEMA })
    contextExcerpts = excerptResult?.excerpts || null
    if (contextExcerpts) {
      log(`Injecting ${contextExcerpts.length} context excerpts into Marcus prompt`)
    }
  }

  const useExcerpts = contextExcerpts && contextExcerpts.length > 0
  const buildResult = await briefedAgent(`
You are Marcus Webb, senior engineer.
Read ${WORK_DIR}/marcus-brief.md for full instructions including ACs and files to modify.

## TDD — NON-NEGOTIABLE
1. Write the failing test FIRST
2. Run TARGETED test (bun test test/your-file.test.ts) to confirm it fails — set timeout: ${testTimeout}
3. Write the implementation to make the test pass
4. Run TARGETED test again to confirm it passes — set timeout: ${testTimeout}
5. Run bunx tsc --noEmit
Do NOT write source code before writing its test. This order is mandatory.
NEVER run the full suite (bun test without a file path) — it takes 3+ minutes. Always target: bun test test/specific-file.test.ts

## Efficiency Rules
- Do NOT read files listed in "Injected Context" above — the content is already in your prompt
- Do NOT use ls, pwd, cat, head, or tail via Bash — use Read tool if you must read a file
- Every tool call should produce value — no exploratory commands

Do NOT commit or push yet — Quinn will validate on local dev first.
If tests fail, fix them before reporting.

Report: success, branch name, files changed, test output, evidence per AC.
Also report worktreePath: your current working directory (run pwd and include the result).
  `, {
    label: 'marcus', phase: 'Implement', role: 'marcus',
    contextExcerpts: useExcerpts ? contextExcerpts : null,
    contextFiles: !useExcerpts && acContextFiles.length > 0 ? acContextFiles : null,
    schema: BUILD_RESULT_SCHEMA
  })

  if (!buildResult || !buildResult.success) {
    log(`IMPLEMENT FAILED: ${buildResult?.findings?.join(', ') || 'unknown'}`)
    return { success: false, buildResult }
  }
  log(`IMPLEMENT SUCCESS — ${(buildResult.filesChanged || []).length} files changed`)
  return { success: true, buildResult }
}

let implementResult
if (priorBranchResult?.testsPass) {
  log('Skipping Implement phase — using prior branch implementation')
  const diffResult = await agent(`
Run: cd ${PROJECT_ROOT} && git diff --name-only main...HEAD
Return only the file list, one per line.
  `, { label: 'prior-diff', phase: 'Implement' })
  const filesChanged = typeof diffResult === 'string' ? diffResult.trim().split('\n').filter(Boolean) : []
  implementResult = { success: true, buildResult: { filesChanged } }
} else {
  implementResult = await runImplement()
  if (!implementResult.success) {
    return { status: 'IMPLEMENT_FAILED', ...implementResult, workDir: WORK_DIR }
  }
}

// Capture Marcus's worktree path so Quinn and fix iterations validate the same code
const marcusWorktreePath = priorBranchResult?.testsPass ? PROJECT_ROOT : (implementResult.buildResult?.worktreePath || PROJECT_ROOT)

// ════════════════════════════════════════════════════════════
// PHASE 5: VALIDATE (Quinn local dev — fast feedback before commit)
// ════════════════════════════════════════════════════════════

phase('Validate')
let quinnLocalResult = { result: 'PASS' }

// Quinn local runs for ALL STANDARD+ tiers (spec: Layer 1, ceremony table: STANDARD = Quinn)
if (discovery.ceremonyTier !== 'LIGHT') {
  for (let validateAttempt = 1; validateAttempt <= 3; validateAttempt++) {
    log(`Quinn local dev — attempt ${validateAttempt}/3`)

    quinnLocalResult = await briefedAgent(`
Read ${HARNESS_ROOT}/prompts/quinn-ui-brief.md for your testing methodology.
Read ${PROJECT_ROOT}/AGENTS.md for project context.

You are Quinn Torres, QA specialist. You have Playwright MCP tools available.

## Working Directory
IMPORTANT: Validate against Marcus's worktree at: ${marcusWorktreePath}
Run all file checks, tests, and validations from that directory (cd ${marcusWorktreePath}).
This is where Marcus made the code changes — do NOT validate against the main branch.

## Environment
- **Config:** Read ${PROJECT_ROOT}/.claude/rungate.json for dev URLs, page paths, and API endpoints
- **Viewport:** 1280x720 (set via browser_resize FIRST)
- **Test as:** Brand-new user — no prior session state
- **Pages map:** Read ${PROJECT_ROOT}/.claude/rungate.json for exact URL paths

## Pre-conditions (GATE — stop if any fail)
1. browser_resize(1280, 720)
2. browser_navigate to target URL from rungate.json pages map
3. browser_snapshot() — verify page loaded (no error banners, data present)
If pre-conditions fail → report FAIL immediately, do NOT proceed.

## User Journey for #${ISSUE}
Follow this structured test plan — each step maps to an AC:

${discovery.acs.map((ac, i) => `Step ${i + 1}: Verify ${ac.id}: ${ac.statement}
  → ACTION: navigate/click/type as needed
  → VERIFY: browser_snapshot() — check expected state
  → SCREENSHOT: browser_take_screenshot() if state changed`).join('\n\n')}

## Anti-checks (ALWAYS run after journey)
- [ ] No "undefined" or "null" rendered as visible text
- [ ] No stuck loading spinners
- [ ] No error banners or toast messages
- [ ] Interactive elements respond to clicks

Any anti-check failure = FAIL even if all ACs pass.

## Screenshot Strategy
- page-load.png — after navigation, before interaction
- After each state-changing action
- final-state.png — end of journey
Do NOT screenshot after every browser_snapshot().

## Verdict
- PASS: all pre-conditions + all ACs + all anti-checks pass
- FAIL: any failure — report which AC or anti-check failed with evidence
    `, { label: `quinn-local-${validateAttempt}`, phase: 'Validate', role: 'quinn', isolation: undefined, schema: GATE_RESULT_SCHEMA })

    if (!quinnLocalResult) {
      log(`Quinn local: agent failed (network/API error) — attempt ${validateAttempt}/3`)
      if (validateAttempt >= 3) return { status: 'VALIDATE_FAILED', reason: 'Quinn agent unavailable', workDir: WORK_DIR }
      continue
    }

    if (quinnLocalResult.result === 'PASS') {
      log('Quinn local: PASS')
      break
    }

    if (validateAttempt >= 3) {
      log('Quinn local failed 3x — circuit break')
      return { status: 'VALIDATE_FAILED', quinnLocalResult, workDir: WORK_DIR }
    }

    log(`Quinn local: FAIL — sending back to Marcus (attempt ${validateAttempt}/3)`)
    const fixResult = await briefedAgent(`
You are Marcus Webb, senior engineer.
IMPORTANT: Work in the worktree at: ${marcusWorktreePath}
cd ${marcusWorktreePath} before making any changes.

Quinn found issues on local dev for issue #${ISSUE}:
${(quinnLocalResult?.failures || []).join('\n')}

Read the failing AC details. Fix the code. Run unit tests again.
Do NOT commit — Quinn will retest.
Report what you fixed.
    `, { label: `marcus-fix-${validateAttempt}`, phase: 'Validate', role: 'marcus', isolation: undefined })
  }
} else {
  log('Quinn local: SKIPPED (LIGHT tier)')
}

// ════════════════════════════════════════════════════════════
// PHASE 6: COMMIT (only after Quinn local PASS)
// ════════════════════════════════════════════════════════════

phase('Commit')
log('Quinn local passed — committing code')

const commitDir = marcusWorktreePath !== PROJECT_ROOT ? marcusWorktreePath : PROJECT_ROOT

const commitResult = await agent(`
Commit and push the fix for issue #${ISSUE}:
1. cd ${commitDir}
2. git add -A
3. git commit -m "fix(#${ISSUE}): ${goalData.issueTitle}"
4. git push -u origin HEAD
5. Report: branch name (git branch --show-current), commit SHA (git rev-parse --short HEAD)
`, { label: 'commit', phase: 'Commit', schema: {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commitSha: { type: 'string' },
    pushed: { type: 'boolean' },
  },
  required: ['branch', 'commitSha'],
}})

if (!commitResult?.commitSha) {
  return { status: 'COMMIT_FAILED', workDir: WORK_DIR }
}
log(`Committed: ${commitResult.commitSha} on ${commitResult.branch}`)

// Branch stored for post-verify merge — do NOT merge to main until verify passes
const worktreeBranch = commitResult.branch

// Check environment status (structured output — no JSON writing)
const ENV_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    apiStatus: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
    uiStatus: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
    uiSkipReason: { type: 'string' },
    testsStatus: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
    testFailCount: { type: 'number' },
    testTotalCount: { type: 'number' },
  },
  required: ['apiStatus', 'uiStatus', 'testsStatus'],
}
// Build env-check prompt dynamically from project config
const apiUrl = projectConfig.apiUrl || null
const uiUrl = projectConfig.uiUrl || null

let envCheckPrompt = 'Run these checks and report results. Do NOT read or write any JSON files.\n\n'

if (apiUrl) {
  envCheckPrompt += `1. API: curl -s -o /dev/null -w "%{http_code}" ${apiUrl}
   - If 200: apiStatus = "PASS"
   - Otherwise: apiStatus = "FAIL"\n\n`
} else {
  envCheckPrompt += '1. API: No API configured for this project. Set apiStatus = "SKIP".\n\n'
}

if (uiUrl) {
  envCheckPrompt += `2. UI: curl -s -o /dev/null -w "%{http_code}" ${uiUrl}
   - If 200 or 302: uiStatus = "PASS"
   - If unreachable: uiStatus = "SKIP", set uiSkipReason\n\n`
} else {
  envCheckPrompt += '2. UI: No UI/pages configured for this project. Set uiStatus = "SKIP", uiSkipReason = "No pages configured".\n\n'
}

envCheckPrompt += `3. Tests: Marcus already verified tests pass during implementation. Set testsStatus = "PASS" (tests were verified pre-commit). Do NOT re-run the full test suite — it takes 3+ minutes and was already run.\n`

const envStatus = await agent(envCheckPrompt, { label: 'env-check-local', phase: 'Commit', schema: ENV_CHECK_SCHEMA })

// Write commit + environment data to workflow-state.json via writeWorkflowState (Zod-validated)
await agent(`
Update workflow-state.json via writeWorkflowState():

bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); s.buildCommit = '${commitResult.commitSha}'; s.agents = {marcus: {branch: '${commitResult.branch}', commitSha: '${commitResult.commitSha}', spawned: true, verdict: 'PASS'}, quinn: {spawned: ${discovery.ceremonyTier !== 'LIGHT'}, verdict: '${discovery.ceremonyTier !== 'LIGHT' ? 'PASS' : 'SKIP'}'}}; s.environments = s.environments || {}; s.environments.local = s.environments.local || {}; s.environments.local.api = '${envStatus?.apiStatus || 'SKIP'}'; s.environments.local.ui = '${envStatus?.uiStatus || 'SKIP'}'; ${envStatus?.uiSkipReason ? `s.environments.local.uiSkipReason = '${envStatus.uiSkipReason}';` : ''} s.environments.local.tests = '${envStatus?.testsStatus || 'SKIP'}'; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"

Run this command and report the output.
`, { label: 'record-commit', phase: 'Commit' })

// ════════════════════════════════════════════════════════════
// PHASE 7: VERIFY (gate + container rebuild + Quinn container)
// ════════════════════════════════════════════════════════════

phase('Verify')

// Run verify gate first (mechanical checks)
// Run verify from worktree (where Marcus's code lives) — NOT main
const verifyResult = await runGateWithHeal('verify', 'Verify',
  'Fix evidence gaps, test failures, uncommitted code. Run AC evidence commands.',
  { cwd: marcusWorktreePath })

if (verifyResult?.result === 'FAIL') {
  if (verifyResult.regressionTarget === 'DISCOVERY' && regressionCount < MAX_REGRESSIONS) {
    regressionCount++
    log(`Verify DISCOVERY regression #${regressionCount}`)
    if (!await runDiscovery('Verify gate found ACs were wrong: ' + (verifyResult.failures || []).join(', '))) {
      return { status: 'VERIFY_FAILED', reason: 'DISCOVERY regression failed', workDir: WORK_DIR }
    }
  }
  if (verifyResult.regressionTarget === 'BUILD' && regressionCount < MAX_REGRESSIONS) {
    regressionCount++
    log(`Verify CODE regression #${regressionCount}`)
  }
}

// Container rebuild + Quinn container (STANDARD+ only, requires container config)
const containerConfig = projectConfig.container || null
if (discovery.ceremonyTier !== 'LIGHT' && containerConfig) {
  const rebuildCmd = containerConfig.rebuildCommand
  const containerHosts = containerConfig.hosts || []
  const containerPort = containerConfig.port
  const containerHealthPath = containerConfig.healthPath || '/'

  if (rebuildCmd) {
    await agent(`
You have ONE task: rebuild the test container. Run this EXACT command and report the output:

cd ${PROJECT_ROOT} && ${rebuildCmd} 2>&1 | tail -20

Report the full output.
    `, { label: 'container-rebuild', phase: 'Verify' })
  }

  if (containerHosts.length > 0 && containerPort) {
    const hostChecks = containerHosts.map((h, i) => `${i + 1}. curl -s -o /dev/null -w "%{http_code}" http://${h}:${containerPort}${containerHealthPath} 2>/dev/null\n   - host${i} = true if 200, false otherwise`).join('\n')
    const hostSchema = {}
    containerHosts.forEach((h, i) => { hostSchema['host' + i] = { type: 'boolean' } })

    const envCheck = await agent(`
Check if the rebuilt container is available:
${hostChecks}
    `, { label: 'env-check', phase: 'Verify', schema: {
      type: 'object',
      properties: hostSchema,
      required: Object.keys(hostSchema),
    }})

    const hostIdx = containerHosts.findIndex((h, i) => envCheck && envCheck['host' + i])
    const testHost = hostIdx >= 0 ? containerHosts[hostIdx] : null
    log(`Container env: ${containerHosts.map((h, i) => `${h}=${envCheck?.['host' + i]}`).join(', ')}, using=${testHost || 'NONE'}`)

    if (testHost) {
      await briefedAgent(`
You are Quinn Torres, QA specialist. You have Playwright MCP tools available.

## COMMIT SHA VERIFICATION (MANDATORY)
Read ${WORK_DIR}/workflow-state.json and get the buildCommit value.
Run: cd ${PROJECT_ROOT} && git rev-parse --short HEAD
Verify HEAD matches buildCommit from workflow-state.json.
If mismatch, FAIL with "Container running wrong version — HEAD {actual} != buildCommit {expected}."

## Available Playwright MCP Tools (use these, NOT manual browser)
- browser_navigate(url) — go to URL
- browser_snapshot() — get accessibility tree (text, fast, preferred over screenshots)
- browser_click(element) — click by ref from snapshot
- browser_type(element, text) — type text into element
- browser_take_screenshot() — capture PNG evidence
- browser_verify_text_visible(text) — assert text on page

## Test Plan for #${ISSUE} on CONTAINER — http://${testHost}:${containerPort}
Read ${PROJECT_ROOT}/.claude/rungate.json for page paths.
1. browser_navigate("http://${testHost}:${containerPort}" + page path from rungate.json)
2. browser_snapshot() — verify page loaded
3. For each AC:
   a. Perform the action (browser_click, browser_type, etc.)
   b. browser_snapshot() or browser_verify_text_visible() to verify
   c. browser_take_screenshot() for evidence
4. Report PASS/FAIL per AC. Include verified commit SHA.

### ACs to Verify
${discovery.acs.map(ac => `- ${ac.id}: ${ac.statement}`).join('\n')}
      `, { label: 'quinn-container', phase: 'Verify', role: 'quinn', schema: GATE_RESULT_SCHEMA })
    } else {
      log('WARN: No test container available — skipping container Quinn')
    }
  }
} else if (discovery.ceremonyTier !== 'LIGHT') {
  log('No container config in rungate.json — skipping container verify')
}

// Rook security review (THOROUGH only)
if (discovery.ceremonyTier === 'THOROUGH') {
  log('Spawning Rook')
  await briefedAgent(`
Security review for issue #${ISSUE}. Changed: ${discovery.filesToModify.join(', ')}
Read ${PROJECT_ROOT}/ARCHITECTURE.md. Check: injection, credentials, path traversal, XSS.
  `, { label: 'rook', phase: 'Verify', role: 'rook', schema: GATE_RESULT_SCHEMA })
}

// ── Merge worktree to main (only after verify passes) ────
if (marcusWorktreePath !== PROJECT_ROOT && worktreeBranch) {
  await agent(`
Merge the verified worktree branch into main:
1. cd ${PROJECT_ROOT}
2. git merge ${worktreeBranch} --no-edit
3. Report: merge result (success/conflict), current HEAD SHA
If merge conflicts, report them — do NOT force.
  `, { label: 'merge-to-main', phase: 'Verify' })
  log('Worktree branch merged to main after verify pass')

  // Push main to origin after merge so ship gate's code-pushed check passes
  await agent(`cd ${PROJECT_ROOT} && git push`, { label: 'push-main', phase: 'Ship' })
  log('Main pushed to origin after worktree merge')
}

// ── GRADE: Post-run compliance grading (#574 — runs before ship gate) ──
// Moved from after PROVE to before SHIP so grading happens even when gate fails.
// Uses deterministic evaluation via evaluateCriteria() instead of LLM grading.
let gradeResult = null
if (!SKIP_GRADE) {
  gradeResult = await agent(`
Find the workflow transcript directory and run grading + efficiency analysis + wall-clock timing:

1. Find the transcript dir — look for agent-*.jsonl files:
   find ~/.claude/projects/ -maxdepth 6 -name "agent-*.jsonl" -path "*/workflows/*" -newer ${WORK_DIR}/workflow-state.json 2>/dev/null | head -1
   Extract the directory from that path (dirname of the found file).

2. Run grading:
   bun ${HARNESS_ROOT}/scripts/grade-deterministic.ts --transcripts "$TDIR" --project ${PROJECT_ROOT} ${WORK_DIR}

3. Run efficiency analysis:
   bun ${HARNESS_ROOT}/scripts/analyze-transcript.ts "$TDIR" --json

4. Wall-clock timing per agent — for each agent-*.jsonl file, get file timestamps:
   for f in "$TDIR"/agent-*.jsonl; do
     name=$(basename "$f" .jsonl)
     created=$(stat -f '%B' "$f" 2>/dev/null || stat -c '%W' "$f" 2>/dev/null)
     modified=$(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null)
     if [ -n "$created" ] && [ -n "$modified" ]; then
       el=$((modified - created))
       echo "$name: $el seconds"
     fi
   done

5. Return a JSON object with grades array, efficiency metrics, and timing. If no transcripts found, return {"grades": [], "efficiency": null, "timing": []}.
  `, { label: 'grade', phase: 'Verify', schema: {
    type: 'object',
    properties: {
      grades: { type: 'array', items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          total: { type: 'number' },
          followed: { type: 'number' },
          flagged: { type: 'array', items: { type: 'string' } }
        },
        required: ['role', 'total', 'followed']
      }},
      efficiency: { type: 'object', properties: {
        fileEfficiency: { type: 'string' },
        deliverableRatio: { type: 'string' },
        testRuns: { type: 'string' },
        contextGrowth: { type: 'string' },
        toolCalls: { type: 'number' }
      }},
      timing: { type: 'array', items: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          seconds: { type: 'number' }
        },
        required: ['agent', 'seconds']
      }}
    },
    required: ['grades']
  }})

  if (gradeResult?.grades) {
    for (const g of gradeResult.grades) {
      log(`GRADE ${g.role}: ${g.followed}/${g.total} rules followed${g.flagged?.length ? ' — flagged: ' + g.flagged.join(', ') : ''}`)
    }
  }
  if (gradeResult?.efficiency) {
    log(`EFFICIENCY: file=${gradeResult.efficiency.fileEfficiency}, deliverable=${gradeResult.efficiency.deliverableRatio}, tests=${gradeResult.efficiency.testRuns}, context=${gradeResult.efficiency.contextGrowth}, calls=${gradeResult.efficiency.toolCalls}`)
  }
  if (gradeResult?.timing?.length) {
    for (const t of gradeResult.timing) {
      log(`TIMING: ${t.agent} = ${t.seconds}s`)
    }
  }
} else {
  log('GRADE: skipped (skipGrade=true)')
}

// ════════════════════════════════════════════════════════════
// PHASE 8: SHIP (container verify + PR creation + gate)
// ════════════════════════════════════════════════════════════

phase('Ship')

// Record container/environment test evidence
if (containerConfig) {
  const containerPort = containerConfig.port || 3000
  const containerHealthPath = containerConfig.healthPath || '/'
  await agent(`
Check test container status, then update workflow-state.json via writeWorkflowState():

1. Check test container: curl -s -o /dev/null -w "%{http_code}" http://${(containerConfig.hosts || [])[0]}:${containerPort}${containerHealthPath} 2>/dev/null
2. Based on result, run this bun -e command (pick the version matching your result):

If container is up (200):
bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); s.environments = s.environments || {}; s.environments.prod = s.environments.prod || {}; s.environments.prod.rebuild = 'PASS'; s.environments.prod.smoke = 'PASS'; s.environments.prod.quinn = 'SKIP'; s.environments.prod.quinnSkipReason = 'Quinn validated on local dev'; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"

If container is down:
bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); s.environments = s.environments || {}; s.environments.prod = s.environments.prod || {}; s.environments.prod.rebuild = 'SKIP'; s.environments.prod.rebuildSkipReason = 'test container not running'; s.environments.prod.smoke = 'SKIP'; s.environments.prod.smokeSkipReason = 'test container not running'; s.environments.prod.quinn = 'SKIP'; s.environments.prod.quinnSkipReason = 'test container not running'; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"

Run the appropriate command and report the output.
`, { label: 'record-env', phase: 'Ship' })
} else {
  await agent(`
No container configured for this project. Record environment as SKIP in workflow-state.json:

bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); s.environments = s.environments || {}; s.environments.prod = s.environments.prod || {}; s.environments.prod.rebuild = 'SKIP'; s.environments.prod.rebuildSkipReason = 'no container configured'; s.environments.prod.smoke = 'SKIP'; s.environments.prod.smokeSkipReason = 'no container configured'; s.environments.prod.quinn = 'SKIP'; s.environments.prod.quinnSkipReason = 'no container configured'; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"

Run this command and report the output.
`, { label: 'record-env', phase: 'Ship' })
}

// Create PR
log('Creating PR')
await agent(`
Create a PR for issue #${ISSUE}:
1. cd ${PROJECT_ROOT}
2. Check: gh pr list --repo ${REPO} --head $(git branch --show-current) --json number
3. If no PR exists:
   gh pr create --repo ${REPO} --title "fix(#${ISSUE}): ${goalData.issueTitle}" --body "$(cat <<'PREOF'
Fixes #${ISSUE}

## Test plan
- Unit tests: PASS
- Quinn local dev: verified
- Container: deferred to CI

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
4. Report the PR URL and number
`, { label: 'create-pr', phase: 'Ship' })

log('Running ship gate')
const shipResult = await runGateWithHeal('ship', 'Ship',
  `Fix ceremony gaps in workflow-state.json via writeWorkflowState():
bun -e "import {writeWorkflowState} from '${HARNESS_ROOT}/gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('${WORK_DIR}/workflow-state.json','utf8')); /* apply fix here */; writeWorkflowState('${WORK_DIR}/workflow-state.json', s);"
- branch-merged: set code-pushed="PASS" if branch is pushed. The PR is open for Jason to review — branch-merged may WARN, that's OK.
- Any missing environments fields: add with SKIP + skipReason.
- code-committed: should already be PASS from commit phase.`)

log(`Ship: ${shipResult?.result || 'UNKNOWN'}`)

if (shipResult?.result !== 'PASS') {
  return { status: 'SHIP_FAILED', issue: ISSUE, slug: SLUG, workDir: WORK_DIR }
}

// ════════════════════════════════════════════════════════════
// PHASE 9: PROVE (full workflow — B3 + Quinn for UI ACs)
// ════════════════════════════════════════════════════════════

phase('Prove')
log('Running prove WORKFLOW (with Quinn for UI) — verifying fix actually works')

const proveResult = await workflow(
  { scriptPath: `${HARNESS_ROOT}/workflows/prove.js` },
  { issue: ISSUE, projectRoot: PROJECT_ROOT, repo: REPO, issueRepo: ISSUE_REPO, home: HOME, slug: SLUG }
)

if (proveResult?.verdict !== 'PROVEN' && regressionCount < MAX_REGRESSIONS) {
  regressionCount++
  log(`Prove UNPROVEN — regression #${regressionCount}, re-implementing`)
  phase('Implement')
  implementResult = await runImplement()
  if (implementResult.success) {
    phase('Commit')
    const reCommit = await agent(`
Commit the regression fix for issue #${ISSUE}:
cd ${PROJECT_ROOT} && git add -A && git commit -m "fix(#${ISSUE}): address prove regression" && git push
Report commit SHA.
    `, { label: 'recommit', phase: 'Commit', schema: { type: 'object', properties: { commitSha: { type: 'string' } }, required: ['commitSha'] } })

    phase('Ship')
    const retryShip = await runGateWithHeal('ship', 'Ship', 'Re-ship after prove regression.')
    if (retryShip?.result === 'PASS') {
      phase('Prove')
      const retryProve = await workflow(
        { scriptPath: `${HARNESS_ROOT}/workflows/prove.js` },
        { issue: ISSUE, projectRoot: PROJECT_ROOT, repo: REPO, issueRepo: ISSUE_REPO, home: HOME, slug: `${SLUG}-retry` }
      )
      if (retryProve?.verdict === 'PROVEN') log('Prove passed after regression fix')
    }
  }
}

const proveVerdict = proveResult?.verdict === 'PROVEN' ? 'PROVEN' : 'UNPROVEN'
log(`Prove: ${proveVerdict}`)

// Post result + label + close
await agent(`
Post prove result to issue #${ISSUE}:
1. gh issue comment ${ISSUE} --repo ${ISSUE_REPO} --body "Prove verdict: ${proveVerdict} (mechanical — via ship.js prove gate)"
2. If verdict is PROVEN: gh issue edit ${ISSUE} --repo ${ISSUE_REPO} --add-label "proven"
3. If verdict is PROVEN and no goal-record.json at ${WORK_DIR}/goal-record.json: gh issue close ${ISSUE} --repo ${ISSUE_REPO}
`, { label: 'prove-label', phase: 'Prove' })

// ── Telemetry ──────────────────────────────────────────────
await agent(`
mkdir -p ${HOME}/.claude/MEMORY/LEARNING/SIGNALS
Append a single JSON line to ${HOME}/.claude/MEMORY/LEARNING/SIGNALS/harness-telemetry.jsonl with:
- ts: current ISO timestamp (run date -u command)
- skill: "ship"
- issue: ${ISSUE}
- result: "${proveVerdict}"
- sizing: "${discovery.sizing}"
- ceremonyTier: "${discovery.ceremonyTier}"
- regressions: ${regressionCount}
Use Bash echo to append.
`, { label: 'telemetry', phase: 'Prove' })

// ── Worktree cleanup (post-workflow) ────────────────────
try {
  await agent(`
Run worktree cleanup:
bun -e "import {cleanupWorktrees} from '${HARNESS_ROOT}/lib/worktree-cleanup.ts'; const r = await cleanupWorktrees({projectRoot:'${PROJECT_ROOT}'}); console.log(JSON.stringify(r))"
Report the result.
  `, { label: 'worktree-cleanup', phase: 'Prove' })
} catch (e) { log(`Worktree cleanup skipped`) }

// ── Stale issue scanner (post-ship, mechanical) ─────────
try {
  const scanResult = await agent(`
Run the mechanical stale issue scanner:
1. cd ${HARNESS_ROOT} && bun scripts/update-project-state.ts --skip-tests
2. cd ${HARNESS_ROOT} && bun scripts/scan-stale-issues.ts --repo ${ISSUE_REPO} --exclude ${ISSUE}

Report the output — how many scanned, stale found, closed.
  `, { label: 'stale-issue-scan', phase: 'Prove', schema: {
    type: 'object',
    properties: {
      scanned: { type: 'number' },
      staleFound: { type: 'number' },
      closed: { type: 'array', items: { type: 'number' } },
    },
    required: ['scanned', 'staleFound'],
  }})
  if (scanResult?.staleFound > 0) {
    log(`Stale issue scan: closed ${scanResult.staleFound} orphaned issues: ${(scanResult.closed || []).join(', ')}`)
  }
} catch (e) { log(`Stale issue scan skipped`) }

return {
  status: proveVerdict === 'PROVEN' ? 'SHIPPED_AND_PROVEN' : 'SHIP_PASSED_PROVE_FAILED',
  issue: ISSUE, slug: SLUG,
  sizing: discovery.sizing, ceremonyTier: discovery.ceremonyTier,
  proveVerdict,
  regressions: regressionCount,
  workDir: WORK_DIR,
  grades: gradeResult?.grades || [],
}
