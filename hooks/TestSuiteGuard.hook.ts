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
import { deriveRunId, deriveWorkerId, evaluateFullSuiteRequest } from '../lib/test-suite-lock';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const command = (input.tool_input?.command as string) || '';
  const sessionId = input.session_id || 'default';
  // Sub-agents inherit the parent's session_id, so the rate budget has to be
  // keyed on the worker — session plus working directory (#239). The release
  // hook derives the same identity; acquire and release must agree.
  const workerId = deriveWorkerId(sessionId, input.cwd);
  // ...and the run the worker belongs to, which is the bound #239's fix left
  // open: every agent in a ship run got its own four. Null outside a run
  // worktree, and then only the per-worker rate applies (#194).
  const runId = deriveRunId(input.cwd) ?? undefined;

  // Fails open: a broken guard must never be able to block the suite it
  // guards. It does NOT fail silently, which is a different thing and was the
  // defect — a guard whose broken state and whose satisfied state look
  // identical cannot be known to have ever fired (#194 SC-642).
  try {
    // `cwd` decides whose repository this suite belongs to (#510). A full
    // suite of a scratch tree — a reviewer's `git archive` export, a fixture
    // repo — is twenty tests and under a second, and charging it against a
    // budget sized for this repository's 400-second run made careful review
    // the thing the guard rationed.
    const decision = evaluateFullSuiteRequest(sessionId, command, {
      workerId,
      runId,
      cwd: input.cwd,
    });
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
  } catch (e) {
    // systemMessage, not stderr: stderr from a hook that exits 0 is only
    // visible under --debug, so printing there is the same silence with extra
    // steps.
    console.log(JSON.stringify({
      systemMessage:
        `GUARD-FAILURE-VISIBLE: TestSuiteGuard could not evaluate this full-suite request ` +
        `and allowed it. DIR-L29 is NOT being enforced right now. ` +
        `${(e as Error)?.message ?? e}`,
    }));
    process.exit(0);
  }
}

main();
