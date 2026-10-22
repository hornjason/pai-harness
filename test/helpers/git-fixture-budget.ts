/**
 * A per-test budget for the `ai-review-*` suites that tracks the machine (#1140).
 *
 * Six of the 31 `ai-review-*` suites build their fixtures out of real `git`
 * subprocesses and then run the real restore/baseline/drift shell steps
 * against them. Measured on 2026-10-22 at `72e4d103`, across 540 cases run at
 * `--timeout 180000`: 3 cases over bun's 5000ms default, and **37 more
 * between 2500ms and 5000ms**. The three that were reported are one sample of
 * that population, not a fixed set — a later run put a fourth case
 * (`hardened: the reviewer's write is REFUSED`, 6296ms) over the line and one
 * of the reported three under it.
 *
 * The cost is subprocess-bound and the work is not reducible: `checkout()` in
 * `ai-review-restore-index.test.ts` is 11 `git` spawns for a median 1418ms,
 * and its own docstring records that a detached checkout with a real `origin`
 * is "the only shape that can witness this issue". So this is **"the limit is
 * too low"**, not "the case is too slow".
 *
 * ## Why this is a ratio and not a number
 *
 * `./scaffold-budget.ts` is the precedent, and it exists because the constant
 * was tried twice and did not converge: #454 declared `15_000` after a 5007ms
 * death, and the same case by name died at **15007.04ms** three days later.
 *
 * ## The reading that set the floor, and what it cost to get
 *
 * The first draft of this file calibrated on a bare `git rev-parse` spawn and
 * floored at 30_000. It was measured, and it **failed**: on a three-round
 * verification run the machine went to a load average of 245 (six agents
 * running suites at once) and `AC-5 … SC-4` died at **38582.60ms** against
 * the 38574ms that calibration had just handed it. Kept here because of what
 * the pair of numbers says:
 *
 * | between load ~126 and load ~245 | grew by |
 * |---|---|
 * | a bare `git rev-parse` spawn (60.8 → 86.0ms) | **1.41x** |
 * | an `init`+`add`+`commit` fixture (373 → 571ms) | **1.53x** |
 * | the case the budget had to cover (6200 → ≥38582ms) | **≥6.2x** |
 *
 * **The first explanation offered for that gap was wrong, and the probe that
 * killed it is worth keeping.** The claim was that a case is a sum over ~30
 * subprocesses and rides the *tail* of the spawn distribution while a median
 * calibration measures the *body*. Measured at load 121 over **300** bare
 * `git` spawns — the earlier samples were N=5..12, too few to see a tail at
 * all:
 *
 * | statistic | value | ratio to median |
 * |---|---|---|
 * | median | 32.1ms | — |
 * | p95 | 40.0ms | 1.24x |
 * | p99 | 52.6ms | 1.64x |
 * | max | 63.0ms | 1.96x |
 * | mean | 32.4ms | **1.01x** |
 *
 * A mean sitting on the median is not a heavy tail, and ten 30-spawn blocks
 * summed varied by **1.09x** max-to-median — summing concentrates, exactly as
 * it should. So the tail story is falsified: it cannot produce 6.2x.
 *
 * What survives is simpler. `rev-parse --git-dir` against an empty directory
 * does essentially **no disk work** — it measures process creation and a
 * stat. The cases do object writes, index writes, an fsync-ing `commit` and a
 * `push` over `file://`, so they are I/O- and memory-pressure-bound where the
 * probe is not. The two do not move together because they are not measuring
 * the same resource.
 *
 * That makes the calibration below MORE justified rather than less, and it is
 * why the shape of the calibration matters more than its statistic:
 *
 *  - The calibration is the **bash-nested** fixture, not a bare spawn: the
 *    cases run `bun → bash → git`, and #478's own docstring is explicit that
 *    "a calibration that skipped it would time something the cases do not
 *    do". Measured at load 219: median 897ms, max 1271ms.
 *  - It takes the **max** of its samples rather than the median. Note what
 *    this is and is not worth now: with the tail story gone, the max of six
 *    buys little over the median (1.96x max-to-median over 300 samples, and
 *    far less over six). It is kept because it errs toward a larger budget,
 *    not because it is tracking something the median misses. The **floor** is
 *    what covers the gap, and that is the honest division of labour.
 *
 * ## The floor is what carries this machine
 *
 * `BUDGET_FLOOR_MS` is 120_000, and it is the number doing the work —
 * exactly as in #478, where "the floor still wins and today's behaviour is
 * unchanged … the mechanism changes; the number does not". It is not a guess:
 *
 *  - It is `GATE_TEST_TIMEOUT_MS` from `lib/gate-timeouts.ts`, this repo's
 *    existing answer to "a case that spawns real heavy subprocesses".
 *  - It is **~3x the 38582ms pathological reading** above, which is the only
 *    reading taken on a machine in the state this issue actually bites in.
 *  - It is **~16x the 7608ms worst reading** on an ordinarily busy machine.
 *
 * The calibration therefore only overtakes the floor on a box materially
 * slower than this one — a CI runner, which is the portability case #478
 * makes and which is not measurable from here.
 *
 * ## A budget is not a licence
 *
 * Raising a ceiling cannot make a check unable to fail: every assertion in
 * the six suites is unchanged, and a case that hangs still dies, just at the
 * budget instead of at 5000ms. The cost of the floor is that a genuine hang
 * in these six files takes two minutes to report instead of five seconds.
 * That is the trade `lib/gate-timeouts.ts` already made for the same reason.
 * What it buys is that a red in these files means the code is wrong, which
 * for the last three rebases in this area it did not.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** How many fixture calibrations are timed. The max of these is the reading. */
export const CALIBRATION_RUNS = 6;

/** The slowest case measured for #1140 on an ordinarily busy machine. */
export const SLOWEST_CASE_MS = 7_608;

/**
 * The same class of case on a thrashing one — load average 245, six agents
 * running suites at once.
 *
 * A LOWER BOUND, not a reading: the case was killed at this number, so its
 * true cost is at least this and nobody knows by how much. That is exactly
 * why it is the floor's reference point and not its value.
 */
export const PATHOLOGICAL_CASE_MS = 38_583;

/**
 * What the calibration fixture cost on the machine that produced
 * `SLOWEST_CASE_MS`, in milliseconds.
 *
 * Derived rather than timed directly, and said so: the per-operation profile
 * at that load measured `init` 145ms, `add` 95ms, `commit` 133ms, plus ~60ms
 * for the `bash` level and ~75ms for the trailing `status`.
 */
export const CALIBRATION_AT_SLOWEST_MS = 508;

/**
 * The slowest case expressed in calibration fixtures — `SLOWEST_CASE_MS` over
 * `CALIBRATION_AT_SLOWEST_MS`, rounded. The unit the cost is denominated in,
 * so a slower runner inflates it automatically rather than by anyone's
 * arithmetic.
 */
export const SLOWEST_CASE_IN_FIXTURES = 15;

/** Headroom over the slowest measured case. See the module comment. */
export const HEADROOM_MULTIPLE = 4;

/** The lowest the calibrated budget may fall. See "The floor is what carries this machine". */
export const BUDGET_FLOOR_MS = 120_000;

/**
 * The `ai-review-*` suites whose cases are built on real `git` subprocesses.
 *
 * Six of the seven carry a case above 2500ms — half the budget this issue is
 * about — in the 540-case reading of 2026-10-22.
 *
 * **`ai-review-workflow.test.ts` is the seventh and it is here on different
 * evidence, which is worth stating because the two kinds are not equally
 * strong.** Its intrinsic cost is an order of magnitude below the other six:
 * measured at load 207, the whole file runs in 10.12s, 62 pass, and its
 * slowest case is **1160ms**. It was nonetheless reported failing at
 * **15.1s and 15.6s**, and the file is byte-identical to the one that was
 * measured — three commits separate that reading from this one and none
 * touches this file or `lib/scaffold/ai-review-step.ts`.
 *
 * I could not reproduce it: **14 runs, 0 failures** (10 consecutive standalone
 * at load ~80, one standalone at load 207, three in company at loads
 * 213/207/141). So it is included on a reading I did not take, and the reason
 * that is not credulity is the inflation factor measured elsewhere in this
 * file — 6.2x between an ordinary load and a thrashing one. A 1160ms case
 * needs ~4.3x to cross 5000ms, which is *inside* the range this machine has
 * been measured to produce. A low intrinsic cost is a later crossing, not an
 * exemption.
 *
 * So the criterion is NOT "measured above 2500ms" — that is a property of the
 * load the sample was taken at. It is "the fixtures spawn real subprocesses,
 * so the case inflates superlinearly under contention". The census in
 * `ai-review-fixture-budget.test.ts` holds the list to its claim in the
 * membership direction only; see the follow-up filed against the growth
 * direction.
 */
export const GIT_FIXTURE_SUITES = [
  "ai-review-ignored-reading.test.ts",
  "ai-review-moving-base.test.ts",
  "ai-review-restore-index.test.ts",
  "ai-review-restore-isolation.test.ts",
  "ai-review-security-repairs.test.ts",
  "ai-review-untrusted-restore.test.ts",
  "ai-review-workflow.test.ts",
] as const;

export interface GitFixtureCalibration {
  /** The SLOWEST of `CALIBRATION_RUNS` fixtures on this machine, in milliseconds. */
  fixtureMs: number;
  /**
   * Every calibration fixture ran to completion.
   *
   * When one did not, the timing is not a reading of what the fixture costs —
   * it is a reading of how long failing took — so it contributes nothing but
   * the floor. This is `scaffold-budget.ts`'s `killed` branch in this file's
   * terms, and without it the budget is derived from the failure.
   */
  ok: boolean;
  /** Said out loud, so a floor that applied because git broke is not silence. */
  note: string;
}

/**
 * The shape the cases actually run: `bun` spawns `bash`, `bash` runs `git`.
 *
 * Kept to one commit and one status so the calibration stays cheap — it runs
 * at module scope, outside any case's timeout, where a stall has no case to
 * blame it on.
 */
const CALIBRATION_SCRIPT = `set -e
git init -q -b main "$1"
cd "$1"
printf 'calibration\\n' > a.txt
git add -A
git commit -qm c
git status --porcelain >/dev/null
`;

/** Time `CALIBRATION_RUNS` miniature git fixtures on this machine. */
export function calibrateGitFixture(): GitFixtureCalibration {
  const dir = mkdtempSync(join(tmpdir(), "git-fixture-calibration-"));
  try {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const script = join(dir, "calibrate.sh");
    writeFileSync(script, CALIBRATION_SCRIPT);
    let slowest = 0;
    let ok = true;
    for (let i = 0; i < CALIBRATION_RUNS; i++) {
      const started = performance.now();
      const r = Bun.spawnSync(["bash", script, join(dir, `r${i}`)], { env });
      slowest = Math.max(slowest, performance.now() - started);
      if (r.exitCode !== 0) ok = false;
    }
    return {
      fixtureMs: slowest,
      ok,
      note: ok
        ? `the slowest of ${CALIBRATION_RUNS} git fixtures took ${slowest.toFixed(0)}ms on this machine`
        : `a calibration fixture did not run to completion — the floor applies`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The per-case budget: the slowest measured case, re-priced at this machine's
 * fixture cost, times the stated headroom — never below the floor.
 */
export function gitFixtureBudget(cal: GitFixtureCalibration): number {
  if (!cal.ok) return BUDGET_FLOOR_MS;
  return Math.max(
    BUDGET_FLOOR_MS,
    Math.round(cal.fixtureMs * SLOWEST_CASE_IN_FIXTURES * HEADROOM_MULTIPLE),
  );
}

/**
 * The budget for this machine, calibrated once per process.
 *
 * Memoised, and not as a micro-optimisation: all six suites call this at
 * module scope, and bun runs them in ONE process, so an uncached version
 * calibrates six times. Measured at load 219, where one calibration is six
 * fixtures at ~0.9s: that is ~32s of pure overhead added to every full
 * `ai-review-*` run, CI included, to re-measure a machine that has not
 * changed. One reading per process, shared.
 */
let memoised: number | null = null;

export function gitFixtureTestTimeout(): number {
  if (memoised === null) memoised = gitFixtureBudget(calibrateGitFixture());
  return memoised;
}
