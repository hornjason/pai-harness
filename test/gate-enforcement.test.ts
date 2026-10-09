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
  logEnforcementSignal,
  logDocHygieneSignals,
  type GateFailure,
  type GatePending,
  type WorkflowGateFailure,
  type EnforcementDecision,
} from '../lib/gate-enforcement';
import { readFileSync, existsSync } from 'fs';

function pendingFixture(over: Partial<GatePending> = {}): GatePending {
  return {
    session_id: 's1',
    gate: 'verify',
    issue: 42,
    slug: 'slug',
    failures: [{ check: 'ac', detail: 'nope' }],
    strike_count: 1,
    max_strikes: 3,
    outcome_ac_failure: false,
    created_at: new Date().toISOString(),
    expires_ts: Date.now() + 1000,
    ...over,
  };
}

// SC-369 / AC-6: these two used to be inline in GateEnforcement.hook.ts, where
// nothing could reach them without simulating a PreToolUse payload on stdin.
describe('gate-enforcement signal emitters (extracted from the hook)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gate-signal-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const readEvents = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];

  it('logEnforcementSignal records a block with its reason', () => {
    const file = join(dir, 'signals.jsonl');
    logEnforcementSignal(dir, file, pendingFixture({ outcome_ac_failure: true }), 'Skill', 'block', 3);
    const [e] = readEvents(file);
    expect(e.type).toBe('gate_enforcement');
    expect(e.action).toBe('block');
    expect(e.reason).toBe('outcome_ac_failure');
    expect(e.strike).toBe(3);
    expect(e.gate).toBe('verify');
    expect(e.issue).toBe(42);
    expect(e.tool).toBe('Skill');
  });

  it('logEnforcementSignal attributes a strike block to max_strikes', () => {
    const file = join(dir, 'signals.jsonl');
    logEnforcementSignal(dir, file, pendingFixture(), 'Skill', 'block', 3);
    expect(readEvents(file)[0].reason).toBe('max_strikes');
  });

  it('logEnforcementSignal records a nag without a reason', () => {
    const file = join(dir, 'signals.jsonl');
    logEnforcementSignal(dir, file, pendingFixture(), 'Bash', 'nag', 2);
    const [e] = readEvents(file);
    expect(e.action).toBe('nag');
    expect(e.reason).toBeUndefined();
    expect(e.strike).toBe(2);
  });

  it('logDocHygieneSignals writes one event per finding', () => {
    const file = join(dir, 'signals.jsonl');
    logDocHygieneSignals(dir, file, dir, () => ({
      pass: false,
      findings: [
        { checkId: 'HYGIENE-1', file: 'specs/A.md', level: 'WARN', message: 'no governs' },
        { checkId: 'HYGIENE-2', file: 'specs/B.md', level: 'WARN', message: 'no updated' },
      ],
    }));
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('doc-hygiene');
    expect(events[0].checkId).toBe('HYGIENE-1');
    expect(events[1].file).toBe('specs/B.md');
  });

  it('logDocHygieneSignals writes nothing when the check passes', () => {
    const file = join(dir, 'signals.jsonl');
    logDocHygieneSignals(dir, file, dir, () => ({ pass: true, findings: [] }));
    expect(readEvents(file)).toHaveLength(0);
  });

  // The injected `check` above makes the emitter testable but leaves the real
  // wiring unproven, which is how a feature ends up switched off while its
  // tests stay green. This one runs the DEFAULT path end to end.
  it('defaults to the real doc-hygiene scan and emits its findings', () => {
    const file = join(dir, 'signals.jsonl');
    mkdirSync(join(dir, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'UNGOVERNED-SPEC.md'), '---\ndoc-type: spec\ntestable: true\n---\n\n# Ungoverned\n');
    logDocHygieneSignals(dir, file, dir);
    const events = readEvents(file);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.map(e => e.checkId)).toContain('GOVERNS-MISSING');
  });

  // Best-effort by design: a hygiene scan that throws must not take down the
  // gate nag it is piggybacking on.
  it('logDocHygieneSignals swallows a throwing check', () => {
    const file = join(dir, 'signals.jsonl');
    expect(() => logDocHygieneSignals(dir, file, dir, () => { throw new Error('boom'); })).not.toThrow();
    expect(readEvents(file)).toHaveLength(0);
  });
});

// Moving logic out of a hook is only safe if the hook still calls it. Grepping
// the hook for the function name would pass on a call sitting after an early
// `process.exit`, so this drives the real hook with a real payload.
describe('GateEnforcement.hook.ts still emits both signal kinds', () => {
  let home: string;
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch {} });

  it('writes a gate_enforcement nag and doc-hygiene findings', () => {
    home = mkdtempSync(join(tmpdir(), 'gate-hook-'));
    const paiDir = join(home, '.claude');
    const workDir = join(home, 'work');
    mkdirSync(join(paiDir, 'MEMORY', 'STATE'), { recursive: true });
    mkdirSync(join(workDir, 'slug'), { recursive: true });
    // BASE_DIR/.. is the project root the hygiene sweep scans.
    mkdirSync(join(home, 'specs'), { recursive: true });
    writeFileSync(join(home, 'specs', 'UNGOVERNED-SPEC.md'), '---\ndoc-type: spec\ntestable: true\n---\n\n# x\n');
    writeFileSync(join(workDir, 'slug', 'workflow-state.json'), JSON.stringify({
      phase: 'VERIFY', issue: 209, slug: 'slug', acs: [],
      gates: { verify: { result: 'FAIL', failures: [{ check: 'ac', detail: 'AC-1 unmet' }] } },
    }));

    const res = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, '..', 'hooks', 'GateEnforcement.hook.ts')],
      stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', session_id: 'sess-1', tool_input: {} })),
      env: { ...process.env, PAI_DIR: paiDir, RUNGATE_WORK_DIR: workDir },
    });
    expect(res.exitCode).toBe(0);

    const signals = join(paiDir, 'MEMORY', 'LEARNING', 'SIGNALS', 'signals.jsonl');
    expect(existsSync(signals)).toBe(true);
    const types = readFileSync(signals, 'utf-8').trim().split('\n').map(l => JSON.parse(l).type);
    expect(types).toContain('gate_enforcement');
    expect(types).toContain('doc-hygiene');
  });
});

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

    it('scans nested directories (e.g. pai/361)', () => {
      const nestedDir = join(tempDir, 'pai', '361');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, 'workflow-state.json'), JSON.stringify({
        phase: 'BUILD',
        issue: 361,
        gates: {
          scope: { result: 'FAIL', failures: [{ check: 'nested', detail: 'found' }] },
        },
      }));
      const result = findWorkflowGateFailure(tempDir);
      expect(result).not.toBeNull();
      expect(result!.issue).toBe(361);
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

    it('creates signals directory and file if missing (SC-504: no silent drop)', () => {
      const signalsDir = join(tempDir, 'new-signals');
      const signalsFile = join(signalsDir, 'signals.jsonl');

      // SC-504: logSignal must create the file when it doesn't exist
      logSignal(signalsDir, signalsFile, { type: 'test' });

      const content = require('fs').readFileSync(signalsFile, 'utf-8');
      expect(content).toContain('"type":"test"');
    });

    it('does not throw on write failure', () => {
      // Write to a nonexistent nested path should not throw
      expect(() => {
        logSignal('/nonexistent/dir', '/nonexistent/dir/file.jsonl', { type: 'test' });
      }).not.toThrow();
    });
  });
});
