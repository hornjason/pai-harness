/**
 * Covers SC-1971..SC-1975 (SCAFFOLD-DECOMPOSITION-SPEC.md), #478.
 *
 * `test/unit/scaffold-project.test.ts` spawns a real scaffold in 32 places.
 * One of them died at 5007ms in 2026-10-13; the fix declared a 15_000ms
 * budget and asserted that the test ceiling exceeds it. On 2026-10-16 the
 * SAME case, by name, died at 15007.04ms, while a re-run of the same tree
 * reported 0 fail and the file passed 39/39 in isolation.
 *
 * Two things are wrong with raising it again, and only the first is obvious.
 *
 * **A bigger constant is the move that did not converge** — #445 and #407 are
 * both in this repo's history for exactly it. A constant encodes one
 * machine's speed on one afternoon, and the runner's speed is the variable.
 * So the budget is now a ratio to a calibration run taken on the machine the
 * suite is on: a loaded runner moves both numbers together.
 *
 * **And an over-budget run is not a failing one.** The code was never
 * observed to behave incorrectly; the measurement did not happen. `0`,
 * `SKIP`, `FAIL` and silence are indistinguishable from each other while
 * `UNMEASURED` is not, which is `.claude/rules/config-access.md`'s Silent
 * Default Substitution.
 *
 * The budget is injectable, so both arms below run on an idle machine. A
 * timeout path with no positive control is the zero this repo keeps
 * measuring, and the positive control here is two-sided: a run that finishes
 * is not unmeasured, and a run that FAILS on the merits is not unmeasured
 * either — several cases in that file pass `expectFail` and must keep
 * reaching their assertions.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  BUDGET_FLOOR_MS,
  BUDGET_MULTIPLE,
  calibrateScaffold,
  isScaffoldUnmeasured,
  runScaffoldProcess,
  ScaffoldCensus,
  ScaffoldUnmeasured,
  scaffoldBudget,
  scaffoldTestTimeout,
  type ScaffoldReading,
} from "./helpers/scaffold-budget";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scaffold-project.ts");

/** The smallest tree the scaffold will act on. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-478-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "budget-fixture", dependencies: {} }));
  return dir;
}

describe("#478: an over-budget scaffold is unmeasured, not wrong", () => {
  test("SC-1971: a run killed by its budget is reported as unmeasured, with both numbers", () => {
    // 1ms is not a plausible budget and that is the point: the starved path
    // is reachable on an idle machine, so this case needs no contention to
    // reproduce the condition that only appears under contention.
    const dir = fixture();
    try {
      const r = runScaffoldProcess({ script: SCRIPT, projectPath: dir, args: ["--fix"], budgetMs: 1 });

      expect(r.timedOut, "a run the budget killed was not reported as timed out").toBe(true);
      expect(r.exitCode, "a killed run reported an exit status it never set").toBeNull();
      expect(r.signal).not.toBeNull();

      const err = new ScaffoldUnmeasured(r);
      expect(isScaffoldUnmeasured(err)).toBe(true);
      // Both numbers, because "it timed out" sends a reader to the machine
      // and "it ran 1ms against a 1ms budget" sends them to the budget.
      expect(err.message).toContain("UNMEASURED");
      expect(err.message).toContain("1ms budget");
      expect(err.message, "the notice does not say the code went unobserved").toContain("NOT observed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1972: a run that finishes, and a run that fails on its merits, are both measured", () => {
    // The two-sided positive control. A reading that called every
    // non-success a timeout would satisfy the case above and silently
    // convert every real scaffold failure in the unit file into an
    // UNMEASURED that passes — the fail-open this whole change could most
    // easily have introduced.
    const dir = fixture();
    try {
      const ok = runScaffoldProcess({ script: SCRIPT, projectPath: dir, args: ["--fix"], budgetMs: 120_000 });
      expect(ok.timedOut, "a run that finished was called a timeout").toBe(false);
      expect(ok.exitCode, "the exit status the scaffold set was lost").toBe(0);
      expect(ok.output.length, "the scaffold's own words were discarded").toBeGreaterThan(0);

      const missing = runScaffoldProcess({
        script: SCRIPT,
        projectPath: join(dir, "no-such-directory"),
        budgetMs: 120_000,
      });
      expect(missing.timedOut, "a scaffold that refused on the merits was called a timeout").toBe(false);
      expect(missing.exitCode, "a refusing scaffold exited 0").not.toBe(0);
      expect(missing.output).toContain("ERROR: Path does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1973: the budget tracks the calibration, and never falls below the floor", () => {
    // The mechanism, asserted as a function of its input rather than by
    // reading the constant back. A `scaffoldBudget` that ignored its
    // argument and returned the floor would be the old behaviour wearing the
    // new mechanism's name, and nothing but a second calibration can see it.
    const slow = scaffoldBudget({ elapsedMs: 9_000, ok: true, note: "slow runner" });
    const quick = scaffoldBudget({ elapsedMs: 100, ok: true, note: "warm cache" });

    expect(slow, "a slower machine did not get a larger budget").toBe(9_000 * BUDGET_MULTIPLE);
    expect(slow, "the budget does not move with the calibration").toBeGreaterThan(quick);
    expect(quick, "a suspiciously fast calibration tightened the budget below what is known to work")
      .toBe(BUDGET_FLOOR_MS);

    // The floor is the number #454 already set. Raising it is the move this
    // issue exists to refuse, so it is pinned rather than described.
    expect(BUDGET_FLOOR_MS, "the floor was raised, which is the fix #478 rejects").toBe(15_000);
    expect(scaffoldTestTimeout(slow), "a test may be killed before the scaffold it is waiting for")
      .toBeGreaterThan(slow);
  });

  test("SC-1974: the calibration measures a real scaffold, including its nested generator", () => {
    // 73% of a scaffold is a second cold bun start generating CODE-MAP.md, so
    // a calibration that skipped `--fix` would time something no case does
    // and hand back a budget too tight for all of them.
    const cal = calibrateScaffold(SCRIPT);

    expect(cal.elapsedMs, "the calibration was never timed").toBeGreaterThan(0);
    expect(cal.ok, `the calibration scaffold did not succeed: ${cal.note}`).toBe(true);
    expect(cal.note, "the calibration does not say what it measured").toMatch(/\d+ms/);
    // Not a unit test of the clock: a scaffold with a nested bun start cannot
    // finish in single-digit milliseconds, and a calibration that did is
    // measuring something other than a scaffold.
    expect(cal.elapsedMs, "the calibration is too fast to have run a scaffold").toBeGreaterThan(100);
  }, 180_000);

  test("SC-1975: the census counts both outcomes and names the unmeasured ones", () => {
    // UNMEASURED without a count is silence, and silence reads as success.
    // The consuming file refuses when `measured` is zero, so the census has
    // to be able to report a zero — and to report a non-zero beside it.
    const census = new ScaffoldCensus();
    const starved: ScaffoldReading = {
      output: "",
      elapsedMs: 15_031,
      budgetMs: 15_000,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    };

    census.recordMeasured();
    census.recordMeasured();
    census.recordUnmeasured("reports what it created and what it skipped", starved);

    expect(census.measured).toBe(2);
    expect(census.total, "an unmeasured case fell out of the denominator").toBe(3);

    const summary = census.summary(15_000, { elapsedMs: 1_400, ok: true, note: "one scaffold took 1400ms" });
    expect(summary).toContain("measured 2 of 3 cases");
    // By name, not by count. A reader cannot act on "1 case was unmeasured".
    expect(summary, "the unmeasured case is counted but not named")
      .toContain("reports what it created and what it skipped");
    expect(summary).toContain("15031ms");
    expect(summary, "the notice does not say the code went unobserved").toContain("not observed to be wrong");
  });
});
