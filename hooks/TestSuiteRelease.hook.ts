#!/usr/bin/env bun
/**
 * TestSuiteRelease.hook.ts -- PostToolUse on Bash
 * Issue #67, SC-370.
 *
 * Thin trigger: when a full suite finishes, hand its concurrency slot back so
 * the next session is not stuck waiting out the 420s TTL after a ~190s run.
 *
 * The TTL is the backstop for when this never fires (crash, reboot, kill -9) --
 * it is what stops a dead session from wedging the repo, so slot correctness
 * does not depend on this hook running.
 */

import { parseHookInput } from './lib/utils';
import { deriveWorkerId, isFullSuiteCommand, releaseFullSuiteSlot } from '../lib/test-suite-lock';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const command = (input.tool_input?.command as string) || '';

  // A backgrounded Bash call returns immediately while the suite keeps running.
  // Releasing here would hand the slot back mid-run and restore the concurrency
  // the guard exists to prevent. Let the TTL reclaim it instead.
  if (input.tool_input?.run_in_background) process.exit(0);

  try {
    if (!isFullSuiteCommand(command)) process.exit(0);
    // Same derivation as the guard (#239): a release that named only the
    // session could free a sibling worker's slot while its suite still runs.
    const sessionId = input.session_id || 'default';
    const workerId = deriveWorkerId(sessionId, input.cwd);
    releaseFullSuiteSlot(sessionId, { workerId });
  } catch {
    // A failed release is recovered by the TTL; never surface it as a tool error.
    process.exit(0);
  }
}

main();
