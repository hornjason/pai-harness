import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const HOOK_PATH = join(import.meta.dir, '../../hooks/TestSuiteGuard.hook.ts');
const TMPDIR = process.env.TMPDIR || '/tmp';

function counterPath(sessionId: string) {
  return join(TMPDIR, `rungate-test-suite-count-${sessionId}`);
}

async function runHook(command: string, sessionId = 'test-tsg'): Promise<string> {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId });
  const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe('TestSuiteGuard', () => {
  const sessionId = `test-tsg-${Date.now()}`;

  afterEach(() => {
    const p = counterPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
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
