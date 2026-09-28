/**
 * Stale file cleanup logic — extracted from StaleTTLCleanup.hook.ts
 *
 * Contains recursive file finding, TTL-based cleanup of .ship-active
 * and workflow-state.json files, and empty directory removal.
 * Hook file is thin trigger only.
 *
 * Per Hook Architecture Spec D-2: hook logic in lib/ with unit tests.
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  deletedCount: number;
  log: string[];
}

/**
 * Recursively find files by name under a directory.
 */
export function findFiles(dir: string, name: string): string[] {
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
 * Clean .ship-active files older than 4 hours.
 */
export function cleanupShipActive(workDir: string): CleanupResult {
  const result: CleanupResult = { deletedCount: 0, log: [] };
  const now = Date.now();

  for (const f of findFiles(workDir, '.ship-active')) {
    try {
      const stat = statSync(f);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > FOUR_HOURS_MS) {
        const ageMin = Math.floor(ageMs / 60000);
        result.log.push(`DELETED .ship-active age=${ageMin}m path=${f}`);
        unlinkSync(f);
        result.deletedCount++;
      }
    } catch {
      // File may have been deleted between find and stat
    }
  }

  return result;
}

/**
 * Clean workflow-state.json files based on TTL rules:
 * - Non-active phases (not BUILD/VERIFY/SCOPE): 4-hour TTL
 * - Active phases: 7-day hard TTL (zombie prevention)
 * - Goal-record exemption: skip if goal-record.json exists alongside
 */
export function cleanupWorkflowState(workDir: string): CleanupResult {
  const result: CleanupResult = { deletedCount: 0, log: [] };
  const now = Date.now();

  for (const f of findFiles(workDir, 'workflow-state.json')) {
    try {
      const stat = statSync(f);
      const ageMs = now - stat.mtimeMs;

      const data = JSON.parse(readFileSync(f, 'utf-8'));
      const phase = data.phase || '';
      const isActivePhase = ['BUILD', 'VERIFY', 'SCOPE'].includes(phase);

      // Hard TTL: active-phase files older than 7 days (zombie prevention)
      if (isActivePhase && ageMs > SEVEN_DAYS_MS) {
        const ageDays = Math.floor(ageMs / 86400000);
        result.log.push(`DELETED workflow-state.json age=${ageDays}d phase=${phase} (7-day hard TTL) path=${f}`);
        unlinkSync(f);
        result.deletedCount++;
        continue;
      }

      // Skip active phases for the 4h TTL
      if (isActivePhase) continue;

      // GoalRecord TTL exemption (ADR-007): skip if goal-record.json exists
      if (existsSync(join(dirname(f), 'goal-record.json'))) {
        result.log.push(`EXEMPT goal-record TTL-exempt path=${f}`);
        continue;
      }

      if (ageMs > FOUR_HOURS_MS) {
        const ageMin = Math.floor(ageMs / 60000);
        result.log.push(`DELETED workflow-state.json age=${ageMin}m phase=${phase || 'unknown'} path=${f}`);
        unlinkSync(f);
        result.deletedCount++;
      }
    } catch {
      // Parse or stat failure — skip
    }
  }

  return result;
}

/**
 * Remove empty subdirectories at the top level of workDir.
 */
export function cleanupEmptyDirs(workDir: string): void {
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
}
