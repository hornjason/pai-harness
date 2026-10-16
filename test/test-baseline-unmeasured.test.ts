/**
 * Covers SC-1672..SC-1677 and SC-1681..SC-1683 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #307 SC-A6,
 * SC-A7, SC-A10.
 *
 * `captureTestBaseline` runs the project's suite before any change lands and
 * records how many tests were already failing, so the verify gate can subtract
 * them. It answered `0` for four different facts:
 *
 *   1. the project has no `.claude/rungate.json` — including every project on
 *      the documented directory layout, which it never looked at
 *   2. the config has no `test.command` — including every project that
 *      authored `dev.testCmd` instead, which is the canonical spelling
 *   3. the suite ran and printed something this harness cannot parse
 *   4. the suite ran and nothing was failing
 *
 * Only the fourth is a clean tree, and the scope gate printed
 * "0 pre-existing failures — clean suite" for all four. That sentence is the
 * strongest claim the baseline can make — it asserts the tree was green before
 * the change — and three of the four times it was made, nothing had been
 * measured at all.
 *
 * ## Why the fixtures are shaped the way they are
 *
 * `captureTestBaseline` WORKS on rungate. This repo's own config carries
 * `test.command`, so the one branch that reads a command finds one, and a
 * rungate-shaped fixture is green against the broken code and the fixed code
 * alike. That is why the defect survived: every test anyone would naturally
 * write proves nothing.
 *
 * So the fixtures here are shaped like a real consumer that is NOT this repo —
 * `dev.testCmd` and no `test` block, on both layouts — and the suite command is
 * a `printf` that emits bun-shaped output, so the measured arm runs a real
 * `execSync` in milliseconds rather than standing in a mock that would have to
 * be kept honest.
 *
 * `.claude/rules/config-access.md`: "`0`, `{}`, `null` and `SKIP` are all
 * indistinguishable from success; `UNMEASURED` is not."
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  baselineAdjustment,
  captureTestBaseline,
  extractTestFailureCount,
  parseTestFailureCount,
  recordTestBaseline,
} from "../gates/gate-executor";

/** A suite command that prints bun's summary shape without running a suite. */
const PRINTS = (pass: number, fail: number) =>
  `printf ' ${pass} pass\\n ${fail} fail\\n'`;

/** Make a throwaway project root and hand it to `fn`. */
function inProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rg-307-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The monolith layout: `.claude/rungate.json`. */
function monolith(root: string, config: Record<string, unknown>): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate.json"), JSON.stringify(config));
}

/** The directory layout: `.claude/rungate/config.json`. */
function directory(root: string, config: Record<string, unknown>): void {
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config));
}

/** The consumer shape this issue is about: `dev.testCmd`, no `test` block. */
const CONSUMER = (cmd: string) => ({
  project: "consumer-shaped",
  repo: "x/y",
  issueRepo: "x/y",
  dev: { testCmd: cmd, apiBase: "http://localhost:7778", uiBase: "http://localhost:5173" },
  pages: { dashboard: "/" },
});

describe("#307: the test baseline says what it measured", () => {
  test("SC-1672: a project whose only test command is dev.testCmd is measured - not assumed clean", () => {
    // The DDB-shaped case, and the reason SC-A7 insists on this fixture. The
    // old reader asked for `harness.test?.command`, found nothing, and
    // returned 0 — a consumer that authored the canonical spelling got the
    // strongest possible claim made about a suite nobody ran.
    inProject(root => {
      monolith(root, CONSUMER(PRINTS(42, 3)));
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("measured");
      if (reading.status !== "measured") throw new Error("unreachable");
      // 3, not 0. A reader that still returned 0 here would be reporting a
      // clean tree over a suite with three pre-existing failures, and the
      // verify gate would attribute all three to the change.
      expect(reading.failures).toBe(3);
      expect(reading.command).toBe(PRINTS(42, 3));
    });
  });

  test("SC-1673: a project on the directory layout is read at all", () => {
    // `.claude/rungate/` is the documented layout and the old code built the
    // monolith path by hand, so every migrated consumer fell into the
    // not-configured branch and was reported clean. Same assertion as above
    // against the other layout, because a reader that handled only one would
    // pass the first case.
    inProject(root => {
      directory(root, CONSUMER(PRINTS(10, 2)));
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("measured");
      if (reading.status !== "measured") throw new Error("unreachable");
      expect(reading.failures).toBe(2);
    });
  });

  test("SC-1674: a project with no test command anywhere reports UNMEASURED - not zero", () => {
    inProject(root => {
      monolith(root, { project: "no-suite", repo: "x/y", issueRepo: "x/y" });
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status).toBe("unmeasured");
      if (reading.status !== "unmeasured") throw new Error("unreachable");
      // The reason has to name both spellings. "No test command" sends an
      // operator looking for the key they already did not set.
      expect(reading.reason).toContain("dev.testCmd");
      expect(reading.reason).toContain("test.command");
    });
  });

  test("SC-1675: an absent config is UNMEASURED - a project with no rungate is not a clean tree", () => {
    inProject(root => {
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status).toBe("unmeasured");
      if (reading.status !== "unmeasured") throw new Error("unreachable");
      expect(reading.reason).toContain("no rungate config");
    });
  });

  test("SC-1676: output the harness cannot parse is UNMEASURED - not a clean suite", () => {
    // The consumer-facing half. `dev.testCmd` is whatever the project runs —
    // jest, pytest, go test, a Makefile target — and none of those print
    // bun's ` N fail` line. The parser found no count, answered 0, and the
    // gate called it a clean suite. This is the same defect as the two above
    // arriving through the one branch that does run something.
    inProject(root => {
      monolith(root, CONSUMER("printf 'ok 1 - everything is fine\\n'"));
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("unmeasured");
      if (reading.status !== "unmeasured") throw new Error("unreachable");
      // Actionable: the reason quotes what the command actually printed, so
      // an operator can see it was read and not merely unrecognised.
      expect(reading.reason).toContain("ok 1 - everything is fine");
    });
  });

  test("a suite that genuinely passes is measured at zero - the arm that must stay reachable", () => {
    // The positive control for all five cases above. Every one of them
    // asserts something is NOT zero, and a `captureTestBaseline` that had
    // stopped being able to answer zero at all would satisfy the lot.
    inProject(root => {
      monolith(root, CONSUMER(PRINTS(42, 0)));
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status).toBe("measured");
      if (reading.status !== "measured") throw new Error("unreachable");
      expect(reading.failures).toBe(0);
    });
  });

  test("a command that exits non-zero is still measured from what it printed", () => {
    // A suite with failures exits 1, so `execSync` throws and the count has
    // to come off `e.stdout`. The old code did this and it was the one part
    // worth keeping; a rewrite that lost it would report every failing suite
    // as unmeasured and silently stop subtracting real baselines.
    inProject(root => {
      monolith(root, CONSUMER(`${PRINTS(40, 5)}; exit 1`));
      const reading = captureTestBaseline({ projectRoot: root });

      expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("measured");
      if (reading.status !== "measured") throw new Error("unreachable");
      expect(reading.failures).toBe(5);
    });
  });
});

describe("#307: what the reading does once it is taken", () => {
  test("SC-1681: an unmeasured reading records no number - the reason cannot sit beside a zero", () => {
    // The reading being honest buys nothing if the two lines that record it
    // write a 0 anyway: `?? 0` at the verify gate would read that as a
    // measured clean tree, which is the defect one field over.
    const baselines: Record<string, any> = {};
    recordTestBaseline(baselines, { status: "unmeasured", reason: "no suite configured" });

    expect(baselines.testBaseline, "a number was recorded for a reading that has none").toBeUndefined();
    expect(baselines.testBaselineUnmeasured).toBe("no suite configured");
  });

  test("SC-1682: a later measured reading clears the earlier reason - the two keys are exclusive", () => {
    // Both directions, over the same object, because a recorder that only
    // ever adds leaves a stale reason beside a fresh number and the verify
    // gate has two answers to pick from.
    const baselines: Record<string, any> = {};
    recordTestBaseline(baselines, { status: "unmeasured", reason: "no suite configured" });
    recordTestBaseline(baselines, { status: "measured", failures: 4, command: "bun test" });

    expect(baselines.testBaseline).toBe(4);
    expect(baselines.testBaselineUnmeasured, "the stale reason survived a real measurement").toBeUndefined();
  });

  test("SC-1683: the verify gate separates an unmeasured baseline from a measured zero", () => {
    // Both subtract nothing, so the arithmetic cannot tell them apart and
    // this is the only place that can. Asserted against each other in one
    // test so they cannot drift into agreeing.
    expect(baselineAdjustment({ testBaselineUnmeasured: "no suite configured" }, 7)).toEqual({
      kind: "unmeasured",
      reason: "no suite configured",
    });
    expect(baselineAdjustment({ testBaseline: 0 }, 7)).toEqual({ kind: "none" });

    // A real baseline still subtracts, which is the behaviour #599 added and
    // this issue must not cost.
    expect(baselineAdjustment({ testBaseline: 3 }, 7)).toEqual({ kind: "subtract", baseline: 3, fails: 4 });
    // ...clamped, per subtractTestBaseline.
    expect(baselineAdjustment({ testBaseline: 9 }, 7)).toEqual({ kind: "subtract", baseline: 9, fails: 0 });
  });

  test("a run from before this change still reads as none, not as unmeasured", () => {
    // Durable state written by an older scope gate has `testBaseline: 0` and
    // no reason key, and a verify gate that WARNed on it would warn on every
    // in-flight run the moment this lands. Absent baselines likewise.
    expect(baselineAdjustment({ testBaseline: 0, tscBaseline: 0 }, 2)).toEqual({ kind: "none" });
    expect(baselineAdjustment(undefined, 2)).toEqual({ kind: "none" });
    expect(baselineAdjustment({}, 2)).toEqual({ kind: "none" });
    // ...and an empty reason is not a reason. A `""` written by a future
    // caller would otherwise WARN with nothing to say.
    expect(baselineAdjustment({ testBaselineUnmeasured: "" }, 2)).toEqual({ kind: "none" });
  });
});

describe("#307: the parser can say it found no count", () => {
  test("SC-1677: parseTestFailureCount returns null where extractTestFailureCount returns zero", () => {
    // One binding, two readings. `extractTestFailureCount` is consumed by
    // `gates/workflow.test.ts`, whose contract this issue is forbidden to
    // change, so the nullable answer is a sibling rather than a widening —
    // and the two are asserted against each other here so the wrapper cannot
    // drift away from the parser it wraps.
    expect(parseTestFailureCount(" 42 pass\n")).toBeNull();
    expect(extractTestFailureCount(" 42 pass\n")).toBe(0);

    // ...and where a count IS stated the two agree, which is what makes the
    // disagreement above meaningful rather than a wrapper that always zeroes.
    expect(parseTestFailureCount(" 42 pass\n 3 fail\n")).toBe(3);
    expect(extractTestFailureCount(" 42 pass\n 3 fail\n")).toBe(3);

    // A stated zero is a measurement. This is the distinction the whole
    // issue turns on, in one line: bun prints ` 0 fail` on a clean run.
    expect(parseTestFailureCount(" 42 pass\n 0 fail\n")).toBe(0);
  });
});
