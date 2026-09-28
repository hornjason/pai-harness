#!/usr/bin/env bun
/**
 * AgentVerdictCapture.hook.ts — SubagentStop hook
 *
 * Parses agent output for structured verdict blocks.
 * Writes verdict, testedSha, testedPaths, spawned to workflow-state.json.
 * Auto-appends blockers to verifyBlockers[].
 * Runs transcript audit and writes compliance results.
 *
 * Issue: #439, #544 (extracted findActiveWorkflow + extractVerdict to lib/)
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { parseHookInput } from './lib/parseStdin';
import { detectAgent } from './lib/agentDetection';
import { runAgentAudit, populateBehavioralCache } from '../lib/agent-audit';
import { findActiveWorkflow, extractVerdict } from '../lib/verdict-capture';

const WORK_DIR = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');

function identifyRole(toolInput: any): string | null {
  const detected = detectAgent(toolInput);
  if (detected) return detected.key;
  const name = (toolInput.name || '').toLowerCase();
  if (name.startsWith('quinn')) return 'quinn';
  if (name.startsWith('marcus')) return 'marcus';
  if (name.startsWith('rook')) return 'rook';
  return null;
}

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  const toolInput = payload.tool_input || {};
  const role = identifyRole(toolInput);
  if (!role) process.exit(0);

  const wf = findActiveWorkflow(WORK_DIR);
  if (!wf) process.exit(0);

  const resp = payload.tool_response;
  const respText = typeof resp === 'string' ? resp : (resp?.output || JSON.stringify(resp) || '');
  const verdict = extractVerdict(respText);
  const state = wf.data;

  if (!state.agents) state.agents = {};
  if (!state.agents[role]) state.agents[role] = {};
  state.agents[role].spawned = true;

  if (verdict) {
    state.agents[role].verdict = verdict.verdict || verdict.result || null;
    if (verdict.testedSha) state.agents[role].testedSha = verdict.testedSha;
    if (verdict.testedPaths) state.agents[role].testedPaths = verdict.testedPaths;

    if (verdict.blockers && Array.isArray(verdict.blockers)) {
      if (!state.verifyBlockers) state.verifyBlockers = [];
      for (const b of verdict.blockers) {
        const id = b.id || `${role}-blocker-${state.verifyBlockers.length + 1}`;
        if (!state.verifyBlockers.some((vb: any) => vb.id === id)) {
          state.verifyBlockers.push({ id, description: b.description || b.detail || String(b), quinnReverified: false });
        }
      }
    }
  } else {
    state.agents[role].verdict = null;
  }

  const auditResult = runAgentAudit(payload.transcript_path, role);
  if (auditResult) {
    if (!state.audits) state.audits = {};
    state.audits[role] = auditResult;

    const projectRoot = process.env.RUNGATE_PROJECT_ROOT || join(WORK_DIR, '..');
    populateBehavioralCache(auditResult as any, projectRoot);
  }

  state.updatedTs = new Date().toISOString();
  writeFileSync(wf.path, JSON.stringify(state, null, 2));
  process.exit(0);
}

main();
