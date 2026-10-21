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
 *
 * REGISTERED, in user scope. The header this replaced carried #898's
 * unregistered declaration and said the TTL backstop above had been the only
 * mechanism since #67. That was false in both of its claims. Measured
 * 2026-10-21 by parsing `~/.claude/settings.json`:
 *
 *   PostToolUse  matcher='Bash'  bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts
 *
 * #898's census counted THIS REPOSITORY's registries and read zero as
 * absence; "registered nowhere" is a claim about every scope. The repo's own
 * `test/test-suite-guard-registration.test.ts` has asserted the opposite since
 * #67-A and was green the whole time. `lib/hook-scopes.ts` is the reading that
 * now cannot be taken from one scope (#713, #910).
 *
 * ## Execution evidence, which was the part nobody could check
 *
 * This hook used to write nothing. So "did it release the slot?" had no
 * answer available to any search, and an absent slot file was equally
 * consistent with a release that fired and a TTL that expired. Every decision
 * on a full-suite command now leaves a record in `hook-firings.jsonl` under
 * the rungate work dir -- `released`, `declined-background`, or
 * `release-failed`.
 *
 * Only full-suite commands are recorded. This hook is attached to EVERY Bash
 * call in every session, and a record per call is a file nobody can read.
 */

import { parseHookInput } from './lib/utils';
import { deriveWorkerId, isFullSuiteCommand, releaseFullSuiteSlot } from '../lib/test-suite-lock';
import { recordHookFiring } from '../lib/hook-evidence';

const HOOK = 'TestSuiteRelease';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const command = (input.tool_input?.command as string) || '';
  const sessionId = input.session_id || 'default';

  try {
    // Out of population: not a full suite, so this hook has nothing to say
    // about it and records nothing. Everything below IS in population, and
    // every path out of it leaves a record -- a decline and a hook that never
    // ran are otherwise the same observation, which is #910.
    if (!isFullSuiteCommand(command)) process.exit(0);

    // A backgrounded Bash call returns immediately while the suite keeps
    // running. Releasing here would hand the slot back mid-run and restore the
    // concurrency the guard exists to prevent. Let the TTL reclaim it instead.
    if (input.tool_input?.run_in_background) {
      recordHookFiring(HOOK, 'declined-background', { command, sessionId, cwd: input.cwd });
      process.exit(0);
    }

    // Same derivation as the guard (#239): a release that named only the
    // session could free a sibling worker's slot while its suite still runs.
    const workerId = deriveWorkerId(sessionId, input.cwd);
    releaseFullSuiteSlot(sessionId, { workerId });
    recordHookFiring(HOOK, 'released', { command, sessionId, workerId, cwd: input.cwd });
  } catch (e) {
    // A failed release is recovered by the TTL; never surface it as a tool
    // error. It IS recorded: a release that threw and a release that never
    // happened leave the same empty lock dir behind.
    recordHookFiring(HOOK, 'release-failed', { command, sessionId, error: String(e) });
    process.exit(0);
  }
}

main();
