import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitHooks } from '../../lib/scaffold/steps';

/**
 * Covers SC-2030, SC-2031 (HARNESS-STANDARD.md) — #599.
 *
 * `test/unit/git-hooks-generator.test.ts` asserts the generated hook declines
 * to write DA-owned state from a linked worktree. This file asserts that those
 * observations CAN GO RED — that they are watching the worktree check rather
 * than watching a hook which happens to stage nothing for some other reason.
 *
 * The defect is REBUILT rather than described: a mutant copy of the generated
 * hook whose `commondir` is assigned from `gitdir`, so the comparison always
 * reports "primary" and the pre-#450 behaviour is back. A three-observation
 * suite is spawned twice over the same argv, differing only in which hook it
 * is pointed at, and the two runs are compared by NAME.
 *
 * Three properties make that a measurement rather than a count:
 *
 *   - **The primary observation is the positive control.** It is the one
 *     observation the mutation cannot change — the mutant and the real hook
 *     agree in the primary checkout, because that is where the two git dirs
 *     are the same answer anyway. "2 of 3 red" is satisfied by any two; only
 *     "these two and not that one" says what this claims. A suite that failed
 *     to load reports 0 of 0, and a count alone cannot tell that from a pass.
 *   - **`ran` is read before any verdict.** Both spawns must report three
 *     cases before either verdict is believed.
 *   - **The mutation is proved to have been applied, on a named input**
 *     (#485): the real hook prints the SKIPPED decline in a linked worktree
 *     and the mutant does not. Without that, a mutant that silently failed to
 *     differ would produce a 0 that reads exactly like a dead check.
 */

/**
 * The one line that makes the worktree check a comparison of two answers.
 *
 * Assigning `commondir` from `gitdir` is the smallest edit that restores the
 * pre-#450 behaviour while leaving every other byte of the hook — including
 * the `if`, the `-n` test, the decline branch and its message — in place. A
 * mutation that deleted the whole block would turn the same cases red while
 * proving much less: the reds could be caused by the missing branch rather
 * than by the comparison it exists to make.
 */
const ANCHOR = 'commondir=$(git rev-parse --git-common-dir)';
const ALWAYS_PRIMARY = 'commondir="$gitdir"';

let DIR = '';
let realHook = '';
let mutantHook = '';
let realText = '';
let mutantText = '';
let suiteFile = '';

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hook-worktree-mutation-'));

  const gen = join(DIR, 'gen');
  mkdirSync(join(gen, '.git', 'hooks'), { recursive: true });
  createGitHooks(gen, []);
  realText = readFileSync(join(gen, '.git', 'hooks', 'pre-commit'), 'utf-8');

  const occurrences = realText.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the worktree-check anchor appears ${occurrences} times ` +
        `in the generated hook, not once. A second copy would survive the mutation and the ` +
        `mutant would behave like the real hook.`,
    );
  }
  mutantText = realText.replace(ANCHOR, ALWAYS_PRIMARY);

  realHook = join(DIR, 'real-pre-commit.sh');
  mutantHook = join(DIR, 'mutant-pre-commit.sh');
  writeFileSync(realHook, realText, { mode: 0o755 });
  writeFileSync(mutantHook, mutantText, { mode: 0o755 });

  suiteFile = join(DIR, 'observations.test.ts');
  writeFileSync(suiteFile, OBSERVATION_SUITE);
});

afterAll(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

/**
 * The spawned suite. Written to a temp directory, so it imports nothing
 * relative — a specifier it could not resolve would make every case red and
 * read exactly like the mutation being caught.
 */
const OBSERVATION_SUITE = `
import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOOK = process.env.HOOK_UNDER_TEST;
if (!HOOK) throw new Error("HOOK_UNDER_TEST is unset — the suite has nothing to observe");
const script = readFileSync(HOOK, "utf-8");

function plantUpdater(root) {
  const abs = join(root, "scripts", "update-project-state.ts");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    abs,
    'import { writeFileSync } from "fs";\\n' +
      'writeFileSync("PROJECT-STATE.md", "# regenerated\\\\n");\\n',
  );
}

function runIn(where) {
  const primary = mkdtempSync(join(tmpdir(), "hookobs-"));
  const linked = primary + "-linked";
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: primary });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "T"], { cwd: primary });
    writeFileSync(join(primary, "seed.txt"), "seed\\n");
    execFileSync("git", ["add", "-A"], { cwd: primary });
    execFileSync("git", ["commit", "-q", "--no-verify", "-m", "seed"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "-q", "-b", "side", linked], { cwd: primary });

    const cwd = where === "primary" ? primary : linked;
    writeFileSync(join(cwd, "project-state.json"), '{"session": 1}\\n');
    writeFileSync(join(cwd, "PROJECT-STATE.md"), "# state\\n");
    plantUpdater(cwd);

    const sh = join(cwd, ".pre-commit.sh");
    writeFileSync(sh, script, { mode: 0o755 });
    spawnSync("sh", [sh], { cwd, encoding: "utf-8" });
    return execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf-8" })
      .split("\\n")
      .filter(Boolean);
  } finally {
    rmSync(linked, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
}

test("a linked worktree stages no project-state.json", () => {
  expect(runIn("worktree")).not.toContain("project-state.json");
});

test("a linked worktree stages no PROJECT-STATE.md", () => {
  expect(runIn("worktree")).not.toContain("PROJECT-STATE.md");
});

test("the primary checkout still stages project-state.json", () => {
  expect(runIn("primary")).toContain("project-state.json");
});
`;

interface SuiteRun {
  pass: number;
  fail: number;
  failed: string[];
}

/** Spawn the observation suite against one hook and read its junit-free report. */
function runSuite(hook: string): SuiteRun {
  const r = spawnSync('bun', ['test', suiteFile], {
    encoding: 'utf-8',
    env: { ...process.env, HOOK_UNDER_TEST: hook },
    cwd: DIR,
    timeout: 240_000,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = Number((/^\s*(\d+) pass/m.exec(text) ?? [])[1] ?? NaN);
  const fail = Number((/^\s*(\d+) fail/m.exec(text) ?? [])[1] ?? NaN);
  const failed = [...text.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(m => m[1].trim());
  if (!Number.isFinite(pass) || !Number.isFinite(fail)) {
    throw new Error(
      `the observation suite reported no counts — the instrument, not the code (#60).\n${text}`,
    );
  }
  return { pass, fail, failed };
}

const WORKTREE_OBSERVATIONS = [
  'a linked worktree stages no project-state.json',
  'a linked worktree stages no PROJECT-STATE.md',
];
const PRIMARY_OBSERVATION = 'the primary checkout still stages project-state.json';

describe('SC-2031: the mutant is proved applied before any count is read', () => {
  test('the always-primary mutant differs from the real hook on a named input', () => {
    // The input: a linked worktree with project-state.json on disk. The real
    // hook declines and says so; the mutant believes it is in the primary
    // checkout and runs the update. Named and run, not assumed (#485).
    const observe = (hookText: string) => {
      const primary = mkdtempSync(join(tmpdir(), 'hookdiverge-'));
      const linked = `${primary}-linked`;
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
        execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: primary });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: primary });
        writeFileSync(join(primary, 'seed.txt'), 'seed\n');
        execFileSync('git', ['add', '-A'], { cwd: primary });
        execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed'], { cwd: primary });
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: primary });
        writeFileSync(join(linked, 'project-state.json'), '{"session": 1}\n');
        writeFileSync(join(linked, 'PROJECT-STATE.md'), '# state\n');
        // The updater has to be resolvable, or the mutant reaches the state
        // branch and reports UNMEASURED — which stages nothing and so looks
        // exactly like the worktree decline it is supposed to have lost.
        mkdirSync(join(linked, 'scripts'), { recursive: true });
        writeFileSync(
          join(linked, 'scripts', 'update-project-state.ts'),
          'import { writeFileSync } from "fs";\nwriteFileSync("PROJECT-STATE.md", "# regenerated\\n");\n',
        );
        const sh = join(linked, '.pre-commit.sh');
        writeFileSync(sh, hookText, { mode: 0o755 });
        const r = spawnSync('sh', [sh], { cwd: linked, encoding: 'utf-8' });
        const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: linked,
          encoding: 'utf-8',
        })
          .split('\n')
          .filter(Boolean);
        return { err: r.stderr ?? '', staged };
      } finally {
        rmSync(linked, { recursive: true, force: true });
        rmSync(primary, { recursive: true, force: true });
      }
    };

    const real = observe(realText);
    const mutant = observe(mutantText);
    expect(real.err, 'the real hook did not decline in a linked worktree').toContain(
      'project-state: SKIPPED',
    );
    expect(mutant.err, 'the mutant declined too — the mutation was not applied').not.toContain(
      'project-state: SKIPPED',
    );
    expect(mutant.staged, 'the mutant did not reach the state branch at all').toContain(
      'PROJECT-STATE.md',
    );
    expect(real.staged, 'the real hook staged DA-owned state from a worktree').not.toContain(
      'PROJECT-STATE.md',
    );
  });

  test('the anchor the mutation edits appears exactly once in the generated hook', () => {
    // A second copy would survive the replacement and the mutant would behave
    // like the real hook — the 0 that reads as a dead check. `beforeAll`
    // already aborts the file on this; asserting it as well means the reason
    // is named rather than appearing as an unexplained suite abort.
    expect(realText.split(ANCHOR).length - 1).toBe(1);
    expect(mutantText, 'the mutant is byte-identical to the real hook').not.toBe(realText);
    expect(mutantText).toContain(ALWAYS_PRIMARY);
  });
});

describe('SC-2030: the worktree observations can go red', () => {
  test('the real hook leaves all three observations green', () => {
    const r = runSuite(realHook);
    expect(r.pass + r.fail, 'the observation suite did not run three cases').toBe(3);
    expect(r.fail, `the real hook failed its own observations:\n${r.failed.join('\n')}`).toBe(0);
  });

  test('the always-primary mutant turns exactly the two worktree observations red', () => {
    const r = runSuite(mutantHook);
    expect(r.pass + r.fail, 'the observation suite did not run three cases').toBe(3);
    expect(
      r.fail,
      `expected the two linked-worktree observations to fail, got:\n${r.failed.join('\n')}`,
    ).toBe(2);
    expect(r.fail, 'fewer than two red — the mutant is not reaching the worktree check').toBeGreaterThanOrEqual(2);
    for (const name of WORKTREE_OBSERVATIONS) {
      expect(r.failed.join('\n'), `${name} stayed green under the mutant`).toContain(name);
    }
  });

  test('the primary observation is the control, and the mutant leaves it green', () => {
    // Compared by NAME. "2 of 3" is satisfied by any two, and the one pairing
    // that would mean the mutation did something other than what it claims is
    // the one where the control moves.
    const r = runSuite(mutantHook);
    expect(r.failed.join('\n'), 'the positive control moved — the mutant is not local').not.toContain(
      PRIMARY_OBSERVATION,
    );
    expect(r.pass, 'nothing passed, so the suite may simply have failed to load').toBe(1);
  });
});
