#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 *
 * SC-369 (HOOK-ARCHITECTURE-SPEC): hook under 100 lines, logic in lib/
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 *
 * TRIGGER: PreToolUse (matcher: ".*" — fires on every tool call)
 *
 * PURPOSE:
 * When a harness gate fails, nag the DA on every tool call until fixed.
 * After max_strikes, block Skill calls (Bash/Read/Agent still work for fixing).
 * OUTCOME AC failures get immediate block — no strike counting.
 *
 * This file is a trigger only: parse stdin, call runGateEnforcement, print,
 * exit 0. Every decision — strike counting, block vs nag, signal logging, the
 * doc-hygiene sweep — lives in lib/gate-enforcement.ts, where it is reachable
 * from a test without simulating a PreToolUse payload (HOOK-ARCHITECTURE D-1).
 *
 * INPUT:
 *  - stdin: PreToolUse JSON payload { tool_name, tool_input, session_id, ... }
 *
 * OUTPUT:
 *  - stdout: JSON block decision OR system-reminder nag
 *  - stderr: status messages
 *  - exit(0): always
 */

import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import { runGateEnforcement } from '../lib/gate-enforcement';

const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  try {
    const { stdout } = runGateEnforcement({
      workDir: WORK_DIR,
      signalsDir: SIGNALS_DIR,
      signalsFile: join(SIGNALS_DIR, 'signals.jsonl'),
      pendingFile: join(BASE_DIR, 'MEMORY', 'STATE', 'gate-pending.json'),
      projectRoot: join(BASE_DIR, '..'),
      sessionId: input.session_id || '',
      toolName: input.tool_name || '',
    });
    if (stdout) console.log(stdout);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
  }

  process.exit(0);
}

main();
