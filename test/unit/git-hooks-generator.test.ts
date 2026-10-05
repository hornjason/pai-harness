import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createGitHooks } from '../../lib/scaffold/steps';

let root: string;
let preCommit: string;
let script: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rungate-githooks-'));
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  createGitHooks(root, []);
  preCommit = join(root, '.git', 'hooks', 'pre-commit');
  script = readFileSync(preCommit, 'utf-8');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Run the generated hook in a throwaway repo. Returns its exit code. */
function runHookIn(setup: (repo: string) => void): { code: number; out: string } {
  const repo = mkdtempSync(join(tmpdir(), 'rungate-hookrun-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    setup(repo);
    const sh = join(repo, '.pre-commit.sh');
    writeFileSync(sh, script, { mode: 0o755 });
    try {
      const out = execFileSync('sh', [sh], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status ?? -1, out: String(e.stdout ?? '') };
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('generated pre-commit — structure', () => {
  it('scans the staged diff, not files on disk', () => {
    // Reading the working tree let a secret be staged and then edited out of
    // the file before commit, so the committed blob was never scanned.
    expect(script).toContain('git diff --cached --diff-filter=ACM -U0');
    expect(script).toMatch(/\^\\?\+/); // matches added lines only
  });

  it('does not pipe git straight into grep', () => {
    // A git failure would become empty input, which grep reads as "clean" —
    // the scan would pass exactly when it could not run.
    expect(script).not.toMatch(/git diff --cached[^\n|]*\| *grep/);
    expect(script).toContain('refusing to commit unscanned');
  });

  it('no longer shells out through xargs', () => {
    const code = script.split('\n').filter(l => !l.trim().startsWith('#'));
    expect(code.join('\n')).not.toContain('xargs');
  });

  it('does not mask errors on the security check', () => {
    const checkLines = script.split('\n').filter(l => l.includes('grep -qE'));
    expect(checkLines.length).toBeGreaterThan(0);
    for (const l of checkLines) expect(l).not.toContain('2>/dev/null');
  });

  it('ends with an explicit exit 0', () => {
    // A script exits with its last command's status. Without this, the
    // [ -f project-state.json ] test failing rejected a valid commit.
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('uses no quote characters in the secret pattern', () => {
    // Quotes could not survive JS-template -> single-quoted-shell escaping;
    // the old password="..." form rendered as the malformed class ["\].
    const grepLines = script.split('\n').filter(l => /grep -q?v?E/.test(l) && !l.trim().startsWith('#'));
    expect(grepLines.length).toBeGreaterThan(0);
    for (const line of grepLines) {
      const m = line.match(/grep -q?v?E '([^']*)'/);
      expect(m).not.toBeNull();
      expect(m![1]).not.toContain('"');
      expect(m![1]).not.toContain('["\\]');
    }
  });
});

describe('generated pre-commit — behavior', () => {
  it('passes with nothing staged (every --amend)', () => {
    expect(runHookIn(() => {}).code).toBe(0);
  });

  it('passes on ordinary project files', () => {
    const { code, out } = runHookIn(repo => {
      mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repo, '.github', 'workflows', 'gates.yml'), 'on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n');
      writeFileSync(join(repo, 'index.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(out).not.toContain('Potential secrets');
    expect(code).toBe(0);
  });

  it('passes when project-state.json is absent', () => {
    // The [ -f ] test returning false used to be the script's exit status.
    const { code } = runHookIn(repo => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(code).toBe(0);
  });

  it('passes when project-state.json exists without PROJECT-STATE.md', () => {
    // git add of a missing path exited 128 and became the script's status.
    const { code } = runHookIn(repo => {
      writeFileSync(join(repo, 'project-state.json'), '{}\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(code).toBe(0);
  });

  it('rejects a staged AWS key', () => {
    const { code } = runHookIn(repo => {
      writeFileSync(join(repo, 'leak.txt'), `${AWS_KEY}\n`);
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(code).toBe(1);
  });

  it('rejects a secret in a path containing a space', () => {
    const { code } = runHookIn(repo => {
      writeFileSync(join(repo, 'my config.txt'), `${AWS_KEY}\n`);
      execFileSync('git', ['add', 'my config.txt'], { cwd: repo });
    });
    expect(code).toBe(1);
  });

  it('rejects a credential assignment', () => {
    // Coverage restored after the malformed password="..." pattern was cut.
    const { code } = runHookIn(repo => {
      // Assembled at runtime: a literal here would correctly trip the very
      // check this test exercises, blocking commits of the test itself.
      writeFileSync(join(repo, 'conf.yml'), `pass${'word'}: hunter2hunter2hunter2\n`);
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(code).toBe(1);
  });

  it('allows a credential assignment that reads from the environment', () => {
    const { code, out } = runHookIn(repo => {
      writeFileSync(join(repo, 'conf.ts'), 'const password = process.env.DB_PASSWORD;\napi_key: ${API_KEY}\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
    });
    expect(out).not.toContain('Potential secrets');
    expect(code).toBe(0);
  });

  it('catches a secret staged then removed from the working tree', () => {
    // The file on disk is clean; the staged blob is not. Scanning disk missed
    // this entirely and committed the secret.
    const { code } = runHookIn(repo => {
      writeFileSync(join(repo, 'leak.txt'), `${AWS_KEY}\n`);
      execFileSync('git', ['add', 'leak.txt'], { cwd: repo });
      writeFileSync(join(repo, 'leak.txt'), 'cleaned up\n');
    });
    expect(code).toBe(1);
  });
});
