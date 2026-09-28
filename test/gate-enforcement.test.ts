/**
 * Tests for gate enforcement logic extracted from GateEnforcement.hook.ts
 *
 * Issue: #544
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildGatePending,
  findWorkflowGateFailure,
  formatFailures,
  loadStrikeCount,
  makeEnforcementDecision,
  logSignal,
  type GateFailure,
  type GatePending,
  type WorkflowGateFailure,
  type EnforcementDecision,
} from '../lib/gate-enforcement';

describe('gate-enforcement', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gate-enforcement-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  describe('formatFailures', () => {
    it('formats a single failure', () => {
      const failures: GateFailure[] = [
        { check: 'scope', detail: 'missing AC' },
      ];
      const result = formatFailures(failures);
      expect(result).toBe('  - scope: missing AC');
    });

    it('formats multiple failures', () => {
      const failures: GateFailure[] = [
        { check: 'scope', detail: 'missing AC' },
        { check: 'verify', detail: 'tests fail' },
      ];
      const result = formatFailures(failures);
      expect(result).toContain('  - scope: missing AC');
      expect(result).toContain('  - verify: tests fail');
      expect(result.split('\n')).toHaveLength(2);
    });

    it('handles empty array', () => {
      expect(formatFailures([])).toBe('');
    });
  });

  describe('findWorkflowGateFailure', () => {
    it('returns null when workDir does not exist', () => {
      const result = findWorkflowGateFailure('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('returns null when no workflow files exist', () => {
      mkdirSync(join(tempDir, 'some-slug'), { recursive: true });
      const result = findWorkflowGateFailure(tempDir);
      expect(result).toBeNull();
    });

    it('returns null for DONE phase workflows', () => {
      const slug = 'test-issue';
      mkdirSync(join(tempDir, slug), { recursive: true });
      writeFileSync(join(tempDir, slug, 'workflow-state.json'), JSON.stringify({
        phase: 'DONE',
        issue: 123,
        slug,
        gates: {
          scope: { result: 'FAIL', failures: [{ check: 'test', detail: 'fail' }] },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result).toBeNull();
    });

    it('finds a scope gate failure', () => {
      const slug = 'test-issue';
      mkdirSync(join(tempDir, slug), { recursive: true });
      writeFileSync(join(tempDir, slug, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 42,
        slug,
        gates: {
          scope: { result: 'FAIL', failures: [{ check: 'ac-count', detail: 'no ACs defined' }] },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result).not.toBeNull();
      expect(result!.gate).toBe('scope');
      expect(result!.issue).toBe(42);
      expect(result!.failures).toHaveLength(1);
      expect(result!.failures[0].check).toBe('ac-count');
    });

    it('detects outcome AC failure', () => {
      const slug = 'test-issue';
      mkdirSync(join(tempDir, slug), { recursive: true });
      writeFileSync(join(tempDir, slug, 'workflow-state.json'), JSON.stringify({
        phase: 'VERIFY',
        issue: 99,
        slug,
        gates: {
          verify: { result: 'FAIL', failures: [{ check: 'tests', detail: 'failing' }] },
        },
        acs: [
          { type: 'OUTCOME', verdict: 'FAIL' },
        ],
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result).not.toBeNull();
      expect(result!.hasOutcomeAcFailure).toBe(true);
    });

    it('returns false for outcome AC when no OUTCOME ACs fail', () => {
      const slug = 'test-issue';
      mkdirSync(join(tempDir, slug), { recursive: true });
      writeFileSync(join(tempDir, slug, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 10,
        slug,
        gates: {
          ship: { result: 'FAIL', failures: [{ check: 'lint', detail: 'errors' }] },
        },
        acs: [
          { type: 'OUTCOME', verdict: 'PASS' },
        ],
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result).not.toBeNull();
      expect(result!.hasOutcomeAcFailure).toBe(false);
    });

    it('uses slug from workflow data when available', () => {
      const dirName = 'dir-name';
      mkdirSync(join(tempDir, dirName), { recursive: true });
      writeFileSync(join(tempDir, dirName, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 5,
        slug: 'custom-slug',
        gates: {
          scope: { result: 'FAIL', failures: [{ check: 'x', detail: 'y' }] },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result!.slug).toBe('custom-slug');
    });

    it('falls back to directory name when slug missing', () => {
      const dirName = 'fallback-dir';
      mkdirSync(join(tempDir, dirName), { recursive: true });
      writeFileSync(join(tempDir, dirName, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 5,
        gates: {
          scope: { result: 'FAIL', failures: [{ check: 'x', detail: 'y' }] },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result!.slug).toBe('fallback-dir');
    });

    it('normalizes failure fields using fallbacks', () => {
      const slug = 'normalize-test';
      mkdirSync(join(tempDir, slug), { recursive: true });
      writeFileSync(join(tempDir, slug, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 1,
        slug,
        gates: {
          scope: {
            result: 'FAIL',
            failures: [
              { id: 'alt-id', message: 'alt-msg' },
            ],
          },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result!.failures[0].check).toBe('alt-id');
      expect(result!.failures[0].detail).toBe('alt-msg');
    });
  });

  describe('makeEnforcementDecision', () => {
    function makePending(overrides: Partial<GatePending> = {}): GatePending {
      return {
        session_id: 'test-session',
        gate: 'verify',
        issue: 42,
        slug: 'test-slug',
        failures: [{ check: 'tests', detail: 'failing' }],
        strike_count: 0,
        max_strikes: 3,
        outcome_ac_failure: false,
        created_at: new Date().toISOString(),
        expires_ts: Date.now() + 1000000,
        ...overrides,
      };
    }

    it('blocks Skill calls on outcome AC failure', () => {
      const pending = makePending({ outcome_ac_failure: true });
      const result = makeEnforcementDecision(pending, 'Skill');
      expect(result.action).toBe('block');
      expect(result.reason).toContain('OUTCOME AC failed');
    });

    it('does not block non-Skill calls on outcome AC failure', () => {
      const pending = makePending({ outcome_ac_failure: true });
      const result = makeEnforcementDecision(pending, 'Bash');
      expect(result.action).toBe('nag');
    });

    it('blocks Skill calls when strike count exceeds max', () => {
      const pending = makePending({ strike_count: 3, max_strikes: 3 });
      const result = makeEnforcementDecision(pending, 'Skill');
      expect(result.action).toBe('block');
      expect(result.reason).toContain('strikes');
    });

    it('nags on Skill calls below max strikes and increments count', () => {
      const pending = makePending({ strike_count: 1, max_strikes: 3 });
      const result = makeEnforcementDecision(pending, 'Skill');
      expect(result.action).toBe('nag');
      expect(result.newStrikeCount).toBe(2);
      expect(result.reminder).toContain('GATE FAIL');
    });

    it('nags on non-Skill calls without incrementing strikes', () => {
      const pending = makePending({ strike_count: 1, max_strikes: 3 });
      const result = makeEnforcementDecision(pending, 'Read');
      expect(result.action).toBe('nag');
      expect(result.newStrikeCount).toBe(1);
    });

    it('includes failure details in block reason', () => {
      const pending = makePending({
        outcome_ac_failure: true,
        failures: [{ check: 'scope-check', detail: 'missing acceptance criteria' }],
      });
      const result = makeEnforcementDecision(pending, 'Skill');
      expect(result.reason).toContain('scope-check');
      expect(result.reason).toContain('missing acceptance criteria');
    });

    it('includes gate and issue in nag reminder', () => {
      const pending = makePending({ gate: 'ship', issue: 99 });
      const result = makeEnforcementDecision(pending, 'Edit');
      expect(result.reminder).toContain('ship');
      expect(result.reminder).toContain('99');
    });
  });

  describe('loadStrikeCount', () => {
    it('returns 0 when pending file does not exist', () => {
      const result = loadStrikeCount('/nonexistent/file.json', 42, 'scope');
      expect(result).toBe(0);
    });

    it('returns cached strike count when issue and gate match', () => {
      const file = join(tempDir, 'pending.json');
      writeFileSync(file, JSON.stringify({ issue: 42, gate: 'scope', strike_count: 2 }));
      const result = loadStrikeCount(file, 42, 'scope');
      expect(result).toBe(2);
    });

    it('returns 0 when issue does not match', () => {
      const file = join(tempDir, 'pending.json');
      writeFileSync(file, JSON.stringify({ issue: 99, gate: 'scope', strike_count: 2 }));
      const result = loadStrikeCount(file, 42, 'scope');
      expect(result).toBe(0);
    });

    it('returns 0 when gate does not match', () => {
      const file = join(tempDir, 'pending.json');
      writeFileSync(file, JSON.stringify({ issue: 42, gate: 'verify', strike_count: 2 }));
      const result = loadStrikeCount(file, 42, 'scope');
      expect(result).toBe(0);
    });
  });

  describe('buildGatePending', () => {
    it('builds a GatePending object from workflow failure', () => {
      const wfFailure: WorkflowGateFailure = {
        gate: 'verify',
        issue: 42,
        slug: 'test-slug',
        failures: [{ check: 'tests', detail: 'failing' }],
        hasOutcomeAcFailure: false,
      };
      const result = buildGatePending(wfFailure, 'session-123', 1);
      expect(result.gate).toBe('verify');
      expect(result.issue).toBe(42);
      expect(result.slug).toBe('test-slug');
      expect(result.strike_count).toBe(1);
      expect(result.max_strikes).toBe(3);
      expect(result.session_id).toBe('session-123');
      expect(result.outcome_ac_failure).toBe(false);
    });
  });

  describe('logSignal', () => {
    it('appends signal to existing file', () => {
      const signalsDir = join(tempDir, 'signals');
      mkdirSync(signalsDir, { recursive: true });
      const signalsFile = join(signalsDir, 'signals.jsonl');
      writeFileSync(signalsFile, '');

      logSignal(signalsDir, signalsFile, { type: 'test', value: 1 });

      const content = require('fs').readFileSync(signalsFile, 'utf-8');
      expect(content).toContain('"type":"test"');
    });

    it('creates signals directory if missing', () => {
      const signalsDir = join(tempDir, 'new-signals');
      const signalsFile = join(signalsDir, 'signals.jsonl');

      // Should not throw, even though file doesn't exist
      logSignal(signalsDir, signalsFile, { type: 'test' });
    });

    it('does not throw on write failure', () => {
      // Write to a nonexistent nested path should not throw
      expect(() => {
        logSignal('/nonexistent/dir', '/nonexistent/dir/file.jsonl', { type: 'test' });
      }).not.toThrow();
    });
  });
});
