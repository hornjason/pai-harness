#!/usr/bin/env bun
/**
 * CommitEnforcement.hook.ts — PostToolUse on Agent
 *
 * TRIGGER: PostToolUse (matcher: Agent)
 *
 * Detects two conditions in code agent worktrees after agent completion:
 * 1. UI file changes — writes quinn-required tripwire for quinn-on-ui-change gate
 * 2. Uncommitted changes — writes agent-uncommitted tripwire signal
 *
 * Broadened from Marcus-only to all code agents (marcus, quinn, rook, serena, aditi).
 *
 * Issue: #361, #343
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { findWorkflowForIssue, extractIssueNumber } from './lib/findWorkflow'
import { WORK_DIR, SIGNAL_DIR } from './lib/paths'
import { parseHookInput } from './lib/parseStdin';
import { detectAgent } from './lib/agentDetection'


async function main() {
  const payload = await parseHookInput()
  if (!payload) process.exit(0)

  // Only trigger on Agent tool
  if (payload?.tool_name !== 'Agent') process.exit(0)

  const toolInput = payload.tool_input || {}

  // Detect any known code agent — shared logic via lib/agentDetection
  const agent = detectAgent(toolInput)

  if (!agent) process.exit(0)  // Not a known agent — skip

  // Only check worktree-isolated agents
  if (toolInput.isolation !== 'worktree') process.exit(0)

  // Extract worktree path from response
  const resp = payload.tool_response
  const respText = typeof resp === 'string' ? resp : (resp?.content || '')
  let worktreePath: string | null = null

  // Try regex on response text
  const pathMatch = respText.match(/(?:\/[^\s]*worktrees\/agent-[a-f0-9]+[^\s]*)/i)
  if (pathMatch) {
    worktreePath = pathMatch[0]
  }

  // Fallback: scan worktrees directory for most recently modified
  if (!worktreePath) {
    const wtBase = join(process.env.HOME!, '.claude', '.claude', 'worktrees')
    try {
      const entries = readdirSync(wtBase, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('agent-'))
        .map(e => ({ name: e.name, mtime: statSync(join(wtBase, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (entries.length > 0) {
        worktreePath = join(wtBase, entries[0].name)
      }
    } catch {}
  }

  if (!worktreePath || !existsSync(worktreePath)) process.exit(0)

  // Resolve slug early — needed by both UI detection and uncommitted-changes tripwire
  const issueNum = extractIssueNumber(toolInput.prompt || '')
  const wf = findWorkflowForIssue(issueNum)
  const slug = wf?.slug || issueNum || 'unknown'

  // ── UI file detection (runs independently of uncommitted check) ──
  const uiExtensions = /\.(tsx|jsx|css|scss|html|svg|less)$/i
  let uiFiles: string[] = []
  try {
    const diffOutput = execSync(`git -C "${worktreePath}" diff --name-only main 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000
    }).trim()
    if (diffOutput) {
      uiFiles = diffOutput.split('\n').filter(f => uiExtensions.test(f))
    }
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
    uncommittedStatus = execSync(`git -C "${worktreePath}" status --porcelain`, {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
  } catch {
    process.exit(0)
  }

  // No uncommitted changes — all clean
  if (!uncommittedStatus) process.exit(0)

  const uncommittedFiles = uncommittedStatus.split('\n').filter(l => l.trim()).length

  // Write tripwire signal
  if (!existsSync(SIGNAL_DIR)) {
    mkdirSync(SIGNAL_DIR, { recursive: true })
  }

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
