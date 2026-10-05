import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const HOOK_PATH = join(import.meta.dir, '../../hooks/BashToolGuard.hook.ts');
const PROJECT_ROOT = join(import.meta.dir, '../..');

async function runHook(command: string, cwd: string = PROJECT_ROOT): Promise<string> {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'test-btg' });
  const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function expectBlocked(out: string) {
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe('block');
  expect(parsed.reason).toContain('COMP-7');
}

function expectAllowed(out: string) {
  expect(out).toBe('');
}

describe('BashToolGuard — direct invocation', () => {
  it('blocks cat file.txt', async () => {
    const out = await runHook('cat file.txt');
    expectBlocked(out);
  });

  it('blocks head -20 file.txt', async () => {
    const out = await runHook('head -20 file.txt');
    expectBlocked(out);
  });

  it('blocks tail file.txt', async () => {
    const out = await runHook('tail file.txt');
    expectBlocked(out);
  });
});

describe('BashToolGuard — semicolon-chained patterns', () => {
  it('blocks cd /tmp; cat file.txt', async () => {
    const out = await runHook('cd /tmp; cat file.txt');
    expectBlocked(out);
  });

  it('blocks ls; head -n 50 config.json', async () => {
    const out = await runHook('ls; head -n 50 config.json');
    expectBlocked(out);
  });

  it('blocks echo done; tail -20 log.txt', async () => {
    const out = await runHook('echo done; tail -20 log.txt');
    expectBlocked(out);
  });
});

describe('BashToolGuard — &&-chained patterns', () => {
  it('blocks cd /tmp && cat file.txt', async () => {
    const out = await runHook('cd /tmp && cat file.txt');
    expectBlocked(out);
  });

  it('blocks ls && head file.txt', async () => {
    const out = await runHook('ls && head file.txt');
    expectBlocked(out);
  });
});

describe('BashToolGuard — piped cat/head/tail patterns', () => {
  it('blocks grep foo | cat', async () => {
    const out = await runHook('grep foo bar.txt | cat');
    expectBlocked(out);
  });

  it('blocks grep foo | head -20', async () => {
    const out = await runHook('grep foo bar.txt | head -20');
    expectBlocked(out);
  });

  it('blocks grep foo | tail -5', async () => {
    const out = await runHook('grep foo bar.txt | tail -5');
    expectBlocked(out);
  });

  it('blocks cmd | cat file.txt', async () => {
    const out = await runHook('ls -la | cat file.txt');
    expectBlocked(out);
  });

  it('blocks multi-pipe: cmd | grep x | head', async () => {
    const out = await runHook('find . -name "*.ts" | grep test | head');
    expectBlocked(out);
  });

  it('blocks multi-pipe: cmd | grep x | tail -20', async () => {
    const out = await runHook('find . -name "*.ts" | grep test | tail -20');
    expectBlocked(out);
  });
});

describe('BashToolGuard — allowed commands', () => {
  it('allows grep without pipe to cat', async () => {
    const out = await runHook('grep -r "pattern" src/');
    expectAllowed(out);
  });

  it('allows ls commands', async () => {
    const out = await runHook('ls -la /tmp');
    expectAllowed(out);
  });

  it('allows echo with pipe to other commands', async () => {
    const out = await runHook('echo "test" | wc -l');
    expectAllowed(out);
  });

  it('allows bun test', async () => {
    const out = await runHook('bun test test/unit/foo.test.ts');
    expectAllowed(out);
  });

  it('allows non-Bash tools', async () => {
    const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, session_id: 'test-btg' });
    const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe('');
  });
});

describe('BashToolGuard — harness project scoping', () => {
  let harnessDir: string;
  let plainDir: string;
  let nestedDir: string;

  beforeAll(() => {
    // Harnessed project: has .claude/rungate.json
    harnessDir = mkdtempSync(join(tmpdir(), 'btg-harness-'));
    mkdirSync(join(harnessDir, '.claude'), { recursive: true });
    writeFileSync(join(harnessDir, '.claude', 'rungate.json'), '{"roles":{}}');

    // Nested subdir of a harnessed project — mirrors a worktree subagent cwd
    nestedDir = join(harnessDir, '.claude', 'worktrees', 'wf_test-1');
    mkdirSync(nestedDir, { recursive: true });

    // Non-harness project: no rungate.json anywhere up the tree
    plainDir = mkdtempSync(join(tmpdir(), 'btg-plain-'));
  });

  afterAll(() => {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  it('blocks cat in a harnessed project root', async () => {
    const out = await runHook('cat file.txt', harnessDir);
    expectBlocked(out);
  });

  it('blocks cat from a worktree subdir of a harnessed project', async () => {
    const out = await runHook('cat file.txt', nestedDir);
    expectBlocked(out);
  });

  it('allows cat outside any harnessed project', async () => {
    const out = await runHook('cat file.txt', plainDir);
    expectAllowed(out);
  });

  it('allows piped head outside any harnessed project', async () => {
    const out = await runHook('grep -n "x" shared/model-migration.md | head -80', plainDir);
    expectAllowed(out);
  });

  it('allows non-Bash tools regardless of scope', async () => {
    const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, session_id: 'test-btg' });
    const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe('');
  });
});
