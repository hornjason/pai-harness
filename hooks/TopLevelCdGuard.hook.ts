#!/usr/bin/env bun
/**
 * TopLevelCdGuard.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): no hook exceeds 150 lines
 *
 * The decision lives in lib/top-level-cd.ts and not here — hooks are thin
 * triggers (HOOK-ARCHITECTURE-SPEC), the same shape as VerifyPhaseLock over
 * lib/issue-create-override.ts and BashToolGuard over lib/bash-file-read.ts.
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
 * ## What changed while it stayed inert
 *
 * It can now WARN. Before, it emitted `{decision:'block'}` unconditionally,
 * so "register it as a warning" — the option endorsed on the issue, and the
 * first rung of the WARN→data→FAIL ladder in
 * `specs/harness-automation-matrix.md` — was not a thing anyone could
 * choose without rewriting the hook on the day of the decision. `warn` is
 * the default; `RUNGATE_CD_GUARD=block` opts into refusal and `=off`
 * silences it. See `cdGuardMode` for the 32.7%-of-31,577 measurement that
 * makes a hard refusal the wrong first rung.
 *
 * It is also SCOPED to harnessed projects via `lib/harness-project.ts`, the
 * same decider `BashToolGuard` uses. A top-level `cd` costs something only
 * in a session with concurrent agents holding worktrees; firing everywhere
 * to protect the minority of sessions where it matters is mis-scoped.
 *
 * Neither change registers anything. Both exist so the decision is a
 * configuration choice rather than a code change made under time pressure.
 *
 * The parse, and what it cannot see, is `lib/top-level-cd.ts`. Read its
 * WHAT THIS DOES NOT COVER block before trusting this to stop anything.
 *
 * Issue: #992
 */

import { parseHookInput } from './lib/parseStdin';
import { cdGuardMode, topLevelCdRefusal } from '../lib/top-level-cd';
import { isHarnessProject } from '../lib/harness-project';

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  if (payload.tool_name !== 'Bash') process.exit(0);

  // Scope before parse: outside a harnessed project there are no peer
  // worktrees to kill, so there is nothing for this to protect.
  if (!isHarnessProject(process.cwd())) process.exit(0);

  const { mode, unrecognised } = cdGuardMode();
  if (mode === 'off') process.exit(0);

  const refusal = topLevelCdRefusal(payload.tool_input?.command || '');
  if (refusal === null) process.exit(0);

  const note = unrecognised
    ? `\n(${'RUNGATE_CD_GUARD'}=${JSON.stringify(unrecognised)} is not a mode I know; warning instead of refusing.)`
    : '';

  if (mode === 'block') {
    console.log(JSON.stringify({ decision: 'block', reason: refusal.message + note }));
    process.exit(0);
  }

  // WARN: the command RUNS. Written to stderr so it reaches the transcript
  // without becoming a tool result the model might read as a refusal.
  console.error(`[top-level-cd] ${refusal.message}${note}`);
  process.exit(0);
}

main();
