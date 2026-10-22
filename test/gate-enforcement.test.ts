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
  runGateEnforcement,
  type GateFailure,
  type GatePending,
  type WorkflowGateFailure,
  type EnforcementDecision,
  type WorkflowScan,
} from '../lib/gate-enforcement';
import { readFileSync, existsSync } from 'fs';

/**
 * Narrow a scan to its measured variant. Deliberately a throwing assertion
 * rather than a cast: `failure` exists only on that variant (#1155), and a
 * test that wanted the failure also wanted the sweep to have been complete.
 */
function measured(scan: WorkflowScan): WorkflowGateFailure | null {
  if (scan.reading !== 'MEASURED') {
    throw new Error(`expected MEASURED, got UNMEASURED: ${scan.unmeasuredReasons.join('; ')}`);
  }
  return scan.failure;
}

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
      const result = measured(findWorkflowGateFailure('/nonexistent/path'));
      expect(result).toBeNull();
    });

    it('returns null when no workflow files exist', () => {
      mkdirSync(join(tempDir, 'some-slug'), { recursive: true });
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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
      const result = measured(findWorkflowGateFailure(tempDir));
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

// ── #1155: an unparseable workflow state is UNMEASURED, not "no gate failure" ──
//
// Every row below is labelled control or witness. The controls exist because
// the refusal must not swallow the legitimate readings: a first run with no
// work directory, and a clean state, both still report no failure.

describe('#1155 findWorkflowGateFailure: UNMEASURED refuses, it does not pass', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gate-enf-1155-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function state(slug: string, content: string): void {
    mkdirSync(join(base, slug), { recursive: true });
    writeFileSync(join(base, slug, 'workflow-state.json'), content);
  }

  const CLEAN = JSON.stringify({ phase: 'BUILD', issue: 1, gates: { scope: { result: 'PASS' } } });
  const FAILING = JSON.stringify({
    phase: 'BUILD',
    issue: 42,
    slug: 'real',
    gates: { scope: { result: 'FAIL', failures: [{ check: 'ac-count', detail: 'none' }] } },
  });

  // ── controls ───────────────────────────────────────────────────────────

  it('control: an absent work directory is MEASURED and reports no failure', () => {
    const scan = findWorkflowGateFailure(join(base, 'never-created'));
    expect(scan.reading).toBe('MEASURED');
    expect(measured(scan)).toBeNull();
    expect(scan.unmeasuredReasons).toEqual([]);
  });

  it('control: an empty work directory is MEASURED and reports no failure', () => {
    expect(findWorkflowGateFailure(base).reading).toBe('MEASURED');
    expect(measured(findWorkflowGateFailure(base))).toBeNull();
  });

  it('control: a clean state is MEASURED and reports no failure', () => {
    state('clean', CLEAN);
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('MEASURED');
    expect(measured(scan)).toBeNull();
    expect(scan.unmeasuredReasons).toEqual([]);
  });

  it('control: a DONE phase is MEASURED and reports no failure', () => {
    state('done', JSON.stringify({
      phase: 'DONE', issue: 2,
      gates: { scope: { result: 'FAIL', failures: [{ check: 'x', detail: 'y' }] } },
    }));
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('MEASURED');
    expect(measured(scan)).toBeNull();
  });

  it('control: a real gate FAIL is still MEASURED and still reported', () => {
    state('real', FAILING);
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('MEASURED');
    expect(measured(scan)?.gate).toBe('scope');
    expect(measured(scan)?.issue).toBe(42);
  });

  // ── witnesses: the catch in checkWorkflowFile ──────────────────────────
  //
  // Measured 2026-10-22: three distinct throw sources reach that one catch —
  // a JSON SyntaxError, a TypeError from reading `.phase` off a parsed
  // `null`, and an fs error when the path cannot be read at all.

  it('witness: an unparseable state is UNMEASURED, not no-failure', () => {
    state('corrupt', '{');
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('UNMEASURED');
    expect(scan.reading === 'UNMEASURED' && scan.failureFromPartialScan).toBeNull();
    expect(scan.unmeasuredReasons.join('\n')).toContain('corrupt');
  });

  it('witness: a state that is not JSON at all is UNMEASURED', () => {
    state('garbage', 'not json at all');
    expect(findWorkflowGateFailure(base).reading).toBe('UNMEASURED');
  });

  it('witness: an unreadable state path is UNMEASURED', () => {
    // A directory where the file should be: readFileSync throws EISDIR for
    // every uid, so this does not go green by accident when tests run as root.
    mkdirSync(join(base, 'eisdir', 'workflow-state.json'), { recursive: true });
    expect(findWorkflowGateFailure(base).reading).toBe('UNMEASURED');
  });

  // ── witnesses: the non-object parses, which never throw at all ─────────
  //
  // These reach no catch. `JSON.parse` succeeds, `.phase` is undefined and
  // `gates || {}` is empty, so the old code returned null down the NORMAL
  // path. The catch was never the only fail-open here.

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
    ['a string', '"hi"'],
  ])('witness: a state parsing to %s is UNMEASURED', (_label, content) => {
    state('nonobject', content);
    expect(findWorkflowGateFailure(base).reading).toBe('UNMEASURED');
  });

  // ── witnesses: the two catches in findWorkflowGateFailure itself ───────

  it('witness: an unparseable NESTED state is UNMEASURED', () => {
    mkdirSync(join(base, 'pai', '361'), { recursive: true });
    writeFileSync(join(base, 'pai', '361', 'workflow-state.json'), '{');
    expect(findWorkflowGateFailure(base).reading).toBe('UNMEASURED');
  });

  it('witness: a work directory that cannot be listed is UNMEASURED', () => {
    const notADir = join(base, 'file-not-dir');
    writeFileSync(notADir, 'x');
    const scan = findWorkflowGateFailure(notADir);
    expect(scan.reading).toBe('UNMEASURED');
    expect(scan.reading === 'UNMEASURED' && scan.failureFromPartialScan).toBeNull();
  });

  // ── a refusal does not discard the readable run ────────────────────────

  it('witness: a corrupt sibling does not hide a real FAIL next to it', () => {
    state('aaa-corrupt', '{');
    state('zzz-real', FAILING);
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('UNMEASURED');
    expect(scan.reading === 'UNMEASURED' && scan.failureFromPartialScan?.issue).toBe(42);
  });

  // The same two files the other way round. Both orderings must agree, or
  // `reading` is a fact about readdir rather than about the work directory.
  it('witness: a corrupt sibling is reported even when it sorts AFTER the FAIL', () => {
    state('aaa-real', FAILING);
    state('zzz-corrupt', '{');
    const scan = findWorkflowGateFailure(base);
    expect(scan.reading).toBe('UNMEASURED');
    expect(scan.reading === 'UNMEASURED' && scan.failureFromPartialScan?.issue).toBe(42);
    expect(scan.unmeasuredReasons.join('\n')).toContain('zzz-corrupt');
  });
});

describe('#1155 runGateEnforcement: the refusal, and the repair path it leaves open', () => {
  let base: string;
  let workDir: string;
  let pendingFile: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gate-enf-run-1155-'));
    workDir = join(base, 'work');
    mkdirSync(join(workDir, 'corrupt'), { recursive: true });
    writeFileSync(join(workDir, 'corrupt', 'workflow-state.json'), '{');
    pendingFile = join(base, 'gate-pending.json');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function run(toolName: string) {
    return runGateEnforcement({
      workDir,
      signalsDir: join(base, 'signals'),
      signalsFile: join(base, 'signals', 'signals.jsonl'),
      pendingFile,
      projectRoot: join(base, 'root'),
      sessionId: 's-1155',
      toolName,
    });
  }

  it('witness: a Skill call is blocked while the state cannot be read', () => {
    const r = run('Skill');
    expect(r.action).toBe('block');
    expect(JSON.parse(r.stdout!).decision).toBe('block');
  });

  it('witness: the refusal names the artifact and a repair command', () => {
    const reason = JSON.parse(run('Skill').stdout!).reason as string;
    expect(reason).toContain('UNMEASURED');
    expect(reason).toContain('workflow-state.json');
    expect(reason).toContain('writeWorkflowState');
  });

  // The deadlock control. Measured 2026-10-22: WorkflowStateGuard refuses
  // Write/Edit of this artifact and names a `bun -e … writeWorkflowState`
  // repair; BashWriteGuard only inspects `>`/`>>`/tee/cp/mv targets, so that
  // command is allowed. The repair therefore runs over Bash — and a refusal
  // that also blocked Bash would make a corrupt state unrepairable.
  it('control: Bash is NOT blocked — the repair path stays reachable', () => {
    const r = run('Bash');
    expect(r.action).not.toBe('block');
  });

  it('control: Read and Edit are not blocked either', () => {
    expect(run('Read').action).not.toBe('block');
    expect(run('Edit').action).not.toBe('block');
  });

  it('witness: an unmeasured reading does not clear the strike counter', () => {
    writeFileSync(pendingFile, JSON.stringify({ issue: 9, gate: 'verify', strike_count: 2 }));
    run('Bash');
    expect(existsSync(pendingFile)).toBe(true);
  });

  it('control: a clean work directory still clears the strike counter', () => {
    rmSync(join(workDir, 'corrupt'), { recursive: true, force: true });
    writeFileSync(pendingFile, JSON.stringify({ issue: 9, gate: 'verify', strike_count: 2 }));
    const r = run('Bash');
    expect(r.action).toBe('pass');
    expect(existsSync(pendingFile)).toBe(false);
  });
});

// ── #1155 round 2: the fail-open had routes the catch was not on ──────────
//
// A security review on the live branch found three more, and measurement
// found a fourth. All of them reach the SAME wrong answer as the original
// catch — "no gate failure" — by walking past a malformed value instead of
// throwing on it. Live-data control for every refusal below: 164 state files
// under the real work store, of which issue=number 164/164, acs=array
// 164/164, slug=string 164/164, and 95 of 95 FAIL gates carry `failures` as a
// non-empty array. So none of these refusals can fire on a sanctioned state.

describe('#1155 a malformed value is UNMEASURED, not "no gate failure"', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gate-enf-shape-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  function scan(body: Record<string, unknown>) {
    mkdirSync(join(base, 's'), { recursive: true });
    writeFileSync(join(base, 's', 'workflow-state.json'), JSON.stringify(body));
    return findWorkflowGateFailure(base);
  }
  const FAILS = [{ check: 'c', detail: 'd' }];
  const okGates = { scope: { result: 'FAIL', failures: FAILS } };

  // ── gates, and the records under it ──────────────────────────────────

  it.each([
    ['a string', 'x'],
    ['an array', []],
    ['a number', 7],
  ])('witness: gates present as %s is UNMEASURED', (_l, gates) => {
    const s = scan({ phase: 'BUILD', issue: 1, acs: [], gates });
    expect(s.reading).toBe('UNMEASURED');
    expect(s.unmeasuredReasons.join('\n')).toContain('gates');
  });

  it('witness: a gate record that is not an object is UNMEASURED', () => {
    expect(scan({ phase: 'BUILD', issue: 1, acs: [], gates: { scope: 'FAIL' } }).reading)
      .toBe('UNMEASURED');
  });

  // The sharpest one, and not in the review: `result: "FAIL"` is unambiguous,
  // and the old code DROPPED it because the failures list was the wrong type.
  it('witness: a FAIL whose failures list is not an array is UNMEASURED', () => {
    const s = scan({ phase: 'BUILD', issue: 1, acs: [], gates: { scope: { result: 'FAIL', failures: 'oops' } } });
    expect(s.reading).toBe('UNMEASURED');
    expect(s.unmeasuredReasons.join('\n')).toContain('failures');
  });

  it('witness: acs present as a non-array is UNMEASURED', () => {
    // Not cosmetic: acs feeds hasOutcomeAcFailure, and an OUTCOME AC failure
    // is the difference between an immediate block and a 3-strike nag.
    const s = scan({ phase: 'BUILD', issue: 1, acs: 'nope', gates: okGates });
    expect(s.reading).toBe('UNMEASURED');
  });

  // ── issue and slug: the strike counter's key ──────────────────────────

  it.each([
    ['a string', '42'],
    ['null', null],
    ['an object', {}],
  ])('witness: issue present as %s is UNMEASURED', (_l, issue) => {
    expect(scan({ phase: 'BUILD', issue, acs: [], gates: okGates }).reading).toBe('UNMEASURED');
  });

  it('witness: a state with no issue at all is UNMEASURED', () => {
    expect(scan({ phase: 'BUILD', acs: [], gates: okGates }).reading).toBe('UNMEASURED');
  });

  it('witness: slug present as a non-string is UNMEASURED', () => {
    expect(scan({ phase: 'BUILD', issue: 1, slug: 42, acs: [], gates: okGates }).reading)
      .toBe('UNMEASURED');
  });

  // Why a non-number issue is not a cosmetic complaint. Measured: the strike
  // counter is keyed on `issue` with `===`, so a string issue reads 0 strikes
  // forever, never reaches max_strikes, and the agent is never blocked.
  it('witness: a string issue silently defeats strike escalation', () => {
    const pf = join(base, 'pending.json');
    writeFileSync(pf, JSON.stringify({ issue: 42, gate: 'scope', strike_count: 2 }));
    expect(loadStrikeCount(pf, 42, 'scope')).toBe(2);
    expect(loadStrikeCount(pf, '42' as unknown as number, 'scope')).toBe(0);
  });

  // ── controls: the schema-legal shapes must still read clean ──────────

  it('control: a state with no gates key at all is MEASURED', () => {
    const s = scan({ phase: 'BUILD', issue: 1, acs: [] });
    expect(s.reading).toBe('MEASURED');
  });

  it('control: no acs key is MEASURED — acs is absent, not malformed', () => {
    expect(scan({ phase: 'BUILD', issue: 1, gates: okGates }).reading).toBe('MEASURED');
  });

  it('control: no slug key is MEASURED and still falls back to the dir name', () => {
    const s = scan({ phase: 'BUILD', issue: 1, acs: [], gates: okGates });
    expect(s.reading).toBe('MEASURED');
    expect(s.reading === 'MEASURED' && s.failure?.slug).toBe('s');
  });

  // `failures` is `z.array(z.any()).optional()`, so ABSENT is schema-legal
  // and must not refuse — only a present-but-wrong-typed one does. 0 of 95
  // live FAIL gates omit it, so this arm is for the schema, not for a case
  // anyone has hit.
  it('control: a FAIL with no failures key is schema-legal and does not refuse', () => {
    expect(scan({ phase: 'BUILD', issue: 1, acs: [], gates: { scope: { result: 'FAIL' } } }).reading)
      .toBe('MEASURED');
  });

  it('control: a fully well-formed failing state is MEASURED and reported', () => {
    const s = scan({ phase: 'BUILD', issue: 1, slug: 'x', acs: [], gates: okGates });
    expect(s.reading).toBe('MEASURED');
    expect(s.reading === 'MEASURED' && s.failure?.issue).toBe(1);
  });
});

describe('#1155 an incomplete sweep is never reported as complete', () => {
  let base: string, workDir: string, pendingFile: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gate-enf-partial-'));
    workDir = join(base, 'work');
    pendingFile = join(base, 'pending.json');
    mkdirSync(join(workDir, 'aaa-real'), { recursive: true });
    writeFileSync(join(workDir, 'aaa-real', 'workflow-state.json'), JSON.stringify({
      phase: 'BUILD', issue: 42, slug: 'aaa-real', acs: [],
      gates: { scope: { result: 'FAIL', failures: [{ check: 'ac', detail: 'none' }] } },
    }));
    mkdirSync(join(workDir, 'zzz-corrupt'), { recursive: true });
    writeFileSync(join(workDir, 'zzz-corrupt', 'workflow-state.json'), '{');
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  function run(toolName: string) {
    return runGateEnforcement({
      workDir, signalsDir: join(base, 'sig'), signalsFile: join(base, 'sig', 's.jsonl'),
      pendingFile, projectRoot: join(base, 'root'), sessionId: 's', toolName,
    });
  }

  // The union does the work the comment could not: on UNMEASURED there is no
  // `failure` key to read past the reading, so the hazard is structural
  // rather than a warning sitting next to the number.
  it('witness: a readable failure does NOT make the scan report MEASURED', () => {
    const s = findWorkflowGateFailure(workDir);
    expect(s.reading).toBe('UNMEASURED');
    expect((s as Record<string, unknown>).failure).toBeUndefined();
    expect(s.reading === 'UNMEASURED' && s.failureFromPartialScan?.issue).toBe(42);
  });

  it('witness: a Skill call is blocked even though a failure was readable', () => {
    const r = run('Skill');
    expect(r.action).toBe('block');
    const reason = JSON.parse(r.stdout!).reason as string;
    expect(reason).toContain('UNMEASURED');
    // and it still tells the agent about the failure it COULD read
    expect(reason).toContain('42');
  });

  it('control: Bash stays open in the partial-scan case too', () => {
    expect(run('Bash').action).not.toBe('block');
  });

  it('control: with the corrupt state removed, the real FAIL reports normally', () => {
    rmSync(join(workDir, 'zzz-corrupt'), { recursive: true, force: true });
    const s = findWorkflowGateFailure(workDir);
    expect(s.reading).toBe('MEASURED');
    expect(s.reading === 'MEASURED' && s.failure?.issue).toBe(42);
    expect(run('Skill').action).toBe('nag');
  });
});
