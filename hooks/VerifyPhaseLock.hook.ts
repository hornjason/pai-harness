#!/usr/bin/env bun
/**
 * VerifyPhaseLock.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * Blocks `gh issue create` during VERIFY phase.
 * Use verifyBlockers[] instead. Allows `gh issue create` carrying one of the
 * override labels in lib/issue-create-override.ts.
 *
 * The decision lives in lib/ and not here (#365, HOOK-ARCHITECTURE-SPEC:
 * hooks are thin triggers). It used to be a substring test on the whole
 * command, which a `follow-up` in an issue TITLE satisfied.
 *
 * Issue: #443
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseHookInput } from './lib/parseStdin';
import { verifyPhaseRefusal } from '../lib/issue-create-override';

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

  // Ask the owner BEFORE reading the workflow state. Cheap, and it keeps the
  // whole decision in one place rather than half here and half in lib/.
  const refusal = verifyPhaseRefusal(cmd);
  if (refusal === null) process.exit(0);

  const wf = findActiveWorkflow();
  if (!wf || wf.data.phase !== 'VERIFY') process.exit(0);

  console.log(JSON.stringify({ decision: "block", reason: refusal }));
  process.exit(0);
}

main();
