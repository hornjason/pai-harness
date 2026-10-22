/**
 * The ai-review suites' per-test budget, derived rather than guessed (#1140).
 *
 * ## What was actually wrong
 *
 * Three cases — `AC-12` of #1071 and `AC-1` / `AC-5` of #853 — were reported
 * failing on every clean `main` at 5001–5664ms against bun's 5000ms default.
 * Re-measured here on 2026-10-22 at `72e4d103`, and the reported three
 * reproduce by name. But they are not three defects, and they are not even a
 * fixed three:
 *
 * | reading | what it says |
 * |---|---|
 * | 540 cases across the 31 `ai-review-*` suites, run at `--timeout 180000` | 3 over 5000ms — and **37 more between 2500ms and 5000ms** |
 * | those 40 cases | spread over **6 files**, every one of which spawns real `git` |
 * | one case (`the bound truncates the reading`) across four runs | 5991, 6188, 7348, 7608ms — a **27% spread** |
 * | a fifth run | `hardened: the reviewer's write is REFUSED` crossed 5000ms at 6296ms — a case **not** in the reported three |
 *
 * So the population is ~40 cases clustered in a 2.5–7.5s band against a 5s
 * line, and *which* of them lands above it is decided by the run. Bounding
 * the reported three fixes one sample of that population and leaves the
 * other 37 one busy afternoon away from red. That is the same shape as
 * raising a limit to just above today's worst reading, applied to the
 * question of *which cases* get a limit.
 *
 * ## Where the time goes, measured
 *
 * `checkout()` in `ai-review-restore-index.test.ts` is **11 real `git`
 * subprocesses** and costs a median of 1418ms; the cases then run the real
 * restore/baseline/drift shell steps, each spawning more. Timed on this
 * machine: a bare `git rev-parse` spawn is **60.8ms median** (min 46.0, max
 * 93.5). The cases are spawn-bound, and the fixture's own docstring is why
 * that cost is not reducible — a detached checkout with a real `origin` is
 * "the only shape that can witness this issue".
 *
 * So this is **"the limit is too low"**, not "the case is too slow". The work
 * is necessary; the 5000ms it inherits was never derived from it.
 *
 * ## Why a bigger constant is not the fix
 *
 * `test/helpers/scaffold-budget.ts` is this repo's record of that move
 * failing twice: #454 declared 15_000 after a 5007ms death, and the same case
 * died at **15007.04ms** three days later. A constant encodes one machine's
 * speed on one afternoon.
 *
 * Measured here rather than asserted: three rounds of the six slow files at
 * `--timeout 8000` — the cheapest wrong fix, set just above the 7608ms worst
 * reading — came back **114 pass / 0 fail each time**. So the wrong fix was
 * NOT caught in the act, and that is reported rather than dressed up. What
 * convicts it is the spread: a single case was observed between 5991ms and
 * 7608ms, so a ceiling 5% above the top of a 27%-wide distribution is inside
 * the noise, and the machine these were taken on was already at load 75–134.
 *
 * The budget is therefore a RATIO to a calibration taken on the machine the
 * suite is running on, the shape #478 settled on. **Note honestly what this
 * is and is not evidence for:** per-spawn cost measured 59.0ms at load 126
 * and 60.8ms at load 75, so it did *not* track load average over tonight's
 * range, and the calibration is not justified by that. It is justified by
 * portability — a CI runner is not this laptop — which is the claim #478
 * makes and which is not measurable from here.
 *
 * ## The negative control this file keeps
 *
 * A budget helper that returns the floor no matter what it is handed would
 * satisfy "the cases stop failing" perfectly while measuring nothing. So
 * `scales with the machine` drives `gitFixtureBudget` over injected
 * calibrations rather than the live one, and the `failed calibration` case
 * asserts the branch that stops a budget being derived from a reading that
 * was never taken.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { perTestTimeoutDeclarations } from "../lib/per-test-timeouts";
import {
  BUDGET_FLOOR_MS,
  CALIBRATION_RUNS,
  GIT_FIXTURE_SUITES,
  HEADROOM_MULTIPLE,
  PATHOLOGICAL_CASE_MS,
  SLOWEST_CASE_IN_FIXTURES,
  SLOWEST_CASE_MS,
  calibrateGitFixture,
  gitFixtureBudget,
  gitFixtureTestTimeout,
  type GitFixtureCalibration,
} from "./helpers/git-fixture-budget";

/**
 * This file eats its own cooking, and it had to.
 *
 * The first draft left these cases on the 5000ms default on the grounds that
 * they are arithmetic. They are not: `AC-4` runs a LIVE calibration, which is
 * six `bash`+`git` fixtures, and at load 219 that is ~5.4s. It was observed
 * both ways within two minutes — `1 fail` with `timed out after 5000ms`, then
 * `16 pass` in 8.69s on the immediate re-run. That is this issue's own defect,
 * reproduced in the file written to fix it, which is the second time tonight a
 * budget looked like a safe constant from one reading.
 *
 * The call is at module scope, so the calibration happens outside any case's
 * timeout and `AC-4`'s own call is served from the memo.
 */
setDefaultTimeout(gitFixtureTestTimeout());

const TEST_DIR = import.meta.dir;

/** A calibration that succeeded, for driving the budget over values that are not this machine's. */
const reading = (fixtureMs: number): GitFixtureCalibration => ({
  fixtureMs,
  ok: true,
  note: `injected: ${fixtureMs}ms`,
});

// ── AC-1: the budget tracks the machine, and the floor is a floor ────────

describe("AC-1 (#1140): the budget is derived from a calibration, not written down", () => {
  test("it scales with the machine once the calibration clears the floor", () => {
    // Driven over injected values, not `calibrateGitFixture()` — a helper that
    // ignored its argument and returned the floor would pass a test that fed
    // it this machine's real reading, because on this machine the floor wins.
    const slow = gitFixtureBudget(reading(4_000));
    const slower = gitFixtureBudget(reading(8_000));
    expect(
      slow,
      "a 4000ms fixture does not clear the floor, so the ratio is never exercised",
    ).toBeGreaterThan(BUDGET_FLOOR_MS);
    expect(
      slower,
      "doubling what a fixture costs did not move the budget — the calibration is decorative",
    ).toBeGreaterThan(slow);
    expect(slower / slow, "the budget is not proportional to the calibration").toBeCloseTo(2, 1);
  });

  test("the floor carries a fast machine, so today's behaviour is not tightened", () => {
    expect(
      gitFixtureBudget(reading(1)),
      "a suspiciously fast calibration tightened the budget below what is known to work",
    ).toBe(BUDGET_FLOOR_MS);
  });

  test("a calibration that was not a reading contributes only the floor", () => {
    // #478's `killed` branch, in this file's terms. A git that did not run
    // took as long as the failure took, and multiplying that hands out a
    // budget derived from the failure rather than from git's cost.
    const failed: GitFixtureCalibration = { fixtureMs: 90_000, ok: false, note: "git did not run" };
    expect(
      gitFixtureBudget(failed),
      "a failed calibration was multiplied, so the budget comes from a reading nobody took",
    ).toBe(BUDGET_FLOOR_MS);
  });
});

// ── AC-2: the headroom is stated, and it is over a MEASURED case ─────────

describe("AC-2 (#1140): the bound clears the slowest measured case with stated headroom", () => {
  test("the slowest case, at the calibration that measured it, fits with the headroom to spare", () => {
    // SLOWEST_CASE_IN_FIXTURES is SLOWEST_CASE_MS expressed in fixtures, so
    // the ratio below is the headroom factor and nothing else — it goes red
    // if either number is edited without the other.
    //
    // Driven on a machine 10x slower than the reference, because on the
    // reference machine the FLOOR wins and this case would otherwise be
    // measuring 120_000 while appearing to measure the ratio. That is the
    // #478 arrangement working as intended, and the case below pins it.
    const reference = SLOWEST_CASE_MS / SLOWEST_CASE_IN_FIXTURES;
    const tenTimesSlower = gitFixtureBudget(reading(reference * 10));
    expect(
      tenTimesSlower / (SLOWEST_CASE_MS * 10),
      "the budget no longer stands at the stated multiple of the slowest measured case",
    ).toBeCloseTo(HEADROOM_MULTIPLE, 1);
  });

  test("on the machine the numbers came from, the floor is what applies", () => {
    // Said out loud rather than left implicit: the ratio is for a slower box.
    // If this ever stops being true the floor has been cut, and the sentence
    // in the module comment about the floor carrying this machine is stale.
    const reference = SLOWEST_CASE_MS / SLOWEST_CASE_IN_FIXTURES;
    expect(
      gitFixtureBudget(reading(reference)),
      "the calibration now overtakes the floor on the reference machine",
    ).toBe(BUDGET_FLOOR_MS);
  });

  test("the bound is not bun's default wearing a constant's name", () => {
    expect(
      BUDGET_FLOOR_MS,
      "the floor is at or under the 5000ms default this issue is about, so it bounds nothing",
    ).toBeGreaterThan(5_000);
    expect(
      BUDGET_FLOOR_MS,
      "the floor does not clear the 7608ms worst reading, so the reported cases still red",
    ).toBeGreaterThan(SLOWEST_CASE_MS);
  });

  test("the floor clears the thrashing-machine reading, which is the one that bit", () => {
    // The first draft floored at 30_000 and died at 38582.60ms under load
    // 245. A floor chosen against the ordinary reading alone would be that
    // draft again, so the pathological LOWER BOUND is what this pins — and
    // because it is a lower bound, clearing it by a hair would be the same
    // mistake #1140 is about.
    expect(
      BUDGET_FLOOR_MS,
      "the floor is back under the reading that already killed one draft of this fix",
    ).toBeGreaterThan(PATHOLOGICAL_CASE_MS);
    expect(
      BUDGET_FLOOR_MS / PATHOLOGICAL_CASE_MS,
      "the floor clears a LOWER BOUND by less than 2x, so it is set at the cost again",
    ).toBeGreaterThanOrEqual(2);
  });
});

// ── AC-3: every spawn-bound suite carries the budget, not just the three ──

describe("AC-3 (#1140): the six measured suites declare the budget at file level", () => {
  test("the census is not empty", () => {
    // An empty list satisfies "every file declares it" perfectly.
    expect(
      GIT_FIXTURE_SUITES.length,
      "no suites are under the budget, so every case below is vacuous",
    ).toBeGreaterThanOrEqual(6);
  });

  for (const file of GIT_FIXTURE_SUITES) {
    test(`${file} raises the budget for every case in it`, () => {
      const src = readFileSync(join(TEST_DIR, file), "utf-8");
      const found = perTestTimeoutDeclarations(src);
      expect(found, `${file} did not parse, so this reading is a refusal, not a clean result`).not.toBeNull();
      const fileDefaults = found!.filter(d => d.kind === "file-default");
      expect(
        fileDefaults,
        `${file} has cases measured between 2500ms and 7608ms and inherits the 5000ms default — ` +
          `it is one busy run from the red this issue is about`,
      ).toHaveLength(1);
    });
  }
});

// ── AC-4: the calibration on THIS machine actually took a reading ────────

describe("AC-4 (#1140): the live calibration is a reading, and says so when it is not", () => {
  test("it times the stated number of spawns and reports what it found", () => {
    const cal = calibrateGitFixture();
    expect(CALIBRATION_RUNS, "nothing is timed, so the calibration is a constant").toBeGreaterThan(0);
    expect(cal.note, "the calibration did not say what it measured").not.toBe("");
    if (!cal.ok) {
      // UNMEASURED, not a pass and not a red disguised as one: git failing to
      // run is an instrument failure, and the floor is what the budget falls
      // back to. Named out loud so it cannot be silence.
      console.log(`UNMEASURED: git calibration did not take a reading — ${cal.note}`);
      expect(gitFixtureBudget(cal), "an unmeasured machine did not fall back to the floor").toBe(
        BUDGET_FLOOR_MS,
      );
      return;
    }
    expect(cal.fixtureMs, "a fixture took no time at all, which is not a reading").toBeGreaterThan(0);
    expect(gitFixtureBudget(cal), "the live budget fell under the floor").toBeGreaterThanOrEqual(
      BUDGET_FLOOR_MS,
    );
  });

  test("the reading is taken once per process, not once per suite", () => {
    // All six suites call this at module scope in ONE bun process. Two live
    // calibrations are two maxima over six timings each and would not agree
    // to the millisecond on a loaded box, so exact equality is the evidence
    // that the second call did not re-measure.
    expect(
      gitFixtureTestTimeout(),
      "the budget was re-calibrated, so a full ai-review run pays for six readings of one machine",
    ).toBe(gitFixtureTestTimeout());
  });
});
