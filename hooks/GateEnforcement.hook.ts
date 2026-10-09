#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 *
 * SC-369 (HOOK-ARCHITECTURE-SPEC): GateEnforcement line count target
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 *
 * TRIGGER: PreToolUse (matcher: ".*" — fires on every tool call)
 *
 * PURPOSE:
 * When a harness gate fails, nag the DA on every tool call until fixed.
 * After max_strikes, block Skill calls (Bash/Read/Agent still work for fixing).
 * OUTCOME AC failures get immediate block — no strike counting.
 *
 * BEHAVIOR:
 *  1. Read MEMORY/STATE/gate-pending.json — if missing/expired → exit 0
 *  2. Cross-session guard: if pending session_id ≠ current → exit 0
 *  3. outcome_ac_failure → immediate block on Skill calls
 *  4. Skill + strike_count >= max_strikes → block
 *  5. Otherwise → nag (system-reminder), increment strike_count
 *  6. Write updated strike_count back
 *  7. Log to MEMORY/LEARNING/SIGNALS/signals.jsonl
 *
 * INPUT:
 *  - stdin: PreToolUse JSON payload { tool_name, tool_input, session_id, ... }
 *
 * OUTPUT:
 *  - stdout: JSON block decision OR system-reminder nag
 *  - stderr: status messages
 *  - exit(0): always
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import {
  buildGatePending,
  findWorkflowGateFailure,
  loadStrikeCount,
  logDocHygieneSignals,
  logEnforcementSignal,
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
      logEnforcementSignal(SIGNALS_DIR, SIGNALS_FILE, pending, toolName, 'block', pending.strike_count);
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

    logEnforcementSignal(SIGNALS_DIR, SIGNALS_FILE, pending, toolName, 'nag', decision.newStrikeCount);
    // SC-508: doc-hygiene signal check — log findings for promotion tracking
    logDocHygieneSignals(SIGNALS_DIR, SIGNALS_FILE, join(BASE_DIR, '..'));

    process.exit(0);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
    process.exit(0);
  }
}

main();
