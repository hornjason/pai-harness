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
import { prePushHookScript } from '../../lib/scaffold/pre-push-hook';
import { EMBEDDED_PATTERNS } from '../../lib/secret-patterns';
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
/**
 * #891. Every fixture measured against the REAL generator plants a current
 * `pre-push` beside whatever the case is about.
 *
 * The checker reports on every hook the generator declares, so a fixture
 * with only a `pre-commit` is now refused for the missing one — correctly,
 * and for a reason none of these cases is asking about. Planting the current
 * one holds the second hook fixed so each case still measures the thing in
 * its name (#585: vary exactly one reading).
 */
function plantCurrentPrePush(hooksDir: string): void {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), prePushHookScript(), { mode: 0o755 });
}

function repoWithHook(name: string, hook: string | null): string {
  const dir = join(FIX, name);
  initRepo(dir);
  const path = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  if (hook === null) rmSync(path, { force: true });
  else writeFileSync(path, hook, { mode: 0o755 });
  plantCurrentPrePush(join(dir, '.git', 'hooks'));
  return dir;
}

/**
 * #874. A fixture whose `core.hooksPath` points somewhere else, with whatever
 * is at the DEFAULT location given separately.
 *
 * The decoy argument is the point of the helper. `core.hooksPath` redirects
 * git wholesale: `.git/hooks/pre-commit` is then an ordinary untracked file
 * that nothing executes, and a check reading it reports a verdict about a
 * program that will never run. A fixture with nothing at the default location
 * cannot tell "read the right file" from "read nothing and fell through", so
 * every hooksPath case here says what is sitting at the old address.
 *
 * `hooksPath` is written to the config verbatim, so a relative value stays
 * relative — git resolves one against the working directory it runs the hook
 * from, and a check that assumed absolute would read a path that does not
 * exist and call it "no hook installed".
 */
function repoWithHooksPath(
  name: string,
  opts: { hooksPath: string; hook: string | null; decoy: string | null },
): { dir: string; hookFile: string } {
  const dir = join(FIX, name);
  initRepo(dir);
  const defaultPath = join(dir, '.git', 'hooks', 'pre-commit');
  if (opts.decoy === null) rmSync(defaultPath, { force: true });
  else writeFileSync(defaultPath, opts.decoy, { mode: 0o755 });

  const resolved = opts.hooksPath.startsWith('/') ? opts.hooksPath : join(dir, opts.hooksPath);
  mkdirSync(resolved, { recursive: true });
  const hookFile = join(resolved, 'pre-commit');
  if (opts.hook === null) rmSync(hookFile, { force: true });
  else writeFileSync(hookFile, opts.hook, { mode: 0o755 });

  // Into the directory git will actually read, which core.hooksPath has
  // just moved. The decoy location is left alone on purpose.
  plantCurrentPrePush(resolved);

  git(dir, ['config', 'core.hooksPath', opts.hooksPath]);
  return { dir, hookFile };
}

/**
 * #874. A minimal rungate checkout: a `lib/scaffold/steps.ts` that emits a
 * hook, and a `lib/secret-patterns.ts` declaring whatever registry the case
 * wants, with the two deliberately allowed to disagree.
 *
 * The script reaches both modules through paths computed from `--generator`,
 * so a synthetic root is the only way to vary the registry without editing
 * the real one — and editing the real one is not a test, it is a change to
 * the thing under test.
 *
 * The emitted hook carries the managed marker and every GUARD_PROPERTIES
 * probe, because a hook missing one of those is refused for a reason that has
 * nothing to do with the registry, and the case would then pass without ever
 * reaching the guard it names.
 */
function fakeGenerator(
  name: string,
  opts: { patterns: Array<{ id: string; ere: string }>; emit: string[] },
): { root: string; hook: string } {
  const root = join(FIX, `generator-${name}`);
  mkdirSync(join(root, 'lib', 'scaffold'), { recursive: true });
  const hook = [
    '#!/bin/sh',
    PRE_COMMIT_MANAGED_MARKER,
    '# --git-common-dir',
    '# Which updater runs was decided when this hook was generated (#610), not here.',
    'echo "project-state: UNMEASURED — synthetic" >&2',
    'echo "are DA-owned (#296); update them from the primary checkout." >&2',
    ...opts.emit.map(e => `# ${e}`),
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(
    join(root, 'lib', 'scaffold', 'steps.ts'),
    `export const PRE_COMMIT_MANAGED_MARKER = ${JSON.stringify(PRE_COMMIT_MANAGED_MARKER)};\n` +
      `export function preCommitHookScript(_root: string): string { return ${JSON.stringify(hook)}; }\n` +
      // #891. The population the checker reads is the generator's own
      // declaration, so a synthetic generator has to declare one. A single
      // entry on purpose: these cases are about the pre-commit projection,
      // and a second hook here would make every count in this file depend
      // on something none of them is asking about.
      `export const GENERATED_HOOKS = [{ name: "pre-commit", ` +
      `script: preCommitHookScript, marker: PRE_COMMIT_MANAGED_MARKER, ` +
      `describes: "synthetic" }];\n`,
  );
  writeFileSync(
    join(root, 'lib', 'secret-patterns.ts'),
    `export const EMBEDDED_PATTERNS = ${JSON.stringify(opts.patterns)};\n`,
  );
  return { root, hook };
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
      // The probe was the literal `if (refusal)` and went red in #891 when
      // the CLI began collecting a verdict per hook before raising once --
      // `if (refusals.length > 0)`. The property did not move; the probe was
      // narrower than the property it stood for, which is this repo's second
      // shape. It is the guard expression that has to name what
      // currencyRefusal returned, and the singleton assertion above is what
      // makes "one position" mean one position.
    ).toMatch(/^\s*if \(refusals?\b/);
    // Two clauses, because the call is no longer on one line (#891) and a
    // single literal spanning it would be asserting the formatting. The
    // property is that the thing raised is what currencyRefusal returned
    // about the file on disk.
    const above = source.slice(0, at);
    expect(above, 'currencyRefusal is not called above the staleness raise').toContain(
      'const refusal = currencyRefusal(',
    );
    expect(
      above,
      'the verdict above the raise is not taken over the INSTALLED file',
    ).toContain('readIfPresent(path)');
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

// ── #874: the file git will run, not the file at the conventional address ──
//
// WHAT WAS BROKEN TO PROVE THESE CASES FAIL, run and counted rather than
// asserted, over this file alone (48 tests). Every count was predicted before
// the battery ran, and THE BASELINE ROW WAS READ FIRST — an instrument that
// has stopped reporting takes the baseline down with it, and that is the row
// nobody mutates anything to produce.
//
// | Row | Predicted | Measured | The input on which mutant and original differ |
// |---|---|---|---|
// | baseline — unmutated | 48 pass, 0 fail | 48 pass, 0 fail | — |
// | M1 the genuinely pre-#874 resolver: `--git-common-dir` + `join(…, "hooks", "pre-commit")` | 6 | 7 of 48 | a repo whose `core.hooksPath` holds `exit 0` and whose `.git/hooks/pre-commit` holds the generator output: the original refuses naming `…/elsewhere/pre-commit`, the mutant prints `pre-commit is current` and exits 0 |
// | M2 THE CHEAPEST WRONG FIX for the resolver: old resolver, plus UNMEASURED whenever `core.hooksPath` is set | 6 | 7 of 48 | a repo whose `core.hooksPath` holds the CURRENT generator output: the original exits 0 naming it, the mutant refuses `core.hooksPath is set to elsewhere`. AC-2 and AC-3 are the cases that do not survive it |
// | M3 `missingPatternIds` short-circuited to `return []` | 14 | 14 of 48 | the hook with tier 1's `jwt` expression deleted: the original names `jwt`, the mutant names no pattern |
// | M4 THE CHEAPEST WRONG FIX for the naming: a hand table naming only `jwt` | 13 | 13 of 48 | the hook with `aws-access-key` deleted: the original names it, the mutant names nothing. The `jwt` case is the one green of the thirteen, which is the whole argument against the table |
// | M5 `patternsBlindToGenerator` short-circuited to `return []` | 1 | 1 of 48 | the synthetic generator declaring `invented-pattern` and emitting it nowhere: the original is UNMEASURED, the mutant reaches a verdict about a pattern nothing could carry |
// | M6 the empty/ill-typed `EMBEDDED_PATTERNS` refusal removed | 1 | 1 of 48 | the synthetic generator exporting `[]`: the original refuses naming the export, the mutant compares against a declaration of nothing and passes |
// | M7 the `--install` missing-directory refusal removed | 1 | 1 of 48 | `core.hooksPath = nowhere`: the original refuses as INSTALL naming the directory, the mutant throws a bare ENOENT that prints with no class at all |
// | M8 `EMBEDDED_PATTERNS` truncated to tier 1 — the four tier-2/tier-3 entries dropped | 2 red, 44 cases | 2 of 44 — AC-7's pin and AC-9 | the registry itself |
// | M9 the symlinked-hooks-directory refusal removed | 1 | 1 of 48 | `core.hooksPath` pointing at a symlink to a directory outside the repository: the original refuses as INSTALL, the mutant OVERWRITES the file there and prints `pre-commit installed, and current` |
//
// M2's first cut measured 35 and was NOT a mutation: it read `core.hooksPath`
// with a bare `git config --get`, which exits 1 when the key is absent, so
// `execFileSync` threw for every fixture and the mutant died rather than
// behaved differently. A mutant that crashes measures that the file still
// parses. Re-cut with `--default ""`, the row is 6 — over the 47 cases that
// existed then.
//
// M1 and M2 were 6 of 47 before M9's case was written and are 7 of 48 after.
// The extra red is the symlinked-directory case, which sets `core.hooksPath`
// and therefore cannot reach the refusal it is about on either mutant —
// squarely about the mutated behaviour, and not a crashing mutant: 41 cases
// still pass in both rows. Every row in the table above is the re-measurement
// over 48; the predictions are the numbers written down before the first run.
//
// M8 is the row that justifies AC-7 existing at all. Four of the thirteen
// AC-8 cases are GENERATED FROM the list the mutation empties, so they are
// DELETED rather than reddened — 43 cases ran, not 47 — and a case population
// that is a projection of its own subject cannot witness that subject being
// emptied. The hand-written pin is the only thing that goes red.
//
// None of the eight mutations is left in the tree; all were run and reverted,
// and `scripts/check-installed-hook-currency.ts` and `lib/secret-patterns.ts`
// were confirmed byte-identical to the measured source afterwards by sha256,
// restored from a `cp` backup and never by `git checkout --`.

describe('#874: core.hooksPath decides where the hook that runs lives', () => {
  // The defect, in one sentence: `core.hooksPath` redirects git wholesale, and
  // a check joining `<common-dir>/hooks/pre-commit` then reports a verdict
  // about a file nothing executes. Measured on 2026-10-21 against the
  // pre-#874 script: a repository whose hooksPath pointed at `exit 0` and
  // whose `.git/hooks/pre-commit` held the current generator output printed
  // `pre-commit is current` and exited 0.
  //
  // THE CHEAPEST WRONG FIX, named before the repair: read
  // `core.hooksPath` and refuse UNMEASURED whenever it is set. One config read
  // and one throw; the false CLEAN disappears. It is wrong twice over — it
  // still never reads the hook that runs, so it trades a false pass for a
  // permanent non-measurement, and `core.hooksPath` is an ordinary supported
  // setting, so the check becomes one people switch off.
  //
  // AC-2 is the case that does not survive it: a hooksPath pointing at a
  // CURRENT hook must come back clean. A suite asserting only "non-zero when
  // hooksPath is set" would go green on that repair and certify it.
  //
  // The second-cheapest wrong fix is to read the config value and join it as
  // if it were always absolute. AC-3 is the case that does not survive THAT:
  // git resolves a relative hooksPath against the directory it runs the hook
  // from, and an absolute join of `relhooks` reads a path that does not exist
  // and reports "no hook installed" on a checkout whose hook is fine.

  test('AC-1: a stale hook at core.hooksPath is refused even when the default address holds a current one', () => {
    // The decoy is the whole case. `.git/hooks/pre-commit` is byte-identical
    // to the generator output, so every reading taken at the old address says
    // CLEAN; the program git actually runs on a commit is three lines of
    // `exit 0`. Without the decoy this case could pass on a check that read
    // nothing at all.
    const { dir, hookFile } = repoWithHooksPath('hookspath-stale', {
      hooksPath: 'elsewhere',
      hook: '#!/bin/sh\n# mine\nexit 0\n',
      decoy: CURRENT,
    });
    expect(
      readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf-8'),
      'the decoy is not the generator output, so a reading at the old address would refuse anyway',
    ).toBe(CURRENT);

    expectRefusedAs(against(dir), 'STALE', /hand-written|not managed/i);
    expect(
      run(SCRIPT, against(dir)).err,
      'the refusal names the decoy rather than the file git will run',
    ).toContain(hookFile);
  });

  test('AC-2: a current hook at an ABSOLUTE core.hooksPath is clean, and the verdict names it', () => {
    const outside = join(FIX, 'hookspath-absolute-dir');
    mkdirSync(outside, { recursive: true });
    const { dir } = repoWithHooksPath('hookspath-absolute', {
      hooksPath: outside,
      hook: CURRENT,
      decoy: null,
    });
    const r = run(SCRIPT, against(dir));
    expect(r.code, `a current hook at core.hooksPath was refused:\n${r.err}`).toBe(0);
    expect(r.out, 'the verdict does not name the hooksPath file').toContain(
      join(outside, 'pre-commit'),
    );
  });

  test('AC-3: a RELATIVE core.hooksPath resolves the way git resolves it', () => {
    // Measured, not assumed: with `core.hooksPath = relhooks`, git ran
    // `<toplevel>/relhooks/pre-commit` for a commit issued from the toplevel
    // AND for one issued from a subdirectory, and `git rev-parse --git-path
    // hooks` answered `relhooks` and `../relhooks` respectively — relative to
    // the directory git was asked from, which is why the answer is resolved
    // against --project and not against the toplevel.
    const { dir, hookFile } = repoWithHooksPath('hookspath-relative', {
      hooksPath: 'relhooks',
      hook: CURRENT,
      decoy: null,
    });
    const r = run(SCRIPT, against(dir));
    expect(r.code, `a current hook at a relative core.hooksPath was refused:\n${r.err}`).toBe(0);
    expect(realpathSync(/at (\/.*?)\s*$/m.exec(r.out)?.[1] ?? '/nonexistent')).toBe(
      realpathSync(hookFile),
    );
  });

  test('AC-4: with core.hooksPath set and nothing installed there, the DEFAULT address is not consulted', () => {
    // A fall-back to `<common-dir>/hooks` when the hooksPath file is absent
    // would be the fail-open version of this fix: the check would find the
    // decoy, call it current, and the commit would still run nothing.
    const { dir, hookFile } = repoWithHooksPath('hookspath-empty', {
      hooksPath: 'elsewhere',
      hook: null,
      decoy: CURRENT,
    });
    expectRefusedAs(against(dir), 'STALE', /no .*pre-commit|not installed/i);
    expect(run(SCRIPT, against(dir)).err).toContain(hookFile);
  });

  test('AC-5: --install writes where core.hooksPath points, not to the default address', () => {
    // The remedy the refusal names has to reach the same file the refusal is
    // about. Installing to `.git/hooks` on a repository that reads its hooks
    // from elsewhere produces a check that passes and a commit that scans
    // nothing — strictly worse than the state it replaced, because the
    // disagreement is now certified.
    const { dir, hookFile } = repoWithHooksPath('hookspath-install', {
      hooksPath: 'elsewhere',
      hook: '#!/bin/sh\n' + PRE_COMMIT_MANAGED_MARKER + '\nexit 0\n',
      decoy: null,
    });
    const installed = run(SCRIPT, [...against(dir), '--install']);
    expect(installed.code, `--install refused:\n${installed.err}`).toBe(0);
    expect(readFileSync(hookFile, 'utf-8')).toBe(CURRENT);
    expect(
      existsSync(join(dir, '.git', 'hooks', 'pre-commit')),
      '--install wrote to the default address, which this repository does not read',
    ).toBe(false);
    expect(run(SCRIPT, against(dir)).code, 'the installed copy is still not current').toBe(0);
  });

  test('AC-5: --install refuses a core.hooksPath directory that does not exist', () => {
    // git can be pointed anywhere on disk by this setting, so a `mkdir -p`
    // here would build a tree outside the repository on the strength of one
    // config value. Refusing by name also keeps the message classified: the
    // bare ENOENT escapes as an unlabelled string, which is #613.
    const dir = repoWithHook('hookspath-missing-dir', null);
    git(dir, ['config', 'core.hooksPath', 'nowhere']);
    expectRefusedAs([...against(dir), '--install'], 'INSTALL', /does not exist/i);
    expect(existsSync(join(dir, 'nowhere')), 'the directory was created anyway').toBe(false);
  });

  test('AC-5: --install refuses a SYMLINKED core.hooksPath directory', () => {
    // The leaf has been refused since #599 on the grounds that "the target
    // may be outside this repository". A symlinked hooks DIRECTORY defeats
    // that completely, and since #874 the directory is the part
    // `core.hooksPath` chooses — so it is the half an operator is least
    // likely to have looked at. Raised by the automated security review of
    // the first push of this branch; the containment check it also suggested
    // is declined on the PR, because a hooks directory outside the worktree
    // is how teams share hooks.
    const dir = repoWithHook('hookspath-symlinked-dir', null);
    const outside = join(FIX, 'outside-hooks-dir');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'pre-commit'), 'not the hook\n');
    symlinkSync(outside, join(dir, 'linked-hooks'));
    git(dir, ['config', 'core.hooksPath', 'linked-hooks']);

    expectRefusedAs([...against(dir), '--install'], 'INSTALL', /symlink/i);
    expect(
      readFileSync(join(outside, 'pre-commit'), 'utf-8'),
      'the generator was written through the linked directory',
    ).toBe('not the hook\n');
  });

  test('AC-6 control: with core.hooksPath UNSET the reading is the shared common dir, unchanged', () => {
    // The negative control for the four cases above. git treats `hooks` as a
    // path shared by every worktree, so `--git-path hooks` has to keep
    // answering with the primary `.git/hooks` from a linked worktree — the
    // property SC-2044 pins. A fix that started reading the per-worktree
    // gitdir would pass every hooksPath case here and break every agent.
    const primary = repoWithHook('hookspath-control', CURRENT);
    const linked = join(FIX, 'hookspath-control-linked');
    git(primary, ['worktree', 'add', '-q', '-b', 'control-side', linked]);
    for (const where of [primary, linked]) {
      // git answers relative to the directory it was asked from, so the
      // answer is resolved against that directory and not against this
      // process's cwd — the same resolution the script has to perform.
      const answer = execFileSync('git', ['-C', where, 'rev-parse', '--git-path', 'hooks'], {
        encoding: 'utf-8',
      }).trim();
      expect(
        realpathSync(answer.startsWith('/') ? answer : join(where, answer)),
        `git answered a non-shared hooks directory for ${where}`,
      ).toBe(realpathSync(join(primary, '.git', 'hooks')));
      expect(run(SCRIPT, against(where)).code, `the control run was refused for ${where}`).toBe(0);
    }
  });
});

// ── #874: which patterns the installed copy is missing, by name ────────────

describe('#874: the refusal names the registry patterns the installed hook lacks', () => {
  // `lib/secret-patterns.ts` is the registry and the generator interpolates
  // every tier from it, so a byte-exact comparison already catches a hook
  // whose scanner has drifted. What it could not do is SAY SO: the live
  // installed hook on this machine on 2026-10-21 was missing tier 1's `jwt`
  // and the whole of tiers 2 and 3, and the refusal reported that it
  // "predates the generation-time updater resolution (#610)" — true, and
  // about the least important of the differences.
  //
  // THE CHEAPEST WRONG FIX, named before the repair: add one GUARD_PROPERTIES
  // row whose probe is the jwt expression. One line, and the message names
  // jwt. It is wrong because GUARD_PROPERTIES is hand-maintained and the
  // registry is the authority — the tenth pattern is invisible again, and the
  // table and the registry become two deciders that agree until one is
  // edited.
  //
  // AC-8 is the case that does not survive it: it drops each registry id in
  // turn, reading the list from the registry at runtime, so a row written for
  // jwt satisfies exactly one of its generated cases and fails the rest.

  test('AC-7: EMBEDDED_PATTERNS is exactly this list', () => {
    // The pin AC-8 needs. AC-8's cases are generated FROM this list, so
    // emptying it DELETES them rather than reddening them — a case population
    // that is a projection of its own subject cannot witness that subject
    // being emptied. This case is written out by hand for that reason, and
    // updating it is the cost of adding a pattern.
    expect(EMBEDDED_PATTERNS.map(p => p.id)).toEqual([
      'github-pat-classic',
      'github-oauth',
      'github-server',
      'github-pat-fine',
      'aws-access-key',
      'openai',
      'anthropic',
      'private-key',
      'jwt',
      'tier2-assignment',
      'tier2-allowlist',
      'tier3-shell-default',
      'tier3-allowlist',
    ]);
  });

  test('AC-7: every registry expression reaches the generated hook', () => {
    // The instrument check. A registry entry the generator never emits makes
    // the probe below report every installed hook as missing it, which is a
    // refusal that names the wrong thing on every run — the stale-probe
    // failure GUARD_PROPERTIES already guards against, one table over.
    const blind = EMBEDDED_PATTERNS.filter(p => !CURRENT.includes(p.ere)).map(p => p.id);
    expect(blind, 'the generator does not interpolate these registry expressions').toEqual([]);
  });

  EMBEDDED_PATTERNS.forEach((pattern, index) => {
    test(`AC-8: a hook missing ${pattern.id} is refused, and the refusal names it`, () => {
      const narrowed = CURRENT.split(pattern.ere).join('');
      expect(narrowed, `${pattern.ere} is not in the generated hook`).not.toBe(CURRENT);
      // Collateral damage would make this case measure the wrong id. One
      // expression being a substring of another would remove two and the
      // refusal would name both, so the case says which it expects to survive.
      for (const other of EMBEDDED_PATTERNS) {
        if (other.id === pattern.id) continue;
        expect(
          narrowed.includes(other.ere),
          `removing ${pattern.id} also removed ${other.id}, so this case cannot isolate either`,
        ).toBe(true);
      }

      // The fixture is named by INDEX, never by the id. Its path appears in
      // the refusal, so a directory called `narrowed-jwt` makes the assertion
      // below match the path rather than the finding — measured: all thirteen
      // of these cases passed that way against a script that names no pattern
      // at all, which is `.claude/rules/checks-must-be-able-to-fail.md`'s
      // "fixture that reached the assertion without the feature", arriving in
      // the file that was written to avoid it.
      const dir = repoWithHook(`narrowed-${index}`, narrowed);
      expect(dir, 'the fixture path leaks the id the refusal is asserted to name').not.toContain(
        pattern.id,
      );
      expectRefusedAs(against(dir), 'STALE', new RegExp(pattern.id.replace(/[-]/g, '[-]')));
      const err = run(SCRIPT, against(dir)).err;
      for (const other of EMBEDDED_PATTERNS) {
        if (other.id === pattern.id) continue;
        expect(
          err.includes(other.id),
          `the refusal names ${other.id}, which this hook still carries:\n${err}`,
        ).toBe(false);
      }
    });
  });

  test('AC-11: a registry the generator cannot satisfy is UNMEASURED, not stale', () => {
    // The witness for `patternsBlindToGenerator`. Without it that refusal and
    // AC-7's test-side "every registry expression reaches the generated hook"
    // would be two deciders asking one question of one input — behaviourally
    // one, with a mutation of either leaving the other holding the case up
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). This
    // reaches it through an input AC-7 cannot have: a generator checkout
    // whose registry and whose emitter disagree, which is what `--generator`
    // pointed at another rungate tree can produce.
    const { root } = fakeGenerator('blind-registry', {
      patterns: [{ id: 'invented-pattern', ere: 'ZZZZ[0-9]{9}' }],
      emit: [],
    });
    expectRefusedAs(
      ['--project', repoWithHook('blind-registry-project', null), '--generator', root],
      'UNMEASURED',
      /does not interpolate invented-pattern/,
    );
  });

  test('AC-11: a registry exporting no patterns at all is UNMEASURED', () => {
    // `[]` is not a reading. An empty declaration would make every installed
    // hook carry every pattern it declares, which is a PASS composed entirely
    // of things nobody checked — `.claude/rules/config-access.md`'s point
    // about `0` and `{}` being indistinguishable from success.
    const { root } = fakeGenerator('empty-registry', { patterns: [], emit: [] });
    expectRefusedAs(
      ['--project', repoWithHook('empty-registry-project', null), '--generator', root],
      'UNMEASURED',
      /EMBEDDED_PATTERNS/,
    );
  });

  test('AC-11: a synthetic generator whose registry it DOES satisfy gets through to a verdict', () => {
    // The control for the two above. Both of them refuse, and a refusal is
    // also what a fake generator that simply fails to load produces — so
    // without an otherwise-identical generator that reaches the comparison,
    // neither case can tell the registry guard from a broken fixture.
    const { root, hook } = fakeGenerator('good-registry', {
      patterns: [{ id: 'invented-pattern', ere: 'ZZZZ[0-9]{9}' }],
      emit: ['ZZZZ[0-9]{9}'],
    });
    const dir = repoWithHook('good-registry-project', hook);
    const r = run(SCRIPT, ['--project', dir, '--generator', root]);
    expect(r.code, `the synthetic generator did not reach a verdict:\n${r.err}`).toBe(0);
  });

  test('AC-9: a hook missing two patterns names both', () => {
    // One id is satisfied by a message that names the first difference it
    // finds and stops. The live installed hook was missing four.
    const [a, b] = [EMBEDDED_PATTERNS[8], EMBEDDED_PATTERNS[11]];
    const narrowed = CURRENT.split(a.ere).join('').split(b.ere).join('');
    const err = run(SCRIPT, against(repoWithHook('narrowed-two', narrowed))).err;
    expect(err).toContain(a.id);
    expect(err).toContain(b.id);
  });

  test('AC-10: a hook that differs in bytes but lacks no pattern names no pattern', () => {
    // The discrimination case. A refusal that always lists the registry is a
    // refusal that says nothing, and this is the input that tells the two
    // apart: every expression present, one trailing comment different.
    const err = run(SCRIPT, against(repoWithHook('drifted-no-patterns', `${CURRENT}\n# hand-edited\n`))).err;
    expect(err, 'the byte-difference refusal is gone').toMatch(/not byte-identical|differs/i);
    for (const p of EMBEDDED_PATTERNS) {
      expect(
        err.includes(p.id),
        `the refusal names ${p.id} for a hook that carries every registry expression:\n${err}`,
      ).toBe(false);
    }
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
    // Deliberately a SECOND reading, not a call into the script — the case is
    // named after an independent one, and importing the script's own resolver
    // would make this an assertion that one function agrees with itself.
    // It has to honour core.hooksPath for the same reason the script does
    // (#874): on a checkout that sets it, a reading at `<common-dir>/hooks`
    // is about a file nothing runs, and this case would then compare the
    // script's correct verdict against a wrong oracle and fail.
    const hooks = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf-8',
    }).trim();
    const path = join(hooks.startsWith('/') ? hooks : join(REPO_ROOT, hooks), 'pre-commit');
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
