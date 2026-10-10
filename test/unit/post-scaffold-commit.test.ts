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
      postScaffoldCommit(root, ['CREATED: AGENTS.md'], { commit: true });
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
      postScaffoldCommit(root, ['UPDATED: seed.txt'], { commit: true });
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
      postScaffoldCommit(root, actions, { commit: true });
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
      postScaffoldCommit(root, actions, { commit: true });
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
      writeFileSync(join(r, 'rep.md'), '# rep\n');
    });
    try {
      postScaffoldCommit(root, [
        '  GENERATED: .claude/rules/a.md',
        'GENERATED: gen.md',
        'DEPLOYED: dep.md',
        // #216 added REPLACED. A verb the stager does not know about leaves
        // the file it names uncommitted, which is how .claude/rules/ was lost.
        'REPLACED: rep.md (-2 lines)',
      ], { commit: true });
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
      postScaffoldCommit(root, ['CREATED: .claude/rules/'], { commit: true });
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
      postScaffoldCommit(root, ['CREATED: .git/hooks/pre-commit', 'CREATED: AGENTS.md'], { commit: true });
      const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf-8' });
      expect(committed).toContain('AGENTS.md');
      expect(committed).not.toContain('pre-commit');
    } finally {
      cleanup();
    }
  });
});

/**
 * #216 AC-4 — the commit was unconditional, and it was wrong in both
 * directions. On a consumer repo, running the documented onboarding command
 * created a commit the operator never asked for; and because it ran after a
 * write that could destroy their ci.yml, it committed the destruction too.
 * Committing is now opt-in, and it refuses on a tree it does not understand.
 */
describe('#216 AC-4: committing is opt-in and refuses on a dirty tree', () => {
  const headOf = (root: string) =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
  const commitCount = (root: string) =>
    Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim());

  it('creates zero commits when --commit was not passed', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
    });
    try {
      const before = commitCount(root);
      const actions = ['CREATED: AGENTS.md'];
      postScaffoldCommit(root, actions);
      expect(commitCount(root) - before).toBe(0);
      expect(actions.join('\n')).toContain('--commit');
      // and the generated file is still there, just uncommitted
      expect(status(root)).toContain('AGENTS.md');
    } finally {
      cleanup();
    }
  });

  it('does not even stage when --commit was not passed', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
    });
    try {
      postScaffoldCommit(root, ['CREATED: AGENTS.md']);
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf-8' }).trim();
      expect(staged).toBe('');
      // An empty index also describes "staged it and then committed it", so
      // the file has to still be sitting there untracked for this to mean
      // anything.
      expect(status(root)).toBe('?? AGENTS.md');
    } finally {
      cleanup();
    }
  });

  it('refuses on a dirty working tree: a tracked file modified outside the scaffold', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'seed.txt'), 'edited by a human mid-session\n');
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
    });
    try {
      const before = headOf(root);
      const actions = ['CREATED: AGENTS.md'];
      postScaffoldCommit(root, actions, { commit: true });
      expect(headOf(root)).toBe(before);
      const refusal = actions.find(a => a.startsWith('REFUSED:'));
      expect(refusal).toBeDefined();
      expect(refusal!).toContain('seed.txt');
      // the human's edit is untouched
      expect(execFileSync('git', ['show', 'HEAD:seed.txt'], { cwd: root, encoding: 'utf-8' })).toBe('seed\n');
    } finally {
      cleanup();
    }
  });

  it('an untracked unrelated file is not "dirty" — it was never going to be committed', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'scratch.ts'), 'export const wip = 1;\n');
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
    });
    try {
      const actions = ['CREATED: AGENTS.md'];
      postScaffoldCommit(root, actions, { commit: true });
      expect(actions.join('\n')).toContain('CREATED: post-scaffold commit');
      expect(status(root)).toContain('scratch.ts');
    } finally {
      cleanup();
    }
  });

  it('a tracked file the scaffold itself rewrote is not "dirty"', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'seed.txt'), 'regenerated by the scaffold\n');
    });
    try {
      const actions = ['REPLACED: seed.txt (-1 lines)'];
      postScaffoldCommit(root, actions, { commit: true });
      expect(status(root)).toBe('');
      expect(actions.join('\n')).toContain('CREATED: post-scaffold commit');
    } finally {
      cleanup();
    }
  });
});
