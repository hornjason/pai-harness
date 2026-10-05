import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
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

async function runHook(command: string, sessionId = 'test-tsg'): Promise<string> {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId });
  const proc = Bun.spawn(['bun', HOOK_PATH], {
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
