#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 *
 * TRIGGER: PreToolUse (matcher: ".*" — fires on every tool call)
 *
 * Thin trigger — all logic lives in lib/gate-enforcement.ts (D-1, D-2).
 * Detects gate failures, delegates decision to lib, outputs result.
 *
 * Issue: #544
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import {
  findWorkflowGateFailure,
  makeEnforcementDecision,
  formatFailures,
  logSignal,
  loadCachedStrikeCount,
  type GatePending,
} from '../lib/gate-enforcement';

const STATE_DIR = join(BASE_DIR, 'MEMORY', 'STATE');
const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const PENDING_FILE = join(STATE_DIR, 'gate-pending.json');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');
const MAX_STRIKES = 3;

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  try {
    const wfFailure = findWorkflowGateFailure(WORK_DIR);
    if (!wfFailure) {
      if (existsSync(PENDING_FILE)) {
        try { unlinkSync(PENDING_FILE); } catch {}
      }
      process.exit(0);
    }

    const strikeCount = loadCachedStrikeCount(PENDING_FILE, wfFailure.issue, wfFailure.gate);
    const toolName = input.tool_name || '';
    const decision = makeEnforcementDecision(wfFailure, toolName, strikeCount, MAX_STRIKES);

    if (decision.action === 'block') {
      console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
      logSignal(SIGNALS_DIR, SIGNALS_FILE, {
        ts: new Date().toISOString(), type: 'gate_enforcement',
        gate: decision.gate, issue: decision.issue,
        strike: strikeCount, tool: toolName, action: 'block',
        reason: wfFailure.hasOutcomeAcFailure ? 'outcome_ac_failure' : 'max_strikes',
      });
      console.error(`[GateEnforcement] BLOCKED ${toolName} — ${decision.gate}`);
      process.exit(0);
    }

    // Nag — inject system-reminder
    const failureText = formatFailures(wfFailure.failures);
    const reminder = [
      '<system-reminder>',
      `⚠️ GATE FAIL (${decision.gate}): issue #${decision.issue}`,
      failureText,
      `Strike ${decision.newStrikeCount}/${MAX_STRIKES}. Fix before proceeding or post skip-reason to issue.`,
      '</system-reminder>',
    ].join('\n');
    console.log(reminder);

    if (toolName === 'Skill') {
      const pending: GatePending = {
        session_id: input.session_id || '', gate: wfFailure.gate,
        issue: wfFailure.issue, slug: wfFailure.slug,
        failures: wfFailure.failures, strike_count: decision.newStrikeCount,
        max_strikes: MAX_STRIKES, outcome_ac_failure: wfFailure.hasOutcomeAcFailure,
        created_at: new Date().toISOString(), expires_ts: Date.now() + (4 * 60 * 60 * 1000),
      };
      try { writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf-8'); } catch {}
    }

    logSignal(SIGNALS_DIR, SIGNALS_FILE, {
      ts: new Date().toISOString(), type: 'gate_enforcement',
      gate: decision.gate, issue: decision.issue,
      strike: decision.newStrikeCount, tool: toolName, action: 'nag',
    });
    console.error(`[GateEnforcement] Nag — strike ${decision.newStrikeCount}/${MAX_STRIKES} on ${decision.gate}`);
    process.exit(0);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
    process.exit(0);
  }
}

main();
