#!/usr/bin/env bun
/**
 * VerifyPhaseLock.hook.ts — PreToolUse on Bash
 *
 * Blocks `gh issue create` during VERIFY phase.
 * Use verifyBlockers[] instead. Allows `gh issue comment`
 * and `gh issue create` with --label follow-up.
 *
 * Issue: #443
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseHookInput } from './lib/parseStdin';

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
  if (!cmd.includes('gh issue create')) process.exit(0);

  const wf = findActiveWorkflow();
  if (!wf || wf.data.phase !== 'VERIFY') process.exit(0);

  // Allow follow-up issues
  if (cmd.includes('--label') && cmd.includes('follow-up')) process.exit(0);

  // Allow gh issue comment
  if (cmd.includes('gh issue comment')) process.exit(0);

  console.log(JSON.stringify({
    decision: "block",
    reason: "[VerifyPhaseLock] During VERIFY phase, use verifyBlockers[] in workflow-state.json instead of creating new issues. Add --label follow-up to override."
  }));
  process.exit(0);
}

main();
