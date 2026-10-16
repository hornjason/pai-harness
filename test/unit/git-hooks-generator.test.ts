import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createGitHooks, PRE_COMMIT_MANAGED_MARKER } from '../../lib/scaffold/steps';

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

/**
 * Covers SC-1653, SC-1654, SC-1655 (HARNESS-STANDARD.md) — #450.
 *
 * The hook ran `update-project-state.ts` and staged its output on every commit
 * in every worktree. `project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md`
 * are DA-owned (#296) and the project says so in CLAUDE.md and in
 * `.claude/rules/key-files.md` — so this was a rule the tooling actively
 * undid, which is a worse shape than the rule nothing executes that
 * `.claude/rules/checks-must-be-able-to-fail.md` is about: an agent that
 * obeyed it perfectly still shipped the violation.
 *
 * Both arms are driven by EXECUTING the generated hook against a real linked
 * worktree, not by reading its source. #397's post-mortem is that a
 * source-text assertion cannot notice the script's behaviour is impossible.
 */
describe('#450: the generated pre-commit leaves DA-owned state alone in a worktree', () => {
  /**
   * A primary checkout with one commit, and a linked worktree off it. Plants
   * the state files UNSTAGED in `where`, runs the hook there, and reports
   * what ended up in the index.
   */
  function runWithStateFiles(where: 'primary' | 'worktree'): { code: number; out: string; staged: string[] } {
    const primary = mkdtempSync(join(tmpdir(), 'rungate-wtstate-'));
    const linked = `${primary}-linked`;
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: primary });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: primary });
      writeFileSync(join(primary, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', '-A'], { cwd: primary });
      execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed'], { cwd: primary });
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: primary });

      const cwd = where === 'primary' ? primary : linked;
      // Present on disk, deliberately NOT staged. The only thing that can put
      // them in the index is the hook's own `git add`.
      writeFileSync(join(cwd, 'project-state.json'), '{"session": 1}\n');
      writeFileSync(join(cwd, 'PROJECT-STATE.md'), '# state\n');
      writeFileSync(join(cwd, 'SUCCESS.md'), '# success\n');

      const sh = join(cwd, '.pre-commit.sh');
      writeFileSync(sh, script, { mode: 0o755 });
      let code = 0;
      let out = '';
      try {
        out = execFileSync('sh', [sh], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        code = e.status ?? -1;
        out = String(e.stdout ?? '') + String(e.stderr ?? '');
      }
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf-8' })
        .split('\n').filter(Boolean);
      return { code, out, staged };
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  }

  it('SC-1653: stages none of the DA-owned state files from a linked worktree', () => {
    const { code, staged } = runWithStateFiles('worktree');
    expect(code, 'the hook rejected an ordinary commit').toBe(0);
    for (const f of ['project-state.json', 'PROJECT-STATE.md', 'SUCCESS.md']) {
      expect(staged, `${f} was staged from a linked worktree`).not.toContain(f);
    }
  });

  it('SC-1654: still stages them in the primary checkout', () => {
    // The positive control, in the same file as the case above. A guard with
    // no positive control is indistinguishable from one that never fires,
    // which is the zero this repo keeps measuring — and a worktree check that
    // compared the two git dirs as plain strings would read the primary
    // checkout as a worktree and silently disable the update everywhere.
    const { code, staged } = runWithStateFiles('primary');
    expect(code).toBe(0);
    expect(staged, 'the update never fires at all').toContain('project-state.json');
    expect(staged).toContain('PROJECT-STATE.md');
    // SUCCESS.md is DA-owned too and the hook has never staged it. Asserted
    // so that widening the `git add` later has to be a deliberate change.
    expect(staged, 'the hook started staging SUCCESS.md').not.toContain('SUCCESS.md');
  });

  it('SC-1655: the skip is announced rather than silent', () => {
    // UNMEASURED is not SKIP: a developer who expected the state files to move
    // must not have to diff the commit to find out they did not.
    const { out } = runWithStateFiles('worktree');
    expect(out).toContain('project-state: SKIPPED');
    expect(out, 'it does not say why').toContain('linked worktree');
    expect(out, 'it does not say what to do instead').toContain('primary checkout');
    expect(out, 'the rule it is enforcing is unattributable').toContain('#296');

    // ...and the primary checkout does NOT print it, or the message would be
    // noise that stops meaning anything.
    expect(runWithStateFiles('primary').out).not.toContain('project-state: SKIPPED');
  });
});

describe('generated pre-commit — redeployment', () => {
  it('#450: an existing managed hook is overwritten so a fix can reach it', () => {
    /**
     * `createGitHooks` wrote pre-commit only `if (!existsSync(preCommit))`, so
     * every checkout that already had one would keep the version that does the
     * thing #296 forbids — the fix above would have reached nobody, including
     * this repo, where #450 was observed. The pre-push hook had exactly this
     * bug and #85 fixed it the same way: overwrite our own managed hook, leave
     * a hand-written one alone.
     *
     * Compared BYTE FOR BYTE against a freshly generated hook rather than
     * grepped for a phrase the new script happens to contain. The first draft
     * asserted `toContain('project-state: SKIPPED')`, and the mutation
     * battery showed why that is worthless here: a mutation that makes the
     * skip branch unreachable, or replaces `echo` with `:`, leaves the phrase
     * sitting in the source and the assertion green. What this test is for is
     * "the stale copy was replaced"; the behaviour is proved by executing the
     * hook above.
     */
    const dir = mkdtempSync(join(tmpdir(), 'rungate-hookredeploy-'));
    const fresh = mkdtempSync(join(tmpdir(), 'rungate-hookfresh-'));
    try {
      mkdirSync(join(fresh, '.git', 'hooks'), { recursive: true });
      createGitHooks(fresh, []);
      const expected = readFileSync(join(fresh, '.git', 'hooks', 'pre-commit'), 'utf-8');

      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      const path = join(dir, '.git', 'hooks', 'pre-commit');
      // An old managed hook, carrying the marker and the unconditional update.
      const stale = `#!/bin/sh\n${PRE_COMMIT_MANAGED_MARKER}\ngit add project-state.json\n`;
      writeFileSync(path, stale);
      const actions: string[] = [];
      createGitHooks(dir, actions);

      expect(readFileSync(path, 'utf-8'), 'the stale managed hook survived').toBe(expected);
      // Positive control on the comparison itself: `expected` must not be the
      // stale text, or the assertion above would hold over a hook nothing
      // rewrote.
      expect(expected, 'the generator produced the stale hook').not.toBe(stale);
      expect(actions.join('\n')).toContain('UPDATED: .git/hooks/pre-commit');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#450: a hand-written hook is preserved and reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rungate-hookmine-'));
    try {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      const path = join(dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(path, '#!/bin/sh\n# mine\nexit 0\n');
      const actions: string[] = [];
      createGitHooks(dir, actions);
      expect(readFileSync(path, 'utf-8'), "someone's own hook was overwritten").toBe('#!/bin/sh\n# mine\nexit 0\n');
      expect(actions.join('\n')).toContain('SKIP: .git/hooks/pre-commit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

