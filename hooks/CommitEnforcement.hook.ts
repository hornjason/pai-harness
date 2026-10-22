#!/usr/bin/env bun
/**
 * CommitEnforcement.hook.ts — PostToolUse on Agent
 *
 * SC-304 (AGENTS-MD-TEMPLATE-SPEC): CommitEnforcement contains [code, agent]
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 *
 * TRIGGER: PostToolUse (matcher: Agent)
 *
 * Detects two conditions in code agent worktrees after agent completion:
 * 1. UI file changes — writes quinn-required tripwire for quinn-on-ui-change gate
 * 2. Uncommitted changes — writes agent-uncommitted tripwire signal
 *
 * Broadened from Marcus-only to all code agents (marcus, quinn, rook, serena,
 * aditi) — true of NOTHING until #1000, because the config that detection
 * reads was in no commit; see `hooks/lib/agentDetection.ts`.
 *
 * The worktree it acts on comes out of an agent-authored reply, so it must
 * be a REGISTERED worktree of this harness's own repo and git runs ISOLATED
 * — `lib/agent-worktree.ts`, `lib/git-isolation.ts` (#1001).
 *
 * Issue: #361, #343, #1000, #1001
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { findWorkflowForIssue, extractIssueNumber } from './lib/findWorkflow'
import { agentWorktreeSubject } from '../lib/agent-worktree'
import { gitIsolatedArgs, gitIsolatedEnv } from '../lib/git-isolation'
import { WORK_DIR, SIGNAL_DIR } from './lib/paths'
import { parseHookInput } from './lib/parseStdin';
import { detectAgentOrRecord } from './lib/agentDetection'

async function main() {
  const payload = await parseHookInput()
  if (!payload) process.exit(0)

  if (payload?.tool_name !== 'Agent') process.exit(0)

  const toolInput = payload.tool_input || {}

  // `OrRecord`: an unreadable config leaves evidence, not a silent null (#1000).
  const agent = detectAgentOrRecord(toolInput, 'CommitEnforcement', { cwd: (payload as { cwd?: string }).cwd })

  if (!agent) process.exit(0)  // Not a known agent, or config unreadable (recorded) — skip

  if (toolInput.isolation !== 'worktree') process.exit(0)

  const resp = payload.tool_response
  // `tool_response.content` is declared `unknown` — the payload is whatever the
  // tool emitted. Only a string is regex-able; anything else means no path here.
  const respContent = typeof resp === 'string' ? resp : resp?.content
  const respText = typeof respContent === 'string' ? respContent : ''

  // A registered worktree of this harness's OWN repo, or nothing (#1001).
  // A named-but-unregistered candidate is a TERMINAL refusal in there — the
  // fall-through to the scan is what made the previous fix misattribute.
  const worktreePath = agentWorktreeSubject(respText, 'CommitEnforcement', { agent: agent.key })
  if (!worktreePath) process.exit(0)

  // Resolve slug early — needed by both UI detection and uncommitted-changes tripwire
  const issueNum = extractIssueNumber(toolInput.prompt || '')
  const wf = findWorkflowForIssue(issueNum)
  const slug = wf?.slug || issueNum || 'unknown'

  // ── UI file detection (runs independently of uncommitted check) ──
  const uiExtensions = /\.(tsx|jsx|css|scss|html|svg|less)$/i
  let uiFiles: string[] = []
  try {
    // ARGV, never a shell string (#971 SC-4), and ISOLATED: argv does
    // nothing about config keys git EXECUTES (#1001, lib/git-isolation.ts).
    const diffOutput = execFileSync('git', gitIsolatedArgs(['-C', worktreePath, 'diff', '--name-only', 'main']), {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: gitIsolatedEnv(),
    }).trim()
    if (diffOutput) uiFiles = diffOutput.split('\n').filter(f => uiExtensions.test(f))
  } catch {}

  if (uiFiles.length > 0) {
    const uiSignalName = `quinn-required-${agent.key}-${slug.replace(/\//g, '-')}`
    const uiSignalPath = join(SIGNAL_DIR, uiSignalName)
    if (!existsSync(SIGNAL_DIR)) mkdirSync(SIGNAL_DIR, { recursive: true })
    await Bun.write(uiSignalPath, JSON.stringify({
      detected: new Date().toISOString(),
      worktreePath,
      uiFiles,
      uiFileCount: uiFiles.length,
      issue: issueNum || null,
      slug,
      agent: agent.key,
    }, null, 2))
    console.error(`[commit-enforcement] ${uiFiles.length} UI files changed by ${agent.key} — quinn-required signal written`)
  }

  // ── Uncommitted-changes detection ──
  let uncommittedStatus = ''
  try {
    uncommittedStatus = execFileSync('git', gitIsolatedArgs(['-C', worktreePath, 'status', '--porcelain']), {
      timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: gitIsolatedEnv(),
    }).trim()
  } catch {
    process.exit(0)
  }

  if (!uncommittedStatus) process.exit(0)

  const uncommittedFiles = uncommittedStatus.split('\n').filter(l => l.trim()).length

  if (!existsSync(SIGNAL_DIR)) mkdirSync(SIGNAL_DIR, { recursive: true })

  const signalName = `agent-uncommitted-${agent.key}-${slug.replace(/\//g, '-')}`
  const signalPath = join(SIGNAL_DIR, signalName)
  const signal = {
    detected: new Date().toISOString(),
    worktreePath,
    uncommittedFiles,
    uncommittedStatus,
    issue: issueNum || null,
    slug,
    agent: agent.key,
  }

  await Bun.write(signalPath, JSON.stringify(signal, null, 2))
  console.error(`[commit-enforcement] ${uncommittedFiles} uncommitted files by ${agent.key} in ${worktreePath}`)
  console.log(`\n<system-reminder>${agent.name} UNCOMMITTED CHANGES: ${agent.name} left ${uncommittedFiles} uncommitted file(s) in worktree ${worktreePath}. Review and commit before proceeding. Signal written to ${signalPath}.</system-reminder>`)

  process.exit(0)
}

main()
