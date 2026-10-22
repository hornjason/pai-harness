#!/usr/bin/env bun
/**
 * GateResultProtection.hook.ts — PreToolUse on Write + Edit
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * TRIGGER: PreToolUse (matcher: Write, Edit)
 *
 * PURPOSE:
 * Block direct writes to workflow-state.json that modify gate result fields.
 * Gate results must be produced by gate-runner.ts, not written directly.
 *
 * PROTECTED FIELDS:
 *  - gates.scope.result, gates.verify.result, gates.ship.result
 *  - phase = "DONE" (only gate-runner advances to DONE)
 *
 * ALLOWED:
 *  - Writes that don't target workflow-state.json
 *  - Writes to workflow-state.json that don't touch gate result fields
 *    (e.g., adding ACs, updating changelog, setting phase to BUILD/SCOPE/VERIFY)
 *
 * PORTABILITY (#713): `workflow-state.json` is a rungate gate artifact and the
 * only import is `./lib/parseStdin`. No PAI-owned path is read, so this guards
 * the same artifact on a consumer repo as it does here.
 *
 * Issue: #471
 */

import { parseHookInput } from './lib/parseStdin';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  // Only check Write and Edit targeting workflow-state.json
  const filePath: string = (toolInput.file_path as string) || '';
  if (!filePath.endsWith('workflow-state.json')) {
    process.exit(0);
  }

  let blocked = false;
  let reason = '';

  if (toolName === 'Write') {
    // For Write: parse the content parameter as JSON, check gate fields
    const content: string = (toolInput.content as string) || '';
    try {
      const parsed = JSON.parse(content);
      const hasGateResult =
        parsed.gates?.scope?.result ||
        parsed.gates?.verify?.result ||
        parsed.gates?.ship?.result;
      const hasDonePhase = parsed.phase === 'DONE';

      if (hasGateResult || hasDonePhase) {
        blocked = true;
        reason = hasGateResult
          ? 'Gate results must be produced by gate-runner.ts, not written directly.'
          : 'Phase DONE must be set by gate-runner.ts after ship gate passes.';
      }
    } catch {
      // Not valid JSON — allow (might be a partial write or non-JSON content)
    }
  } else if (toolName === 'Edit') {
    // For Edit: check if new_string contains gate result patterns
    const newString: string = (toolInput.new_string as string) || '';
    const gateResultPattern =
      newString.includes('"result": "PASS"') ||
      newString.includes('"result": "FAIL"') ||
      newString.includes('"result":"PASS"') ||
      newString.includes('"result":"FAIL"');
    const donePhasePattern =
      newString.includes('"phase": "DONE"') || newString.includes('"phase":"DONE"');

    if (gateResultPattern || donePhasePattern) {
      blocked = true;
      reason = gateResultPattern
        ? 'Gate results must be produced by gate-runner.ts, not written directly.'
        : 'Phase DONE must be set by gate-runner.ts after ship gate passes.';
    }
  }

  if (blocked) {
    console.log(JSON.stringify({ decision: 'block', reason }));
  }
  // If not blocked, exit silently (allow)
  process.exit(0);
}

main().catch(() => process.exit(0));
