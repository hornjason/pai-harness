#!/usr/bin/env bun
/**
 * StaleTTLCleanup.hook.ts — Auto-cleanup stale workflow-state.json and .ship-active files (#256, #270)
 *
 * TRIGGER: SessionStart
 *
 * Thin trigger — cleanup logic delegated to lib/stale-cleanup.ts
 * per Hook Architecture Spec D-2.
 */

import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { cleanupShipActive, cleanupWorkflowState, cleanupEmptyDirs } from '../lib/stale-cleanup';

const PAI_WORK = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');
const STALE_LOG = join(process.env.HOME!, '.claude', 'state', 'stale-cleanup.log');

if (!existsSync(PAI_WORK)) {
  process.exit(0);
}

let deletedCount = 0;
const timestamp = new Date().toISOString();

function log(msg: string): void {
  try {
    appendFileSync(STALE_LOG, `${timestamp} ${msg}\n`);
  } catch {
    // Log dir may not exist yet
  }
}

// Clean .ship-active files > 4h old
const shipResult = cleanupShipActive(PAI_WORK);
deletedCount += shipResult.deletedCount;
for (const msg of shipResult.log) log(msg);

// Clean workflow-state.json files based on TTL
const wfResult = cleanupWorkflowState(PAI_WORK);
deletedCount += wfResult.deletedCount;
for (const msg of wfResult.log) log(msg);

// Clean up empty directories
cleanupEmptyDirs(PAI_WORK);

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

// Clean stale remote branches (older than 7 days with no open PR)
try {
  const { cleanupStaleBranches } = await import('../lib/branch-cleanup.ts')
  const projectRoot = process.cwd()
  const result = cleanupStaleBranches({ projectRoot, maxAgeDays: 7 })
  if (result.deleted.length) {
    deletedCount += result.deleted.length
    log(`BRANCH cleanup [${projectRoot}]: deleted ${result.deleted.length} stale remote branches: ${result.deleted.join(', ')}`)
  }
  if (result.skipped.length) {
    log(`BRANCH cleanup [${projectRoot}]: skipped ${result.skipped.length} branches (open PRs): ${result.skipped.join(', ')}`)
  }
  if (result.errors.length) {
    log(`BRANCH cleanup [${projectRoot}]: ${result.errors.length} errors: ${result.errors.join('; ')}`)
  }
} catch (e) {
  log(`BRANCH cleanup error: ${e}`)
}

if (deletedCount > 0) {
  console.log(`Stale TTL cleanup: removed ${deletedCount} files older than 4h`);
} else {
  console.log('Stale TTL cleanup: no stale files found');
}
