/**
 * #804 — the suite's margin against its budget, read from a report.
 *
 * `timeoutProximityViolations` and `durationCoverageViolations` have been
 * correct since #621 and have never run against this repository's suite. The
 * population they read comes from `SUITE_JUNIT_REPORT`, and measured on
 * `1222742b` that variable appears five times in the tree, all five inside
 * `test/test-timeout-population.test.ts` — four in the function that reads it
 * and one in the env of that file's own mutant spawn. Nothing else sets it,
 * and `.github/workflows/ci.yml:76` ran the suite with no reporter, so both
 * of its live cases printed UNMEASURED and passed on every run.
 *
 * So the thing under test here is NOT a new comparison. It is the composition
 * — one budget, N reports, both existing readings, one refusal — and most of
 * these cases are about the ways a composition can report nothing while
 * looking like it reported success.
 *
 * ## What this does NOT do, said here rather than left as an omission
 *
 * It does not wire the reading into CI, so #804 is not closed by it. The
 * obvious wiring is `[test.reporter] junit = "junit.xml"` in `bunfig.toml`,
 * which is MEASURED to work on bun 1.3.14 and needs no command-line flag —
 * and it has a hazard worth stating before anyone reaches for it: several
 * suites in `test/` spawn `bun test` as a subprocess with the repository as
 * cwd, so every one of those nested runs inherits the declaration, writes the
 * same relative path, and the LAST writer wins. A top-level run of 15,000
 * cases can end with a three-case report on disk, and a three-case report is
 * not empty — `examined === 0` below would not catch it. Where the report is
 * written is the decision #804 still needs.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Exit 0 when the report is missing.** It is the 5pm repair for the first
 * red this produces — the job cannot find the file, so stop failing on it —
 * and it reinstates the exact defect #804 is filed about: a reading that did
 * not happen, reported as one that passed. `AC-4` and `AC-9` are red under
 * it, non-vacuously: `AC-4` asserts the UNMEASURED reading refuses, and
 * `AC-9` observes the real script's exit status against a mutant whose
 * `REFUSE_EXIT` is zero.
 *
 * ## What was broken to prove these can fail
 *
 * See the table in `specs/HARNESS-STANDARD.md` beside this issue's criteria,
 * and the battery note in the pull request. Counts were predicted before the
 * battery ran and the baseline row was read first.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DEFAULT_WITHIN,
  describeSuiteMargin,
  suiteMarginReading,
  suiteMarginRefusal,
} from "../lib/suite-timeout-margin";
import { type JunitDurationReading } from "../lib/junit-checks";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "suite-timeout-margin.ts");

/** The budget every case below compares against, in the form bunfig declares it. */
const BUNFIG = "[test]\ntimeout = 5000\n";

/**
 * A report in bun 1.3.14's own shape — `time` in fractional SECONDS, which is
 * the unit a hand-written fixture gets wrong and then every assertion is a
 * fact about the fixture.
 */
function report(cases: Array<{ name: string; seconds: number; timedOut?: boolean }>): string {
  const bodies = cases
    .map(c =>
      c.timedOut
        ? `      <testcase name="${c.name}" classname="g" time="${c.seconds}" file="a.test.ts" line="3" assertions="0">\n` +
          `        <failure type="TimeoutError" />\n      </testcase>`
        : `      <testcase name="${c.name}" classname="g" time="${c.seconds}" file="a.test.ts" line="3" assertions="0" />`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="bun test" tests="${cases.length}" assertions="0" failures="0" skipped="0" time="1.0">\n` +
    `  <testsuite name="a.test.ts" file="a.test.ts" tests="${cases.length}" assertions="0" failures="0" skipped="0" time="1.0" hostname="h">\n` +
    `    <testsuite name="g" file="a.test.ts" line="2" tests="${cases.length}" assertions="0" failures="0" skipped="0" time="1.0" hostname="h">\n` +
    `${bodies}\n    </testsuite>\n  </testsuite>\n</testsuites>\n`
  );
}

/** Write `xml` into a fresh scratch root and return the path. Unique per run. */
function plant(xml: string, name = "junit.xml"): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-804-"));
  const path = join(dir, name);
  writeFileSync(path, xml);
  return path;
}

const UNREADABLE: JunitDurationReading = {
  durations: null,
  count: 0,
  skipped: 0,
  withoutDuration: 0,
  reason: "ENOENT: no such file or directory",
};

describe("#804: the suite says how close it ran to its budget", () => {
  test("AC-1: a case inside the band is named, with its duration and its share of the budget", () => {
    // 4100ms of 5000 is 82% — inside the default 20% band and nowhere near
    // being killed, which is the whole point: the warning has to arrive while
    // there is still something to do about it.
    const reading = suiteMarginReading({ reports: [plant(report([{ name: "slow one", seconds: 4.1 }]))], bunfigSource: BUNFIG });

    expect(reading.reading).toBe("MEASURED");
    expect(reading.examined).toBe(1);
    expect(reading.violations).toHaveLength(1);
    expect(reading.violations[0]).toContain("slow one");
    expect(reading.violations[0]).toContain("4100.00ms");
    expect(reading.violations[0]).toContain("82.0%");
    expect(suiteMarginRefusal(reading)).not.toBeNull();
  });

  test("AC-2: a case the budget KILLED is reported as killed, not as a near miss", () => {
    // The distinction #621 is entirely about, and the one a timeout erases
    // from the console: a killed case did not fail on its merits.
    const reading = suiteMarginReading({
      reports: [plant(report([{ name: "killed one", seconds: 5.0, timedOut: true }]))],
      bunfigSource: BUNFIG,
    });

    expect(reading.violations).toHaveLength(1);
    expect(reading.violations[0]).toContain("was KILLED");
    expect(reading.violations[0]).toContain("killed one");
  });

  test("AC-3: a case comfortably under its budget is not reported", () => {
    // The boundary. A reading that named everything would be red on every run
    // and would be switched off, which is the failure mode #804 describes
    // from the other side.
    const reading = suiteMarginReading({
      reports: [plant(report([{ name: "fast one", seconds: 0.109 }, { name: "ordinary", seconds: 1.2 }]))],
      bunfigSource: BUNFIG,
    });

    expect(reading.reading).toBe("MEASURED");
    expect(reading.examined).toBe(2);
    expect(reading.violations).toEqual([]);
    expect(suiteMarginRefusal(reading)).toBeNull();
    expect(describeSuiteMargin(reading)).toContain("none within");
  });

  test("AC-4: a report that cannot be read is UNMEASURED and refuses", () => {
    // The cheapest wrong fix, as a case. A missing report is the first red
    // this produces in anger, and exiting 0 on it rebuilds #804: a reading
    // that did not happen, reported as one that passed.
    const reading = suiteMarginReading({
      reports: ["/nowhere/junit.xml"],
      bunfigSource: BUNFIG,
      read: () => UNREADABLE,
    });

    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.examined).toBe(0);
    expect(reading.readable).toBe(0);
    expect(reading.violations.join(" ")).toContain("could not be read");
    const refusal = suiteMarginRefusal(reading);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("UNMEASURED");
  });

  test("AC-5: a report that parses and holds no testcase is UNMEASURED, not agreement", () => {
    // Zero durations compared against any budget is perfect agreement, which
    // is the shape #621's own coverage check exists for. Asserted here as
    // well because the composition is what could lose it.
    const reading = suiteMarginReading({ reports: [plant(report([]))], bunfigSource: BUNFIG });

    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.readable).toBe(1);
    expect(reading.examined).toBe(0);
    expect(reading.reasons.join(" ")).toContain("no testcase duration was read");
  });

  test("AC-6: no declared budget is UNMEASURED, and bun's built-in 5000 is not substituted", () => {
    // Silent Default Substitution, in the position it would be invisible:
    // 5000 IS bun's default, so a substituted one would produce correct
    // numbers for this repository and silently wrong ones for a project that
    // raised its budget on the command line.
    const reading = suiteMarginReading({
      reports: [plant(report([{ name: "slow one", seconds: 4.9 }]))],
      bunfigSource: '[install]\ntimeout = 5000\n',
    });

    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.timeoutMs).toBeNull();
    expect(reading.reasons.join(" ")).toContain("no [test] timeout is declared");
    // The proximity comparison never ran, so the 4900ms case is NOT reported.
    // A violation here would mean a budget was invented to compare against.
    expect(reading.violations).toEqual([]);
  });

  test("AC-7: the union is read, so a sharded run is covered by every shard", () => {
    // Four shards write four reports and the suite is their union. A reading
    // that stopped at the first would be green on three quarters of a run,
    // and CI has been sharded here since c664837a.
    const clean = plant(report([{ name: "fast one", seconds: 0.1 }]), "junit-1.xml");
    const slow = plant(report([{ name: "shard four case", seconds: 4.6 }]), "junit-4.xml");
    const reading = suiteMarginReading({ reports: [clean, slow], bunfigSource: BUNFIG });

    expect(reading.reports).toBe(2);
    expect(reading.readable).toBe(2);
    expect(reading.examined).toBe(2);
    expect(reading.violations).toHaveLength(1);
    expect(reading.violations[0]).toContain("shard four case");
  });

  test("AC-8: the default band gives notice, and a narrower one is the band that does not", () => {
    // The second cheapest wrong fix: make the band so narrow that nothing is
    // ever in it. 1% of 5000 is 50ms of notice, which is a warning that
    // arrives after the thing it warns about.
    //
    // Stated exactly, because the loose version of this claim is wrong: the
    // scan #804 was filed over ran at 3482ms, which is 69.6% and OUTSIDE the
    // default 20% band. What the band buys is the window between 4000ms and
    // the 5005ms that killed it — the scan crossed that window while growing
    // with the tree, and 0.01 would have said nothing anywhere in it.
    const at84 = plant(report([{ name: "at eighty-four percent", seconds: 4.2 }]));
    expect(DEFAULT_WITHIN).toBeGreaterThanOrEqual(0.2);

    const wide = suiteMarginReading({ reports: [at84], bunfigSource: BUNFIG });
    expect(wide.withinFraction).toBe(DEFAULT_WITHIN);
    expect(wide.violations).toHaveLength(1);
    expect(wide.violations[0]).toContain("84.0%");

    const narrow = suiteMarginReading({ reports: [at84], bunfigSource: BUNFIG, withinFraction: 0.01 });
    expect(narrow.violations).toEqual([]);
  });

  test("AC-9: the real script refuses where a mutant with REFUSE_EXIT zeroed does not", () => {
    // The refusal, performed and observed. An in-process assertion that
    // `suiteMarginRefusal` returned a string does not establish that the
    // SCRIPT exits non-zero — a script that computed a refusal and printed it
    // without exiting passes that assertion either way.
    const source = readFileSync(SCRIPT, "utf-8");
    const anchor = "export const REFUSE_EXIT = 1;";
    expect(
      source.split(anchor).length - 1,
      "REFUSE_EXIT is not declared exactly once in the script, so a refusal could bypass the mutation",
    ).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), "rungate-804-mutant-"));
    const mutant = join(dir, "suite-timeout-margin.ts");
    writeFileSync(
      mutant,
      source
        .replace(anchor, "export const REFUSE_EXIT = 0;")
        .replace('from "../lib/suite-timeout-margin"', `from "${join(REPO_ROOT, "lib", "suite-timeout-margin")}"`),
    );

    // One input, run twice: a project whose bunfig declares the budget and
    // whose report holds a case at 92% of it.
    const project = mkdtempSync(join(tmpdir(), "rungate-804-project-"));
    writeFileSync(join(project, "bunfig.toml"), BUNFIG);
    writeFileSync(join(project, "junit.xml"), report([{ name: "nearly killed", seconds: 4.6 }]));

    const args = [join(project, "junit.xml"), "--project-root", project];
    const real = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8" });
    const mutated = spawnSync("bun", [mutant, ...args], { encoding: "utf-8" });

    // The mutant must have RUN. A mutant that died on module resolution exits
    // non-zero, which reads exactly like the mutation having been rejected on
    // its merits.
    expect(mutated.stdout, `the mutant produced no reading:\n${mutated.stderr}`).toContain("nearly killed");
    expect(real.stdout).toContain("nearly killed");

    expect(real.status, `the real script did not refuse:\n${real.stdout}\n${real.stderr}`).toBe(1);
    expect(mutated.status, "the mutant refused, so the exit is not routed through REFUSE_EXIT").toBe(0);
  });
});
