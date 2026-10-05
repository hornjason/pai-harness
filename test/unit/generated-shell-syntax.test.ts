import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createGitHooks, createCiWorkflows } from '../../lib/scaffold/steps';

/**
 * These shell scripts live inside JS template literals. A stray backtick in a
 * comment terminates the literal and breaks scaffold-project.ts at parse time
 * — which is how one word in a comment took out 36 tests. Shell-syntax
 * checking the generated output catches that whole class.
 */
function shellCheck(source: string, label: string) {
  const dir = mkdtempSync(join(tmpdir(), 'shellcheck-'));
  try {
    const f = join(dir, 'script.sh');
    writeFileSync(f, source);
    execFileSync('sh', ['-n', f], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e: any) {
    throw new Error(`${label} is not valid shell:\n${String(e.stderr ?? e.message)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withRoot<T>(prefix: string, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('generated shell is syntactically valid', () => {
  it('pre-commit hook parses', () => {
    withRoot('gh-', root => {
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      createGitHooks(root, []);
      shellCheck(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8'), 'pre-commit');
    });
  });

  it('pre-push hook parses', () => {
    withRoot('gh2-', root => {
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      createGitHooks(root, []);
      shellCheck(readFileSync(join(root, '.git', 'hooks', 'pre-push'), 'utf-8'), 'pre-push');
    });
  });

  it('gates.yml secret scan parses', () => {
    withRoot('ci-', root => {
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'rungate.json'), '{}');
      createCiWorkflows(root, []);
      const p = join(root, '.github', 'workflows', 'gates.yml');
      expect(existsSync(p)).toBe(true);
      const yml = readFileSync(p, 'utf-8');
      const m = yml.match(/- name: Secret scan\n        run: \|\n([\s\S]*?)(?=\n      - |\n*$)/);
      expect(m).not.toBeNull();
      shellCheck(m![1].split('\n').map(l => l.replace(/^ {10}/, '')).join('\n'), 'gates.yml secret scan');
    });
  });
});
