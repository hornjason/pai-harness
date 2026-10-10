import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { postScaffoldCommit } from '../../lib/scaffold/steps';
import { initFixtureRepo, commitFixture } from '../helpers/git-fixture';

const SCAFFOLD = join(import.meta.dir, '..', '..', 'scripts', 'scaffold-project.ts');

function repoWith(fn: (root: string) => void): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'postscaffold-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  fn(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const status = (root: string) =>
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).trim();

const commitCount = (root: string) =>
  Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim());

/**
 * #216 AC-4. The commit used to be unconditional: every `scaffold-project.ts
 * --fix` ended in a commit the caller never asked for. On a consumer repo that
 * is a commit appearing in someone else's history as a side effect of running
 * an audit, so it is now opt-in.
 */
describe('AC-4: the post-scaffold commit is opt-in', () => {
  it('creates no commit at all without an explicit commit request', () => {
    const { root, cleanup } = repoWith(r => writeFileSync(join(r, 'AGENTS.md'), '# generated\n'));
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

  it('creates no commit when commit is explicitly false', () => {
    const { root, cleanup } = repoWith(r => writeFileSync(join(r, 'AGENTS.md'), '# generated\n'));
    try {
      const before = commitCount(root);
      postScaffoldCommit(root, ['CREATED: AGENTS.md'], { commit: false });
      expect(commitCount(root) - before).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('a full --fix run with no --commit flag creates zero commits', () => {
    const root = mkdtempSync(join(tmpdir(), 'postscaffold-cli-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0', type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n');
      writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
      initFixtureRepo(root);
      commitFixture(root, 'init');
      const before = commitCount(root);

      execFileSync('bun', ['run', SCAFFOLD, root, '--fix'], { timeout: 180000, stdio: 'pipe' });

      expect(commitCount(root) - before).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  it('refuses on a dirty working tree, even when asked to commit', () => {
    // `git add -A` used to sweep up in-progress edits and commit them under a
    // message about scaffolding. Staging only generated paths stopped the
    // sweep; refusing outright stops the surprise commit as well.
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'AGENTS.md'), '# generated\n');
      writeFileSync(join(r, 'my-wip.ts'), 'export const wip = 1;\n');
    });
    try {
      const before = commitCount(root);
      const actions = ['CREATED: AGENTS.md'];
      postScaffoldCommit(root, actions, { commit: true });

      expect(commitCount(root) - before).toBe(0);
      const refusal = actions.find(a => a.startsWith('REFUSED:'));
      expect(refusal).toBeDefined();
      expect(refusal!).toContain('my-wip.ts');
      // both files are still sitting in the working tree, untouched
      expect(status(root)).toContain('my-wip.ts');
      expect(status(root)).toContain('AGENTS.md');
    } finally {
      cleanup();
    }
  });

  it('commits when asked and the only dirty paths are generated ones', () => {
    const { root, cleanup } = repoWith(r => writeFileSync(join(r, 'AGENTS.md'), '# generated\n'));
    try {
      const before = commitCount(root);
      postScaffoldCommit(root, ['CREATED: AGENTS.md'], { commit: true });
      expect(commitCount(root) - before).toBe(1);
      const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf-8' });
      expect(committed).toContain('AGENTS.md');
      expect(status(root)).toBe('');
    } finally {
      cleanup();
    }
  });
});

describe('postScaffoldCommit stages only generated files', () => {
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

  it('commits files listed as REPLACED — a forced overwrite is still generated output', () => {
    const { root, cleanup } = repoWith(r => {
      writeFileSync(join(r, 'seed.txt'), 'shorter\n');
    });
    try {
      postScaffoldCommit(root, ['REPLACED: seed.txt (-3 lines)'], { commit: true });
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
    });
    try {
      postScaffoldCommit(root, [
        '  GENERATED: .claude/rules/a.md',
        'GENERATED: gen.md',
        'DEPLOYED: dep.md',
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
