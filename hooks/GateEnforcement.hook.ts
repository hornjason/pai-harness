#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 * TRIGGER: PreToolUse (matcher: ".*")
 * Thin trigger: delegates to lib/gate-enforcement.ts. Issue: #544
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import {
  buildGatePending,
  findWorkflowGateFailure,
  loadStrikeCount,
  logSignal,
  makeEnforcementDecision,
} from '../lib/gate-enforcement';

const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');
const PENDING_FILE = join(BASE_DIR, 'MEMORY', 'STATE', 'gate-pending.json');

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  try {
    const wfFailure = findWorkflowGateFailure(WORK_DIR);
    if (!wfFailure) {
      if (existsSync(PENDING_FILE)) { try { unlinkSync(PENDING_FILE); } catch {} }
      process.exit(0);
    }

    const strikeCount = loadStrikeCount(PENDING_FILE, wfFailure.issue, wfFailure.gate);
    const pending = buildGatePending(wfFailure, input.session_id || '', strikeCount);
    const toolName = input.tool_name || '';
    const decision = makeEnforcementDecision(pending, toolName);

    if (decision.action === 'block') {
      console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
      logSignal(SIGNALS_DIR, SIGNALS_FILE, {
        ts: new Date().toISOString(), type: 'gate_enforcement',
        gate: pending.gate, issue: pending.issue, strike: pending.strike_count,
        tool: toolName, action: 'block',
        reason: pending.outcome_ac_failure ? 'outcome_ac_failure' : 'max_strikes',
      });
      process.exit(0);
    }

    console.log(decision.reminder);
    if (toolName === 'Skill') {
      try {
        writeFileSync(PENDING_FILE, JSON.stringify(
          { ...pending, strike_count: decision.newStrikeCount }, null, 2
        ), 'utf-8');
      } catch {}
    }

    logSignal(SIGNALS_DIR, SIGNALS_FILE, {
      ts: new Date().toISOString(), type: 'gate_enforcement',
      gate: pending.gate, issue: pending.issue,
      strike: decision.newStrikeCount, tool: toolName, action: 'nag',
    });
    process.exit(0);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
    process.exit(0);
  }
}

main();
