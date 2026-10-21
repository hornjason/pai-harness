#!/usr/bin/env bun
/**
 * HookCurrency.hook.ts — report installed git hooks that are not what the
 * generator produces today (#879)
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * TRIGGER: SessionStart
 *
 * CADENCE, stated rather than implied: once per session. Not PreToolUse.
 * The reading costs a `git rev-parse`, two file reads and a string compare,
 * which is nothing per session and is noise on every tool call — and a
 * message an operator sees forty times an hour is a message they stop
 * reading, which is the failure mode this hook exists to avoid rather than
 * one it can afford to risk.
 *
 * #874 taught the check to read the hook git will actually run. #891 taught
 * it to read every hook the scaffold installs rather than one. Neither
 * reached anybody, because nothing ran it: the script had to be remembered,
 * and `.git/hooks/` is untracked, so a developer whose pre-commit predates a
 * fix has no position in the repository that can tell them. Measured on this
 * repository on 2026-10-21, both hooks were stale and had been for days.
 *
 * Thin trigger: every decision is `scripts/check-installed-hook-currency.ts`.
 * This file chooses a root, prints, and exits 0.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { repoRootFrom } from '../lib/paths';
import {
  readHookCurrency,
  currencyClass,
  currencyLines,
  defaultGeneratorRoot,
  REFUSAL_PREFIX,
} from '../scripts/check-installed-hook-currency';

/**
 * A SessionStart hook never fails the session. Every exit here is 0, and
 * that is the whole of #879's third criterion: a fresh clone, a CI checkout
 * and a tree whose hooks are perfect must all be survivable, so the only
 * thing this hook can do about a stale hook is SAY so.
 *
 * It is also why the refusal CLASS matters more here than the exit code.
 * With no class to read, "no pre-commit is installed" and "the pre-commit
 * that runs on every commit predates #728" would arrive under one label,
 * and the fresh clone's harmless reading would train the operator to
 * ignore the other one.
 */
function report(line: string): void {
  console.log(line);
}

const PROJECT_ROOT = repoRootFrom(process.cwd());
if (!PROJECT_ROOT) {
  // Not a refusal and not a clean report. UNMEASURED by name, because a
  // session opened outside a repository has not been found to have current
  // hooks — it has not been asked (#68 is the same mistake, made silently).
  report('Hook currency UNMEASURED: cwd is not inside a git repository');
  process.exit(0);
}

// A tree the scaffold has never touched has no hooks of ours to be stale,
// and reporting on one every session would be noise in exactly the projects
// that have not opted in. Gated on the directory the hooks live in, the way
// StaleTTLCleanup gates its sweeps.
if (!existsSync(join(PROJECT_ROOT, '.git')) && !existsSync(join(PROJECT_ROOT, '.git/hooks'))) {
  process.exit(0);
}

try {
  const { current, refusals } = await readHookCurrency(PROJECT_ROOT, defaultGeneratorRoot());
  const cls = currencyClass(refusals);

  if (cls === null) {
    // Said out loud rather than passed over in silence. Silence is what the
    // last two fixes shipped into, and it is indistinguishable from a hook
    // that did not run.
    report(`Hook currency: ${current.length} installed hook(s) current`);
  } else {
    // No remedy line here. The refusal already carries one, composed by the
    // code that knows WHICH fix the installed copy predates, and a second
    // one written at this distance was both a duplicate decider and wrong:
    // it hardcoded a `node_modules/rungate/` path, which is right for a
    // consumer and wrong in rungate's own checkout. Measured before it was
    // deleted.
    report(`${REFUSAL_PREFIX[cls]}: ${currencyLines(refusals)}`);
    if (current.length > 0) report(`  (current: ${current.length} other hook(s))`);
  }
} catch (e) {
  // A hook that cannot take the reading says so. Swallowing this would make
  // a broken check byte-indistinguishable from a clean tree, which is the
  // state #879 found the repository in.
  report(`Hook currency UNMEASURED: ${e instanceof Error ? e.message : String(e)}`);
}

process.exit(0);
