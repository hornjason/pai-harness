/**
 * Tests for lib/stale-cleanup.ts — archive-then-purge lifecycle
 * Issue: #469
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { archiveAndPurge, cleanStaleFiles } from '../lib/stale-cleanup';
import { tmpdir } from 'os';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `stale-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function createWorkDir(slug: string, phase?: string, ageMs?: number): void {
  const dir = join(testDir, slug);
  mkdirSync(dir, { recursive: true });

  if (phase !== undefined) {
    const workflowState = { phase, updated: Date.now() - (ageMs || 0) };
    writeFileSync(join(dir, 'workflow-state.json'), JSON.stringify(workflowState));
  }

  // Add some artifacts
  writeFileSync(join(dir, 'goal-record.json'), JSON.stringify({ goal: 'test' }));
  writeFileSync(join(dir, 'PRD.md'), '# PRD\n');

  // Set mtime if specified
  if (ageMs !== undefined) {
    const time = (Date.now() - ageMs) / 1000;
    const files = readdirSync(dir).map(f => join(dir, f));
    for (const f of files) {
      utimesSync(f, time, time);
    }
  }
}

describe('archiveAndPurge', () => {
  // #132. The orphan branch had no age check at all, where every other branch
  // in archiveAndPurge compares against a TTL. A run directory was therefore
  // archived on sight for as long as it had not yet written
  // workflow-state.json — which, for a run that writes other artifacts first,
  // means while it is live.
  //
  // This is not a hypothetical. It happened to this session's own run
  // directory mid-session: created 17:22, holding the run's PRD, moved into
  // .archive by a SessionStart cleanup, and the next write to the PRD failed
  // with "file does not exist". It also explains why
  // lib/compliance-backfill.ts has to sweep .archive to find its full corpus
  // of grade records — a moved directory splits a run's artifacts across two
  // paths with nothing recording that they belong together.
  //
  // The test below used to assert the bug: it created a brand-new directory
  // and expected `archived` to be 1.
  test('does NOT archive an orphaned directory that was just created', () => {
    const slug = 'orphaned-but-live';
    const dir = join(testDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PRD.md'), '# a run in progress');

    const result = archiveAndPurge(testDir, 4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);

    expect(result.archived, 'a live run directory was archived underneath it').toBe(0);
    expect(existsSync(join(dir, 'PRD.md'))).toBe(true);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(false);
  });

  test('archives an orphaned directory once it is past the archive TTL', () => {
    // The other half: the branch still has a job. Only "on sight" goes away.
    const slug = 'orphaned-dir';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const dir = join(testDir, slug);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'goal-record.json');
    writeFileSync(stale, JSON.stringify({ goal: 'test' }));
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(stale, fiveHoursAgo, fiveHoursAgo);
    utimesSync(dir, fiveHoursAgo, fiveHoursAgo);

    const result = archiveAndPurge(testDir, fourHoursMs, 30 * 24 * 60 * 60 * 1000);

    expect(result.archived).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(true);
    expect(existsSync(join(testDir, '.archive', slug, 'goal-record.json'))).toBe(true);
  });

  test('archives DONE directory older than 4h', () => {
    const slug = 'done-dir';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    createWorkDir(slug, 'DONE', fiveHoursMs);

    const result = archiveAndPurge(testDir, fourHoursMs, 30 * 24 * 60 * 60 * 1000);

    expect(result.archived).toBe(1);
    expect(existsSync(join(testDir, slug))).toBe(false);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(true);
  });

  test('skips active BUILD directory younger than 7d', () => {
    const slug = 'active-build';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    createWorkDir(slug, 'BUILD', fiveHoursMs);

    const result = archiveAndPurge(testDir, fourHoursMs, 30 * 24 * 60 * 60 * 1000);

    expect(result.skipped).toBe(1);
    expect(existsSync(join(testDir, slug))).toBe(true);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(false);
  });

  test('force archives active BUILD directory older than 7d (hard TTL)', () => {
    const slug = 'old-build';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

    createWorkDir(slug, 'BUILD', eightDaysMs);

    const result = archiveAndPurge(testDir, fourHoursMs, 30 * 24 * 60 * 60 * 1000);

    expect(result.archived).toBe(1);
    expect(existsSync(join(testDir, slug))).toBe(false);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(true);
  });

  test('purges archived directory older than 30d', () => {
    const slug = 'old-archive';
    const archiveDir = join(testDir, '.archive', slug);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'workflow-state.json'), JSON.stringify({ phase: 'DONE' }));

    // Set mtime to 31 days ago
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    const time = (Date.now() - thirtyOneDaysMs) / 1000;
    utimesSync(archiveDir, time, time);

    const result = archiveAndPurge(testDir, 4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);

    expect(result.purged).toBe(1);
    expect(existsSync(archiveDir)).toBe(false);
  });

  test('keeps archived directory younger than 30d', () => {
    const slug = 'recent-archive';
    const archiveDir = join(testDir, '.archive', slug);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'workflow-state.json'), JSON.stringify({ phase: 'DONE' }));

    // Set mtime to 20 days ago
    const twentyDaysMs = 20 * 24 * 60 * 60 * 1000;
    const time = (Date.now() - twentyDaysMs) / 1000;
    utimesSync(archiveDir, time, time);

    const result = archiveAndPurge(testDir, 4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);

    expect(result.purged).toBe(0);
    expect(existsSync(archiveDir)).toBe(true);
  });

  test('migrates old _archived-* directories into .archive/', () => {
    const oldArchive1 = join(testDir, '_archived-old-slug-1');
    const oldArchive2 = join(testDir, '_archived-old-slug-2');

    mkdirSync(oldArchive1, { recursive: true });
    mkdirSync(oldArchive2, { recursive: true });
    writeFileSync(join(oldArchive1, 'data.json'), '{}');
    writeFileSync(join(oldArchive2, 'data.json'), '{}');

    const result = archiveAndPurge(testDir, 4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);

    expect(existsSync(oldArchive1)).toBe(false);
    expect(existsSync(oldArchive2)).toBe(false);
    expect(existsSync(join(testDir, '.archive', '_archived-old-slug-1'))).toBe(true);
    expect(existsSync(join(testDir, '.archive', '_archived-old-slug-2'))).toBe(true);
    expect(existsSync(join(testDir, '.archive', '_archived-old-slug-1', 'data.json'))).toBe(true);
  });

  test('skips directories starting with . (except migration source)', () => {
    const hiddenDir = join(testDir, '.hidden');
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(hiddenDir, 'data.json'), '{}');

    const result = archiveAndPurge(testDir, 4 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);

    expect(result.archived).toBe(0);
    expect(existsSync(hiddenDir)).toBe(true);
  });

  test('skips VERIFY and SCOPE phases under 7d', () => {
    const verifySlug = 'verify-work';
    const scopeSlug = 'scope-work';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    createWorkDir(verifySlug, 'VERIFY', fiveHoursMs);
    createWorkDir(scopeSlug, 'SCOPE', fiveHoursMs);

    const result = archiveAndPurge(testDir, fourHoursMs, 30 * 24 * 60 * 60 * 1000);

    expect(result.skipped).toBe(2);
    expect(existsSync(join(testDir, verifySlug))).toBe(true);
    expect(existsSync(join(testDir, scopeSlug))).toBe(true);
  });
});

describe('cleanStaleFiles integration', () => {
  test('calls archiveAndPurge internally', () => {
    const slug = 'done-dir';
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const fiveHoursMs = 5 * 60 * 60 * 1000;

    createWorkDir(slug, 'DONE', fiveHoursMs);

    const result = cleanStaleFiles(testDir, fourHoursMs, sevenDaysMs);

    // Should have archived the DONE dir
    expect(existsSync(join(testDir, slug))).toBe(false);
    expect(existsSync(join(testDir, '.archive', slug))).toBe(true);
  });

  test('preserves .ship-active cleanup behavior', () => {
    const slug = 'work-dir';
    const dir = join(testDir, slug);
    mkdirSync(dir, { recursive: true });

    const shipActiveFile = join(dir, '.ship-active');
    writeFileSync(shipActiveFile, '');

    // Set mtime to 5 hours ago
    const fiveHoursMs = 5 * 60 * 60 * 1000;
    const time = (Date.now() - fiveHoursMs) / 1000;
    utimesSync(shipActiveFile, time, time);

    const result = cleanStaleFiles(testDir, 4 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);

    expect(result.deleted).toBeGreaterThan(0);
    expect(existsSync(shipActiveFile)).toBe(false);
  });
});
