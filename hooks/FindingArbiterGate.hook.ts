#!/usr/bin/env bun
/**
 * FindingArbiterGate.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): no hook exceeds 150 lines
 *
 * Those two and no more, which is the convention every other hook here
 * follows — VerifyPhaseLock, TopLevelCdGuard, BashWriteGuard and
 * WorkflowStateGuard all trace to exactly SC-370 and SC-371, and the
 * behaviour each one actually claims lives in its row in the spec's
 * current-state table and in its own test file.
 *
 * A first draft of this hook minted four bespoke criteria. They were
 * withdrawn on a measurement rather than on taste: `sc-id-namespace.test.ts`
 * walks every registry id across every test file, and its two
 * whole-registry cases sit at roughly 98% of bun's 5,000 ms per-test budget
 * on an idle machine. Four new ids added ~1.7 s and turned both red — 0 of
 * 48 failing with the spec reverted, 2 of 48 with it applied, reproduced
 * three times against a clean `origin/main` control worktree. Raising the
 * budget is the repair this repository explicitly refuses
 * (`test/test-timeout-population.test.ts`, #621), so the cost was removed
 * instead of the check. See the PR for the full reading.
 *
 * Refuses a `gh issue create` whose symptom is already on the tracker.
 *
 * The decision lives in `lib/finding-gate.ts` and not here — hooks are thin
 * triggers (HOOK-ARCHITECTURE-SPEC), the same shape as VerifyPhaseLock over
 * `lib/issue-create-override.ts` and TopLevelCdGuard over
 * `lib/top-level-cd.ts`. **Read that module's header before changing
 * anything here**; it explains why this one guard fails OPEN.
 *
 * ## Why a second hook rather than a branch inside VerifyPhaseLock
 *
 * `VerifyPhaseLock` already intercepts `gh issue create`, so putting this
 * there looks like the cheap answer. It is the wrong one, and quietly: that
 * hook reads the newest `workflow-state.json` under `WORK_DIR` and
 * **exits 0 unless its phase is VERIFY**. This lane does not run phases at
 * all — `.claude/rules/ship-workflow.md`, direct-ship mode since
 * 2026-10-19 — so `findActiveWorkflow()` returns null for most agents and
 * the branch would never be reached by the sessions that file the issues.
 * Wiring the arbiter there would have reproduced #1241 exactly: a mechanism
 * that is present, tested, and never called.
 *
 * The two guards also answer different questions and must stay separately
 * mutable. VerifyPhaseLock asks *should you be filing during VERIFY*;
 * this asks *does this symptom already exist*. Folding them into one hook
 * would be the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — two deciders over one
 * input, where a mutation of either leaves the other holding the case up.
 *
 * ## It does not run on this machine until the hooks are redeployed
 *
 * Per #1216 the live `~/.pai/hooks/` copies are stale, so registering this
 * in the repository changes nothing here until someone redeploys. That is a
 * known, separate blocker and is not cleared by this change; #1261 says so
 * in those words. The mechanism ships; the filing rate on this machine does
 * not move until #1216 does.
 *
 * Issue: #1261
 */

import { join } from 'path';

import { parseHookInput } from './lib/parseStdin';
import { getWorkDir } from './lib/paths';
import {
  FINDING_GATE_DECISION,
  FINDING_GATE_ENV,
  FINDING_GATE_OFF,
  findingGateReading,
} from '../lib/finding-gate';

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  if (payload.tool_name !== 'Bash') process.exit(0);

  // The documented bypass. Read exactly, for the reason
  // `.claude/rules/config-access.md` gives about a variable that turns a
  // gate off: a loose reading disables the gate by accident.
  if (process.env[FINDING_GATE_ENV] === FINDING_GATE_OFF) process.exit(0);

  // The raw value, NOT `|| ''`. An absent or non-string command is a thing
  // this hook cannot read, and it is allowed — loudly — rather than
  // silently passed over. `lib/finding-gate.ts` explains the direction.
  const cmd = payload.tool_input?.command;
  if (typeof cmd !== 'string') {
    if (cmd !== undefined) {
      console.error(
        '[FindingArbiterGate] the Bash command could not be read, so no finding was ' +
        'adjudicated: UNMEASURED, allowed. This gate never refuses on a reading it could not take.',
      );
    }
    process.exit(0);
  }

  const cwd = process.cwd();
  const reading = await findingGateReading(cmd, cwd, {
    projectRoot: cwd,
    // The offline comparison population, as `scripts/arbitrate-finding.ts`
    // takes `--existing`: for a test, and for a measurement.
    existingFile: process.env.RUNGATE_FINDING_GATE_EXISTING ?? null,
    logPath: join(getWorkDir(), 'finding-gate.jsonl'),
  });

  if (reading.refusal !== null) {
    console.log(JSON.stringify({ decision: FINDING_GATE_DECISION, reason: reading.refusal }));
    process.exit(0);
  }

  // An allow the arbiter could not stand behind says so. stderr reaches the
  // transcript without becoming a tool result the model reads as a refusal —
  // the channel TopLevelCdGuard's `warn` rung uses for the same reason.
  if (reading.unmeasured !== null) {
    console.error(
      `[FindingArbiterGate] UNMEASURED, allowed: ${reading.unmeasured}. ` +
      'A finding that could not be adjudicated is not a finding that was rejected.',
    );
  }
  process.exit(0);
}

main();
