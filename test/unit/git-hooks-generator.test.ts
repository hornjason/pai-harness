import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createGitHooks } from '../../lib/scaffold/steps';

let root: string;
let preCommit: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rungate-githooks-'));
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  createGitHooks(root, []);
  preCommit = join(root, '.git', 'hooks', 'pre-commit');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('generated pre-commit secret scan', () => {
  it('guards on a non-empty staged file list', () => {
    // Without the guard, `git diff --cached --name-only | xargs grep ...`
    // runs grep with no file operands when nothing is staged. grep then reads
    // stdin and exits 0, so the hook reports a secret that is not there and
    // blocks every `git commit --amend`.
    const content = readFileSync(preCommit, 'utf-8');
    expect(content).toContain('staged_count=$(git diff --cached --name-only');
    expect(content).toContain('[ "$staged_count" -gt 0 ]');
  });

  it('does not pipe a bare diff straight into xargs grep', () => {
    const content = readFileSync(preCommit, 'utf-8');
    expect(content).not.toMatch(/git diff --cached --name-only \| xargs grep/);
  });

  it('uses NUL-delimited paths so filenames with spaces are scanned', () => {
    const content = readFileSync(preCommit, 'utf-8');
    expect(content).toContain('xargs -0');
  });

  it('does not emit a malformed character class', () => {
    // The old password="..." pattern rendered as ["\] after JS-template ->
    // single-quoted-shell escaping and matched ordinary YAML.
    const grepLine = readFileSync(preCommit, 'utf-8')
      .split('\n')
      .find(l => l.includes('xargs -0 grep'))!;
    expect(grepLine).toBeDefined();
    expect(grepLine).not.toContain('["\\]');
    expect(grepLine).not.toContain('password');
  });

  it('passes a commit of ordinary project files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rungate-clean-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repo, '.github', 'workflows', 'gates.yml'), 'on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n');
      writeFileSync(join(repo, 'project-state.json'), '{}\n');
      writeFileSync(join(repo, 'PROJECT-STATE.md'), '# State\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      const script = join(repo, 'pre-commit.sh');
      writeFileSync(script, readFileSync(preCommit, 'utf-8'), { mode: 0o755 });
      const out = execFileSync('sh', [script], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      expect(out).not.toContain('Potential secrets');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('flags a secret in a staged path containing a space', () => {
    // Whitespace-split paths become unscannable fragments; grep errors, the
    // error is swallowed by 2>/dev/null, and the secret ships.
    const repo = mkdtempSync(join(tmpdir(), 'rungate-spacepath-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
      writeFileSync(join(repo, 'my config.txt'), `${fakeKey}\n`);
      execFileSync('git', ['add', 'my config.txt'], { cwd: repo });
      const script = join(repo, 'pre-commit.sh');
      writeFileSync(script, readFileSync(preCommit, 'utf-8'), { mode: 0o755 });

      let failed = false;
      try {
        execFileSync('sh', [script], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 when nothing is staged', () => {
    // Run the generated script directly in a repo with an empty index.
    const repo = mkdtempSync(join(tmpdir(), 'rungate-emptyidx-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const script = join(repo, 'pre-commit.sh');
      writeFileSync(script, readFileSync(preCommit, 'utf-8'), { mode: 0o755 });
      const out = execFileSync('sh', [script], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      expect(out).not.toContain('Potential secrets');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still flags a staged file containing an AWS key', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rungate-secret-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      // Built at runtime: a literal here would (correctly) trip the very
      // scanner this test exercises, blocking commits of the test itself.
      const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
      writeFileSync(join(repo, 'leak.txt'), `${fakeKey}\n`);
      execFileSync('git', ['add', 'leak.txt'], { cwd: repo });
      const script = join(repo, 'pre-commit.sh');
      writeFileSync(script, readFileSync(preCommit, 'utf-8'), { mode: 0o755 });

      let failed = false;
      try {
        execFileSync('sh', [script], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
