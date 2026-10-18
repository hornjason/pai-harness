import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createGitHooks, PRE_COMMIT_MANAGED_MARKER } from '../../lib/scaffold/steps';
import {
  ORIGINAL,
  REGENERATED,
  UPDATER_CHATTER,
  runWithStateFiles as runHookWithStateFiles,
  type HookRun,
  type UpdaterLayout,
} from '../helpers/pre-commit-fixture';

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

/**
 * A primary checkout with one commit, and a linked worktree off it. Plants the
 * state files UNSTAGED, runs the freshly generated hook, and reports the two
 * streams apart, what ended up in the index, and the bytes of PROJECT-STATE.md.
 */
function runWithStateFiles(
  where: 'primary' | 'worktree',
  opts: { updater?: UpdaterLayout } = {},
): HookRun {
  return runHookWithStateFiles(script, where, opts);
}

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
    const { err } = runWithStateFiles('worktree');
    expect(err).toContain('project-state: SKIPPED');
    expect(err, 'it does not say why').toContain('linked worktree');
    expect(err, 'it does not say what to do instead').toContain('primary checkout');
    expect(err, 'the rule it is enforcing is unattributable').toContain('#296');

    // ...and the primary checkout does NOT print it, or the message would be
    // noise that stops meaning anything.
    expect(runWithStateFiles('primary').err).not.toContain('project-state: SKIPPED');
  });
});

/**
 * Covers SC-2038, SC-2039, SC-2040 (HARNESS-STANDARD.md) — #599.
 *
 * #450 stopped the hook staging DA-owned state from a linked worktree and
 * left the primary arm exactly as it found it:
 *
 *     bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true
 *     git add PROJECT-STATE.md project-state.json 2>/dev/null || true
 *
 * Three separate fail-opens in two lines. The path is the CONSUMER layout, so
 * in the harness's own checkout — which has `scripts/update-project-state.ts`
 * and no `node_modules/rungate` at all — bun exited non-zero on a file that
 * does not exist. `2>/dev/null` threw the ENOENT away, `|| true` threw the
 * status away, and the `git add` below then staged whatever happened to be on
 * disk. A commit that regenerated nothing was byte-indistinguishable from one
 * that regenerated everything.
 *
 * Every case here is driven by EXECUTING the hook and reading the state file
 * afterwards. "The updater ran" is asserted by the CONTENT it wrote, not by
 * the file being staged: staging is what the broken version did too.
 */
describe('#599: the primary arm runs an updater that exists, and stages only when it succeeded', () => {
  it('SC-2038: resolves the harness layout and stages after the updater succeeded', () => {
    const { code, staged, stateMd, err } = runWithStateFiles('primary', { updater: 'harness' });
    expect(code).toBe(0);
    expect(stateMd, 'the updater never ran — nothing rewrote PROJECT-STATE.md').toBe(REGENERATED);
    expect(staged).toContain('PROJECT-STATE.md');
    expect(staged).toContain('project-state.json');
    expect(err).not.toContain('UNMEASURED');
  });

  it('SC-2038: resolves the vendored consumer layout when the harness copy is absent', () => {
    // The path #450 hardcoded. It is still right for a consumer, so the fix is
    // a resolution order and not a replacement — asserting only the harness
    // case would let someone delete this branch and stay green.
    const { code, staged, stateMd } = runWithStateFiles('primary', { updater: 'vendored' });
    expect(code).toBe(0);
    expect(stateMd, 'the vendored updater never ran').toBe(REGENERATED);
    expect(staged).toContain('PROJECT-STATE.md');
  });

  it('SC-2039: an absent updater is reported UNMEASURED and nothing is staged', () => {
    // This is the live defect, reproduced: project-state.json is present, no
    // updater is anywhere, and the old hook staged both files regardless.
    const { code, staged, stateMd, err } = runWithStateFiles('primary', { updater: 'none' });
    expect(code, 'a missing updater must not reject the commit').toBe(0);
    expect(stateMd, 'something rewrote the file with no updater present').toBe(ORIGINAL);
    expect(staged, 'a stale PROJECT-STATE.md was staged anyway').not.toContain('PROJECT-STATE.md');
    expect(staged, 'a stale project-state.json was staged anyway').not.toContain('project-state.json');
    expect(err, 'the hook went silent about doing nothing').toContain('UNMEASURED');
    expect(err, 'it does not say where it looked').toContain('scripts/update-project-state.ts');
  });

  it('SC-2039: an updater that exits non-zero is reported and nothing is staged', () => {
    const { code, staged, err } = runWithStateFiles('primary', { updater: 'failing' });
    expect(code, 'a failing updater must not reject the commit').toBe(0);
    expect(staged, 'yesterday PROJECT-STATE.md went into today commit').not.toContain('PROJECT-STATE.md');
    expect(staged).not.toContain('project-state.json');
    expect(err).toContain('UNMEASURED');
  });

  it('SC-2040: every project-state message is on stderr and none of it is on stdout', () => {
    // AC-3's reason, and the reason the streams are read apart rather than
    // concatenated: stdout is what a caller captures as the command's answer,
    // and a concatenated reading cannot tell the two apart at all — the
    // assertion would hold whichever stream carried the text.
    const skipped = runWithStateFiles('worktree');
    expect(skipped.err).toContain('project-state: SKIPPED');
    expect(skipped.out, 'the decline went to stdout').not.toContain('project-state');

    const unmeasured = runWithStateFiles('primary', { updater: 'none' });
    expect(unmeasured.err).toContain('project-state: UNMEASURED');
    expect(unmeasured.out, 'the UNMEASURED reading went to stdout').not.toContain('project-state');

    // And the updater's own chatter: a hook that prints an updater's progress
    // on stdout is a hook whose stdout no caller can parse.
    const ran = runWithStateFiles('primary', { updater: 'harness' });
    expect(ran.out, 'the updater printed onto the hook stdout').not.toContain(UPDATER_CHATTER);
    expect(ran.err, 'the updater output was discarded rather than redirected').toContain(UPDATER_CHATTER);
  });

  it('SC-2040: no project-state line is silenced with 2>/dev/null', () => {
    // The amplifier, not the bug. Every reading above is only legible because
    // the ENOENT is no longer thrown away, so the redirect is asserted gone
    // from the invocation rather than left to the behaviour cases to imply.
    const invocation = script.split('\n').filter(l => l.includes('$updater') && !l.trim().startsWith('#'));
    expect(invocation.length, 'the updater is not invoked through a resolved variable').toBeGreaterThan(0);
    for (const line of invocation) {
      expect(line, 'the updater failure is being discarded again').not.toContain('2>/dev/null');
    }
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

