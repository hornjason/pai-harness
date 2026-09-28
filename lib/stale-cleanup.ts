/**
 * Stale File Cleanup Logic
 *
 * Extracted from StaleTTLCleanup.hook.ts (#544).
 * Contains file discovery, TTL enforcement, and empty directory cleanup.
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';

interface CleanupResult {
  deleted: number;
  logs: string[];
}

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
  } catch {
    // Permission errors or missing dirs
  }
  return results;
}

/**
 * Clean stale workflow artifacts from the work directory.
 * Enforces 4h TTL on ship artifacts, 7d hard TTL on active phases.
 */
export function cleanStaleFiles(
  workDir: string,
  fourHoursMs: number,
  sevenDaysMs: number,
): CleanupResult {
  const now = Date.now();
  let deleted = 0;
  const logs: string[] = [];

  // Clean .ship-active files > 4h old
  for (const f of findFiles(workDir, '.ship-active')) {
    try {
      const stat = statSync(f);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > fourHoursMs) {
        const ageMin = Math.floor(ageMs / 60000);
        logs.push(`DELETED .ship-active age=${ageMin}m path=${f}`);
        unlinkSync(f);
        deleted++;
      }
    } catch {
      // File may have been deleted between find and stat
    }
  }

  // Clean workflow-state.json > 4h old (preserve active BUILD/VERIFY/SCOPE phases)
  for (const f of findFiles(workDir, 'workflow-state.json')) {
    try {
      const stat = statSync(f);
      const ageMs = now - stat.mtimeMs;

      const data = JSON.parse(readFileSync(f, 'utf-8'));
      const phase = data.phase || '';
      const isActivePhase = ['BUILD', 'VERIFY', 'SCOPE'].includes(phase);

      // Hard TTL: BUILD/VERIFY/SCOPE-phase files older than 7 days (zombie prevention)
      if (isActivePhase && ageMs > sevenDaysMs) {
        const ageDays = Math.floor(ageMs / 86400000);
        logs.push(`DELETED workflow-state.json age=${ageDays}d phase=${phase} (7-day hard TTL) path=${f}`);
        unlinkSync(f);
        deleted++;
        continue;
      }

      // Skip active phases for the 4h TTL
      if (isActivePhase) continue;

      // GoalRecord TTL exemption (ADR-007): skip if goal-record.json exists in same directory
      if (existsSync(join(dirname(f), 'goal-record.json'))) {
        logs.push(`EXEMPT goal-record TTL-exempt path=${f}`);
        continue;
      }

      if (ageMs > fourHoursMs) {
        const ageMin = Math.floor(ageMs / 60000);
        logs.push(`DELETED workflow-state.json age=${ageMin}m phase=${phase || 'unknown'} path=${f}`);
        unlinkSync(f);
        deleted++;
      }
    } catch {
      // Parse or stat failure — skip
    }
  }

  // Clean up empty directories
  try {
    const topDirs = readdirSync(workDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of topDirs) {
      const dirPath = join(workDir, d.name);
      try {
        const contents = readdirSync(dirPath);
        if (contents.length === 0) {
          rmdirSync(dirPath);
        }
      } catch {
        // Skip if can't read or remove
      }
    }
  } catch {
    // Skip
  }

  return { deleted, logs };
}
