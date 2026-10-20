import { describe, it, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ORIGINAL,
  REGENERATED_BY_SCRIPTS,
  hookFor,
  runWithStateFiles,
  type HookRun,
} from '../helpers/pre-commit-fixture';

/**
 * Covers SC-2041, SC-2042 (HARNESS-STANDARD.md) — #599.
 *
 * The generated pre-commit's worktree guard is the thing that stops a linked
 * worktree writing DA-owned state. #450 shipped it with three in-tree cases,
 * and three in-tree cases are exactly what
 * `.claude/rules/checks-must-be-able-to-fail.md` says is not evidence: a guard
 * that cannot be seen to go red when it is removed is indistinguishable from
 * one that never fires.
 *
 * So the guard is REMOVED — the comparison rewritten to compare `$gitdir`
 * with itself, which is "always the primary checkout" and is also a regression
 * shape someone could plausibly write — and the same four observations are run
 * against the real hook and against the mutant.
 *
 * Three properties make the count mean something, and each is its own case
 * below rather than a comment:
 *
 *   - **The baseline is read first.** Four green against the real hook. An
 *     instrument that has stopped reporting takes the baseline down with it,
 *     and that is the one row nobody checks.
 *   - **Green and red are compared by NAME.** "2 of 4" is satisfied by any two.
 *     Only the two worktree observations mean what this claims.
 *   - **A positive control that the mutation cannot reach stays green.** The
 *     secret scan is ~60 lines above the guard and has nothing to do with it.
 *     A mutant that failed to parse would take it down too, and a count alone
 *     cannot tell a dead mutant from a thorough one.
 */

/**
 * The one line the worktree decision is made on, and the single site this
 * battery mutates. Declared as a literal so the builder can refuse when it
 * moves rather than quietly producing a mutant identical to the original.
 */
const WORKTREE_COMPARISON = '[ "$gitdir" = "$commondir" ]';

/** Always-true, and the shape of the regression: the guard compares a value with itself. */
const ALWAYS_PRIMARY = '[ "$gitdir" = "$gitdir" ]';

export function buildAlwaysPrimaryMutant(source: string): string {
  const occurrences = source.split(WORKTREE_COMPARISON).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the worktree comparison appears ${occurrences} times. ` +
        `At 0 the guard has moved and the mutant would be a copy of the original; above 1 ` +
        `the surviving copy would hold every case up and the reds would mean nothing.`,
    );
  }
  return source.replace(WORKTREE_COMPARISON, ALWAYS_PRIMARY);
}

/**
 * One question asked of one hook. `failure` returns null when the hook
 * behaves, and the reason when it does not — so a battery row is a list of
 * names rather than a number nobody can attribute.
 */
interface Observation {
  name: string;
  /** True when this observation is downstream of the worktree guard. */
  worktreeGuarded: boolean;
  failure(script: string): string | null;
}

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

const OBSERVATIONS: Observation[] = [
  {
    name: 'a linked worktree stages no DA-owned state',
    worktreeGuarded: true,
    failure(script) {
      const { staged }: HookRun = runWithStateFiles(script, 'worktree');
      const forbidden = staged.filter(f =>
        ['project-state.json', 'PROJECT-STATE.md', 'SUCCESS.md'].includes(f),
      );
      return forbidden.length ? `staged ${forbidden.join(', ')} from a linked worktree` : null;
    },
  },
  {
    name: 'a linked worktree regenerates no DA-owned state',
    worktreeGuarded: true,
    failure(script) {
      // Distinct from the one above, and not a second decider wearing a
      // second name: the old hook's defect was that it RAN the updater and
      // then staged. A guard that suppressed only the `git add` would leave
      // this one red while the index looked clean.
      const { stateMd }: HookRun = runWithStateFiles(script, 'worktree');
      return stateMd === ORIGINAL ? null : 'PROJECT-STATE.md was rewritten inside a linked worktree';
    },
  },
  {
    name: 'the primary checkout regenerates and stages',
    worktreeGuarded: false,
    failure(script) {
      // The primary arm, which the always-primary mutant leaves alone. It
      // staying green is what makes the two reds a measurement of the WORKTREE
      // branch rather than of the block as a whole.
      const { staged, stateMd }: HookRun = runWithStateFiles(script, 'primary');
      if (stateMd !== REGENERATED_BY_SCRIPTS) return 'the updater did not run in the primary checkout';
      if (!staged.includes('PROJECT-STATE.md')) return 'PROJECT-STATE.md was not staged';
      if (!staged.includes('project-state.json')) return 'project-state.json was not staged';
      return null;
    },
  },
  {
    name: 'a staged AWS key is still rejected',
    worktreeGuarded: false,
    failure(script) {
      // The positive control. It sits ~60 lines above the mutated line and
      // shares nothing with it, so it goes red only if the mutant stopped
      // being a runnable shell script.
      const repo = mkdtempSync(join(tmpdir(), 'rungate-mutctl-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
        writeFileSync(join(repo, 'leak.txt'), `${AWS_KEY}\n`);
        execFileSync('git', ['add', '-A'], { cwd: repo });
        const sh = join(repo, '.pre-commit.sh');
        writeFileSync(sh, script, { mode: 0o755 });
        try {
          execFileSync('sh', [sh], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          return 'the secret scan let a staged AWS key through';
        } catch (e: any) {
          return e.status === 1 ? null : `the hook exited ${e.status} rather than refusing`;
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  },
];

let script = '';
let mutant = '';

beforeAll(() => {
  // The HARNESS layout, because every observation below runs the fixture's
  // default layout and the updater is baked in at generation time (#610). A
  // hook generated against an empty tree carries the UNMEASURED branch, and
  // the primary-arm observation would then be red in the baseline for a
  // reason that has nothing to do with the worktree guard under test.
  script = hookFor('harness');
  mutant = buildAlwaysPrimaryMutant(script);
});

type Row = { name: string; failed: string | null };

/**
 * Both halves of the battery, run once and memoised.
 *
 * Eight hook executions against eight real git repositories, which is well
 * past what a `beforeAll` is allowed; and running them per-case would run
 * them four times over. The cost is paid by whichever case asks first, and
 * every case below carries its own timeout for that reason.
 */
let BATTERY: { baseline: Row[]; mutated: Row[] } | null = null;
function battery(): { baseline: Row[]; mutated: Row[] } {
  if (!BATTERY) {
    BATTERY = {
      baseline: OBSERVATIONS.map(o => ({ name: o.name, failed: o.failure(script) })),
      mutated: OBSERVATIONS.map(o => ({ name: o.name, failed: o.failure(mutant) })),
    };
  }
  return BATTERY;
}

const BATTERY_TIMEOUT = 180_000;

const redNames = (rows: Row[]) => rows.filter(r => r.failed).map(r => r.name).sort();

describe('#599: the worktree guard is removed and the battery is counted', () => {
  it('the mutant was built, and it differs from the original', () => {
    expect(mutant, 'the mutation was never applied — this would measure the code twice').not.toBe(script);
    expect(mutant).toContain(ALWAYS_PRIMARY);
    expect(mutant, 'the original comparison survived in the mutant').not.toContain(WORKTREE_COMPARISON);
  });

  it('the builder aborts loudly when the comparison moves', () => {
    // A mutation harness that silently no-ops when its target moves is the
    // decorative check this whole battery exists to rule out.
    expect(() => buildAlwaysPrimaryMutant('#!/bin/sh\nexit 0\n')).toThrow(/appears 0 times/);
    expect(() =>
      buildAlwaysPrimaryMutant(`${WORKTREE_COMPARISON}\n${WORKTREE_COMPARISON}\n`),
    ).toThrow(/appears 2 times/);
  });

  it('the baseline: all four observations pass against the real generated hook', () => {
    // Read before any mutation row. An instrument that stopped reporting takes
    // the baseline down too, and a zero beside a broken baseline is not a zero.
    const { baseline } = battery();
    expect(redNames(baseline), 'the fixture itself is failing, so no count below means anything').toEqual([]);
    expect(baseline.length, 'observations went missing').toBe(4);
  }, BATTERY_TIMEOUT);

  it('SC-2041: the always-primary mutant turns exactly the two worktree observations red', () => {
    const red = redNames(battery().mutated);
    expect(red.length, `expected 2 red, got ${red.length}: ${red.join(' | ')}`).toBe(2);
    expect(red).toEqual([
      'a linked worktree regenerates no DA-owned state',
      'a linked worktree stages no DA-owned state',
    ]);
  }, BATTERY_TIMEOUT);

  it('SC-2041: the primary arm and the secret scan stay green under the mutant', () => {
    // Compared by name, because "2 of 4" is satisfied by any two. The primary
    // arm staying green is what makes this a measurement of the worktree
    // branch; the secret scan staying green is what says the mutant still runs.
    const { mutated } = battery();
    const green = mutated.filter(r => !r.failed).map(r => r.name).sort();
    expect(green).toEqual([
      'a staged AWS key is still rejected',
      'the primary checkout regenerates and stages',
    ]);
    for (const o of OBSERVATIONS) {
      const row = mutated.find(r => r.name === o.name)!;
      expect(Boolean(row.failed), `${o.name} disagreed with its guarded classification`).toBe(
        o.worktreeGuarded,
      );
    }
  }, BATTERY_TIMEOUT);

  it('SC-2042: mutant and original differ on a named input', () => {
    // Before believing any count above, the one input on which the two scripts
    // behave differently, run rather than argued: a linked worktree holding
    // project-state.json and an updater. The real hook declines; the mutant
    // regenerates the DA's file and stages it.
    const real = runWithStateFiles(script, 'worktree');
    const broken = runWithStateFiles(mutant, 'worktree');

    expect(real.staged).not.toContain('PROJECT-STATE.md');
    expect(real.stateMd).toBe(ORIGINAL);
    expect(real.err).toContain('project-state: SKIPPED');

    expect(broken.staged, 'the mutant declined too, so nothing was mutated').toContain('PROJECT-STATE.md');
    expect(broken.stateMd).toBe(REGENERATED_BY_SCRIPTS);
    expect(broken.err).not.toContain('project-state: SKIPPED');
  }, BATTERY_TIMEOUT);
});
