#!/usr/bin/env bun
/**
 * TopLevelCdGuard.hook.ts — PreToolUse on Bash
 *
 * SC-368 (HOOK-ARCHITECTURE-SPEC): the decision lives in lib/, not here
 * SC-370 (HOOK-ARCHITECTURE-SPEC): hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): no hook exceeds 150 lines
 *
 * Refuses a Bash command whose TOP LEVEL begins with or chains to `cd`.
 *
 * Why a hook and not a sentence. A top-level `cd` moves the SESSION's primary
 * working directory, and the agent runtime resolves `isolation: 'worktree'`
 * against that directory — so a `cd` out of the repo kills another agent's
 * worktree creation hours later, with no error naming the cause. The prose
 * rule existed, at maximum emphasis, at the top of every brief. On 2026-10-21
 * four independent actors broke it in one evening, including the person who
 * wrote it and the agent that built this hook. The conclusion was not to state
 * it more loudly: `VerifyPhaseLock` holds because it is not advice.
 *
 * NOT REGISTERED. This hook is deliberately inert — registering it changes
 * behaviour for every session on this machine and needs Jason's sign-off,
 * which has not been given (#992's scope note). It appears in no settings
 * file and in no hooks registry. The registration step is the remaining
 * action, recorded on the PR.
 *
 * The parse, and what it cannot see, is `lib/top-level-cd.ts`. Read its
 * WHAT THIS DOES NOT COVER block before trusting this to stop anything.
 *
 * Issue: #992
 */

import { parseHookInput } from './lib/parseStdin';
import { topLevelCdRefusal } from '../lib/top-level-cd';

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  if (payload.tool_name !== 'Bash') process.exit(0);

  const refusal = topLevelCdRefusal(payload.tool_input?.command || '');
  if (refusal === null) process.exit(0);

  console.log(JSON.stringify({ decision: 'block', reason: refusal.message }));
  process.exit(0);
}

main();
