/**
 * AC-3 / AC-7 of #621 — how close the suite runs to the per-test timeout.
 *
 * #621's 122 "failures" were not failures. All 122 had a duration at or above
 * 5000ms and 112 carried the literal string `timed out after 5000ms`, which is
 * bun's built-in per-test budget. Zero were assertion failures. A suite whose
 * slowest tests sit just under that line is green on an idle laptop and red
 * under 27 agents, and nothing in the tree could say which side of the line
 * anything was on.
 *
 * So this file asks one question of a real run: **how close did the closest
 * test get?** A test at 99% of the budget has not failed yet and is the only
 * warning anybody is going to get.
 *
 * ## The budget is read, not written down
 *
 * The number comes out of `bunfig.toml` (AC-3a). A literal here would be a
 * fourth place the budget is written — and #550 is this repo's record of what
 * that costs: a 240000ms spawn inside a 5000ms test, each number correct
 * beside the thing it annotated and the pair never compared.
 *
 * ## …and the declaration is proved to be the budget in force
 *
 * MEASURED on bun 1.3.14, which is the fact that shaped this file: `[test]
 * timeout` in `bunfig.toml` is **not read by the test runner**. A scratch
 * project declaring `timeout = 1000` runs a 2000ms test to completion and
 * reports `1 pass`; the same test under `bun test --timeout 1000` dies with
 * `this test timed out after 1000ms`. This repo's `bunfig.toml` declared
 * 30000 while every one of #621's timeouts died at 5000.
 *
 * A proximity check against a budget nobody enforces is the cleanest possible
 * example of a check that cannot fail: no test is ever within 1% of 30000,
 * because they are all killed at 5000 first. So the declaration is not taken
 * on trust — a probe runs a test that sleeps past it and asserts the runner
 * kills it at exactly the declared number
 * (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * That probe is also what blocks the cheapest wrong repair. "A test is within
 * 1% of the timeout" invites raising the timeout, which #621 refuses on the
 * merits — and which, measured, does not even work: raising this key changes
 * nothing the runner does, and the probe goes red saying so.
 *
 * ## Coverage and proximity are two cases, deliberately (AC-7)
 *
 * An empty report satisfies "no duration is near the budget" perfectly. The
 * reading therefore reports how many testcases it read, the coverage case
 * refuses a reading of zero, and the proximity case stays SILENT on an empty
 * reading rather than refusing it — because if both refused, a reader could
 * not tell which property a red row was about, and short-circuiting the
 * reader would take both down together. The mutation at the bottom performs
 * exactly that short-circuit and asserts the split: coverage red, proximity
 * green, one input.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bunfigTestTimeoutMs,
  durationCoverageViolations,
  parseJunitDurations,
  readJunitDurations,
  timeoutProximityViolations,
  type JunitDurationReading,
} from "../lib/junit-checks";

// Rewritten to an absolute literal when this file is copied into a temp
// directory as a mutant, so every path below keeps resolving there.
const TEST_DIR = import.meta.dir;
const REPO_ROOT = join(TEST_DIR, "..");
const THIS_FILE = join(TEST_DIR, "test-timeout-population.test.ts");
const BUNFIG_SOURCE = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf-8");

/** The one place the budget is named. */
const DECLARED_TIMEOUT_MS = bunfigTestTimeoutMs(BUNFIG_SOURCE);

/** "Within one percent of the timeout" (AC-3b). */
const WITHIN = 0.01;

/** Set in the mutant spawn, so the mutant cannot spawn a mutant. */
const IS_MUTANT = process.env.TIMEOUT_POPULATION_MUTANT === "1";

/**
 * A real bun 1.3.14 JUnit report, captured rather than hand-written: three
 * testcases, one of them `<skipped />`, `time` in fractional SECONDS.
 *
 * Hand-written XML would make every assertion below a fact about this
 * string. The one thing a fixture here has to be is bun's actual output.
 */
const CAPTURED_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="0" failures="0" skipped="1" time="1.210606">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="0" failures="0" skipped="1" time="0" hostname="h">
    <testsuite name="g" file="a.test.ts" line="2" tests="3" assertions="0" failures="0" skipped="1" time="1.201" hostname="h">
      <testcase name="slowish" classname="g" time="1.201579" file="a.test.ts" line="3" assertions="0" />
      <testcase name="fast" classname="g" time="0.000013" file="a.test.ts" line="4" assertions="0" />
      <testcase name="skipped one" classname="g" time="0" file="a.test.ts" line="5" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;

/**
 * Also captured, from `bun test a.test.ts --timeout 500` over a file holding
 * a 1500ms test and a throwing one.
 *
 * `TimeoutError` versus `AssertionError` is the distinction #621 is entirely
 * about — 122 red rows, zero of them assertions — and the JUnit report is
 * the only place in a run where it survives in machine-readable form.
 */
const TIMED_OUT_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="0" failures="2" skipped="0" time="0.508379">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="0" failures="2" skipped="0" time="0.501" hostname="h">
    <testcase name="times out" classname="" time="0.501027" file="a.test.ts" line="2" assertions="0">
      <failure type="TimeoutError" />
    </testcase>
    <testcase name="asserts wrong" classname="" time="0.000293" file="a.test.ts" line="3" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;

/**
 * The suite's own report, when the run provides one.
 *
 * A `bun test` run cannot read its own JUnit report: the file is written when
 * the run ends. So the population this check is about has to arrive from
 * outside, and `SUITE_JUNIT_REPORT` is the contract — a ship run, CI, or a
 * developer runs `bun test --reporter=junit --reporter-outfile=<path>` once
 * and points this at it.
 *
 * When nothing provides one the reading is `null` WITH A REASON, and the two
 * cases below print UNMEASURED rather than passing quietly. `0`, `{}`, `null`
 * and SKIP are indistinguishable from success and silence is worse than all
 * four (.claude/rules/config-access.md, Silent Default Substitution).
 */
function suiteReading(): { source: string; reading: JunitDurationReading } {
  const path = process.env.SUITE_JUNIT_REPORT;
  if (!path) {
    return {
      source: "SUITE_JUNIT_REPORT (unset)",
      reading: {
        durations: null,
        count: 0,
        skipped: 0,
        withoutDuration: 0,
        reason: "no suite JUnit report was provided — set SUITE_JUNIT_REPORT to one written by `bun test --reporter=junit --reporter-outfile=<path>`",
      },
    };
  }
  return { source: path, reading: readJunitDurations(path) };
}

/**
 * Source with comments removed, so "this file does not restate the budget"
 * is a claim about CODE and a comment may still discuss the number.
 *
 * Narrow on purpose: block comments and `//` tails only. A regex that also
 * tried to understand strings deleted 61% of a file in this repo's history
 * and the guard it was protecting went green, so the case that uses this
 * asserts the stripper did not eat the file.
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** `N pass` / `N fail` off a bun run's summary. */
function summaryCount(output: string, label: string): number {
  const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
  return m ? Number(m[1]) : 0;
}

describe("#621: the suite is measured against the budget it actually has", () => {
  test("AC-3a: the per-test timeout is read from bunfig.toml and restated nowhere here", () => {
    expect(DECLARED_TIMEOUT_MS, `bunfig.toml declares no [test] timeout:\n${BUNFIG_SOURCE}`).not.toBeNull();
    expect(DECLARED_TIMEOUT_MS!).toBeGreaterThan(0);

    // Search the SLICE, not the document: a `timeout` under another table is
    // a different setting, and a reader that matched it anywhere in the file
    // would silently measure against `[install] timeout`.
    expect(bunfigTestTimeoutMs('[install]\ntimeout = 1234\n')).toBeNull();
    expect(bunfigTestTimeoutMs('[test]\nroot = "test"\n\n[install]\ntimeout = 1234\n')).toBeNull();
    // …and it does find one where one is declared, so the two nulls above are
    // facts about their input rather than about a reader that always says no.
    expect(bunfigTestTimeoutMs('[install]\ntimeout = 1234\n\n[test]\ntimeout = 4321\n')).toBe(4321);
    // A sub-table ends the section; `[test.reporter] timeout` is not this one.
    expect(bunfigTestTimeoutMs('[test]\nroot = "test"\n\n[test.reporter]\ntimeout = 777\n')).toBeNull();

    // The literal appears nowhere in this file's code (AC-3a).
    const code = codeOf(readFileSync(THIS_FILE, "utf-8"));
    expect(code, "the comment stripper removed the whole file").toContain("DECLARED_TIMEOUT_MS");
    expect(code.length, "the comment stripper ate most of the file — it is not measuring code")
      .toBeGreaterThan(readFileSync(THIS_FILE, "utf-8").length * 0.3);
    expect(
      new RegExp(String.raw`\b${DECLARED_TIMEOUT_MS}\b`).test(code),
      `this file hardcodes ${DECLARED_TIMEOUT_MS}, which is bunfig.toml's job`,
    ).toBe(false);
    // The instrument, over a number that is not the budget: the stripper
    // keeps code and drops comments, so the `false` above is a fact about
    // the file and not about a stripper that returns nothing.
    expect(codeOf("const a = 8675309;\n")).toContain("8675309");
    expect(codeOf("const a = 1; // 8675309\n")).not.toContain("8675309");
  });

  test("AC-3a: the declared budget is the budget the runner enforces", () => {
    // Without this the proximity check is vacuous in the quietest possible
    // way. MEASURED on bun 1.3.14: `[test] timeout` in bunfig.toml is not
    // read by the runner, so a declaration of 30000 — which is what this
    // repo carried while #621's tests died at 5000 — puts the line being
    // watched 25 seconds above anything that can ever happen.
    //
    // What this asserts is the property that matters, which is NOT "bunfig
    // is read": it is that the number the proximity check uses is the number
    // a test is killed at.
    const dir = mkdtempSync(join(tmpdir(), "bunfig-timeout-probe-"));
    writeFileSync(join(dir, "bunfig.toml"), BUNFIG_SOURCE);
    const sleepFor = DECLARED_TIMEOUT_MS! + 1500;
    writeFileSync(
      join(dir, "probe.test.ts"),
      `import { test } from "bun:test";\n` +
        `test("sleeps past the declared budget", async () => {\n` +
        `  await new Promise(r => setTimeout(r, ${sleepFor}));\n` +
        `});\n`,
    );

    const r = spawnSync("bun", ["test", "probe.test.ts"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: sleepFor + 60000,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // The instrument first: a run that never produced a verdict reports no
    // timeout either, and that is indistinguishable from a budget in force.
    expect(
      summaryCount(out, "pass") + summaryCount(out, "fail"),
      `the probe run produced no summary at all:\n${out}`,
    ).toBe(1);

    const killed = /timed out after (\d+)ms/.exec(out);
    expect(
      killed,
      `the runner let a ${sleepFor}ms test finish, so the ${DECLARED_TIMEOUT_MS}ms in bunfig.toml is ` +
        `not the budget in force and every proximity assertion below is measuring a line nothing reaches:\n${out}`,
    ).not.toBeNull();
    expect(
      Number(killed![1]),
      `bunfig.toml declares ${DECLARED_TIMEOUT_MS}ms and the runner killed the test at ${killed![1]}ms`,
    ).toBe(DECLARED_TIMEOUT_MS!);
  }, 180000);
});

// ── the reading reports its own coverage (AC-7a) ────────────────────────────

describe("#621: a reading that read nothing is not a clean reading", () => {
  test("AC-7a: a report with zero testcases fails the coverage check rather than passing it", () => {
    const empty = parseJunitDurations('<?xml version="1.0"?>\n<testsuites name="bun test" tests="0"></testsuites>\n');
    // An empty report is a MEASUREMENT — the run listed nothing — so the
    // durations are `[]` and not `null`.
    expect(empty.durations).toEqual([]);
    expect(empty.count).toBe(0);
    expect(
      durationCoverageViolations(empty, "an empty report"),
      "a report listing no testcase was accepted as coverage",
    ).not.toEqual([]);

    // …and the proximity check is SILENT over the same reading. This is the
    // whole reason AC-7 asks for two cases: if proximity also refused here,
    // the two questions would be one question and no row could say which
    // property had broken.
    expect(timeoutProximityViolations(empty, DECLARED_TIMEOUT_MS!, WITHIN)).toEqual([]);

    // Unreadable is not empty. `null` says the reader said nothing; `[]` says
    // the report said nothing. Both refuse here, for different reasons.
    const missing = readJunitDurations(join(tmpdir(), "no-such-junit-report-621.xml"));
    expect(missing.durations).toBeNull();
    expect(missing.reason, "an unreadable report refuses without saying why").toBeTruthy();
    expect(durationCoverageViolations(missing, "a missing report")).not.toEqual([]);

    // A testcase carrying no `time` is a duration the reader did not get.
    // Dropping it silently would shrink the population the proximity check
    // sees while the count still looked plausible.
    const noTime = parseJunitDurations(
      '<?xml version="1.0"?>\n<testsuites name="bun test" tests="1">\n' +
        '<testsuite name="f.test.ts"><testcase name="untimed" /></testsuite>\n</testsuites>\n',
    );
    expect(noTime.withoutDuration).toBe(1);
    expect(noTime.count).toBe(0);
    expect(
      durationCoverageViolations(noTime, "a report with no time attributes"),
      "a partial reading was reported as complete",
    ).not.toEqual([]);
  });

  test("AC-7a: a real report's durations are read in milliseconds, skips excluded", () => {
    // bun writes `time` in fractional SECONDS. Reading it as milliseconds
    // would put every duration a thousand times below the budget, and the
    // proximity check would be green forever.
    const reading = parseJunitDurations(CAPTURED_REPORT);
    expect(reading.durations!.map(d => d.name)).toEqual(["g > slowish", "g > fast"]);
    expect(reading.durations![0].ms).toBeCloseTo(1201.579, 2);
    expect(reading.count).toBe(2);
    // A `<skipped />` testcase has a duration of zero and is not a test that
    // ran — counting it would pad the coverage number with tests nobody
    // measured, which is #532's dangerous direction in a new place.
    expect(reading.skipped).toBe(1);
    expect(durationCoverageViolations(reading, "the captured report")).toEqual([]);
  });
});

// ── the proximity check, over a real run (AC-3b) ────────────────────────────

describe("#621: the proximity check names the test and its duration", () => {
  test("AC-3b: a killed test and a creeping one are named; a budgeted one and a fast one are not", () => {
    // FOUR CLASSES IN ONE REAL RUN. Driven over a VALUE rather than over
    // bunfig's number, so the fixture takes seconds instead of a minute and
    // the comparison is not the budget against itself.
    //
    // The class that makes this check usable rather than noisy is the third
    // one: a test that finished PAST the budget without timing out was
    // given a bigger budget of its own, and reporting it would make the
    // live check red forever over tests nobody is at risk from — measured,
    // `gates/workflow.test.ts`'s 240000ms typecheck check runs 16770ms.
    const budget = 2000;
    const dir = mkdtempSync(join(tmpdir(), "timeout-proximity-"));
    const report = join(dir, "report.xml");
    writeFileSync(
      join(dir, "near.test.ts"),
      `import { test } from "bun:test";\n` +
        `const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));\n` +
        `test("creeps up on the budget", async () => { await sleep(${budget - 20}); });\n` +
        `test("nowhere near it", async () => { await sleep(100); });\n` +
        `test("is killed by the budget", async () => { await sleep(${budget * 2}); });\n` +
        `test("has a budget of its own", async () => { await sleep(${budget + 400}); }, ${budget * 10});\n`,
    );
    const r = spawnSync(
      "bun",
      ["test", "near.test.ts", `--timeout=${budget}`, "--reporter=junit", `--reporter-outfile=${report}`],
      { cwd: dir, encoding: "utf-8", timeout: 120000 },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // The instrument: the fixture really did produce the population this
    // case is about — three survivors and one kill — and not, say, four
    // tests that all died because the machine stalled.
    expect(summaryCount(out, "pass"), `the fixture suite did not run as intended:\n${out}`).toBe(3);
    expect(summaryCount(out, "fail"), `the fixture produced no timeout to read:\n${out}`).toBe(1);

    const reading = readJunitDurations(report);
    expect(reading.durations, `the fixture report could not be read: ${reading.reason}`).not.toBeNull();
    expect(durationCoverageViolations(reading, report)).toEqual([]);
    expect(reading.count).toBe(4);
    expect(reading.durations!.filter(d => d.timedOut).map(d => d.name)).toEqual(["is killed by the budget"]);

    const violations = timeoutProximityViolations(reading, budget, WITHIN);
    const named = (fragment: string) => violations.filter(v => v.includes(fragment));
    expect(named("creeps up on the budget"), `the creeping test was not named:\n${violations.join("\n")}`)
      .toHaveLength(1);
    expect(named("is killed by the budget"), `the killed test was not named:\n${violations.join("\n")}`)
      .toHaveLength(1);
    expect(named("nowhere near it"), "a fast test was reported").toHaveLength(0);
    expect(
      named("has a budget of its own"),
      "a test that declared its own budget was reported — the check is noise on every run that has one",
    ).toHaveLength(0);
    expect(violations, `exactly two classes are findings:\n${violations.join("\n")}`).toHaveLength(2);

    // NAMED WITH ITS DURATION — a count alone would not tell anybody which
    // test to go and look at, which is the only use this check has.
    const creeping = named("creeps up on the budget")[0];
    const quoted = /(\d+(?:\.\d+)?)ms/.exec(creeping);
    expect(quoted, `the violation quotes no duration: ${creeping}`).not.toBeNull();
    const measured = reading.durations!.find(d => d.name.includes("creeps up"))!;
    expect(Number(quoted![1])).toBeCloseTo(measured.ms, 1);

    // The band is arithmetic, not "it was slow": against a budget four times
    // the size, the creeping test is comfortably clear and only the kill —
    // which is a fact about the run that produced the report, not about the
    // number compared against — survives.
    const wider = timeoutProximityViolations(reading, budget * 4, WITHIN);
    expect(wider, `against a 4x budget only the kill survives:\n${wider.join("\n")}`).toHaveLength(1);
    expect(wider[0]).toContain("is killed by the budget");
    // …and widening the window to the whole budget catches everything that
    // ran UNDER it, so the filter is doing arithmetic rather than naming
    // whatever it finds first. THREE, not four: the test that finished past
    // the budget stays out at every window width, because "it is past the
    // budget" is what says the budget is not its own. Predicted four,
    // measured three, and the arithmetic is the finding — the exclusion is
    // a property of the class and not of the band.
    expect(timeoutProximityViolations(reading, budget, 0.99)).toHaveLength(3);
  }, 180000);

  test("AC-3b: a test killed by the budget is a finding; one that failed on its merits is not", () => {
    // The same two rows from a captured report, so the classification is
    // pinned to bun's own vocabulary rather than to the fixture above. An
    // `AssertionError` at 0.3ms is a test doing its job; a `TimeoutError` is
    // the run telling you nothing about the code.
    const reading = parseJunitDurations(TIMED_OUT_REPORT);
    expect(reading.count).toBe(2);
    expect(reading.durations!.map(d => d.timedOut)).toEqual([true, false]);

    // Compared against a budget neither duration is anywhere near: the kill
    // is still a finding, because it already happened.
    const violations = timeoutProximityViolations(reading, DECLARED_TIMEOUT_MS!, WITHIN);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("times out");
    expect(violations[0]).toContain("KILLED");
    expect(violations.join("\n")).not.toContain("asserts wrong");
  });
});

// ── the live population ─────────────────────────────────────────────────────

describe("#621: the suite's own report", () => {
  test("AC-7a: the suite reading reports how many testcases it read", () => {
    const { source, reading } = suiteReading();
    if (reading.durations === null) {
      console.error(`[#621] UNMEASURED coverage: ${reading.reason} (source: ${source})`);
      expect(reading.reason, "an unread report must record why").toBeTruthy();
      return;
    }
    // ONE decider. An `expect(reading.count).toBeGreaterThan(0)` beside this
    // reads as reinforcement and is the fourth shape in miniature: it asks
    // the same question of the same reading, so deleting
    // `durationCoverageViolations` entirely left this case red anyway and
    // the mutation below measured 1 where 2 was predicted. Measured, not
    // reasoned about — nothing in the diff showed it.
    expect(
      durationCoverageViolations(reading, source).join("\n"),
      "the suite's JUnit report was read, and it covers nothing",
    ).toBe("");
    console.error(`[#621] read ${reading.count} testcase durations (${reading.skipped} skipped) from ${source}`);
  });

  test("AC-3b: no testcase lands within one percent of the per-test timeout", () => {
    const { source, reading } = suiteReading();
    if (reading.durations === null) {
      console.error(`[#621] UNMEASURED proximity: ${reading.reason} (source: ${source})`);
      expect(reading.reason, "an unread report must record why").toBeTruthy();
      return;
    }
    const violations = timeoutProximityViolations(reading, DECLARED_TIMEOUT_MS!, WITHIN);
    expect(
      violations.join("\n"),
      `${violations.length} of ${reading.count} testcases in ${source} are within ${WITHIN * 100}% of the ` +
        `${DECLARED_TIMEOUT_MS}ms per-test timeout — they do not fail on their merits, they are killed`,
    ).toBe("");
  });
});

// ── the split is real (AC-7b) ───────────────────────────────────────────────

/**
 * Short-circuit the duration reader and watch the two cases come apart.
 *
 * The claim AC-7b makes is not "coverage can fail". It is that coverage and
 * proximity are separate questions, which is only true if one input moves one
 * of them and not the other. So the reader is replaced by one that returns an
 * empty list — the exact shape an empty report has — and the two cases are run
 * against it through their own names:
 *
 *   coverage  → RED   (it read nothing, and says so)
 *   proximity → GREEN (nothing it read is near the budget, truthfully)
 *
 * A mutation that turned both red would mean the two cases were one case.
 */
function buildMutant(scratch: string): { lib: string; suite: string } {
  const libSource = readFileSync(join(REPO_ROOT, "lib", "junit-checks.ts"), "utf-8");
  const SIGNATURE = "export function parseJunitDurations(xml: string): JunitDurationReading {";
  const hits = libSource.split(SIGNATURE).length - 1;
  if (hits !== 1) {
    throw new Error(`could not build the mutant: the duration reader signature appears ${hits} times`);
  }
  const lib = join(scratch, "junit-checks-mutant.ts");
  writeFileSync(
    lib,
    libSource.replace(
      SIGNATURE,
      `${SIGNATURE}\n  return { durations: [], count: 0, skipped: 0, withoutDuration: 0 };`,
    ),
  );

  // The suite copy runs from a temp directory, so `import.meta.dir` and every
  // relative specifier have to become absolute. A survivor would make the
  // mutant die on module resolution, and that non-zero exit reads as a
  // refusal it never made.
  const own = readFileSync(THIS_FILE, "utf-8");
  // Anchored to the start of a line, so the declaration is matched and this
  // sentence about it is not.
  const ANCHOR = /^const TEST_DIR = import\.meta\.dir;$/gm;
  const anchors = own.match(ANCHOR) || [];
  if (anchors.length !== 1) {
    throw new Error(`could not build the mutant: the TEST_DIR anchor appears ${anchors.length} times`);
  }
  const relocated = own
    .replace(ANCHOR, `const TEST_DIR = ${JSON.stringify(TEST_DIR)};`)
    .replace(/from "\.\.\/lib\/junit-checks"/g, `from ${JSON.stringify(lib)}`);
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(`could not build the mutant: ${leftover.length} relative imports were not rewritten`);
  }
  const suite = join(scratch, "timeout-population-mutant.test.ts");
  writeFileSync(suite, relocated);
  return { lib, suite };
}

function runOneCase(suite: string, name: string, report: string): { ran: number; failed: number; output: string } {
  const r = spawnSync("bun", ["test", suite, "-t", name], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180000,
    env: { ...process.env, SUITE_JUNIT_REPORT: report, TIMEOUT_POPULATION_MUTANT: "1" },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    ran: summaryCount(output, "pass") + summaryCount(output, "fail"),
    failed: summaryCount(output, "fail"),
    output,
  };
}

const COVERAGE_CASE = "AC-7a: the suite reading reports how many testcases it read";
const PROXIMITY_CASE = "AC-3b: no testcase lands within one percent of the per-test timeout";

describe.skipIf(IS_MUTANT)("#621: coverage and proximity are two cases, performed", () => {
  test("AC-7b: short-circuiting the duration reader turns coverage red and leaves proximity green", () => {
    const scratch = mkdtempSync(join(tmpdir(), "timeout-population-mutant-"));
    const report = join(scratch, "suite-junit.xml");
    writeFileSync(report, CAPTURED_REPORT);

    // The real source first, over the same report. Without this the mutant's
    // red is not evidence of anything: a case that was already red would look
    // identical.
    const realCoverage = runOneCase(THIS_FILE, COVERAGE_CASE, report);
    expect(realCoverage.ran, `the coverage case never ran against the real reader:\n${realCoverage.output}`).toBe(1);
    expect(realCoverage.failed, `the coverage case is red before any mutation:\n${realCoverage.output}`).toBe(0);

    const { suite } = buildMutant(scratch);

    const mutantCoverage = runOneCase(suite, COVERAGE_CASE, report);
    expect(mutantCoverage.ran, `the coverage case never ran in the mutant — resolution, not a verdict:\n${mutantCoverage.output}`)
      .toBe(1);
    expect(mutantCoverage.failed, `a reader that read nothing satisfied the coverage case:\n${mutantCoverage.output}`)
      .toBe(1);

    const mutantProximity = runOneCase(suite, PROXIMITY_CASE, report);
    expect(mutantProximity.ran, `the proximity case never ran in the mutant:\n${mutantProximity.output}`).toBe(1);
    // The half that makes this a measurement of the SPLIT rather than of the
    // mutant: if this went red too, the two cases would be answering one
    // question and coverage would be redundant.
    expect(
      mutantProximity.failed,
      `the proximity case also went red, so it is not independent of coverage:\n${mutantProximity.output}`,
    ).toBe(0);
  }, 300000);
});
