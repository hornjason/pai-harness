#!/usr/bin/env bun
/**
 * StaleTTLCleanup.hook.ts — Auto-cleanup stale workflow-state.json and .ship-active files (#256, #270)
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * TRIGGER: SessionStart
 *
 * Enforces 4h TTL on ship artifacts, 7d hard TTL on active phases.
 * Thin trigger: delegates to lib/stale-cleanup.ts. Issue: #544
 */

import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { cleanStaleFiles } from '../lib/stale-cleanup';

const PAI_WORK = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');
const STALE_LOG = join(process.env.HOME!, '.claude', 'state', 'stale-cleanup.log');
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

if (!existsSync(PAI_WORK)) process.exit(0);

const timestamp = new Date().toISOString();
function log(msg: string): void {
  try { appendFileSync(STALE_LOG, `${timestamp} ${msg}\n`); } catch {}
}

// Core cleanup
const result = cleanStaleFiles(PAI_WORK, FOUR_HOURS_MS, SEVEN_DAYS_MS);
let deletedCount = result.deleted;
for (const msg of result.logs) log(msg);

// Worktree cleanup
try {
  const { cleanupWorktrees } = await import('../lib/worktree-cleanup.ts');
  const projectRoot = process.cwd();
  if (existsSync(join(projectRoot, '.claude', 'worktrees'))) {
    const wr = await cleanupWorktrees({ projectRoot, maxAgeMs: 24 * 60 * 60 * 1000 });
    if (wr.removed.length) {
      deletedCount += wr.removed.length;
      log(`WORKTREE cleanup [${projectRoot}]: removed ${wr.removed.length} stale worktrees`);
    }
  }
} catch (e) { log(`WORKTREE cleanup error: ${e}`); }

// Branch cleanup
try {
  const { cleanupStaleBranches } = await import('../lib/branch-cleanup.ts');
  const projectRoot = process.cwd();
  const br = await cleanupStaleBranches({ projectRoot, maxAgeDays: 7 });
  if (br.deleted.length) {
    deletedCount += br.deleted.length;
    log(`BRANCH cleanup [${projectRoot}]: deleted ${br.deleted.length} stale remote branches`);
  }
} catch (e) { log(`BRANCH cleanup error: ${e}`); }

// Gap scan — drift detection
let gapWarns = 0;
try {
  const { scanGaps } = await import('../lib/gap-scanner.ts');
  const projectRoot = process.cwd();
  const gapResult = scanGaps(projectRoot, PAI_WORK);
  for (const r of gapResult.results) {
    if (r.status === 'WARN') {
      gapWarns++;
      log(`GAP ${r.check}: ${r.detail}`);
    }
  }
} catch (e) { log(`GAP scan error: ${e}`); }

const parts: string[] = [];
if (deletedCount > 0) parts.push(`${deletedCount} removed`);
if (gapWarns > 0) parts.push(`${gapWarns} gap warnings`);
if (parts.length > 0) {
  console.log(`Stale TTL cleanup: ${parts.join(', ')}`);
} else {
  console.log('Stale TTL cleanup: no stale files found');
}
