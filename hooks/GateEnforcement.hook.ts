#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 *
 * TRIGGER: PreToolUse (matcher: ".*" — fires on every tool call)
 *
 * Thin trigger — all logic delegated to lib/gate-enforcement.ts
 * per Hook Architecture Spec D-2.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import {
  findWorkflowGateFailure,
  makeEnforcementDecision,
  logSignal,
  buildPendingRecord,
} from '../lib/gate-enforcement';

const STATE_DIR = join(BASE_DIR, 'MEMORY', 'STATE');
const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const PENDING_FILE = join(STATE_DIR, 'gate-pending.json');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  try {
    const wfFailure = findWorkflowGateFailure(WORK_DIR);
    if (!wfFailure) {
      if (existsSync(PENDING_FILE)) try { unlinkSync(PENDING_FILE); } catch {}
      process.exit(0);
    }

    // Load cached strike count
    let strikeCount = 0;
    if (existsSync(PENDING_FILE)) {
      try {
        const cached = JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
        if (cached.issue === wfFailure.issue && cached.gate === wfFailure.gate)
          strikeCount = cached.strike_count || 0;
      } catch {}
    }

    const toolName = input.tool_name || '';
    const decision = makeEnforcementDecision({
      gate: wfFailure.gate, issue: wfFailure.issue, slug: wfFailure.slug,
      failures: wfFailure.failures, hasOutcomeAcFailure: wfFailure.hasOutcomeAcFailure,
      strikeCount, maxStrikes: 3,
    }, toolName);

    console.log(decision.output);

    if (decision.action === 'nag' && toolName === 'Skill') {
      const pending = buildPendingRecord(wfFailure, decision.newStrikeCount, input.session_id);
      try { writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf-8'); } catch {}
    }

    logSignal({
      ts: new Date().toISOString(), type: 'gate_enforcement',
      gate: wfFailure.gate, issue: wfFailure.issue,
      strike: decision.newStrikeCount, tool: toolName, action: decision.action,
      ...(decision.reason ? { reason: decision.reason } : {}),
    }, SIGNALS_DIR, SIGNALS_FILE);

    process.exit(0);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
    process.exit(0);
  }
}

main();
