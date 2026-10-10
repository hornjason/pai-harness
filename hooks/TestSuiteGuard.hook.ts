#!/usr/bin/env bun
/**
 * TestSuiteGuard.hook.ts -- PreToolUse on Bash
 * SC-473, SC-370. Tier 3 mechanical enforcement for DIR-L29 + issue #67.
 *
 * Thin trigger: detect a full-suite Bash command, ask lib/test-suite-lock.ts,
 * report the verdict. Both the per-session budget and the cross-session
 * concurrency cap live in the lib module.
 */

import { parseHookInput } from './lib/utils';
import { evaluateFullSuiteRequest, workerIdFromHook } from '../lib/test-suite-lock';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const command = (input.tool_input?.command as string) || '';
  const sessionId = input.session_id || 'default';
  // Sub-agents share their parent's session_id, so the rate budget needs a
  // narrower key than the session or a fan-out spends one budget between all
  // of them (#239). Release must derive this the same way.
  const workerId = workerIdFromHook(input);

  // Fails open: a broken guard must never be able to block the suite it guards.
  try {
    const decision = evaluateFullSuiteRequest(sessionId, command, { workerId });
    if (!decision.allow) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: decision.reason,
      }));
    } else if (decision.warning) {
      // Allowed, but the cap is not being enforced. This must reach the
      // transcript: stderr from a hook that exits 0 is only visible under
      // --debug, so the earlier console.error was itself a silent fail-open.
      console.log(JSON.stringify({ systemMessage: decision.warning }));
    }
  } catch {
    process.exit(0);
  }
}

main();
