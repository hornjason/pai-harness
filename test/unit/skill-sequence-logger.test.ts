/**
 * skill-sequence-logger.test.ts
 *
 * Test suite for SkillSequenceLogger hook (SessionEnd trigger)
 *
 * COVERAGE:
 * - Transcript parsing for Skill() tool calls
 * - JSONL format validation
 * - Rating join logic (session_id match)
 * - Non-blocking behavior (always exit 0)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('SkillSequenceLogger.hook.ts', () => {
  let tempDir: string;
  let ratingsPath: string;
  let sequencesPath: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skill-seq-test-'));
    ratingsPath = join(tempDir, 'ratings.jsonl');
    sequencesPath = join(tempDir, 'skill-sequences.jsonl');
    transcriptPath = join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('parses Skill() tool calls from transcript', () => {
    // Red phase — hook doesn't exist yet
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me use a skill' },
            { type: 'tool_use', name: 'Skill', input: { skill: 'dev-loop', args: 'BKL-042' } }
          ]
        }
      },
      {
        type: 'tool_result',
        message: { content: [{ type: 'text', text: 'Skill completed successfully' }] }
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'testing-and-qa-validation' } }
          ]
        }
      }
    ];

    writeFileSync(transcriptPath, transcript.map(t => JSON.stringify(t)).join('\n'));
    writeFileSync(ratingsPath, JSON.stringify({
      session_id: 'test-123',
      rating: 8,
      timestamp: '2026-05-10T10:00:00Z'
    }) + '\n');

    const input = JSON.stringify({
      session_id: 'test-123',
      transcript_path: transcriptPath
    });

    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'SkillSequenceLogger.hook.ts');

    // This will fail until we implement the hook
    execSync(`bun ${hookPath}`, {
      input: input,
      env: {
        ...process.env,
        RATINGS_FILE: ratingsPath,
        SEQUENCES_FILE: sequencesPath
      }
    });

    expect(existsSync(sequencesPath)).toBe(true);
    const lines = readFileSync(sequencesPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2); // Two Skill() calls

    const first = JSON.parse(lines[0]);
    expect(first.skill_name).toBe('dev-loop');
    expect(first.args).toBe('BKL-042');
    expect(first.session_id).toBe('test-123');
    expect(first.rating).toBe(8);

    const second = JSON.parse(lines[1]);
    expect(second.skill_name).toBe('testing-and-qa-validation');
    expect(second.session_id).toBe('test-123');
    expect(second.rating).toBe(8);
  });

  test('joins with ratings.jsonl on session_id', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'debugging-and-bug-fixes' } }
          ]
        }
      }
    ];

    writeFileSync(transcriptPath, transcript.map(t => JSON.stringify(t)).join('\n'));
    writeFileSync(ratingsPath, JSON.stringify({
      session_id: 'test-456',
      rating: 3,
      timestamp: '2026-05-10T11:00:00Z'
    }) + '\n');

    const input = JSON.stringify({
      session_id: 'test-456',
      transcript_path: transcriptPath
    });

    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'SkillSequenceLogger.hook.ts');

    execSync(`bun ${hookPath}`, {
      input: input,
      env: {
        ...process.env,
        RATINGS_FILE: ratingsPath,
        SEQUENCES_FILE: sequencesPath
      }
    });

    const lines = readFileSync(sequencesPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.rating).toBe(3);
  });

  test('handles missing rating gracefully (rating=null)', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'research-and-api-investigation' } }
          ]
        }
      }
    ];

    writeFileSync(transcriptPath, transcript.map(t => JSON.stringify(t)).join('\n'));
    // No ratings.jsonl file created — missing rating scenario

    const input = JSON.stringify({
      session_id: 'test-789',
      transcript_path: transcriptPath
    });

    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'SkillSequenceLogger.hook.ts');

    execSync(`bun ${hookPath}`, {
      input: input,
      env: {
        ...process.env,
        RATINGS_FILE: ratingsPath,
        SEQUENCES_FILE: sequencesPath
      }
    });

    const lines = readFileSync(sequencesPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.rating).toBeNull();
  });

  test('always exits 0 (non-blocking)', () => {
    const input = JSON.stringify({
      session_id: 'test-exit',
      transcript_path: '/nonexistent/path'
    });

    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'SkillSequenceLogger.hook.ts');

    // Even with invalid input, should exit 0
    const result = execSync(`bun ${hookPath}; echo $?`, {
      input: input,
      encoding: 'utf-8',
      env: {
        ...process.env,
        RATINGS_FILE: ratingsPath,
        SEQUENCES_FILE: sequencesPath
      }
    });

    expect(result.trim().endsWith('0')).toBe(true);
  });

  test('JSONL format validation', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'product-feature-development' } }
          ]
        }
      }
    ];

    writeFileSync(transcriptPath, transcript.map(t => JSON.stringify(t)).join('\n'));

    const input = JSON.stringify({
      session_id: 'test-format',
      transcript_path: transcriptPath
    });

    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'SkillSequenceLogger.hook.ts');

    execSync(`bun ${hookPath}`, {
      input: input,
      env: {
        ...process.env,
        RATINGS_FILE: ratingsPath,
        SEQUENCES_FILE: sequencesPath
      }
    });

    const content = readFileSync(sequencesPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Each line must be valid JSON
    lines.forEach(line => {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('session_id');
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('skill_name');
      expect(entry).toHaveProperty('rating');
    });
  });
});
