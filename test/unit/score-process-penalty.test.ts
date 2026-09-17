/**
 * Regression tests for gate retry tracking and process penalty in score-issue.sh
 * Issue #72 — Gate retry tracking and process penalty
 *
 * Tests:
 *   - No gate-runs.jsonl → retries = 0, no penalty
 *   - 1 run per gate → retries = 0, no penalty
 *   - 3 scope-gate runs → max retries = 2, penalty applied (A→B)
 *   - 2 retries on verify → penalty applied
 *   - 1 retry on all gates → penalty applied (total_retries = 4, threshold is 2)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const WT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

let tempDir: string;
let workDir: string;
let scriptDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'score-penalty-'));
  // score-issue.sh uses ${HOME}/.claude/MEMORY/WORK/${SLUG} — HOME is set to tempDir
  workDir = join(tempDir, '.claude', 'MEMORY', 'WORK', 'test-slug');
  mkdirSync(workDir, { recursive: true });
  scriptDir = join(WT, 'skills', 'ship');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper: create gate check JSONs (prerequisite for score-issue.sh)
function createGateChecks(dir: string) {
  const gates = ['scope-check.json', 'verify-check.json', 'durability-check.json'];
  for (const gate of gates) {
    writeFileSync(join(dir, gate), JSON.stringify({
      gate: gate.replace('-check.json', '-gate'),
      issue: 999,
      slug: 'test-slug',
      timestamp: new Date().toISOString(),
      pass: 5,
      fail: 0,
      checks: []
    }));
  }
}

// Helper: create stuck-detection.json
function createStuckDetection(dir: string, iterationCount = 0) {
  writeFileSync(join(dir, 'stuck-detection.json'), JSON.stringify({
    iteration_count: iterationCount,
    last_state: 'CONTINUE',
    start_timestamp: new Date().toISOString()
  }));
}

// Helper: write gate-runs.jsonl with specific entries
function writeGateRuns(dir: string, entries: Array<{ gate: string; pass: number; fail: number; result: string }>) {
  const lines = entries.map(e => JSON.stringify({
    gate: e.gate,
    pass: e.pass,
    fail: e.fail,
    result: e.result,
    ts: new Date().toISOString()
  }));
  writeFileSync(join(dir, 'gate-runs.jsonl'), lines.join('\n') + '\n');
}

// Helper: parse scorecard.json
function readScorecard(dir: string): {
  grade: string;
  process?: { max_retries: number; total_retries: number; penalty_applied: boolean };
} {
  const raw = readFileSync(join(dir, 'scorecard.json'), 'utf-8');
  return JSON.parse(raw);
}

// Helper: run score-issue.sh with mocked gh commands
function runScoreIssue(slugDir: string): string {
  const mockBin = join(tempDir, 'bin');
  mkdirSync(mockBin, { recursive: true });

  // Mock gh script that returns minimal valid data
  writeFileSync(join(mockBin, 'gh'), `#!/bin/bash
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  # Return raw body text (--jq '.body' strips JSON wrapper)
  cat << 'GHEOF'
## Sizing Declaration
Predicted: S

## AC-1
Test acceptance criterion
GHEOF
elif [[ "$1" == "api" ]]; then
  echo "## Sizing Outcome"
  echo "Mismatch: NO"
fi
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: tempDir,
    PAI_WORK_DIR: join(tempDir, '.claude', 'MEMORY', 'WORK'),
    PATH: `${mockBin}:${process.env.PATH}`,
  };

  try {
    const output = execSync(
      `bash "${join(scriptDir, 'score-issue.sh')}" --issue 999 --slug test-slug --repo hornjason/pai-config`,
      { env, cwd: scriptDir, encoding: 'utf-8', timeout: 15000 }
    );
    return output;
  } catch (e: any) {
    return e.stdout || e.stderr || e.message;
  }
}


describe('Gate retry tracking and process penalty (#72)', () => {

  describe('No gate-runs.jsonl — backward compatible', () => {
    it('retries = 0 and no penalty when gate-runs.jsonl does not exist', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      expect(existsSync(join(workDir, 'gate-runs.jsonl'))).toBe(false);

      runScoreIssue(workDir);
      const scorecard = readScorecard(workDir);

      expect(scorecard.process).toBeDefined();
      expect(scorecard.process!.max_retries).toBe(0);
      expect(scorecard.process!.total_retries).toBe(0);
      expect(scorecard.process!.penalty_applied).toBe(false);
    });
  });

  describe('1 run per gate — no retries', () => {
    it('retries = 0 when each gate ran exactly once', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      writeGateRuns(workDir, [
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'verify', pass: 4, fail: 0, result: 'PASS' },
        { gate: 'durability', pass: 6, fail: 0, result: 'PASS' },
        { gate: 'close', pass: 3, fail: 0, result: 'PASS' },
      ]);

      runScoreIssue(workDir);
      const scorecard = readScorecard(workDir);

      expect(scorecard.process!.max_retries).toBe(0);
      expect(scorecard.process!.total_retries).toBe(0);
      expect(scorecard.process!.penalty_applied).toBe(false);
    });
  });

  describe('3 scope-gate runs — max retries = 2, penalty applied', () => {
    it('downgrades A to B when scope gate ran 3 times', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      writeGateRuns(workDir, [
        { gate: 'scope', pass: 3, fail: 2, result: 'FAIL' },
        { gate: 'scope', pass: 4, fail: 1, result: 'FAIL' },
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'verify', pass: 4, fail: 0, result: 'PASS' },
        { gate: 'durability', pass: 6, fail: 0, result: 'PASS' },
        { gate: 'close', pass: 3, fail: 0, result: 'PASS' },
      ]);

      runScoreIssue(workDir);
      const scorecard = readScorecard(workDir);

      expect(scorecard.process!.max_retries).toBe(2);
      expect(scorecard.process!.total_retries).toBe(2);
      expect(scorecard.process!.penalty_applied).toBe(true);
      // Base grade would be A (90%+ first pass, 0 iterations, MATCH sizing)
      // With penalty: A → B
      expect(scorecard.grade).toBe('B');
    });
  });

  describe('2 retries on verify — penalty applied', () => {
    it('applies penalty when verify gate has 2 retries (3 runs)', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      writeGateRuns(workDir, [
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'verify', pass: 2, fail: 3, result: 'FAIL' },
        { gate: 'verify', pass: 3, fail: 2, result: 'FAIL' },
        { gate: 'verify', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'durability', pass: 6, fail: 0, result: 'PASS' },
        { gate: 'close', pass: 3, fail: 0, result: 'PASS' },
      ]);

      runScoreIssue(workDir);
      const scorecard = readScorecard(workDir);

      expect(scorecard.process!.max_retries).toBe(2);
      expect(scorecard.process!.penalty_applied).toBe(true);
    });
  });

  describe('1 retry on all gates — penalty applied (total retries threshold)', () => {
    it('applies penalty when total retries = 4 (above threshold of 2)', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      writeGateRuns(workDir, [
        { gate: 'scope', pass: 3, fail: 2, result: 'FAIL' },
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'verify', pass: 3, fail: 1, result: 'FAIL' },
        { gate: 'verify', pass: 4, fail: 0, result: 'PASS' },
        { gate: 'durability', pass: 5, fail: 1, result: 'FAIL' },
        { gate: 'durability', pass: 6, fail: 0, result: 'PASS' },
        { gate: 'close', pass: 2, fail: 1, result: 'FAIL' },
        { gate: 'close', pass: 3, fail: 0, result: 'PASS' },
      ]);

      runScoreIssue(workDir);
      const scorecard = readScorecard(workDir);

      expect(scorecard.process!.max_retries).toBe(1);
      expect(scorecard.process!.total_retries).toBe(4);
      expect(scorecard.process!.penalty_applied).toBe(true);
      // Base grade A (90%+ first pass, 0 iterations, MATCH sizing)
      // Penalty: A → B
      expect(scorecard.grade).toBe('B');
    });
  });

  describe('PROCESS row in printed output', () => {
    it('includes PROCESS row with retry counts in stdout', () => {
      createGateChecks(workDir);
      createStuckDetection(workDir, 0);

      writeGateRuns(workDir, [
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
        { gate: 'verify', pass: 4, fail: 0, result: 'PASS' },
        { gate: 'durability', pass: 6, fail: 0, result: 'PASS' },
        { gate: 'close', pass: 3, fail: 0, result: 'PASS' },
      ]);

      const output = runScoreIssue(workDir);

      expect(output).toContain('PROCESS');
      expect(output).toContain('2/2');  // max_retries/total_retries
    });
  });

  describe('Gate JSONL append format', () => {
    it('gate-runs.jsonl entries have required fields', () => {
      const testFile = join(workDir, 'gate-runs.jsonl');
      writeGateRuns(workDir, [
        { gate: 'scope', pass: 5, fail: 0, result: 'PASS' },
      ]);

      const lines = readFileSync(testFile, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.gate).toBe('scope');
      expect(entry.pass).toBe(5);
      expect(entry.fail).toBe(0);
      expect(entry.result).toBe('PASS');
      expect(entry.ts).toBeDefined();
    });
  });
});
