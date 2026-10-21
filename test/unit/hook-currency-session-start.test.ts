import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { preCommitHookScript } from '../../lib/scaffold/steps';
import { prePushHookScript } from '../../lib/scaffold/pre-push-hook';

/**
 * #879 — nothing RAN the installed-hook currency check, so #874's and #891's
 * fixes reached nobody by themselves.
 *
 * `.git/hooks/` is untracked. No position in the repository can see what is
 * installed there, no CI job installs it, and `createGitHooks` only runs on a
 * re-scaffold — so "the generator is fixed" and "the hook on my machine is
 * fixed" are two claims and only the first has ever had evidence. Measured on
 * this repository on 2026-10-21: BOTH installed hooks were stale, the
 * `pre-commit` by five secret-scanner expressions and the `pre-push` by the
 * whole of #728, while every test in the tree was green.
 *
 * This file is about the SessionStart hook that takes the reading. What the
 * reading SAYS is `test/unit/installed-hook-currency.test.ts`'s subject and is
 * deliberately not re-asserted here; the two questions are kept apart so
 * neither can go green on half a repair (#484).
 *
 * Every case drives the real hook file as a subprocess against a planted
 * repository. Nothing here reads this machine's own `.git/hooks`, whose state
 * moves under the suite, and nothing reads `~/.claude/settings.json`, which is
 * machine state no checkout can see — the registration is asserted in the
 * COMMITTED `.claude/settings.json`, which is why the hook is project-scoped
 * (#199: "this cannot be checked" is a claim, and splitting the population by
 * what the repo can see is the usable form of the answer).
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HOOK = join(REPO_ROOT, 'hooks', 'HookCurrency.hook.ts');
const hookSource = readFileSync(HOOK, 'utf-8');
const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf-8'));
const registry = JSON.parse(
  readFileSync(join(REPO_ROOT, '.claude', 'rungate', 'hooks.json'), 'utf-8'),
);

let FIX = '';
/** What the generator produces for a bare fixture repository, byte for byte. */
let CURRENT = '';

beforeAll(() => {
  FIX = mkdtempSync(join(tmpdir(), 'hook-currency-session-'));
  CURRENT = preCommitHookScript(FIX);
});
afterAll(() => {
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

/**
 * A repository whose installed `pre-commit` is exactly `preCommit`, with a
 * CURRENT `pre-push` beside it so each case varies exactly one reading
 * (#585). A fixture missing the second hook would be refused for a reason no
 * case here is asking about.
 */
function repo(name: string, preCommit: string | null): string {
  const dir = join(FIX, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  const hooks = join(dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const at = join(hooks, 'pre-commit');
  if (preCommit === null) rmSync(at, { force: true });
  else writeFileSync(at, preCommit, { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), prePushHookScript(), { mode: 0o755 });
  return dir;
}

/** The hook, run the way a session runs it: from inside the project. */
function runHook(cwd: string) {
  const r = spawnSync('bun', [HOOK], { cwd, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ── Where it is registered, and how often it fires ───────────────────────

describe('#879: the check runs without anyone remembering it', () => {
  test('AC-1: the hook is registered for SessionStart in the committed settings', () => {
    // The position matters as much as the fact. A machine-scoped registration
    // in ~/.claude/settings.json is invisible to every checkout, which is how
    // five hooks in this tree sat inert for four weeks (#199).
    const events = Object.keys(settings.hooks ?? {});
    const naming = events.filter(e =>
      JSON.stringify(settings.hooks[e]).includes('HookCurrency.hook.ts'),
    );
    expect(naming, 'the hook is registered under no event, so nothing runs it').toContain(
      'SessionStart',
    );

    const entry = (registry.hooks ?? registry).find?.((h: any) => h.name === 'HookCurrency');
    expect(entry, 'HookCurrency has no entry in .claude/rungate/hooks.json').toBeTruthy();
    expect(entry.hookFor).toBe('SessionStart');
    expect(entry.enabled, 'the entry exists but is disabled, which runs nothing').toBe(true);

    // The fourth position self-referential-tests.md Tier 2 requires for a new
    // hook. Written here by #879 because the census that owned the spec table
    // enforced a FLOOR -- "at least 14 rows" -- so deleting this hook's row
    // was measured at 0 red (row M10). A floor cannot witness an addition.
    //
    // #898 replaced that floor with a named agreement over every hook on
    // disk, so this line is now REDUNDANT for its original purpose and is
    // kept deliberately rather than deleted: it is the per-hook case the
    // census generalises, and the two go red for different reasons. Remove
    // the row and both fail; point the census at the wrong file and only the
    // census fails; stop generating this hook and only this fails. A
    // redundancy that distinguishes causes is not duplication (#898 AC-2).
    expect(
      readFileSync(join(REPO_ROOT, 'specs', 'HOOK-ARCHITECTURE-SPEC.md'), 'utf-8'),
      'the hook has no row in the HOOK-ARCHITECTURE-SPEC current state table',
    ).toContain('| HookCurrency | HookCurrency.hook.ts |');
  });

  test('AC-2: it fires once per session and the stated cadence is the registered one', () => {
    // #879 asks for the cadence to be STATED rather than implied, and a
    // sentence in a file is not a cadence. Two positions, compared: the
    // declared trigger and the prose that explains it. A hook registered for
    // PreToolUse while its comment says "once per session" is the #621 shape
    // -- two documents naming one fact with nothing comparing them.
    const events = Object.keys(settings.hooks ?? {}).filter(e =>
      JSON.stringify(settings.hooks[e]).includes('HookCurrency.hook.ts'),
    );
    expect(
      events,
      'the hook is registered for more than one event, so the cadence is whatever fires most',
    ).toEqual(['SessionStart']);
    expect(hookSource, 'the TRIGGER line does not name the event it is registered for').toContain(
      'TRIGGER: SessionStart',
    );
    expect(
      hookSource,
      'the cadence is implied by the registration and stated nowhere (#879 asks for both)',
    ).toMatch(/once per session/i);
  });
});

// ── Proven able to fail: a planted pair, measured rather than asserted ───

describe('#879: a stale hook produces the message and a current one does not', () => {
  test('AC-3: the pair differs in exactly one line, and only one half reports STALE', () => {
    // #585's discipline. The stale half is DERIVED from the current half by
    // appending one line, so the two cannot carry a second difference -- a
    // pair of hand-written literals is two literals, and the next edit
    // touches one of them.
    const drifted = `${CURRENT}# a line somebody added by hand\n`;
    expect(drifted.split('\n').length, 'the pair differs by more than the appended line').toBe(
      CURRENT.split('\n').length + 1,
    );

    const clean = runHook(repo('pair-current', CURRENT));
    const stale = runHook(repo('pair-stale', drifted));

    expect(clean.code, `a current tree was failed:\n${clean.err}`).toBe(0);
    expect(stale.code, `a stale tree failed the session:\n${stale.err}`).toBe(0);

    expect(stale.out, 'a stale installed hook produced no staleness message').toContain('STALE');
    expect(stale.out, 'the message does not name the hook that is stale').toContain('pre-commit');
    expect(
      clean.out,
      'a tree whose hooks are all current was reported STALE, so the message means nothing',
    ).not.toContain('STALE');
    expect(clean.out, 'a clean reading is silent, which is indistinguishable from not running')
      .toMatch(/current/i);
  });
});

// ── A tree with nothing installed is UNMEASURED, and survivable ──────────

describe('#879: a fresh clone is not a failure', () => {
  test('AC-4: no installed hook reports UNMEASURED and exits 0', () => {
    // The criterion this file exists for, and the property the cheapest wrong
    // fix violates: registering `scripts/check-installed-hook-currency.ts`
    // itself as the SessionStart command is one line and no new file.
    // Measured on a fresh `git init` carrying a current pre-push and no
    // pre-commit -- the script exits 1 and this hook exits 0, so that
    // registration opens every fresh clone and every CI checkout with a
    // failing SessionStart hook.
    //
    // Note what this case does and does not do. It establishes the property.
    // The case that goes RED when somebody makes that swap is AC-1/AC-2,
    // which read the registration itself (battery row M1, 2 red); this one
    // keeps running against the hook file either way. Said explicitly
    // because "survives the wrong fix" reads as coverage when it is not.
    const r = runHook(repo('fresh-clone', null));
    expect(r.code, `a fresh clone failed the session:\n${r.err}`).toBe(0);
    expect(r.out, 'an absent hook was not reported as UNMEASURED').toContain('UNMEASURED');
    expect(
      r.out,
      'an absent hook was reported STALE, which tells the operator to --install over nothing',
    ).not.toContain('STALE');
  });

  test('AC-5: a hand-written hook is UNMEASURED, not STALE', () => {
    // Not ours to judge, and calling it stale told the operator to run
    // --install, which would overwrite their file.
    const r = runHook(repo('hand-written', '#!/bin/sh\n# mine\nexit 0\n'));
    expect(r.code, `a hand-written hook failed the session:\n${r.err}`).toBe(0);
    expect(r.out).toContain('UNMEASURED');
    expect(r.out).not.toContain('STALE');
  });

  test('AC-6: a cwd outside any repository is UNMEASURED and exits 0', () => {
    const outside = mkdtempSync(join(tmpdir(), 'hook-currency-norepo-'));
    try {
      const r = runHook(outside);
      expect(r.code, `a non-repository cwd failed the session:\n${r.err}`).toBe(0);
      expect(r.out, 'a session opened outside a repository reported nothing at all').toContain(
        'UNMEASURED',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── The hook decides nothing ─────────────────────────────────────────────

describe('#879: the hook is a trigger, not a second checker', () => {
  test('AC-7: the population and the strongest-class comparison are not restated here', () => {
    // A hook that walked `GENERATED_HOOKS` itself, or compared classes
    // itself, would be a second decider agreeing with the script until the
    // day it did not -- and no behavioural case could tell them apart.
    expect(hookSource, 'the hook names the hook population itself').not.toContain(
      'GENERATED_HOOKS',
    );
    expect(hookSource, 'the hook decides the strongest class itself').not.toMatch(
      /cls === ['"]STALE['"]|=== ['"]STALE['"]/,
    );
    expect(hookSource, 'the hook does not take its reading from the one binding').toContain(
      'readHookCurrency(',
    );
    expect(hookSource, 'the hook does not consult the one class decider').toContain(
      'currencyClass(',
    );
  });

  test('AC-8: the hook cannot end a session, whatever it reads', () => {
    // Every exit is 0. A SessionStart hook that can fail is a hook somebody
    // disables, and a disabled hook reports nothing -- which is the state
    // #879 found the repository in, reached by a different road.
    const exits = hookSource.match(/process\.exit\((\d+)\)/g) || [];
    expect(exits.length, 'the hook has no explicit exit at all').toBeGreaterThan(0);
    for (const e of exits) {
      expect(e, 'a non-zero exit would fail the session on a tree the hook merely dislikes').toBe(
        'process.exit(0)',
      );
    }
    expect(hookSource, 'a throw from the reading is not caught, so it would surface as an error')
      .toContain('} catch (e) {');
  });
});
