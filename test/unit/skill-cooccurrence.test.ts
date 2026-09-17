/**
 * skill-cooccurrence.test.ts
 *
 * Test suite for SkillCooccurrence.ts CLI tool
 *
 * COVERAGE:
 * - Matrix building from skill-sequences.jsonl
 * - Pair counting within same session
 * - JSON output format
 * - Empty input handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('SkillCooccurrence.ts', () => {
  let tempDir: string;
  let sequencesPath: string;
  let outputPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cooccur-test-'));
    sequencesPath = join(tempDir, 'skill-sequences.jsonl');
    outputPath = join(tempDir, 'skill-cooccurrence.json');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('builds co-occurrence matrix from skill sequences', () => {
    // Session 1: dev-loop + testing
    // Session 2: dev-loop + testing (again)
    // Session 3: debugging + research
    const sequences = [
      { session_id: 's1', timestamp: '2026-05-10T10:00:00Z', skill_name: 'dev-loop', args: '', rating: 8 },
      { session_id: 's1', timestamp: '2026-05-10T10:05:00Z', skill_name: 'testing-and-qa-validation', args: '', rating: 8 },
      { session_id: 's2', timestamp: '2026-05-10T11:00:00Z', skill_name: 'dev-loop', args: '', rating: 9 },
      { session_id: 's2', timestamp: '2026-05-10T11:05:00Z', skill_name: 'testing-and-qa-validation', args: '', rating: 9 },
      { session_id: 's3', timestamp: '2026-05-10T12:00:00Z', skill_name: 'debugging-and-bug-fixes', args: '', rating: 7 },
      { session_id: 's3', timestamp: '2026-05-10T12:05:00Z', skill_name: 'research-and-api-investigation', args: '', rating: 7 }
    ];

    writeFileSync(sequencesPath, sequences.map(s => JSON.stringify(s)).join('\n'));

    const toolPath = join(process.env.HOME!, '.claude', 'PAI', 'Tools', 'SkillCooccurrence.ts');

    execSync(`bun ${toolPath}`, {
      env: {
        ...process.env,
        SEQUENCES_FILE: sequencesPath,
        OUTPUT_FILE: outputPath
      }
    });

    expect(existsSync(outputPath)).toBe(true);
    const matrix = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // dev-loop + testing occurred together 2 times
    expect(matrix['dev-loop']['testing-and-qa-validation']).toBe(2);
    expect(matrix['testing-and-qa-validation']['dev-loop']).toBe(2);

    // debugging + research occurred together 1 time
    expect(matrix['debugging-and-bug-fixes']['research-and-api-investigation']).toBe(1);
    expect(matrix['research-and-api-investigation']['debugging-and-bug-fixes']).toBe(1);

    // dev-loop and debugging never occurred together
    expect(matrix['dev-loop']['debugging-and-bug-fixes']).toBeUndefined();
  });

  test('handles single-skill sessions (no pairs)', () => {
    const sequences = [
      { session_id: 's1', timestamp: '2026-05-10T10:00:00Z', skill_name: 'dev-loop', args: '', rating: 8 },
      { session_id: 's2', timestamp: '2026-05-10T11:00:00Z', skill_name: 'testing-and-qa-validation', args: '', rating: 9 }
    ];

    writeFileSync(sequencesPath, sequences.map(s => JSON.stringify(s)).join('\n'));

    const toolPath = join(process.env.HOME!, '.claude', 'PAI', 'Tools', 'SkillCooccurrence.ts');

    execSync(`bun ${toolPath}`, {
      env: {
        ...process.env,
        SEQUENCES_FILE: sequencesPath,
        OUTPUT_FILE: outputPath
      }
    });

    const matrix = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // Each skill appears but has no co-occurrences
    expect(matrix['dev-loop']).toEqual({});
    expect(matrix['testing-and-qa-validation']).toEqual({});
  });

  test('handles empty input file', () => {
    writeFileSync(sequencesPath, '');

    const toolPath = join(process.env.HOME!, '.claude', 'PAI', 'Tools', 'SkillCooccurrence.ts');

    execSync(`bun ${toolPath}`, {
      env: {
        ...process.env,
        SEQUENCES_FILE: sequencesPath,
        OUTPUT_FILE: outputPath
      }
    });

    const matrix = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(Object.keys(matrix).length).toBe(0);
  });

  test('counts multiple occurrences in same session as one', () => {
    // Same skill called twice in one session — should count as 1 for pairs
    const sequences = [
      { session_id: 's1', timestamp: '2026-05-10T10:00:00Z', skill_name: 'dev-loop', args: '', rating: 8 },
      { session_id: 's1', timestamp: '2026-05-10T10:01:00Z', skill_name: 'dev-loop', args: '', rating: 8 },
      { session_id: 's1', timestamp: '2026-05-10T10:05:00Z', skill_name: 'testing-and-qa-validation', args: '', rating: 8 }
    ];

    writeFileSync(sequencesPath, sequences.map(s => JSON.stringify(s)).join('\n'));

    const toolPath = join(process.env.HOME!, '.claude', 'PAI', 'Tools', 'SkillCooccurrence.ts');

    execSync(`bun ${toolPath}`, {
      env: {
        ...process.env,
        SEQUENCES_FILE: sequencesPath,
        OUTPUT_FILE: outputPath
      }
    });

    const matrix = JSON.parse(readFileSync(outputPath, 'utf-8'));

    // dev-loop + testing co-occurred once (same session)
    expect(matrix['dev-loop']['testing-and-qa-validation']).toBe(1);
  });

  test('JSON output format validation', () => {
    const sequences = [
      { session_id: 's1', timestamp: '2026-05-10T10:00:00Z', skill_name: 'dev-loop', args: '', rating: 8 },
      { session_id: 's1', timestamp: '2026-05-10T10:05:00Z', skill_name: 'testing-and-qa-validation', args: '', rating: 8 }
    ];

    writeFileSync(sequencesPath, sequences.map(s => JSON.stringify(s)).join('\n'));

    const toolPath = join(process.env.HOME!, '.claude', 'PAI', 'Tools', 'SkillCooccurrence.ts');

    execSync(`bun ${toolPath}`, {
      env: {
        ...process.env,
        SEQUENCES_FILE: sequencesPath,
        OUTPUT_FILE: outputPath
      }
    });

    const content = readFileSync(outputPath, 'utf-8');
    const matrix = JSON.parse(content); // Must be valid JSON

    // Top-level keys are skill names
    Object.keys(matrix).forEach(skill => {
      expect(typeof skill).toBe('string');
      expect(typeof matrix[skill]).toBe('object');

      // Nested values are counts
      Object.values(matrix[skill]).forEach(count => {
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThan(0);
      });
    });
  });
});
