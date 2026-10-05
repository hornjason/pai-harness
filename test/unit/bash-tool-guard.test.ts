import { describe, it, expect } from 'bun:test';
import { join } from 'path';

const HOOK_PATH = join(import.meta.dir, '../../hooks/BashToolGuard.hook.ts');

async function runHook(command: string): Promise<string> {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'test-btg' });
  const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(input);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function expectBlock(out: string) {
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe('block');
  expect(parsed.reason).toContain('COMP-7');
}

function expectAllow(out: string) {
  expect(out).toBe('');
}

describe('BashToolGuard', () => {
  // --- Direct invocation patterns (cat, head, tail) ---
  describe('direct invocation', () => {
    it('blocks direct cat', async () => {
      expectBlock(await runHook('cat file.txt'));
    });

    it('blocks direct head', async () => {
      expectBlock(await runHook('head -20 file.txt'));
    });

    it('blocks direct tail', async () => {
      expectBlock(await runHook('tail file.txt'));
    });
  });

  // --- Semicolon-chained patterns ---
  describe('semicolon-chained', () => {
    it('blocks cat after semicolon', async () => {
      expectBlock(await runHook('cd /tmp; cat file.txt'));
    });

    it('blocks head after semicolon', async () => {
      expectBlock(await runHook('cd /tmp; head -10 file.txt'));
    });

    it('blocks tail after semicolon', async () => {
      expectBlock(await runHook('cd /tmp; tail -f log.txt'));
    });
  });

  // --- Piped patterns (the gap that AC-2 addresses) ---
  describe('piped patterns', () => {
    it('blocks piped cat (grep | cat)', async () => {
      expectBlock(await runHook('grep foo bar.txt | cat'));
    });

    it('blocks piped head (grep | head)', async () => {
      expectBlock(await runHook('grep foo bar.txt | head'));
    });

    it('blocks piped head with args (grep | head -20)', async () => {
      expectBlock(await runHook('grep foo bar.txt | head -20'));
    });

    it('blocks piped tail (ls | tail)', async () => {
      expectBlock(await runHook('ls -la | tail'));
    });

    it('blocks piped tail with args (find | tail -5)', async () => {
      expectBlock(await runHook('find . -name "*.ts" | tail -5'));
    });

    it('blocks piped cat with args (sort | cat -n)', async () => {
      expectBlock(await runHook('sort data.csv | cat -n'));
    });
  });

  // --- Allowed patterns (should NOT block) ---
  describe('allowed patterns', () => {
    it('allows echo piped to grep', async () => {
      expectAllow(await runHook('echo "hello" | grep hello'));
    });

    it('allows ls command', async () => {
      expectAllow(await runHook('ls -la'));
    });

    it('allows grep without pipe to cat/head/tail', async () => {
      expectAllow(await runHook('grep -r "pattern" src/'));
    });

    it('allows git commands', async () => {
      expectAllow(await runHook('git status'));
    });

    it('allows non-Bash tool_name', async () => {
      const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/test' } });
      const proc = Bun.spawn(['bun', HOOK_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      proc.stdin.write(input);
      proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out.trim()).toBe('');
    });
  });

  // --- Root cause documentation (AC-1) ---
  describe('root cause documentation', () => {
    it('hook file contains worktree root cause comment', async () => {
      const hookContent = await Bun.file(HOOK_PATH).text();
      expect(hookContent).toContain('worktree');
      expect(hookContent.toLowerCase()).toContain('root cause');
    });
  });
});
