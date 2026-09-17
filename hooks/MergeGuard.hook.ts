#!/usr/bin/env bun
/**
 * MergeGuard.hook.ts — PreToolUse on Bash
 *
 * Early warning when git merge targets main/master without verify-gate passing.
 * The pre-push hook is the hard enforcement; this warns so the agent can fix first.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parseHookInput, WORK_DIR, HARNESS_ROOT } from './lib/utils';

const TTL_MS = 4 * 60 * 60 * 1000;

function findActiveShipMarker(): { issue: number; workDir: string } | null {
  if (!existsSync(WORK_DIR)) return null;
  try {
    for (const d of readdirSync(WORK_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const markerPath = join(WORK_DIR, d.name, '.ship-active');
      if (!existsSync(markerPath)) continue;
      if (Date.now() - statSync(markerPath).mtimeMs > TTL_MS) continue;
      try {
        const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
        if (marker.issue) return { issue: marker.issue, workDir: join(WORK_DIR, d.name) };
      } catch {}
    }
  } catch {}
  return null;
}

function checkVerifyGate(workDir: string): boolean {
  const wfPath = join(workDir, 'workflow-state.json');
  if (!existsSync(wfPath)) return false;
  try {
    return JSON.parse(readFileSync(wfPath, 'utf-8')).gates?.verify?.result === 'PASS';
  } catch { return false; }
}

async function main() {
  const input = await parseHookInput();
  if (!input || input.tool_name !== 'Bash') process.exit(0);

  const command = input.tool_input?.command || '';
  const isMerge = /git\s+merge\s+.*\b(main|master)\b/.test(command) ||
    /git\s+checkout\s+(main|master)\s*[;&|]+\s*git\s+merge/.test(command);
  if (!isMerge) process.exit(0);

  const ship = findActiveShipMarker();
  if (!ship || checkVerifyGate(ship.workDir)) process.exit(0);

  const slug = ship.workDir.split('/').pop();
  console.log(`<system-reminder>\n⚠️ MERGE WARNING: verify-gate has not passed for issue #${ship.issue}.\nThe pre-push hook will BLOCK this push. Run verify-gate first:\n  bun run ${HARNESS_ROOT}/gates/run-gate.ts --gate verify --slug ${slug}\n</system-reminder>`);
}

main();
