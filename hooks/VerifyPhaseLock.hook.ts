#!/usr/bin/env bun
/**
 * VerifyPhaseLock.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * TWO independent gates on one chokepoint — `gh issue create` reaching Bash.
 * Both decisions live in lib/ and not here (#365, HOOK-ARCHITECTURE-SPEC:
 * hooks are thin triggers).
 *
 * 1. **The VERIFY-phase lock** (#443, #365). Workflow discipline: during
 *    VERIFY, use verifyBlockers[] instead. Waived by the override labels in
 *    lib/issue-create-override.ts. It used to be a substring test on the
 *    whole command, which a `follow-up` in an issue TITLE satisfied.
 *
 * 2. **The finding adjudication** (#1261), on every phase. Asks whether the
 *    finding earned a filing — duplicate, or a dropped category — through
 *    lib/finding-arbiter.ts's own bindings. Before this, the only question
 *    asked at this chokepoint was gate 1's, and gate 1 tests whether an agent
 *    typed a label. lib/issue-filing-gate.ts has the measurement and the
 *    reason the two gates do not share an override label.
 *
 * Asked in that order because gate 1 is a cheap local read and gate 2 may pay
 * for a `gh issue list`.
 *
 * Issue: #443, #1261
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseHookInput } from './lib/parseStdin';
import { verifyPhaseRefusal } from '../lib/issue-create-override';
import { isRunDirectory } from '../lib/active-workflow';
import { filingGate, ledgerPath, recordAdjudication } from '../lib/issue-filing-gate';

const WORK_DIR = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');

function findActiveWorkflow(): { path: string; data: any } | null {
  if (!existsSync(WORK_DIR)) return null;
  let best: { path: string; data: any; mtime: number } | null = null;

  try {
    for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // `.archive/<slug>/workflow-state.json` matches the nested shape below,
      // so without this an ARCHIVED run decides the lock. One did, for eight
      // days — see lib/active-workflow.ts for the reading.
      if (!isRunDirectory(entry.name)) continue;
      const wfPath = join(WORK_DIR, entry.name, 'workflow-state.json');
      if (existsSync(wfPath)) {
        try {
          const data = JSON.parse(readFileSync(wfPath, 'utf-8'));
          const mtime = statSync(wfPath).mtimeMs;
          if (!best || mtime > best.mtime) {
            best = { path: wfPath, data, mtime };
          }
        } catch {}
      }
      const nested = join(WORK_DIR, entry.name);
      try {
        for (const sub of readdirSync(nested, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          // The same predicate as the outer loop, and for the same reason.
          // Applying it to only one of the two readings leaves the defect
          // intact one level deeper: a hidden bookkeeping directory INSIDE a
          // live run still reaches `best` and still outranks it by mtime.
          // Two readings of one question, one of them filtered — the fourth
          // shape in .claude/rules/checks-must-be-able-to-fail.md. Raised on
          // #1648 by the reviewer.
          if (!isRunDirectory(sub.name)) continue;
          const nestedWf = join(nested, sub.name, 'workflow-state.json');
          if (!existsSync(nestedWf)) continue;
          try {
            const data = JSON.parse(readFileSync(nestedWf, 'utf-8'));
            const mtime = statSync(nestedWf).mtimeMs;
            if (!best || mtime > best.mtime) {
              best = { path: nestedWf, data, mtime };
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return best ? { path: best.path, data: best.data } : null;
}

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  if (payload.tool_name !== 'Bash') process.exit(0);

  const cmd = payload.tool_input?.command || '';

  // ── 1. the VERIFY-phase lock ──
  //
  // Ask the owner BEFORE reading the workflow state. Cheap, and it keeps the
  // whole decision in one place rather than half here and half in lib/.
  const refusal = verifyPhaseRefusal(cmd);
  if (refusal !== null) {
    const wf = findActiveWorkflow();
    if (wf && wf.data.phase === 'VERIFY') {
      console.log(JSON.stringify({ decision: "block", reason: refusal }));
      process.exit(0);
    }
  }

  // ── 2. the finding adjudication (#1261) ──
  //
  // Every phase, and not only VERIFY: #1261's measurement is that filing is
  // unadjudicated generally — open issues sat flat at 32 across three
  // readings while 8 closed and 8 were filed — so a gate that only runs
  // inside one phase would leave the intake rate untouched.
  const gate = await filingGate(cmd, { projectRoot: process.cwd() });
  const unrecorded = gate.rows.filter(row => !recordAdjudication(row)).length;
  // A refusal says the override "is recorded beside the refusal it waived".
  // When the write failed that sentence is false, and a security control
  // asserting a guarantee it is not providing is worse than one that says
  // nothing — so the unrecorded notice rides ON the refusal rather than
  // being skipped by the early exit, which is where it used to go.
  const unrecordedNote =
    unrecorded > 0
      ? `[FindingArbiter] ${unrecorded} adjudication(s) could NOT be written to ${ledgerPath()}, ` +
        "so they are not in the population that prices this gate and any claim below that " +
        "a decision was recorded does not hold for them."
      : null;

  // `gate.note` rides on the refusal for the same reason `unrecordedNote`
  // does, and it was missed when that one was fixed: a `decision: "block"`
  // payload has ONE text field, so anything not folded into `reason` here is
  // discarded by the early exit and never reaches the agent.
  //
  // The note that mattered is the corpus-drop one. A refusal computed against
  // a tracker three issues short is exactly where the shortfall needs saying
  // — the agent is being told its finding is already filed, by a comparison
  // that did not read the whole tracker — and that was the one path on which
  // it was silently dropped. `FG-60` is the case; it went red here first.
  if (gate.refusal !== null) {
    const riders = [gate.note, unrecordedNote].filter((n): n is string => n !== null);
    const reason = [gate.refusal, ...riders].join("\n\n");
    console.log(JSON.stringify({ decision: "block", reason }));
    process.exit(0);
  }
  // systemMessage and not stderr: stderr from a hook that exits 0 is not
  // shown. An UNMEASURED nobody sees is a silent pass, which is the one thing
  // lib/issue-filing-gate.ts's header says this must not become.
  const notes = [gate.note, unrecordedNote].filter((n): n is string => n !== null);
  if (notes.length > 0) console.log(JSON.stringify({ systemMessage: notes.join("\n\n") }));
  process.exit(0);
}

main();
