#!/usr/bin/env bun
/**
 * AutoVerifyGate.hook.ts — PostToolUse on Agent
 *
 * When Marcus/Quinn/Rook agent returns:
 * 1. Find active workflow-state.json in BUILD/VERIFY phase
 * 2. Write agents.<key>.verdict based on response content
 * 3. For Marcus: emit system-reminder to run verify gate
 * 4. For Quinn/Rook: record verdict only
 */

import { writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { parseHookInput, detectAgent, findWorkflowState, extractIssueNumber, WORK_DIR, HARNESS_ROOT } from './lib/utils';

function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, path);
}

const NEGATIVE_PATTERNS = [
  /\b(no|zero|0)\s+(error|fail)/i,
  /\bfixed\s+the\s+(error|fail|bug|issue)/i,
  /\bpreviously\s+failed.*now\s+pass/i,
  /\b0\s+error/i, /\berror.*resolved/i, /\bno\s+failures/i,
  /\bfail(ure)?s?\s*:\s*0\b/i, /\berrors?\s*:\s*0\b/i,
];

async function main() {
  const payload = await parseHookInput();
  if (!payload || payload.tool_name !== 'Agent') process.exit(0);

  const toolInput = payload.tool_input || {};
  const agent = detectAgent(toolInput);
  if (!agent) process.exit(0);

  const { key } = agent;
  const expectedPhase = key === 'marcus' ? 'BUILD' : 'VERIFY';
  const issueNum = extractIssueNumber(toolInput.prompt || '');
  const wf = findWorkflowState(issueNum, [expectedPhase]);
  if (!wf) { console.error('[auto-verify] No active workflow — skipping'); process.exit(0); }

  if (wf.data.phase !== expectedPhase) {
    console.error(`[auto-verify] Phase is ${wf.data.phase}, not ${expectedPhase} — skipping`);
    process.exit(0);
  }

  const resp = payload.tool_response;
  const respContent = typeof resp === 'string' ? resp : (resp?.content || resp?.output || '');
  const hasNeg = NEGATIVE_PATTERNS.some(p => p.test(respContent));
  const respLower = respContent.toLowerCase();
  const verdict = hasNeg ? 'PASS'
    : (respLower.includes('error') || respLower.includes('failed')) ? 'FAIL'
    : 'PASS';

  const state = wf.data;
  state.agents = state.agents || {};
  state.agents[key] = { verdict, completedTs: new Date().toISOString() };
  state.updatedTs = new Date().toISOString();

  const sfPath = join(WORK_DIR, wf.slug, 'workflow-state.json');
  try { atomicWrite(sfPath, JSON.stringify(state, null, 2)); } catch {
    console.error('[auto-verify] Failed to write workflow-state.json');
    process.exit(0);
  }

  console.error(`[auto-verify] ${key} verdict: ${verdict}`);
  if (key === 'marcus') {
    console.log(`\n<system-reminder>AUTO-VERIFY TRIGGERED: Run this command NOW:\nbun run ${HARNESS_ROOT}/gates/run-gate.ts --gate verify --slug ${wf.slug}\nDo NOT skip — auto-verify detected Marcus completion.</system-reminder>`);
  } else {
    console.log(`\n<system-reminder>${key} verdict recorded: ${verdict}. No gate trigger — ${key} runs are part of verification.</system-reminder>`);
  }
}

main();
