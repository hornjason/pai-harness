import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitHooks, PRE_COMMIT_MANAGED_MARKER } from '../../lib/scaffold/steps';

/**
 * Covers SC-2043, SC-2044, SC-2045 (HARNESS-STANDARD.md) — #599.
 *
 * `scripts/check-installed-hook-currency.ts` — the installed `.git/hooks/pre-commit`
 * read at the SHARED git common dir and compared against what the generator
 * produces today.
 *
 * The hook is untracked. Nothing in the repository can see it, nothing in CI
 * installs it, and `createGitHooks` only runs on a re-scaffold — so a fix to
 * the generator reaches a developer's own checkout only when somebody
 * remembers. #450 fixed the worktree guard on 2026-10-17 and this repository
 * was still committing through the old hook afterwards, which is the entire
 * reason #599 was observable at all. "The generator is fixed" and "my commits
 * are fixed" are two claims, and only the first one had any evidence.
 *
 * Every negative case runs TWICE — once against the real script, once against
 * a mutant copy whose single exit-code constant is set to 0 — on the pattern
 * `scripts/rook-review-scope.ts` and `test/rook-review-scope.test.ts`
 * established for #129. A test that only asserts "exit code != 0" cannot tell
 * a refusal from a crash, a typo, or a module-resolution failure, and
 * `.claude/rules/checks-must-be-able-to-fail.md` counts five shipped bugs of
 * that shape in one day.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-installed-hook-currency.ts');
const source = readFileSync(SCRIPT, 'utf-8');

let MUTANT = '';
let MUTANT_DIR = '';
let FIX = '';
/** What the generator produces today, byte for byte. */
let CURRENT = '';

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'seed']);
}

/**
 * A fixture repository whose installed pre-commit is exactly `hook`, or has
 * none at all when `hook` is null. The generator is reached through
 * `--project REPO_ROOT`, so every fixture is compared against the same
 * generator output the live tree is.
 */
function repoWithHook(name: string, hook: string | null): string {
  const dir = join(FIX, name);
  initRepo(dir);
  const path = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  if (hook === null) rmSync(path, { force: true });
  else writeFileSync(path, hook, { mode: 0o755 });
  return dir;
}

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), 'hook-currency-mutant-'));
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, 'REFUSE_EXIT = 0');
  if (mutated === source) {
    throw new Error(
      'could not build the mutant: no `REFUSE_EXIT = 1` in scripts/check-installed-hook-currency.ts',
    );
  }
  MUTANT = join(MUTANT_DIR, 'check-installed-hook-currency.ts');
  writeFileSync(MUTANT, mutated);

  FIX = mkdtempSync(join(tmpdir(), 'hook-currency-fix-'));

  const gen = mkdtempSync(join(tmpdir(), 'hook-currency-gen-'));
  mkdirSync(join(gen, '.git', 'hooks'), { recursive: true });
  createGitHooks(gen, []);
  CURRENT = readFileSync(join(gen, '.git', 'hooks', 'pre-commit'), 'utf-8');
  rmSync(gen, { recursive: true, force: true });
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const r = spawnSync('bun', [script, ...args], { encoding: 'utf-8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** The scope the fixtures are measured against: this repository's generator. */
const against = (project: string) => ['--project', project, '--generator', REPO_ROOT];

function expectRefused(args: string[], reason: RegExp) {
  const real = run(SCRIPT, args);
  expect(real.code, `expected a refusal for [${args.join(' ')}]\n${real.err}`).not.toBe(0);
  expect(real.err).toMatch(reason);

  const mutant = run(MUTANT, args);
  expect(
    mutant.code,
    `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for [${args.join(' ')}] — ` +
      `this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
}

// ── The property the mutant protects (the #129 pattern) ──────────────────

describe('#599: the refusal is routed through exactly one exit code', () => {
  test('REFUSE_EXIT is declared once', () => {
    const decls = source.match(/REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      'more than one assignment to REFUSE_EXIT — the mutant would only neutralise one of them',
    ).toBe(1);
  });

  test('every process.exit goes through it', () => {
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, 'no process.exit at all — nothing can refuse').toBeGreaterThan(0);
    for (const e of exits) {
      expect(
        e,
        `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it and the negative ` +
          `cases below would pass for the wrong reason`,
      ).toBe('process.exit(REFUSE_EXIT)');
    }
  });

  test('the script has no relative imports', () => {
    // Without this a later `from "../lib/..."` makes every mutant run die on
    // module resolution — a non-zero exit that reads as a rejected mutation.
    // The generator is reached through a path computed at runtime instead.
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, 'a relative import would make every mutant run fail to resolve').toEqual([]);
    const dyn = source.match(/import\(\s*["']\.{1,2}\//g) || [];
    expect(dyn, 'a relative dynamic import has the same effect').toEqual([]);
  });
});

// ── What it refuses ──────────────────────────────────────────────────────

describe('#599: an installed hook that is not the generator output is refused', () => {
  test('SC-2043: a checkout with no installed pre-commit is refused', () => {
    // Not "clean". A hook nobody installed is a hook that enforces nothing,
    // and silence there is indistinguishable from a current one.
    expectRefused(against(repoWithHook('absent', null)), /no .*pre-commit|not installed/i);
  });

  test('SC-2043: a hook that predates the worktree guard is refused, and the refusal names it', () => {
    // The #450 shape, verbatim: managed marker, unconditional update.
    const pre450 = [
      '#!/bin/sh',
      PRE_COMMIT_MANAGED_MARKER,
      'if [ -f "project-state.json" ]; then',
      '  bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true',
      '  git add PROJECT-STATE.md project-state.json 2>/dev/null || true',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    const dir = repoWithHook('pre-450', pre450);
    expectRefused(against(dir), /worktree guard/i);
    expect(run(SCRIPT, against(dir)).err, 'the refusal does not say how to fix it').toMatch(/--install/);
  });

  test('SC-2043: a hook that has the guard but predates the updater resolution is refused', () => {
    // The #599 shape: #450 landed, the primary arm did not. This is the case
    // that separates "has a worktree guard" from "is current", and without it
    // the check would certify every hook installed between the two fixes.
    const pre599 = CURRENT
      .replace(/updater=""[\s\S]*?\n    fi\n/, '')
      .replace(/elif bun "\$updater" --skip-tests >&2; then/, 'if true; then');
    expect(pre599, 'the pre-#599 fixture is identical to the current hook').not.toBe(CURRENT);
    expect(pre599, 'the fixture lost the worktree guard too, so it cannot isolate the updater leg')
      .toContain('--git-common-dir');
    expectRefused(against(repoWithHook('pre-599', pre599)), /updater resolution/i);
  });

  test('SC-2043: a hand-written hook is refused rather than silently compared', () => {
    expectRefused(
      against(repoWithHook('hand-written', '#!/bin/sh\n# mine\nexit 0\n')),
      /hand-written|not managed/i,
    );
  });

  test('SC-2043: a hook carrying every guard but differing in bytes is still refused', () => {
    // Byte-exact is the property; the named guards are diagnosis. A check
    // that asked only for the guards would be satisfiable by pasting three
    // strings into a hook that does nothing with them.
    const drifted = `${CURRENT}\n# a line somebody added by hand\n`;
    expectRefused(against(repoWithHook('drifted', drifted)), /not byte-identical|differs/i);
  });

  test('an unknown option and a missing value are both refused', () => {
    expectRefused(['--nonsense', 'x'], /unknown option/i);
    expectRefused(['--project'], /needs a value/i);
  });
});

// ── What it accepts, and where it looks ──────────────────────────────────

describe('#599: a current hook passes, and the read is at the shared common dir', () => {
  test('SC-2044: the freshly generated hook exits 0', () => {
    const dir = repoWithHook('current', CURRENT);
    const r = run(SCRIPT, against(dir));
    expect(r.code, `a current hook was refused:\n${r.err}`).toBe(0);
    expect(r.out).toMatch(/current/i);
  });

  test('SC-2044: run from a linked worktree it reads the PRIMARY hook, not the worktree gitdir', () => {
    // A linked worktree has no `.git/hooks` of its own — `.git` is a file —
    // so a check that joined `<project>/.git/hooks/pre-commit` would report
    // "not installed" from every worktree in the repository, which is the
    // place an agent actually runs it.
    const primary = repoWithHook('shared-primary', CURRENT);
    const linked = join(FIX, 'shared-linked');
    git(primary, ['worktree', 'add', '-q', '-b', 'side', linked]);
    expect(lstatSync(join(linked, '.git')).isFile(), 'the fixture is not a linked worktree').toBe(true);

    const r = run(SCRIPT, against(linked));
    expect(r.code, `the worktree run was refused:\n${r.err}`).toBe(0);
    const reported = /at (\/.*?)\s*$/m.exec(r.out)?.[1];
    expect(reported, `no path in the verdict: ${r.out}`).toBeTruthy();
    // Realpath on both sides: macOS /var/folders is a symlink to /private/var
    // and git answers with the resolved form, so a raw string compare would
    // fail for a reason that has nothing to do with which .git was read.
    expect(realpathSync(reported!), 'it read a path inside the worktree rather than the shared .git')
      .toBe(realpathSync(join(primary, '.git', 'hooks', 'pre-commit')));

    // And the same worktree over a STALE shared hook must refuse, or the case
    // above would pass for a check that never read anything.
    writeFileSync(join(primary, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n# mine\nexit 0\n');
    expectRefused(against(linked), /hand-written|not managed/i);
  });

  test('SC-2045: --install writes the generator output and the next run is current', () => {
    const dir = repoWithHook('installable', '#!/bin/sh\n' + PRE_COMMIT_MANAGED_MARKER + '\nexit 0\n');
    const path = join(dir, '.git', 'hooks', 'pre-commit');
    expect(run(SCRIPT, against(dir)).code, 'the stale fixture was accepted').not.toBe(0);

    const installed = run(SCRIPT, [...against(dir), '--install']);
    expect(installed.code, `--install refused:\n${installed.err}`).toBe(0);
    expect(readFileSync(path, 'utf-8')).toBe(CURRENT);
    expect(run(SCRIPT, against(dir)).code, 'the installed copy is still not current').toBe(0);
  });

  test('SC-2045: --install refuses to write through a symlink', () => {
    // BUG-440-A's shape. `writeFileSync` follows a link, so a pre-commit
    // symlinked at a path outside the repository would be overwritten with
    // the hook and nothing would say so.
    const dir = repoWithHook('symlinked', null);
    const outside = join(FIX, 'outside-target.txt');
    writeFileSync(outside, 'not a hook\n');
    symlinkSync(outside, join(dir, '.git', 'hooks', 'pre-commit'));

    expectRefused([...against(dir), '--install'], /symlink/i);
    expect(readFileSync(outside, 'utf-8'), 'the generator was written through the link').toBe('not a hook\n');
  });
});

// ── The live tree ────────────────────────────────────────────────────────

describe('#599: the live tree', () => {
  test('SC-2044: the verdict on this repository agrees with an independent reading of its hook', () => {
    // This case has to be honest in two environments that differ in the one
    // thing it is about. CI clones and never scaffolds, so there is no
    // installed hook at all; a developer's checkout has one. Asserting exit 0
    // unconditionally would be red in CI for a true reason; skipping in CI
    // would make the case report nothing in the environment that runs it
    // most. So it asserts the AGREEMENT: whatever the installed state is, the
    // script's verdict matches it, read from the same place by this test.
    const common = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
    }).trim();
    const path = join(common.startsWith('/') ? common : join(REPO_ROOT, common), 'hooks', 'pre-commit');
    const installed = existsSync(path) ? readFileSync(path, 'utf-8') : null;

    const r = run(SCRIPT, ['--project', REPO_ROOT]);
    const shouldPass = installed === CURRENT;
    expect(
      r.code === 0,
      shouldPass
        ? `the installed hook at ${path} IS the generator output, and the check refused:\n${r.err}`
        : `the installed hook at ${path} is ${installed === null ? 'absent' : 'not the generator output'}, ` +
          `and the check passed anyway:\n${r.out}`,
    ).toBe(shouldPass);
  });
});
