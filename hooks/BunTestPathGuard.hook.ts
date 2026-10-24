#!/usr/bin/env bun
/**
 * BunTestPathGuard.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): no hook exceeds 150 lines
 * SC-2543 (HOOK-ARCHITECTURE-SPEC): the guard is registered in all four positions
 *
 * The decision lives in lib/bun-test-paths.ts and not here — hooks are thin
 * triggers (HOOK-ARCHITECTURE-SPEC), the same shape as TopLevelCdGuard over
 * lib/top-level-cd.ts and BashToolGuard over lib/bash-file-read.ts.
 *
 * Refuses a Bash command that hands `bun test` a path matching no file.
 *
 * Why a hook and not a sentence. `bun test <real> <absent>` exits 0 and
 * prints a pass total, so a typo'd path in a verification command is
 * byte-identical to a suite that ran and passed. On 2026-10-24 an agent
 * shipping #1536 reported six suites green; one of the six did not exist and
 * had never been opened. The agent self-reported it, which is the only
 * reason it is written down — an instruction to check the file count would
 * have had to be followed by the one person who already believed they had.
 *
 * Why the Bash tool and not a wrapper. 55 sites in this tree execute
 * `bun test` with a path argument and 49 are inside `test/`; a wrapper
 * covers none of them until each is rewritten, and covers a hand-composed
 * command never. The failure this exists for was in a command an agent
 * composed by hand, so the binding has to be the one chokepoint those pass
 * through. The known gap is the reverse: a spawn from inside a running
 * process never reaches a PreToolUse hook. Both halves are stated in
 * lib/bun-test-paths.ts under WHAT THIS DOES NOT COVER.
 *
 * It is registered at PROJECT scope, like TopLevelCdGuard:
 * `${CLAUDE_PROJECT_DIR}` resolves to the worktree a session is in, every
 * worktree carries the committed `.claude/settings.json`, and a targeted
 * test run is a harness concern. Machine-wide registration lives in
 * `~/.claude/settings.json`, which no PR can carry.
 *
 * SCOPED to harnessed projects via lib/harness-project.ts, the same decider
 * TopLevelCdGuard and BashToolGuard use.
 *
 * Issue: #1544
 */

import { parseHookInput } from './lib/parseStdin';
import {
  BUN_TEST_PATH_GUARD_DECISION,
  bunTestPathGuardMode,
  bunTestPathRefusal,
} from '../lib/bun-test-paths';
import { isHarnessProject } from '../lib/harness-project';

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  if (payload.tool_name !== 'Bash') process.exit(0);

  // Scope before parse: outside a harnessed project this repo's verification
  // conventions do not apply and there is nothing for this to protect.
  // NARROWED, not `|| process.cwd()`: the payload field is untyped, and a
  // non-string reaching `resolve()` would throw inside the guard and be
  // swallowed by the fail-open below — a guard that silently stops firing.
  const declared = payload.cwd;
  const cwd = typeof declared === 'string' && declared !== '' ? declared : process.cwd();
  if (!isHarnessProject(cwd)) process.exit(0);

  const { mode, unrecognised } = bunTestPathGuardMode();
  if (mode === 'off') process.exit(0);

  // Fails open on an unexpected error, and says so. A broken guard must never
  // be able to block every `bun test` in the repository — but it must not be
  // able to do that SILENTLY either, which is a different thing and is the
  // defect TestSuiteGuard's #194 found in itself.
  let refusal: ReturnType<typeof bunTestPathRefusal>;
  try {
    refusal = bunTestPathRefusal(payload.tool_input?.command, cwd);
  } catch (e) {
    console.log(JSON.stringify({
      systemMessage:
        `GUARD-FAILURE-VISIBLE: BunTestPathGuard could not evaluate this command and ` +
        `allowed it. #1544 is NOT being enforced right now. ${(e as Error)?.message ?? e}`,
    }));
    process.exit(0);
  }

  if (refusal === null) process.exit(0);

  const note = unrecognised
    ? `\n(${'RUNGATE_BUN_TEST_PATH_GUARD'}=${JSON.stringify(unrecognised)} is not a mode I know; refusing, which is the default.)`
    : '';

  if (mode === 'block') {
    console.log(JSON.stringify({
      decision: BUN_TEST_PATH_GUARD_DECISION,
      reason: refusal.message + note,
    }));
    process.exit(0);
  }

  // WARN: the command RUNS. stderr, so it reaches the transcript without
  // becoming a tool result the model might read as a refusal.
  console.error(`[bun-test-path] ${refusal.message}${note}`);
  process.exit(0);
}

main();
