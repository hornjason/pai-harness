import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { postScaffoldCommit } from '../../lib/scaffold/steps';

function repoWith(fn: (root: string) => void): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'postscaffold-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  fn(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const status = (root: string) =>
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).trim();

describe('postScaffoldCommit stages only generated files', () => {
  it('leaves unrelated work in progress uncommitted', () => {
    // `git add -A` swept up in-progress edits and committed them under a
    // message about scaffolding, forcing the real commit to be an amend.
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
      writeFileSync(join(r, 'my-wip.ts'), 'export const wip = 1;\n');
    });
    try {
      postScaffoldCommit(root, ['CREATED: AGENTS.md']);
      // The scaffold output is committed...
      const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf-8' });
      expect(committed).toContain('AGENTS.md');
      expect(committed).not.toContain('my-wip.ts');
      // ...and the unrelated file is still sitting in the working tree.
      expect(status(root)).toContain('my-wip.ts');
    } finally {
      cleanup();
    }
  });

  it('commits files listed as UPDATED as well as CREATED', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'seed.txt'), 'regenerated\n');
    });
    try {
      postScaffoldCommit(root, ['UPDATED: seed.txt']);
      expect(status(root)).toBe('');
    } finally {
      cleanup();
    }
  });

  it('is a no-op when regenerated files are byte-identical', () => {
    const { root, cleanup } = repoWith(() => {});
    try {
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
      const actions = ['UPDATED: seed.txt'];
      postScaffoldCommit(root, actions);
      const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
      expect(after).toBe(before);
      expect(actions.join('\n')).toContain('SKIP');
    } finally {
      cleanup();
    }
  });

  it('skips when nothing was generated', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'my-wip.ts'), 'export const wip = 1;\n');
    });
    try {
      const actions: string[] = ['SKIP: .claude/agents/ (already exists)'];
      postScaffoldCommit(root, actions);
      expect(actions.join('\n')).toContain('nothing generated');
      expect(status(root)).toContain('my-wip.ts');
    } finally {
      cleanup();
    }
  });

  it('recognizes every write verb scaffold emits', () => {
    // Missing a verb silently leaves generated files uncommitted — GENERATED
    // was missed first time round and .claude/rules/ stayed untracked.
    const { root, cleanup } = repoWith(r => {
      mkdirSync(join(r, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(r, '.claude', 'rules', 'a.md'), '# a\n');
      writeFileSync(join(r, 'gen.md'), '# gen\n');
      writeFileSync(join(r, 'dep.md'), '# dep\n');
    });
    try {
      postScaffoldCommit(root, [
        '  GENERATED: .claude/rules/a.md',
        'GENERATED: gen.md',
        'DEPLOYED: dep.md',
      ]);
      expect(status(root)).toBe('');
    } finally {
      cleanup();
    }
  });

  it('stages a directory reported without per-file entries', () => {
    const { root, cleanup } = repoWith(r => {
      mkdirSync(join(r, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(r, '.claude', 'rules', 'a.md'), '# a\n');
    });
    try {
      postScaffoldCommit(root, ['CREATED: .claude/rules/']);
      expect(status(root)).toBe('');
    } finally {
      cleanup();
    }
  });

  it('ignores .git/ paths, which are untracked by definition', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
    });
    try {
      postScaffoldCommit(root, ['CREATED: .git/hooks/pre-commit', 'CREATED: AGENTS.md']);
      const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf-8' });
      expect(committed).toContain('AGENTS.md');
      expect(committed).not.toContain('pre-commit');
    } finally {
      cleanup();
    }
  });
});
