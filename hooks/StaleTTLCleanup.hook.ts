#!/usr/bin/env bun
/**
 * StaleTTLCleanup.hook.ts — Auto-cleanup stale workflow-state.json and .ship-active files (#256, #270)
 *
 * TRIGGER: SessionStart
 *
 * Enforces 4-hour TTL on ship workflow artifacts to prevent stale state from blocking new sessions.
 * Preserves files in BUILD, VERIFY, and SCOPE phases (active work).
 * 7-day hard TTL on BUILD/VERIFY/SCOPE phase files (zombie prevention).
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';

const PAI_WORK = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');
const STALE_LOG = join(process.env.HOME!, '.claude', 'state', 'stale-cleanup.log');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

if (!existsSync(PAI_WORK)) {
  process.exit(0);
}

let deletedCount = 0;
const now = Date.now();
const timestamp = new Date().toISOString();

function log(msg: string): void {
  try {
    appendFileSync(STALE_LOG, `${timestamp} ${msg}\n`);
  } catch {
    // Log dir may not exist yet
  }
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

// Clean .ship-active files > 4h old
for (const f of findFiles(PAI_WORK, '.ship-active')) {
  try {
    const stat = statSync(f);
    const ageMs = now - stat.mtimeMs;
    if (ageMs > FOUR_HOURS_MS) {
      const ageMin = Math.floor(ageMs / 60000);
      log(`DELETED .ship-active age=${ageMin}m path=${f}`);
      unlinkSync(f);
      deletedCount++;
    }
  } catch {
    // File may have been deleted between find and stat
  }
}

// Clean workflow-state.json > 4h old (preserve active BUILD/VERIFY/SCOPE phases)
for (const f of findFiles(PAI_WORK, 'workflow-state.json')) {
  try {
    const stat = statSync(f);
    const ageMs = now - stat.mtimeMs;

    const data = JSON.parse(readFileSync(f, 'utf-8'));
    const phase = data.phase || '';
    const isActivePhase = ['BUILD', 'VERIFY', 'SCOPE'].includes(phase);

    // Hard TTL: BUILD/VERIFY/SCOPE-phase files older than 7 days (zombie prevention)
    if (isActivePhase && ageMs > SEVEN_DAYS_MS) {
      const ageDays = Math.floor(ageMs / 86400000);
      log(`DELETED workflow-state.json age=${ageDays}d phase=${phase} (7-day hard TTL) path=${f}`);
      unlinkSync(f);
      deletedCount++;
      continue;
    }

    // Skip active phases for the 4h TTL
    if (isActivePhase) continue;

    // GoalRecord TTL exemption (ADR-007): skip if goal-record.json exists in same directory
    if (existsSync(join(dirname(f), 'goal-record.json'))) {
      log(`EXEMPT goal-record TTL-exempt path=${f}`);
      continue;
    }

    if (ageMs > FOUR_HOURS_MS) {
      const ageMin = Math.floor(ageMs / 60000);
      log(`DELETED workflow-state.json age=${ageMin}m phase=${phase || 'unknown'} path=${f}`);
      unlinkSync(f);
      deletedCount++;
    }
  } catch {
    // Parse or stat failure — skip
  }
}

// Clean up empty directories
try {
  const topDirs = readdirSync(PAI_WORK, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const d of topDirs) {
    const dirPath = join(PAI_WORK, d.name);
    try {
      const contents = readdirSync(dirPath);
      if (contents.length === 0) {
        const { rmdirSync } = require('fs');
        rmdirSync(dirPath);
      }
    } catch {
      // Skip if can't read or remove
    }
  }
} catch {
  // Skip
}

// Clean stale worktrees (older than 24h with merged branches) in the current project
try {
  const { cleanupWorktrees } = await import('../lib/worktree-cleanup.ts')
  const projectRoot = process.cwd()
  if (existsSync(join(projectRoot, '.claude', 'worktrees'))) {
    const result = await cleanupWorktrees({ projectRoot, maxAgeMs: 24 * 60 * 60 * 1000 })
    if (result.removed.length) {
      deletedCount += result.removed.length
      log(`WORKTREE cleanup [${projectRoot}]: removed ${result.removed.length} stale worktrees`)
    }
  }
} catch (e) {
  log(`WORKTREE cleanup error: ${e}`)
}

if (deletedCount > 0) {
  console.log(`Stale TTL cleanup: removed ${deletedCount} files older than 4h`);
} else {
  console.log('Stale TTL cleanup: no stale files found');
}
