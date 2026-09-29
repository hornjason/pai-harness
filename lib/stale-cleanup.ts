/**
 * Stale cleanup utilities — extracted from StaleTTLCleanup.hook.ts
 *
 * Deep module: recursive file finder and TTL cleanup logic.
 * The hook file is a thin trigger that delegates here.
 *
 * Issue: #544, #469 (archive-then-purge)
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync, rmdirSync, renameSync, mkdirSync } from 'fs';
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

export interface ArchiveResult {
  archived: number;
  purged: number;
  skipped: number;
  logs: string[];
}

/**
 * Archive and purge work directories.
 *
 * Archive phase: Move directories to .archive/ after archiveTtlMs (default 4h)
 * Purge phase: Delete archived directories after purgeTtlMs (default 30d)
 * Migration: Move old _archived-* directories into .archive/
 */
export function archiveAndPurge(
  workDir: string,
  archiveTtlMs: number,
  purgeTtlMs: number,
): ArchiveResult {
  const now = Date.now();
  let archived = 0;
  let purged = 0;
  let skipped = 0;
  const logs: string[] = [];

  const archiveDir = join(workDir, '.archive');
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // Create .archive/ if it doesn't exist
  if (!existsSync(archiveDir)) {
    try {
      mkdirSync(archiveDir, { recursive: true });
    } catch {}
  }

  // Migration: Move old _archived-* directories into .archive/
  try {
    for (const entry of readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_archived-')) {
        try {
          const srcPath = join(workDir, entry.name);
          const destPath = join(archiveDir, entry.name);
          renameSync(srcPath, destPath);
          logs.push(`MIGRATED ${entry.name} to .archive/`);
        } catch {}
      }
    }
  } catch {}

  // Archive phase: scan top-level directories
  try {
    for (const entry of readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      // Skip hidden directories (except .archive itself)
      if (entry.name.startsWith('.')) continue;

      const dirPath = join(workDir, entry.name);
      const workflowStatePath = join(dirPath, 'workflow-state.json');

      try {
        let shouldArchive = false;
        let reason = '';

        if (existsSync(workflowStatePath)) {
          const data = JSON.parse(readFileSync(workflowStatePath, 'utf-8'));
          const phase = data.phase || '';
          const isActivePhase = ['BUILD', 'VERIFY', 'SCOPE'].includes(phase);
          const ageMs = now - statSync(workflowStatePath).mtimeMs;

          if (isActivePhase && ageMs < sevenDaysMs) {
            // Active work, skip
            skipped++;
            continue;
          } else if (isActivePhase && ageMs >= sevenDaysMs) {
            // Hard TTL exceeded
            shouldArchive = true;
            reason = `phase=${phase} age=${Math.floor(ageMs / 86400000)}d (7-day hard TTL)`;
          } else if (ageMs > archiveTtlMs) {
            // Non-active phase, exceeded archive TTL
            shouldArchive = true;
            reason = `phase=${phase} age=${Math.floor(ageMs / 60000)}m`;
          }
        } else {
          // Orphaned directory (no workflow-state.json)
          shouldArchive = true;
          reason = 'orphaned (no workflow-state.json)';
        }

        if (shouldArchive) {
          const destPath = join(archiveDir, entry.name);
          renameSync(dirPath, destPath);
          archived++;
          logs.push(`ARCHIVED ${entry.name} reason=${reason}`);
        }
      } catch {}
    }
  } catch {}

  // Purge phase: delete old archived directories
  if (existsSync(archiveDir)) {
    try {
      for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const archivedPath = join(archiveDir, entry.name);
        try {
          const ageMs = now - statSync(archivedPath).mtimeMs;
          if (ageMs > purgeTtlMs) {
            rmdirSync(archivedPath, { recursive: true });
            purged++;
            logs.push(`PURGED ${entry.name} age=${Math.floor(ageMs / 86400000)}d`);
          }
        } catch {}
      }
    } catch {}
  }

  // Clean empty directories in .archive/
  if (existsSync(archiveDir)) {
    try {
      for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const archEntryPath = join(archiveDir, entry.name);
          if (readdirSync(archEntryPath).length === 0) {
            rmdirSync(archEntryPath);
          }
        } catch {}
      }
    } catch {}
  }

  return { archived, purged, skipped, logs };
}

/**
 * Clean stale .ship-active files and archive work directories.
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

  // Archive and purge work directories
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const archiveResult = archiveAndPurge(workDir, fourHoursMs, thirtyDaysMs);

  // Merge logs
  logs.push(...archiveResult.logs);

  return { deleted, logs };
}
