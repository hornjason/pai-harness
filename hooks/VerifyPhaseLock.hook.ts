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
import { filingGate, ledgerPath, recordAdjudication } from '../lib/issue-filing-gate';

const WORK_DIR = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');

function findActiveWorkflow(): { path: string; data: any } | null {
  if (!existsSync(WORK_DIR)) return null;
  let best: { path: string; data: any; mtime: number } | null = null;

  try {
    for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
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

  if (gate.refusal !== null) {
    console.log(JSON.stringify({ decision: "block", reason: gate.refusal }));
    process.exit(0);
  }
  // systemMessage and not stderr: stderr from a hook that exits 0 is not
  // shown. An UNMEASURED nobody sees is a silent pass, which is the one thing
  // lib/issue-filing-gate.ts's header says this must not become.
  const notes = [
    gate.note,
    unrecorded > 0
      ? `[FindingArbiter] ${unrecorded} adjudication(s) could not be written to ${ledgerPath()}, ` +
        `so this filing is not in the population that prices the gate.`
      : null,
  ].filter((n): n is string => n !== null);
  if (notes.length > 0) console.log(JSON.stringify({ systemMessage: notes.join("\n\n") }));
  process.exit(0);
}

main();
