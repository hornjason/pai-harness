/**
 * Stale cleanup utilities — extracted from StaleTTLCleanup.hook.ts
 *
 * Deep module: recursive file finder and TTL cleanup logic.
 * The hook file is a thin trigger that delegates here.
 *
 * Issue: #544
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Recursively find files by name under a directory.
 */
function findFiles(dir: string, name: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(fullPath, name));
      } else if (entry.name === name) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

export interface CleanupResult {
  deleted: number;
  logs: string[];
}

/**
 * Clean stale .ship-active and workflow-state.json files.
 * Returns count of deleted files and log messages.
 */
export function cleanStaleFiles(
  workDir: string,
  fourHoursMs: number,
  sevenDaysMs: number,
): CleanupResult {
  const now = Date.now();
  let deleted = 0;
  const logs: string[] = [];

  // Clean .ship-active > 4h old
  for (const f of findFiles(workDir, '.ship-active')) {
    try {
      const ageMs = now - statSync(f).mtimeMs;
      if (ageMs > fourHoursMs) {
        logs.push(`DELETED .ship-active age=${Math.floor(ageMs / 60000)}m path=${f}`);
        unlinkSync(f);
        deleted++;
      }
    } catch {}
  }

  // Clean workflow-state.json (preserve active phases for 4h, hard TTL 7d)
  for (const f of findFiles(workDir, 'workflow-state.json')) {
    try {
      const ageMs = now - statSync(f).mtimeMs;
      const data = JSON.parse(readFileSync(f, 'utf-8'));
      const phase = data.phase || '';
      const isActivePhase = ['BUILD', 'VERIFY', 'SCOPE'].includes(phase);

      if (isActivePhase && ageMs > sevenDaysMs) {
        logs.push(`DELETED workflow-state.json age=${Math.floor(ageMs / 86400000)}d phase=${phase} (7-day hard TTL) path=${f}`);
        unlinkSync(f);
        deleted++;
        continue;
      }
      if (isActivePhase) continue;
      if (existsSync(join(dirname(f), 'goal-record.json'))) continue;

      if (ageMs > fourHoursMs) {
        logs.push(`DELETED workflow-state.json age=${Math.floor(ageMs / 60000)}m phase=${phase || 'unknown'} path=${f}`);
        unlinkSync(f);
        deleted++;
      }
    } catch {}
  }

  // Clean empty directories
  try {
    for (const d of readdirSync(workDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        if (readdirSync(join(workDir, d.name)).length === 0) {
          rmdirSync(join(workDir, d.name));
        }
      } catch {}
    }
  } catch {}

  return { deleted, logs };
}
