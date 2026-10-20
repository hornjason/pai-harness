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
import { preCommitHookScript, PRE_COMMIT_MANAGED_MARKER } from '../../lib/scaffold/steps';
// `import.meta.main` is false under an import, so this loads the table without
// running the check. Importing the labels rather than retyping them is the
// point: a test carrying its own copy of the strings asserts that two literals
// agree, which they do, right up until one of them is edited.
import {
  REFUSAL_PREFIX,
  type RefusalClass,
} from '../../scripts/check-installed-hook-currency';

/**
 * Covers SC-2043, SC-2044, SC-2045 (HARNESS-STANDARD.md) — #599.
 * Covers SC-2141..SC-2146 (HARNESS-STANDARD.md) — #613.
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
/**
 * What the generator produces today FOR A FIXTURE REPOSITORY, byte for byte.
 *
 * Since #610 the hook names one updater, resolved from what the project
 * declares itself to be, so "the generator output" is a function of the
 * project and not a constant. Every fixture built by `repoWithHook` is a bare
 * temp directory — no package.json, no updater — so they all resolve to the
 * same consumer-with-nothing form and one reading serves all of them. The
 * live tree is a different shape and gets its own reading.
 */
let CURRENT = '';
/** The same question asked of this repository, which declares itself rungate. */
let CURRENT_LIVE = '';

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

  // Read, never installed. `preCommitHookScript` writes nothing, which is the
  // property that lets this file ask what the generator would produce for the
  // LIVE repository without going near the installed hook — a file every
  // linked worktree of this repository shares.
  const shape = join(FIX, 'generator-shape');
  mkdirSync(shape, { recursive: true });
  CURRENT = preCommitHookScript(shape);
  CURRENT_LIVE = preCommitHookScript(REPO_ROOT);
  expect(
    CURRENT_LIVE,
    'the harness and a bare consumer get the same hook, so the fixtures below could not tell ' +
      'a project-scoped reading from a scratch one',
  ).not.toBe(CURRENT);
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

/**
 * #613. The same proof, plus the CLASS the refusal was reported under.
 *
 * An exit code says a refusal happened; it cannot say WHAT was refused, and
 * before #613 every refusal in this script printed the staleness label — so
 * `expectRefused` above was satisfied by a flag typo reporting the installed
 * hook as stale on a checkout whose hook was current.
 *
 * Two assertions and the second is the one that means something. Asserting the
 * expected prefix is PRESENT is satisfied by a line carrying every prefix; the
 * claim is that the reader can TELL the classes apart, so every other prefix
 * in the table is asserted absent by name. The reason regexp is asserted too,
 * because a run that died before producing any message has an empty stderr,
 * which contains no wrong prefix either.
 */
function expectRefusedAs(args: string[], cls: RefusalClass, reason: RegExp) {
  const real = run(SCRIPT, args);
  expect(real.code, `expected a refusal for [${args.join(' ')}]\n${real.err}`).not.toBe(0);
  expect(real.err, `the refusal does not say what it is about\n${real.err}`).toMatch(reason);
  expect(
    real.err.startsWith(`${REFUSAL_PREFIX[cls]}: `),
    `[${args.join(' ')}] should be reported as ${cls}, and the line reads:\n${real.err}`,
  ).toBe(true);
  for (const [other, prefix] of Object.entries(REFUSAL_PREFIX)) {
    if (other === cls) continue;
    expect(
      real.err.includes(prefix),
      `[${args.join(' ')}] is a ${cls} refusal and the output also carries the ${other} ` +
        `label, so the two classes are not distinguishable:\n${real.err}`,
    ).toBe(false);
  }

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

// ── #613: the exit code says a refusal happened; the class says what ─────

describe('#613: an argument error is not a verdict about the installed hook', () => {
  test('SC-2141: an unrecognised option, a missing value and an unexpected argument each name the argument', () => {
    // The filed symptom, verbatim: `--harness` instead of `--generator` on a
    // checkout whose hook was current printed a staleness verdict, and the
    // remedy that label implies — --install, or a re-scaffold — replaces a
    // hook that was fine. Nothing about the installed hook had been read.
    //
    // All three inputs are `parseArgs`', which is exactly why they are not on
    // their own sufficient: see SC-2142.
    expectRefusedAs(['--project', '.', '--harness', 'x'], 'ARGUMENTS', /--harness/);
    expectRefusedAs(['--project'], 'ARGUMENTS', /--project needs a value/);
    expectRefusedAs(['not-a-flag'], 'ARGUMENTS', /unexpected argument "not-a-flag"/);
  });

  test('SC-2142: a refusal raised OUTSIDE parseArgs is not reported as an argument error either', () => {
    // This is the case the cheapest wrong fix does not survive, and it is here
    // deliberately (.claude/rules/checks-must-be-able-to-fail.md, fifth shape).
    //
    // The 5pm repair for SC-2141 is three lines: wrap the `parseArgs` call in
    // its own try and leave the outer catch labelling everything else stale.
    // The reported symptom disappears, SC-2141 goes green in full — all three
    // of its inputs are ones parseArgs owns — and ten of the thirteen throw
    // sites stay mislabelled, including all four generator ones.
    //
    // A generator root with no lib/scaffold/steps.ts is the cheapest input
    // outside parseArgs. It is also the class that matters most: "the
    // installed hook differs from the generator" is a measurement and "the
    // generator could not be run" is the absence of one, and the defective
    // version reported the absence as the stalest available verdict.
    const empty = join(FIX, 'no-generator');
    mkdirSync(empty, { recursive: true });
    expectRefusedAs(
      ['--project', repoWithHook('unmeasurable', CURRENT), '--generator', empty],
      'UNMEASURED',
      /could not load the hook generator/,
    );
  });

  test('SC-2143: the four readings are four different strings', () => {
    // `0`, `{}`, `null` and silence are indistinguishable from success. Four
    // classes sharing one label is the same defect one level up, and it is
    // what this file shipped with: an argument error, a measured difference
    // and a reading that was never taken all printed the same sentence.
    const prefixes = Object.values(REFUSAL_PREFIX);
    expect(new Set(prefixes).size, 'two classes share a label and cannot be told apart').toBe(
      prefixes.length,
    );
    // No prefix may be a prefix of another, or startsWith() cannot separate
    // them and neither can a reader scanning the start of a line.
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(a.startsWith(b), `"${a}" starts with "${b}"`).toBe(false);
      }
    }
    // Each literal is written once, in the table. A second copy at a print
    // site would survive any mutation of the table and both would read as
    // covered — the fourth shape.
    for (const p of prefixes) {
      expect(source.split(p).length - 1, `the ${p} label is written in more than one place`).toBe(1);
    }
  });

  test('SC-2145: every raise names a class, and every class is raised', () => {
    // Without this a new refusal added later takes whatever label the catch
    // happens to default to, which is how all thirteen came to share one.
    const raises = source.match(/new HookRefused\(\s*("[A-Z_]+")?/g) || [];
    expect(raises.length, 'no HookRefused is raised at all — nothing can refuse').toBeGreaterThan(0);
    const classes = Object.keys(REFUSAL_PREFIX);
    for (const r of raises) {
      const named = /"([A-Z_]+)"/.exec(r)?.[1];
      expect(
        named && classes.includes(named),
        `${r.replace(/\s+/g, ' ')} does not name a class from REFUSAL_PREFIX, so whatever it ` +
          `refuses will be reported under some other class's label`,
      ).toBe(true);
    }
    // And the table has no dead rows: a class nothing raises is a label that
    // can never appear, which no behavioural case could notice.
    for (const c of classes) {
      expect(
        (source.match(new RegExp(`new HookRefused\\(\\s*"${c}"`, 'g')) || []).length,
        `the ${c} class is declared in REFUSAL_PREFIX and raised nowhere`,
      ).toBeGreaterThan(0);
    }
  });

  test('SC-2146: the class is carried on the raise, and the catch is the only reader of it', () => {
    // One decider. A catch that re-derived the class by matching the message
    // text would be a second reading of a fact the raise already holds — two
    // deciders that agree, which no behavioural test can tell apart.
    const lookups = source.match(/REFUSAL_PREFIX\[/g) || [];
    expect(lookups.length, 'the prefix table is indexed from more than one position').toBe(1);
    expect(source, 'the catch no longer reads the class off the refusal').toContain(
      'REFUSAL_PREFIX[e.refusalClass]',
    );
    // Exactly one position turns a refusal into a line of output. The
    // pre-#613 file had two, and only one of them was entitled to its label.
    const prints = source.match(/console\.error\(/g) || [];
    expect(prints.length, 'a second print site is a second decider about the label').toBe(1);
  });
});

// ── What it refuses ──────────────────────────────────────────────────────

describe('#599: an installed hook that is not the generator output is refused', () => {
  test('SC-2043: a checkout with no installed pre-commit is refused', () => {
    // Not "clean". A hook nobody installed is a hook that enforces nothing,
    // and silence there is indistinguishable from a current one.
    expectRefusedAs(against(repoWithHook('absent', null)), 'STALE', /no .*pre-commit|not installed/i);
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
    expectRefusedAs(against(dir), 'STALE', /worktree guard/i);
    expect(run(SCRIPT, against(dir)).err, 'the refusal does not say how to fix it').toMatch(/--install/);
  });

  test('SC-2043: a hook that has the guard but predates the updater resolution is refused', () => {
    // The #599 shape: #450 landed, the primary arm did not. This is the case
    // that separates "has a worktree guard" from "is current", and without it
    // the check would certify every hook installed between the two fixes.
    const GUARD = 'if [ -n "$gitdir" ] && [ "$gitdir" = "$commondir" ]; then\n';
    const pre599 = CURRENT.split('\n')
      .filter(l => !l.includes('project-state: UNMEASURED') && !l.includes('(#610)'))
      .join('\n')
      .replace(
        GUARD,
        GUARD +
          '    bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true\n' +
          '    git add PROJECT-STATE.md project-state.json 2>/dev/null || true\n',
      );
    expect(pre599, 'the pre-#599 fixture is identical to the current hook').not.toBe(CURRENT);
    expect(pre599, 'the fixture lost the worktree guard too, so it cannot isolate the updater leg')
      .toContain('--git-common-dir');
    expect(pre599, 'the fixture still carries the UNMEASURED reading it is meant to predate')
      .not.toContain('project-state: UNMEASURED');
    expectRefusedAs(against(repoWithHook('pre-599', pre599)), 'STALE', /updater resolution/i);
  });

  test('SC-2043: a hand-written hook is refused rather than silently compared', () => {
    expectRefusedAs(
      against(repoWithHook('hand-written', '#!/bin/sh\n# mine\nexit 0\n')),
      'STALE',
      /hand-written|not managed/i,
    );
  });

  test('SC-2043: a hook carrying every guard but differing in bytes is still refused', () => {
    // Byte-exact is the property; the named guards are diagnosis. A check
    // that asked only for the guards would be satisfiable by pasting three
    // strings into a hook that does nothing with them.
    const drifted = `${CURRENT}\n# a line somebody added by hand\n`;
    expectRefusedAs(against(repoWithHook('drifted', drifted)), 'STALE', /not byte-identical|differs/i);
  });

  test('an unknown option and a missing value are both refused', () => {
    expectRefused(['--nonsense', 'x'], /unknown option/i);
    expectRefused(['--project'], /needs a value/i);
  });

  test('SC-2144: the staleness label belongs to the currencyRefusal return path alone', () => {
    // Criterion 2 of #613 pinned to the BINDING rather than to a count. There
    // are five refusal classes produced by one `return` path and thirteen
    // throw sites that are not refusals of that kind at all, so "the five
    // existing refusals keep their prefix" is a claim about where the label is
    // attached, not about how many messages carry it.
    const raises = source.match(/new HookRefused\(\s*"STALE"/g) || [];
    expect(raises.length, 'the staleness class is raised from more than one position').toBe(1);

    const at = source.indexOf('new HookRefused("STALE"');
    const line = source.slice(source.lastIndexOf('\n', at) + 1, source.indexOf('\n', at));
    expect(
      line,
      'the staleness raise is no longer the currencyRefusal verdict, so the label has ' +
        'detached from the only decider entitled to it',
    ).toContain('if (refusal)');
    expect(
      source.slice(0, at),
      'currencyRefusal is not called above the staleness raise',
    ).toContain('currencyRefusal(readIfPresent(path)');
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
    expectRefusedAs(against(linked), 'STALE', /hand-written|not managed/i);
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

    // #613: an --install that cannot write is an INSTALL refusal, not a
    // staleness verdict. The operator ran --install BECAUSE something said the
    // hook was stale; saying it again names the command that just failed as
    // the remedy for the command that just failed.
    expectRefusedAs([...against(dir), '--install'], 'INSTALL', /symlink/i);
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
    const shouldPass = installed === CURRENT_LIVE;
    expect(
      r.code === 0,
      shouldPass
        ? `the installed hook at ${path} IS the generator output, and the check refused:\n${r.err}`
        : `the installed hook at ${path} is ${installed === null ? 'absent' : 'not the generator output'}, ` +
          `and the check passed anyway:\n${r.out}`,
    ).toBe(shouldPass);
  });
});
