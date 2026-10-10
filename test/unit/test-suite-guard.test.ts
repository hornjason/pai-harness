import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = join(import.meta.dir, '../../hooks/TestSuiteGuard.hook.ts');

// The hook runs as a subprocess, so it cannot be handed a lockDir option --
// it reads RUNGATE_LOCK_DIR. Pointing it at a scratch directory keeps these
// cases off the machine-wide slots. Previously they competed for the real
// ones, including the slot held by the suite executing them, and leaked a live
// slot per case that blocked the next run for the full 420s TTL.
let lockDir: string;

function counterPath(sessionId: string) {
  return join(lockDir, `rungate-test-suite-count-${sessionId}`);
}

async function runHook(
  command: string,
  sessionId = 'test-tsg',
  extra: Record<string, unknown> = {},
  hookPath = HOOK_PATH,
): Promise<string> {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: sessionId,
    ...extra,
  });
  const proc = Bun.spawn(['bun', hookPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, RUNGATE_LOCK_DIR: lockDir },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe('TestSuiteGuard', () => {
  const sessionId = `test-tsg-${Date.now()}`;

  beforeEach(() => {
    // A fresh directory per case: slots are deliberately not released by the
    // guard itself, so reuse would carry holders between cases.
    lockDir = mkdtempSync(join(tmpdir(), 'tsg-hook-'));
  });

  afterEach(() => {
    const p = counterPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('allows targeted test runs', async () => {
    const out = await runHook('bun test test/unit/foo.test.ts', sessionId);
    expect(out).toBe('');
  });

  it('allows first full suite run', async () => {
    const out = await runHook('bun test', sessionId);
    expect(out).toBe('');
  });

  it('allows second full suite run', async () => {
    writeFileSync(counterPath(sessionId), '1');
    const out = await runHook('bun test', sessionId);
    expect(out).toBe('');
  });

  it('blocks third full suite run', async () => {
    writeFileSync(counterPath(sessionId), '2');
    const out = await runHook('bun test', sessionId);
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('DIR-L29');
  });

  it('blocks full suite with flags', async () => {
    writeFileSync(counterPath(sessionId), '2');
    const out = await runHook('bun test --parallel', sessionId);
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe('block');
  });

  it('allows targeted test even after limit', async () => {
    writeFileSync(counterPath(sessionId), '5');
    const out = await runHook('bun test test/specific.test.ts', sessionId);
    expect(out).toBe('');
  });
});

/**
 * #239 — end to end through the real hook binaries, not the lib they call.
 *
 * AC-1 is about what the HOOKS pass. The lib can be perfectly keyed on a worker
 * and the defect survives untouched if TestSuiteGuard never derives one, so
 * these cases drive the actual executables over stdin payloads shaped like the
 * ones Claude Code sends: one session id, two sub-agents, two worktrees.
 *
 * SC-621, SC-622.
 */
describe('TestSuiteGuard — sibling sub-agents under one session id (#239)', () => {
  const RELEASE_PATH = join(import.meta.dir, '../../hooks/TestSuiteRelease.hook.ts');
  const PARENT = 'parent-session-239';
  const A = { cwd: '/tmp/worktrees/wf_a', transcript_path: '/tmp/t/agent-a.jsonl' };
  const B = { cwd: '/tmp/worktrees/wf_b', transcript_path: '/tmp/t/agent-b.jsonl' };

  const counterFiles = () =>
    readdirSync(lockDir).filter((f) => f.startsWith('rungate-test-suite-count-'));

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'tsg-sibling-'));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  /** One worker's full budget: run, release, run, release. */
  async function spend(worker: Record<string, unknown>) {
    expect(await runHook('bun test', PARENT, worker)).toBe('');
    await runHook('bun test', PARENT, worker, RELEASE_PATH);
    expect(await runHook('bun test', PARENT, worker)).toBe('');
    await runHook('bun test', PARENT, worker, RELEASE_PATH);
  }

  it('spends separate rate budgets, so a sibling is not blocked by its siblings', async () => {
    await spend(A);

    // A is out of budget — DIR-L29 still works.
    const exhausted = JSON.parse(await runHook('bun test', PARENT, A));
    expect(exhausted.decision).toBe('block');
    expect(exhausted.reason).toContain('DIR-L29');

    // B shares the session id and nothing else. Before #239 it was blocked
    // here and slept out the window; run wf_18abb197-f03 lost 22 minutes to it.
    expect(await runHook('bun test', PARENT, B)).toBe('');
    expect(counterFiles()).toHaveLength(2);
    // Five `bun` spawns. The default 5s budget is a coin flip on a loaded
    // machine, and a timeout here reads as the guard misbehaving.
  }, 60_000);

  it('release frees the slot the guard took, so the worker can run again', async () => {
    // Acquire and release derive the worker identity independently. If they
    // ever disagree the slot survives until the 420s TTL, and the only visible
    // symptom is the next session being refused by a holder that finished.
    expect(await runHook('bun test', PARENT, A)).toBe('');
    expect(
      readdirSync(lockDir).filter((f) => f.startsWith('full-suite.slot-')),
    ).toHaveLength(1);

    await runHook('bun test', PARENT, A, RELEASE_PATH);
    expect(
      readdirSync(lockDir).filter((f) => f.startsWith('full-suite.slot-')),
    ).toHaveLength(0);
  }, 60_000);

  it('a payload with no worker fields still gets exactly one budget', async () => {
    // Degrade to the pre-#239 behaviour rather than to no budget: an unkeyed
    // caller must not get a fresh window on every call.
    expect(await runHook('bun test', PARENT)).toBe('');
    await runHook('bun test', PARENT, {}, RELEASE_PATH);
    expect(await runHook('bun test', PARENT)).toBe('');
    await runHook('bun test', PARENT, {}, RELEASE_PATH);

    const third = JSON.parse(await runHook('bun test', PARENT));
    expect(third.decision).toBe('block');
    expect(third.reason).toContain('DIR-L29');
    expect(counterFiles()).toHaveLength(1);
  }, 60_000);
});
