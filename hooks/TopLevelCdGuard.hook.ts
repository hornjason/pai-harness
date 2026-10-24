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
 * REGISTERED, as a hard refusal, by #992. Jason's decision, taken against the
 * measurement on that issue — 32.7% of 31,577 recorded commands carry a
 * top-level `cd`, so this fires often, and that is the point rather than an
 * argument against it. The registration is four positions and they must agree
 * (`.claude/rules/self-referential-tests.md`): this comment's `SC-` ids,
 * `.claude/rungate/hooks.json`, the current-state table in
 * `specs/HOOK-ARCHITECTURE-SPEC.md`, and `.claude/settings.json`.
 *
 * ## NOT LIVE. User scope since #1578, and why the first classification was wrong
 *
 * #992 registered this at PROJECT scope, reasoning that `${CLAUDE_PROJECT_DIR}`
 * resolves to the worktree a session is in, that every worktree carries the
 * committed `.claude/settings.json`, and that worktree isolation is a harness
 * concern. **The second clause is true and the conclusion does not follow.**
 *
 * Measured on 2026-10-24 in a worktree whose committed `.claude/settings.json`
 * registered this hook: three bare `cd` calls were NOT refused, while a
 * user-scoped COMP-7 refusal fired on the same `Bash` matcher in the same
 * session. The decider returns `block` when invoked by hand from that cwd;
 * `isHarnessProject()` resolves; `RUNGATE_CD_GUARD` is unset. The worktree
 * carries the file. The session does not load it. So this hook has been
 * green, registered, tested and INERT since #1050 — which is #1578, and is
 * the purest form of *absence of evidence recorded as clean*.
 *
 * The scope follows from what a hook PROTECTS. This one protects the
 * SESSION's primary working directory — the directory `isolation: 'worktree'`
 * resolves against — and a session may be rooted anywhere while working on
 * this repo, including via an added working directory. That is machine-wide
 * state, so SC-518 governs it: machine-wide hooks live in user settings,
 * because project settings only load for sessions started in that directory.
 * It was misclassified from the start.
 *
 * Two consequences, both deliberate:
 *
 * - The repo no longer registers it in `.claude/settings.json`. SC-518 says
 *   the two scopes are not de-duplicated, so leaving it there would fire the
 *   hook twice once the real registration exists.
 * - `test/hook-registration-reconciler.test.ts` now reports it UNMEASURED on
 *   every run, and that reading is the deliverable rather than a loss. A test
 *   saying *this cannot be verified here* beats one reporting a registration
 *   nobody loads as satisfied.
 *
 * **Live registration in `~/.claude/settings.json` is a human action, is
 * outside every agent's permitted scope, and is STILL PENDING.** Merging this
 * does not switch the guard on. Until a human does that, this hook refuses
 * nothing.
 *
 * ## The rung, and what #1040 left behind
 *
 * #1040 built the ladder — `RUNGATE_CD_GUARD` reads `warn` | `block` | `off`
 * — and took no rung, so the decision would be a configuration choice rather
 * than a code change made under pressure. The choice has now been made and
 * it is `block`: `cdGuardMode`'s default moved, so the hook refuses unless a
 * caller opts out. `warn` and `off` are both still reachable, which is what
 * makes this reversible without touching code.
 *
 * It is SCOPED to harnessed projects via `lib/harness-project.ts`, the same
 * decider `BashToolGuard` uses — #1040's scoping, unchanged. A top-level
 * `cd` costs something only in a session with concurrent agents holding
 * worktrees.
 *
 * ## What this will cost, measured rather than guessed
 *
 * 21 Bash commands in this repo's own agent prompts — `workflows/ship.js`,
 * `prove.js`, `verify.js` — open with a top-level `cd` and are refused by
 * this guard. Those workflows are not in use (`.claude/rules/ship-workflow.md`,
 * direct-ship mode since 2026-10-19) and the count is on #992's PR, but it is
 * the first thing to fix if harness mode comes back. `git -C`, a subshell and
 * `bun --cwd` are each a one-line change at those sites.
 *
 * The parse, and what it cannot see, is `lib/top-level-cd.ts`. Read its
 * WHAT THIS DOES NOT COVER block before trusting this to stop anything.
 *
 * Issue: #992
 */

import { parseHookInput } from './lib/parseStdin';
import { CD_GUARD_DECISION, cdGuardMode, topLevelCdRefusal } from '../lib/top-level-cd';
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

  // The raw value, NOT `|| ''`. An absent command is unreadable, and the one
  // decider refuses it rather than letting the guard pass over nothing.
  const refusal = topLevelCdRefusal(payload.tool_input?.command);
  if (refusal === null) process.exit(0);

  const note = unrecognised
    ? `\n(${'RUNGATE_CD_GUARD'}=${JSON.stringify(unrecognised)} is not a mode I know; refusing, which is the default.)`
    : '';

  // `mode` is the configured RUNG and `CD_GUARD_DECISION` is the field the
  // hook protocol reads. They spell the same word today and are not the same
  // fact — collapsing them would break the rung if the protocol ever renamed
  // its verdict — so they stay two names.
  if (mode === 'block') {
    console.log(JSON.stringify({ decision: CD_GUARD_DECISION, reason: refusal.message + note }));
    process.exit(0);
  }

  // WARN: the command RUNS. Written to stderr so it reaches the transcript
  // without becoming a tool result the model might read as a refusal.
  console.error(`[top-level-cd] ${refusal.message}${note}`);
  process.exit(0);
}

main();
