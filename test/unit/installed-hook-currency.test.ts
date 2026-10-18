import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitHooks, PRE_COMMIT_MANAGED_MARKER } from '../../lib/scaffold/steps';

/**
 * Covers SC-2028, SC-2029 (HARNESS-STANDARD.md) — #599.
 *
 * `scripts/check-installed-hook-currency.ts` reads the pre-commit hook that is
 * actually installed at the shared git common dir and compares it against what
 * the generator produces today.
 *
 * The hook is UNTRACKED. That is the whole reason this check has to exist:
 * #450 fixed the generator in September and this repository's own installed
 * hook was still the pre-#450 copy on 2026-10-18, staging `project-state.json`
 * and `PROJECT-STATE.md` from every worktree on every commit. Nothing in the
 * tree could see that, because nothing in the tree ever looked at the file git
 * actually runs. A generator test proves the TEMPLATE is right; it says
 * nothing about the copy on disk.
 *
 * Every refusal is run TWICE — once against the real script and once against a
 * mutant whose single exit-code constant is set to 0 — following
 * `test/rook-review-scope.test.ts` and
 * `.claude/rules/checks-must-be-able-to-fail.md`. A test that only asserts
 * "exit code != 0" cannot tell a refusal from a crash, a typo, or a module
 * that failed to resolve.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-installed-hook-currency.ts');
const source = readFileSync(SCRIPT, 'utf-8');

let MUTANT = '';
let MUTANT_DIR = '';
let FIX = '';

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
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const r = spawnSync('bun', [script, ...args], { encoding: 'utf-8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * Assert a case is refused, and that the REFUSAL is what is being observed.
 *
 * The mutant must exit 0. Every refusal in the script funnels into the one
 * `process.exit(REFUSE_EXIT)`, so there is no case here where a non-zero
 * mutant would be legitimate — a non-zero mutant means the case is going red
 * for some reason other than the refusal under test.
 */
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

/** A git repository with `content` installed as its pre-commit hook, or none. */
function repoWithHook(name: string, content: string | null): string {
  const repo = join(FIX, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, 'pre-commit');
  if (content === null) rmSync(path, { force: true });
  else writeFileSync(path, content, { mode: 0o755 });
  return repo;
}

/**
 * The pre-#450 hook, verbatim in shape: a managed hook with the marker, the
 * secret scan, and an UNCONDITIONAL state update with no worktree check. This
 * is the copy that was installed in this repository when #599 was filed.
 */
const PRE_450_HOOK = `#!/bin/sh
${PRE_COMMIT_MANAGED_MARKER}
staged_diff=$(git diff --cached --diff-filter=ACM -U0) || {
  echo "ERROR: could not read staged diff — refusing to commit unscanned"
  exit 1
}
# Update PROJECT-STATE if it exists
if [ -f "project-state.json" ]; then
  bun scripts/update-project-state.ts 2>/dev/null || true
  git add PROJECT-STATE.md project-state.json 2>/dev/null || true
fi
exit 0
`;

// ── The property the mutant protects ─────────────────────────────────────

describe('SC-2028: the refusal is routed through exactly one exit code', () => {
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
    // The mutant runs from a temp directory. A `from "../lib/..."` would make
    // every mutant die on module resolution — a non-zero exit that reads as
    // the mutation having been rejected on the merits.
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, 'a relative import would make every mutant run fail to resolve').toEqual([]);
  });

  test('the mutant and the original differ on a named input', () => {
    // Before believing any 0 from the mutant: name an input on which the two
    // behave differently, and run it. Without this, a mutant that was never
    // really applied is indistinguishable from a refusal nothing catches.
    const repo = repoWithHook('mutant-evidence', PRE_450_HOOK);
    const args = ['--project', repo, '--harness', REPO_ROOT];
    expect(run(SCRIPT, args).code, 'the real script accepted a pre-#450 hook').toBe(1);
    expect(run(MUTANT, args).code, 'the mutant refused anyway — it was not applied').toBe(0);
  });
});

// ── SC-2029: what the check refuses, and what it accepts ─────────────────

describe('SC-2029: a stale installed hook is a refusal, not a clean bill', () => {
  test('a pre-#450 installed hook is refused', () => {
    const repo = repoWithHook('stale', PRE_450_HOOK);
    expectRefused(['--project', repo, '--harness', REPO_ROOT], /stale/i);
  });

  test('the refusal names the worktree guard the installed hook predates', () => {
    // A refusal that says only "the bytes differ" sends the reader to a diff.
    // The property at issue has a name and an issue number.
    const repo = repoWithHook('stale-reason', PRE_450_HOOK);
    const { err } = run(SCRIPT, ['--project', repo, '--harness', REPO_ROOT]);
    expect(err, 'the refusal does not say what is missing').toContain('worktree');
    expect(err, 'the rule it is enforcing is unattributable').toMatch(/#450|#296/);
    expect(err, 'the refusal does not say how to repair it').toContain('scaffold');
    expect(err, 'the refusal does not name the file it read').toContain('pre-commit');
  });

  test('a managed hook that differs only in later content is still refused', () => {
    // The cheapest wrong fix for "my hook is stale" is to paste the worktree
    // guard into the installed copy by hand and stop there. That leaves every
    // OTHER drift in place, so the comparison stays byte-for-byte and this
    // case is the one that says so.
    const fresh = currentHookText();
    const nearly = `${fresh}\n# one line of local drift\n`;
    const repo = repoWithHook('nearly', nearly);
    expectRefused(['--project', repo, '--harness', REPO_ROOT], /stale/i);
  });

  test('a hand-written hook is refused under its own class', () => {
    // Different cause, different advice: the generator will not overwrite a
    // hand-written hook, so "re-scaffold" is the wrong instruction here and
    // the message must not give it.
    const repo = repoWithHook('handwritten', '#!/bin/sh\n# mine\nexit 0\n');
    expectRefused(['--project', repo, '--harness', REPO_ROOT], /hand-written|unmanaged/i);
  });

  test('an absent hook is refused rather than read as current', () => {
    // Nothing installed means the secret scan is not running either. Silence
    // is the one verdict this must never give.
    const repo = repoWithHook('absent', null);
    expectRefused(['--project', repo, '--harness', REPO_ROOT], /no pre-commit hook|absent/i);
  });

  test('a freshly generated hook exits 0 and says which file it read', () => {
    // The positive control. Without it, a check that refused unconditionally
    // would satisfy every case above.
    const repo = join(FIX, 'current');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    createGitHooks(repo, []);
    const r = run(SCRIPT, ['--project', repo, '--harness', REPO_ROOT]);
    expect(r.code, `a current hook was refused\n${r.err}`).toBe(0);
    expect(r.out).toContain('pre-commit');
    expect(r.out).toMatch(/current/i);
  });

  test('the hook is read from the shared common dir, not the worktree git dir', () => {
    // A linked worktree's `.git` is a FILE, and `.git/worktrees/<name>` has no
    // hooks directory of its own — git runs the common dir's hook. A check
    // that resolved `<project>/.git/hooks` would report "absent" from every
    // worktree, which is the fail-open: the one place the stale hook does
    // damage is the one place the check would decline to look.
    const primary = join(FIX, 'common-primary');
    mkdirSync(primary, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: primary });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: primary });
    writeFileSync(join(primary, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: primary });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed'], { cwd: primary });
    const linked = join(FIX, 'common-linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: primary });

    // The stale hook exists ONLY at the common dir. If the check looked
    // anywhere else it would find nothing and report absent, so this case
    // cannot be satisfied by a route that bypasses the common-dir lookup.
    writeFileSync(join(primary, '.git', 'hooks', 'pre-commit'), PRE_450_HOOK, { mode: 0o755 });
    expect(
      existsSync(join(linked, '.git')),
      "the linked worktree's .git is missing, so the fixture proves nothing",
    ).toBe(true);

    const r = run(SCRIPT, ['--project', linked, '--harness', REPO_ROOT]);
    expect(r.code, `the check did not see the common dir's hook from a worktree\n${r.err}`).toBe(1);
    expect(r.err).toMatch(/stale/i);
  });
});

// ── The live tree, which is the only reason any of this exists ───────────

describe('SC-2029: this repository', () => {
  test('the installed pre-commit hook is not a stale managed copy', () => {
    // Split by what the repo can see (#199). A fresh clone and CI have no
    // installed hook at all, and failing there would be a test about machine
    // state. What this repo DOES own is the statement that an installed hook
    // is never a stale or hand-written one — both of those are real findings
    // on any machine that reports them, and `absent` is reported as
    // UNMEASURED rather than passing quietly.
    const r = run(SCRIPT, ['--project', REPO_ROOT, '--harness', REPO_ROOT]);
    const verdict = `${r.out}${r.err}`;
    if (/no pre-commit hook|absent/i.test(verdict)) {
      console.log('UNMEASURED: no pre-commit hook is installed in this checkout');
      expect(r.code, 'an absent hook was not reported as a refusal').toBe(1);
      return;
    }
    expect(r.code, `the installed hook is out of date:\n${r.err}`).toBe(0);
  });
});

/** What the generator produces today, read the way the script reads it. */
function currentHookText(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-currency-fresh-'));
  try {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    createGitHooks(dir, []);
    return readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
