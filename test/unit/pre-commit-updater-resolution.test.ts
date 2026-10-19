import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// A namespace import, deliberately. A named import of a binding the module
// does not export is a LINK error in Bun, which takes the whole file down —
// and a file that cannot load reports no failures, which is indistinguishable
// from a file whose cases passed (.claude/rules/checks-must-be-able-to-fail.md).
import * as steps from '../../lib/scaffold/steps';
import {
  ORIGINAL,
  REGENERATED_BY_SCRIPTS,
  REGENERATED_BY_VENDORED,
  hookFor,
  plantLayout,
  runWithStateFiles,
  type HookRun,
  type UpdaterLayout,
} from '../helpers/pre-commit-fixture';

/**
 * Covers SC-2210..SC-2219 (HARNESS-STANDARD.md) — #610.
 *
 * The generated pre-commit hook decided which updater to run by sniffing the
 * working tree at COMMIT time:
 *
 *     if [ -f "scripts/update-project-state.ts" ]; then …
 *     elif [ -f "node_modules/rungate/scripts/update-project-state.ts" ]; then …
 *
 * with a comment saying the order was deliberate because "a checkout that has
 * its own scripts/ copy is the harness". That is an identity inferred from a
 * FILENAME — a detector narrower than what it detects. "This tree holds a
 * file at this path" and "this tree is the rungate harness" are different
 * facts, and nothing in the commit recorded which branch fired, so the two
 * outcomes were indistinguishable afterwards.
 *
 * Every case here is driven by EXECUTING the generated hook against real git
 * repositories. The evidence that an updater ran is the BYTES it wrote, and
 * the two planted copies write different bytes — a fixture whose candidates
 * are interchangeable cannot witness a fix about choosing between them.
 *
 * Nothing in this file reads, writes or installs
 * `/Users/jhorn/Projects/rungate/.git/hooks/pre-commit`. Every hook is
 * generated into a `mkdtemp` root and executed in another one.
 */

/** The dual layouts, on which the sniff and the resolution disagree. */
const CONSUMER_WITH_OWN: UpdaterLayout = 'consumer-with-own';
const HARNESS_WITH_VENDORED: UpdaterLayout = 'harness-with-vendored';

const HARNESS_PATH = 'scripts/update-project-state.ts';
const VENDORED_PATH = 'node_modules/rungate/scripts/update-project-state.ts';

/** Memoised, because each one runs the generator against a fresh tree. */
const HOOKS = new Map<UpdaterLayout, string>();
function hook(layout: UpdaterLayout): string {
  if (!HOOKS.has(layout)) HOOKS.set(layout, hookFor(layout));
  return HOOKS.get(layout)!;
}

// ── SC-2210: one path, baked, and no candidate selection at commit time ──

/**
 * The executable lines of a hook. Comments are excluded on purpose: the hook
 * explains the #599 fail-opens in prose, and that prose NAMES both candidate
 * paths. A whole-document count would be satisfied — or refused — by a
 * sentence, which is `.claude/rules/checks-must-be-able-to-fail.md`'s "search
 * the slice, not the document" with the slice being "the code".
 */
function code(hookText: string): string[] {
  const lines = hookText.split('\n').filter(l => !l.trim().startsWith('#'));
  // A slice that failed to find its own region is empty, and an empty string
  // contains nothing — which is indistinguishable from a clean result.
  expect(lines.length, 'the hook has no executable lines at all').toBeGreaterThan(5);
  return lines;
}

/**
 * Executable lines naming `path` AS A PATH, quoted.
 *
 * The quotes are load-bearing, not tidiness: `scripts/update-project-state.ts`
 * is a SUBSTRING of `node_modules/rungate/scripts/update-project-state.ts`, so
 * an unquoted search for the harness candidate matches the vendored line and
 * reports a candidate list in a hook that has one path in it. A detector
 * narrower than what it detects, inverted.
 */
const namesPath = (hookText: string, path: string) =>
  code(hookText).filter(l => l.includes(`"${path}"`));

describe('#610: the emitted hook names one updater and selects between none', () => {
  it('SC-2210: a consumer hook names the vendored path on exactly one executable line', () => {
    const h = hook('vendored');
    expect(
      namesPath(h, VENDORED_PATH).length,
      'the vendored path is executable on more than one line, so there is more than one ' +
        'thing to change and a mutation of either would leave the other standing',
    ).toBe(1);
    expect(
      namesPath(h, HARNESS_PATH),
      'the harness candidate is still executable in a consumer hook, so a candidate list survived',
    ).toEqual([]);
    expect(h).toContain(`updater="${VENDORED_PATH}"`);

    // The property, worded after the thing that matters rather than after a
    // proxy: no executable line tests for the EXISTENCE of an updater.
    // `[ -f "project-state.json" ]` asks a different question and stays.
    expect(
      code(h).filter(l => l.includes('-f ') && l.includes('update-project-state')),
      'the hook still decides which updater exists at commit time',
    ).toEqual([]);
  });

  it('SC-2210: the harness hook is the same shape with the other path', () => {
    const h = hook('harness');
    expect(namesPath(h, HARNESS_PATH).length, 'the harness path is executable on more than one line')
      .toBe(1);
    expect(namesPath(h, VENDORED_PATH), 'a consumer candidate survived in the harness hook')
      .toEqual([]);
    expect(h).toContain(`updater="${HARNESS_PATH}"`);
    expect(
      code(h).filter(l => l.includes('-f ') && l.includes('update-project-state')),
      'the hook still decides which updater exists at commit time',
    ).toEqual([]);
  });
});

// ── SC-2211: the two forms differ, and each names its own path ───────────

describe('#610: generating into the harness and into a consumer produce different hooks', () => {
  it('SC-2211: both forms are asserted, and they are not the same text', () => {
    const harness = hook('harness');
    const consumer = hook('vendored');
    expect(harness, 'the harness and consumer hooks are byte-identical, so nothing was decided')
      .not.toBe(consumer);
    expect(harness).toContain(`updater="${HARNESS_PATH}"`);
    expect(consumer).toContain(`updater="${VENDORED_PATH}"`);
  });
});

// ── SC-2212 / SC-2213: the two trees the sniff gets wrong ────────────────

describe('#610: identity decides, not a filename', () => {
  it('SC-2212: a consumer carrying its own scripts/ copy still runs the vendored updater', () => {
    // The criterion the issue states in full: the fixture MUST have
    // scripts/update-project-state.ts present, or the case cannot tell the
    // new behaviour from the old.
    const { code, staged, stateMd, err } = runWithStateFiles(hook(CONSUMER_WITH_OWN), 'primary', {
      updater: CONSUMER_WITH_OWN,
    });
    expect(code, 'the hook rejected an ordinary commit').toBe(0);
    expect(
      stateMd,
      "the consumer's own scripts/ copy ran — the hook inferred the harness from a filename",
    ).toBe(REGENERATED_BY_VENDORED);
    expect(stateMd).not.toBe(REGENERATED_BY_SCRIPTS);
    expect(staged).toContain('PROJECT-STATE.md');
    expect(err).not.toContain('UNMEASURED');
  });

  it('SC-2213: a harness checkout carrying a vendored duplicate still runs its own scripts/ copy', () => {
    // The other direction, and it is not symmetry for its own sake: it is the
    // case the CHEAPEST WRONG FIX fails. Flipping the two -f tests so the
    // vendored copy wins makes SC-2212 green and grades the harness against a
    // stale duplicate of its own updater, which is what the original comment
    // was protecting against.
    const { code, stateMd } = runWithStateFiles(hook(HARNESS_WITH_VENDORED), 'primary', {
      updater: HARNESS_WITH_VENDORED,
    });
    expect(code).toBe(0);
    expect(
      stateMd,
      'the harness graded itself with the vendored duplicate of its own updater',
    ).toBe(REGENERATED_BY_SCRIPTS);
  });
});

// ── SC-2214: nothing found at generation time is UNMEASURED, not a guess ─

describe('#610: an unresolvable updater is UNMEASURED and carries no lookup', () => {
  it('SC-2214: the hook reports UNMEASURED, names where it looked, and stages nothing', () => {
    const h = hook('none');
    expect(h, 'a candidate path survived in a hook that resolved nothing')
      .not.toContain(`updater="`);
    expect(h, 'it does not say where it looked').toContain(VENDORED_PATH);

    const { code, staged, stateMd, err } = runWithStateFiles(h, 'primary', { updater: 'none' });
    expect(code, 'an unresolvable updater must not reject the commit').toBe(0);
    expect(stateMd, 'something rewrote the file with no updater present').toBe(ORIGINAL);
    expect(staged, 'a stale PROJECT-STATE.md was staged anyway').not.toContain('PROJECT-STATE.md');
    expect(staged).not.toContain('project-state.json');
    expect(err, 'the hook went silent about doing nothing').toContain('project-state: UNMEASURED');
    expect(err, 'the reading was not attributed to generation time').toContain('generated');
  });

  it('SC-2216: an updater that appears AFTER generation does not change what runs', () => {
    // The whole shape of the defect in one case. The hook is generated for a
    // tree with only the vendored copy, and then executed in a tree that has
    // acquired a scripts/ copy — the rename-the-directory scenario. The old
    // hook silently changes its answer; this one cannot.
    const generatedBefore = hook('vendored');
    const { stateMd } = runWithStateFiles(generatedBefore, 'primary', {
      updater: CONSUMER_WITH_OWN,
    });
    expect(
      stateMd,
      'a file that appeared after the hook was generated changed which program it ran',
    ).toBe(REGENERATED_BY_VENDORED);
  });

  it('SC-2220: a consumer whose ONLY updater is its own gets UNMEASURED, and runs nothing', () => {
    // The precondition every other fixture in this file holds: some copy
    // rungate installed is present. This one is on the other side of it, and
    // a battery whose fixtures all meet a precondition measures nothing past
    // it (.claude/rules/checks-must-be-able-to-fail.md).
    //
    // It is also the only case that fails a repair which resolves at
    // GENERATION time and still decides by filename — "bake whichever of the
    // two candidates exists". That repair satisfies the one-path criterion in
    // full, keeps every dual-copy case green, and runs a consumer's own
    // program here. Found by a mutation row coming back HIGH, and by nothing
    // else: the extra red was a text assertion about which path the message
    // names, standing in for a behaviour nothing drove.
    const h = hook('consumer-own-only');
    expect(h, 'a consumer program was baked in because it happened to be named right')
      .not.toContain(`updater="${HARNESS_PATH}"`);

    const { code, stateMd, staged, err } = runWithStateFiles(h, 'primary', {
      updater: 'consumer-own-only',
    });
    expect(code).toBe(0);
    expect(stateMd, "the consumer's own scripts/ copy was run as if rungate had installed it")
      .toBe(ORIGINAL);
    expect(staged).not.toContain('PROJECT-STATE.md');
    expect(err).toContain('project-state: UNMEASURED');
  });

  it('SC-2214: a hook that resolved nothing cannot be made to resolve something later', () => {
    // The UNMEASURED form carries no lookup, so planting BOTH copies in the
    // run repository must still regenerate nothing. Without this the
    // "performs no lookup" half is a claim about the text and not about the
    // behaviour.
    const { stateMd, err } = runWithStateFiles(hook('none'), 'primary', {
      updater: CONSUMER_WITH_OWN,
    });
    expect(stateMd, 'the UNMEASURED hook found an updater at commit time after all').toBe(ORIGINAL);
    expect(err).toContain('project-state: UNMEASURED');
  });
});

// ── SC-2215: the branch that fired is in the commit's output ─────────────

describe('#610: the hook says which updater it is about to run', () => {
  it('SC-2215: the resolved path is printed to stderr before the updater runs, and never to stdout', () => {
    const run = runWithStateFiles(hook(CONSUMER_WITH_OWN), 'primary', {
      updater: CONSUMER_WITH_OWN,
    });
    expect(
      run.err,
      'nothing in the output records which updater fired, which is the defect this issue is about',
    ).toContain(VENDORED_PATH);
    expect(run.out, 'the resolved path went to stdout, which a caller captures as the answer')
      .not.toContain('project-state');

    // Before, not after: the echo has to precede the invocation, or a hook
    // whose updater hangs or crashes the shell records nothing at all.
    const lines = hook(CONSUMER_WITH_OWN).split('\n');
    const announced = lines.findIndex(l => l.includes('project-state: running'));
    const invoked = lines.findIndex(l => l.includes('bun "$updater"'));
    expect(announced, 'the hook never announces the updater').toBeGreaterThan(-1);
    expect(invoked, 'the hook never invokes the updater').toBeGreaterThan(-1);
    expect(announced, 'the announcement comes after the run it is announcing').toBeLessThan(invoked);
  });
});

// ── SC-2217: the generator writes this script, and not a copy of it ──────

describe('#610: one binding', () => {
  it('SC-2217: createGitHooks writes exactly preCommitHookScript(root)', () => {
    // Every case above drives `createGitHooks`. None of them would notice if
    // the template function were right and the caller were not asking it,
    // which is the zero this repo keeps measuring (#431, #235, #224).
    expect(
      typeof (steps as any).preCommitHookScript,
      'lib/scaffold/steps.ts does not export preCommitHookScript, so the hook body is still ' +
        'a template literal inside the generator and nothing can obtain it without installing it',
    ).toBe('function');

    const root = mkdtempSync(join(tmpdir(), 'precommit-onebinding-'));
    try {
      plantLayout(root, 'vendored');
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      steps.createGitHooks(root, []);
      expect(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
        (steps as any).preCommitHookScript(root),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SC-2217: resolving the updater does not write anything into the tree it reads', () => {
    // The currency check has to obtain the hook for a project it is only
    // INSPECTING. A generator that could answer only by installing itself
    // would make the check the thing it is checking — and on this machine the
    // shared .git/hooks/pre-commit is run by every worktree at once.
    const root = mkdtempSync(join(tmpdir(), 'precommit-readonly-'));
    try {
      plantLayout(root, 'vendored');
      const before = execFileSync('find', [root, '-type', 'f'], { encoding: 'utf-8' });
      (steps as any).preCommitHookScript?.(root);
      const after = execFileSync('find', [root, '-type', 'f'], { encoding: 'utf-8' });
      expect(after, 'generating the hook text changed the tree it was asked about').toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── SC-2218 / SC-2219: the mutation battery ──────────────────────────────

/**
 * The one line the choice is baked on, and the single site this battery
 * mutates. The anchor is computed from the layout rather than written twice,
 * so a hook whose assignment moves aborts the builder instead of quietly
 * producing a copy of the original.
 */
type Transform = (hook: string) => string;

const RUNTIME_SNIFF_SCRIPTS_FIRST = [
  'updater=""',
  `    if [ -f "${HARNESS_PATH}" ]; then`,
  `      updater="${HARNESS_PATH}"`,
  `    elif [ -f "${VENDORED_PATH}" ]; then`,
  `      updater="${VENDORED_PATH}"`,
  '    fi',
].join('\n');

const RUNTIME_SNIFF_VENDORED_FIRST = [
  'updater=""',
  `    if [ -f "${VENDORED_PATH}" ]; then`,
  `      updater="${VENDORED_PATH}"`,
  `    elif [ -f "${HARNESS_PATH}" ]; then`,
  `      updater="${HARNESS_PATH}"`,
  '    fi',
].join('\n');

export function restoreRuntimeSniff(source: string, replacement: string): string {
  const assignments = source.match(/updater="[^"]*"/g) || [];
  if (assignments.length !== 1) {
    throw new Error(
      `could not build the mutant: the baked updater assignment appears ${assignments.length} ` +
        `times. At 0 the hook resolves nothing and the mutant would be a copy of the original; ` +
        `above 1 the surviving copy would hold every case up and the reds would mean nothing.`,
    );
  }
  return source.replace(assignments[0], replacement);
}

interface Observation {
  name: string;
  layout: UpdaterLayout;
  failure(hookText: string, layout: UpdaterLayout): string | null;
}

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

const OBSERVATIONS: Observation[] = [
  {
    name: 'a consumer with its own scripts copy runs the vendored updater',
    layout: CONSUMER_WITH_OWN,
    failure(hookText, layout) {
      const { stateMd }: HookRun = runWithStateFiles(hookText, 'primary', { updater: layout });
      return stateMd === REGENERATED_BY_VENDORED
        ? null
        : `the consumer ran ${stateMd === REGENERATED_BY_SCRIPTS ? 'its own scripts/ copy' : 'nothing'}`;
    },
  },
  {
    name: 'a harness with a vendored duplicate runs its own scripts copy',
    layout: HARNESS_WITH_VENDORED,
    failure(hookText, layout) {
      const { stateMd }: HookRun = runWithStateFiles(hookText, 'primary', { updater: layout });
      return stateMd === REGENERATED_BY_SCRIPTS
        ? null
        : `the harness ran ${stateMd === REGENERATED_BY_VENDORED ? 'the vendored duplicate' : 'nothing'}`;
    },
  },
  {
    name: 'a plain consumer runs the vendored updater',
    layout: 'vendored',
    failure(hookText, layout) {
      // A control. The sniff and the resolution agree here, so it stays green
      // under both mutants — which is what says a red above is about the
      // dual-copy tree and not about the block as a whole.
      const { stateMd }: HookRun = runWithStateFiles(hookText, 'primary', { updater: layout });
      return stateMd === REGENERATED_BY_VENDORED ? null : 'the plain consumer did not regenerate';
    },
  },
  {
    name: 'a plain harness runs its scripts copy',
    layout: 'harness',
    failure(hookText, layout) {
      const { stateMd }: HookRun = runWithStateFiles(hookText, 'primary', { updater: layout });
      return stateMd === REGENERATED_BY_SCRIPTS ? null : 'the plain harness did not regenerate';
    },
  },
  {
    name: 'a staged AWS key is still rejected',
    layout: 'vendored',
    failure(hookText) {
      // The positive control. It sits ~80 lines above the mutated line and
      // shares nothing with it, so it goes red only if the mutant stopped
      // being a runnable shell script — and a count alone cannot tell a dead
      // mutant from a thorough one.
      const repo = mkdtempSync(join(tmpdir(), 'rungate-610ctl-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
        writeFileSync(join(repo, 'leak.txt'), `${AWS_KEY}\n`);
        execFileSync('git', ['add', '-A'], { cwd: repo });
        const sh = join(repo, '.pre-commit.sh');
        writeFileSync(sh, hookText, { mode: 0o755 });
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

type Row = { name: string; failed: string | null };

const BATTERY = new Map<string, Row[]>();
function battery(label: string, t: Transform): Row[] {
  if (!BATTERY.has(label)) {
    BATTERY.set(
      label,
      OBSERVATIONS.map(o => ({ name: o.name, failed: o.failure(t(hook(o.layout)), o.layout) })),
    );
  }
  return BATTERY.get(label)!;
}

const IDENTITY: Transform = h => h;
const SNIFF_SCRIPTS_FIRST: Transform = h => restoreRuntimeSniff(h, RUNTIME_SNIFF_SCRIPTS_FIRST);
const SNIFF_VENDORED_FIRST: Transform = h => restoreRuntimeSniff(h, RUNTIME_SNIFF_VENDORED_FIRST);

const redNames = (rows: Row[]) => rows.filter(r => r.failed).map(r => r.name).sort();
const TIMEOUT = 300_000;

describe('#610: the runtime sniff is restored and the battery is counted', () => {
  it('SC-2219: the builder aborts loudly when the baked assignment moves', () => {
    // A mutation harness that silently no-ops when its target moves is the
    // decorative check this whole battery exists to rule out.
    expect(() => restoreRuntimeSniff('#!/bin/sh\nexit 0\n', 'x')).toThrow(/appears 0 times/);
    expect(() => restoreRuntimeSniff('updater="a"\nupdater="b"\n', 'x')).toThrow(/appears 2 times/);
  });

  it('SC-2219: the mutant was built, and it differs from the original', () => {
    const real = hook(CONSUMER_WITH_OWN);
    const mutated = SNIFF_SCRIPTS_FIRST(real);
    expect(mutated, 'the mutation was never applied — this would measure the code twice')
      .not.toBe(real);
    expect(mutated).toContain(`if [ -f "${HARNESS_PATH}" ]; then`);
  });

  it('SC-2219: the baseline — all five observations pass against the real generated hooks', () => {
    // Read before any mutation row. An instrument that stopped reporting takes
    // the baseline down too, and a zero beside a broken baseline is not a zero.
    const base = battery('baseline', IDENTITY);
    expect(redNames(base), 'the fixture itself is failing, so no count below means anything')
      .toEqual([]);
    expect(base.length, 'observations went missing').toBe(5);
  }, TIMEOUT);

  it('SC-2218: restoring the runtime sniff turns exactly the consumer-with-own case red', () => {
    const red = redNames(battery('sniff-scripts-first', SNIFF_SCRIPTS_FIRST));
    expect(red, `expected 1 red, got ${red.length}: ${red.join(' | ')}`).toEqual([
      'a consumer with its own scripts copy runs the vendored updater',
    ]);
  }, TIMEOUT);

  it('SC-2218: the cheapest wrong fix — flipping the sniff order — turns the harness case red', () => {
    // .claude/rules/checks-must-be-able-to-fail.md, fifth shape, applied in
    // advance rather than discovered afterwards. The 5pm repair for the
    // reported symptom is to move the vendored branch above the scripts one:
    // one line, the consumer stops running the wrong program, and the harness
    // starts grading itself against a stale duplicate of its own updater.
    //
    // SC-2212 does NOT survive that repair — it goes green under it. SC-2213
    // is what survives, and it is here for that reason and no other.
    const red = redNames(battery('sniff-vendored-first', SNIFF_VENDORED_FIRST));
    expect(red, `expected 1 red, got ${red.length}: ${red.join(' | ')}`).toEqual([
      'a harness with a vendored duplicate runs its own scripts copy',
    ]);
  }, TIMEOUT);

  it('SC-2218: the two mutants red DIFFERENT rows, and the three controls stay green', () => {
    // "1 red" is satisfied by any one of the five. Named, because a count that
    // does not say which case it was is not a measurement of anything.
    const a = redNames(battery('sniff-scripts-first', SNIFF_SCRIPTS_FIRST));
    const b = redNames(battery('sniff-vendored-first', SNIFF_VENDORED_FIRST));
    expect(a, 'the two mutants are indistinguishable, so neither is isolating anything')
      .not.toEqual(b);
    for (const rows of [battery('sniff-scripts-first', SNIFF_SCRIPTS_FIRST), battery('sniff-vendored-first', SNIFF_VENDORED_FIRST)]) {
      const green = rows.filter(r => !r.failed).map(r => r.name).sort();
      expect(green).toContain('a plain consumer runs the vendored updater');
      expect(green).toContain('a plain harness runs its scripts copy');
      expect(green, 'the mutant stopped being a runnable shell script')
        .toContain('a staged AWS key is still rejected');
    }
  }, TIMEOUT);
});

// ── The live tree, read-only ─────────────────────────────────────────────

describe('#610: this repository resolves to its own updater', () => {
  it('SC-2211: the hook this checkout would get names scripts/update-project-state.ts', () => {
    // A real control on the identity reading, over a tree nobody planted. It
    // READS the repository and writes nothing — in particular it does not go
    // near .git/hooks/pre-commit, which is shared by every worktree on this
    // machine.
    const repoRoot = join(import.meta.dir, '..', '..');
    const fn = (steps as any).preCommitHookScript;
    if (typeof fn !== 'function') {
      throw new Error('preCommitHookScript is not exported, so the live reading cannot be taken');
    }
    const h: string = fn(repoRoot);
    expect(h, 'the harness would be graded by a vendored duplicate of its own updater')
      .toContain(`updater="${HARNESS_PATH}"`);
    expect(h).not.toContain(VENDORED_PATH);
  });
});
