/**
 * #804 — how close the suite runs to the budget, read from reports that exist.
 *
 * `lib/junit-checks.ts` has held the two readings this needs since #621:
 * `timeoutProximityViolations` names every case the budget killed and every
 * case that finished inside the band below it, and `durationCoverageViolations`
 * answers the prior question of whether the reading read anything. Both are
 * correct. Neither has ever run against this repository's suite.
 *
 * Measured 2026-10-20 on `1222742b`: `SUITE_JUNIT_REPORT`, the environment
 * variable `test/test-timeout-population.test.ts` takes its live population
 * from, appears five times in the tree and all five are inside that file —
 * four are the function that reads it, and the fifth is the env of the mutant
 * spawn in its own battery. No workflow sets it; `.github/workflows/ci.yml`
 * ran `bun test --shard=N/4` with no reporter, so the report was never
 * written. Both live cases printed
 *
 *     [#621] UNMEASURED proximity: no suite JUnit report was provided …
 *
 * on every run, including every CI run, and passed. That is why #804 and #805
 * both arrived as a red `main` rather than as a warning: the instrument that
 * exists to say "this case is at 97% of its budget" had no input.
 *
 * ## Why this is a binding and not a second ratchet
 *
 * #804 proposes building a ratchet. Building one would be the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — two deciders answering one
 * question about one input are behaviourally ONE decider, and no behavioural
 * test can tell them apart. So this composes the two existing readings and
 * adds no comparison of its own. What is new here is a population to read.
 *
 * A `bun test` run cannot read its own JUnit report: the file is written when
 * the run ends. So the reading cannot live inside the suite it measures, and
 * this is called afterwards, over the report `bunfig.toml` now declares.
 *
 * ## The band, and why it is not 1%
 *
 * `test/test-timeout-population.test.ts` uses `WITHIN = 0.01`, which is right
 * for what that file claims — "within one percent of the timeout" is #621's
 * AC-3b, stated in those words. It is not a useful warning: against a 5000ms
 * budget it fires at 4950ms, which is 50ms of notice. #804 asks for red
 * "before the suite is", so `DEFAULT_WITHIN` is 0.2 — a case at 80% of its
 * budget is reported, and the scan this issue was filed about would have been
 * named at 3482ms rather than killed at 5005ms.
 *
 * Both numbers are declared, neither is derived from the other, and they
 * answer different questions. That is not the duplication the paragraph above
 * refuses: there is still exactly one implementation of the comparison.
 */
import {
  bunfigTestTimeoutMs,
  durationCoverageViolations,
  readJunitDurations,
  timeoutProximityViolations,
  type JunitDurationReading,
} from "./junit-checks";

/**
 * 20% of the budget. See the header — 1% is 50ms of notice against the
 * default, which is a warning that arrives after the thing it warns about.
 */
export const DEFAULT_WITHIN = 0.2;

export interface SuiteMarginReading {
  /**
   * The ONE discriminator. `reasons` and `violations` are projections of the
   * same walk and cannot disagree with it — a second boolean beside this
   * would always agree with it, which is two deciders wearing one answer.
   */
  reading: "MEASURED" | "UNMEASURED";
  /** Why it is UNMEASURED. Empty exactly when it is not. */
  reasons: string[];
  /** Cases at or past the band, and cases the budget killed. */
  violations: string[];
  /** Testcases with a readable duration, summed across every report. */
  examined: number;
  /** Reports whose duration list could be read at all. */
  readable: number;
  reports: number;
  /** The budget compared against, or null when none could be read. */
  timeoutMs: number | null;
  withinFraction: number;
}

/**
 * Compose the two existing readings over N reports.
 *
 * FAILS CLOSED. Every path that cannot positively establish that a budget was
 * read and that at least one testcase duration was examined returns
 * UNMEASURED with reasons. There is no path that returns a clean MEASURED
 * from a reading of nothing — `0`, `{}` and silence are indistinguishable
 * from success (`.claude/rules/config-access.md`, Silent Default
 * Substitution), and an empty report satisfies a proximity check by having
 * nothing in it.
 *
 * `read` is injected so a case can force an unreadable report without owning
 * a filesystem. An omitted report is still read, so the seam cannot quietly
 * drop one.
 */
export function suiteMarginReading(opts: {
  reports: string[];
  bunfigSource: string | null;
  withinFraction?: number;
  read?: (path: string) => JunitDurationReading;
}): SuiteMarginReading {
  const withinFraction = opts.withinFraction ?? DEFAULT_WITHIN;
  const read = opts.read ?? readJunitDurations;
  const reasons: string[] = [];
  const violations: string[] = [];

  const timeoutMs = opts.bunfigSource === null ? null : bunfigTestTimeoutMs(opts.bunfigSource);
  if (timeoutMs === null) {
    reasons.push(
      "no [test] timeout is declared in bunfig.toml, so there is no budget to compare against — " +
        "a proximity reading needs the number the runner would kill at, and defaulting to bun's " +
        "built-in 5000 here would be a second declaring position for it (#621, #804)",
    );
  }

  if (opts.reports.length === 0) {
    reasons.push(
      "no JUnit report was named — nothing was read, which is not the same fact as nothing being " +
        "close to its budget (#804)",
    );
  }

  let examined = 0;
  let readable = 0;
  for (const path of opts.reports) {
    const reading = read(path);
    violations.push(...durationCoverageViolations(reading, path));
    if (reading.durations === null) continue;
    readable += 1;
    examined += reading.count;
    if (timeoutMs !== null) {
      violations.push(...timeoutProximityViolations(reading, timeoutMs, withinFraction));
    }
  }

  // Asked AFTER the walk, because the walk is what establishes it. A report
  // that exists, parses, and holds no testcase is the shape #621 warns about:
  // zero durations compared against any budget is perfect agreement.
  if (examined === 0 && opts.reports.length > 0) {
    reasons.push(
      `${opts.reports.length} report(s) named and ${readable} readable, but no testcase duration was ` +
        "read from any of them — a comparison over an empty population passes by having nothing in " +
        "it (#621, #804)",
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    reasons,
    violations,
    examined,
    readable,
    reports: opts.reports.length,
    timeoutMs,
    withinFraction,
  };
}

/**
 * Whether the caller must refuse, as ONE binding.
 *
 * UNMEASURED refuses with the violations rather than beside them, and that is
 * the decision this function exists to hold in one place. A reading that could
 * not be taken is not a reading that passed — the whole of #804 is a check
 * printing UNMEASURED on every run and nobody acting on it, so the version of
 * this that exits 0 on UNMEASURED reproduces the defect it was written for.
 */
export function suiteMarginRefusal(reading: SuiteMarginReading): string | null {
  if (reading.reading === "UNMEASURED") {
    return `UNMEASURED: ${reading.reasons.join("; ")}`;
  }
  if (reading.violations.length > 0) {
    return `${reading.violations.length} case(s) at or past ${reading.withinFraction * 100}% of the ${reading.timeoutMs}ms budget`;
  }
  return null;
}

/** The sentence a caller prints instead of the verdict on its own. */
export function describeSuiteMargin(reading: SuiteMarginReading): string {
  const head =
    reading.reading === "UNMEASURED"
      ? `UNMEASURED: the suite's margin against its budget was not read.`
      : reading.violations.length === 0
        ? `MEASURED: ${reading.examined} testcase(s) across ${reading.readable} report(s), none within ` +
          `${reading.withinFraction * 100}% of the ${reading.timeoutMs}ms budget.`
        : `${reading.violations.length} case(s) within ${reading.withinFraction * 100}% of the ` +
          `${reading.timeoutMs}ms budget, of ${reading.examined} examined across ${reading.readable} report(s).`;
  return [head, ...reading.reasons.map(r => `  - ${r}`), ...reading.violations.map(v => `  - ${v}`)].join("\n");
}
