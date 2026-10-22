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
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  budgetMembershipViolations,
  budgetSurfaceCoverage,
  durationCoverageViolations,
  parseJunitDurations,
  readJunitDurations,
  type BudgetSurface,
  type JunitDurationReading,
} from "../lib/junit-checks";
import { perTestTimeoutDeclarations } from "../lib/per-test-timeouts";
import {
  BUDGET_FLOOR_MS,
  CALIBRATION_RUNS,
  GIT_FIXTURE_SUITES,
  HEADROOM_MULTIPLE,
  INHERITED_DEFAULT_MS,
  PATHOLOGICAL_CASE_MS,
  SLOWEST_CASE_IN_FIXTURES,
  SLOWEST_CASE_MS,
  calibrateGitFixture,
  declaresFileBudget,
  gitFixtureBudget,
  gitFixtureSurface,
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

// ── AC-5: the list can see a file that is NOT on it (#1172) ──────────────

/**
 * The growth direction, which `AC-3` above cannot reach.
 *
 * `AC-3` iterates `GIT_FIXTURE_SUITES` and asserts each named file declares
 * a budget. That is one direction: a file ON the list must declare. A file
 * that *should* be on the list and is not is invisible to it, so the list
 * can go stale in silence — someone adds an eighth `ai-review-*` suite built
 * on `checkout()`, it inherits 5000ms, nothing reddens, and the first anyone
 * hears is the "is this red mine?" rebase tax #1140 was filed about.
 *
 * ## What is planted, and what it is planted against
 *
 * A real `bun test --reporter=junit` run over four scratch files — bun's
 * actual output, not hand-written XML, because the `file=` attribution is
 * half of what is being tested and a hand-written string would make every
 * assertion below a fact about that string. MEASURED on bun 1.3.14, the
 * attribute is repo-relative (`file="test/ai-review-wif.test.ts"`) while the
 * member list holds bare basenames, and comparing the two spellings directly
 * is a check that matches nothing and reports clean.
 *
 * | scratch file | sleeps | on surface | on list | expected |
 * |---|---|---|---|---|
 * | `ai-review-planted-growth.test.ts` | 300ms | yes | **no** | **reported** |
 * | `ai-review-wif.test.ts` | 100ms | yes | no | not reported — the real near-miss, by name |
 * | `ai-review-restore-index.test.ts` | 700ms | yes | yes | not reported — already budgeted |
 * | `scaffold-not-ai-review.test.ts` | 400ms | **no** | no | not reported |
 *
 * Driven against a 500ms inherited budget rather than the real 5000ms, so
 * the fixture costs ~1.5s instead of ~15s. The arithmetic is identical and
 * the band is the same fraction; `AC-5a` is what pins the real number.
 */

/** The fixture's stand-in for the inherited default. See the block above. */
const FIXTURE_INHERITED_MS = 500;

/**
 * `gitFixtureSurface` re-priced and re-pointed at a scratch tree.
 *
 * `members` is the planted roster, because it is what `budgetSurfaceCoverage`
 * compares the reading against — a scratch run obviously does not contain the
 * repo's seven. It does NOT gate the membership verdict; `declaresOwnBudget`
 * does, and it reads the scratch sources.
 */
const fixtureSurface = (dir: string): BudgetSurface => ({
  ...gitFixtureSurface(b => declaresFileBudget(b, dir)),
  members: PLANTED_MEMBERS,
  inheritedMs: FIXTURE_INHERITED_MS,
});

/**
 * The scratch files and their sleeps.
 *
 * `declares` mirrors reality rather than decorating the fixture: the member
 * is the only one carrying `setDefaultTimeout`, because that is what being
 * on the list means and it is what `AC-3`'s mechanism reads. Without it the
 * baseline row of the wrong-fix case is red before any repair is applied,
 * and the repair's silence would prove nothing — MEASURED, that is exactly
 * how the first draft of that case failed.
 */
const PLANTED: Array<{ file: string; sleepMs: number; declares: boolean }> = [
  { file: "ai-review-planted-growth.test.ts", sleepMs: 300, declares: false },
  { file: "ai-review-wif.test.ts", sleepMs: 100, declares: false },
  { file: "ai-review-restore-index.test.ts", sleepMs: 700, declares: true },
  { file: "scaffold-not-ai-review.test.ts", sleepMs: 400, declares: false },
];

/** The one file the fixture pretends is already on the list. */
const PLANTED_MEMBERS = ["ai-review-restore-index.test.ts"] as const;

/** `N pass` / `N fail` off a bun run's summary. */
function summaryCount(output: string, label: string): number {
  const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
  return m ? Number(m[1]) : 0;
}

/** Run the planted surface and read bun's own JUnit report of it. */
function plantedReading(dir: string): { reading: JunitDurationReading; report: string } {
  for (const { file, sleepMs, declares } of PLANTED) {
    writeFileSync(
      join(dir, file),
      `import { setDefaultTimeout, test } from "bun:test";\n` +
        (declares ? `setDefaultTimeout(120000);\n` : "") +
        `test("the only case in ${file}", async () => {\n` +
        `  await new Promise(r => setTimeout(r, ${sleepMs}));\n` +
        `});\n`,
    );
  }
  const report = join(dir, "planted.xml");
  const r = spawnSync("bun", ["test", ".", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 120000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // The instrument first: a run that produced no verdict reports no
  // violations either, and that is indistinguishable from a clean surface.
  expect(summaryCount(out, "pass"), `the planted surface did not run as intended:\n${out}`).toBe(
    PLANTED.length,
  );
  expect(summaryCount(out, "fail"), `a planted case failed, so its duration is not a reading:\n${out}`).toBe(0);
  return { reading: readJunitDurations(report), report };
}

/**
 * `AC-3`'s mechanism, applied to the planted tree.
 *
 * This is the cheapest wrong fix, performed rather than described: it is
 * what "add the near-misses to `GIT_FIXTURE_SUITES`" actually buys. It
 * iterates the ROSTER, so its answer is bounded by the roster's contents no
 * matter how large the roster gets.
 */
function ac3StyleViolations(dir: string, members: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of members) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const found = perTestTimeoutDeclarations(readFileSync(path, "utf-8"));
    if (found === null || found.filter(d => d.kind === "file-default").length !== 1) {
      out.push(`${file} is on the list and declares no file-level budget`);
    }
  }
  return out;
}

describe("AC-5 (#1172): the budget can see an ai-review suite that is NOT on its list", () => {
  test("the inherited default is the number the runner actually enforces", () => {
    // Without this, the qualifying band is a fraction of a constant nobody
    // checked. #621 MEASURED that `[test] timeout` in bunfig.toml is not read
    // by the runner at all, so there is nowhere in the repo to read this
    // from and a literal is the only option — which makes probing it the
    // only thing that stops it being decorative.
    const dir = mkdtempSync(join(tmpdir(), "inherited-default-probe-"));
    try {
      const sleepFor = INHERITED_DEFAULT_MS + 1500;
      writeFileSync(
        join(dir, "probe.test.ts"),
        `import { test } from "bun:test";\n` +
          `test("sleeps past the inherited default", async () => {\n` +
          `  await new Promise(r => setTimeout(r, ${sleepFor}));\n` +
          `});\n`,
      );
      // No bunfig and no --timeout: exactly what an undeclared file inherits.
      const r = spawnSync("bun", ["test", "probe.test.ts"], {
        cwd: dir,
        encoding: "utf-8",
        timeout: sleepFor + 60000,
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(
        summaryCount(out, "pass") + summaryCount(out, "fail"),
        `the probe run produced no summary at all:\n${out}`,
      ).toBe(1);
      const killed = /timed out after (\d+)ms/.exec(out);
      expect(
        killed,
        `the runner let a ${sleepFor}ms undeclared case finish, so nothing is inherited and the ` +
          `qualifying band below is a fraction of a number that bounds nothing:\n${out}`,
      ).not.toBeNull();
      expect(
        Number(killed![1]),
        `an undeclared case inherits ${killed![1]}ms, not the ${INHERITED_DEFAULT_MS}ms this file bands against`,
      ).toBe(INHERITED_DEFAULT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

  test("a planted unbudgeted slow suite is named, and the three near-miss classes are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-growth-planted-"));
    try {
      const { reading, report } = plantedReading(dir);
      expect(reading.durations, `the planted report could not be read: ${reading.reason}`).not.toBeNull();
      expect(reading.count, "the planted report lists fewer cases than were planted").toBe(PLANTED.length);
      // The `file` attribution is half of what is under test, so assert the
      // reader got it rather than inferring it from the verdict.
      expect(new Set(reading.durations!.map(d => d.file.split("/").pop()))).toEqual(
        new Set(PLANTED.map(p => p.file)),
      );

      const surface = fixtureSurface(dir);
      expect(
        budgetSurfaceCoverage(reading, surface, report),
        "the planted reading does not cover its own surface, so the verdict below is vacuous",
      ).toEqual([]);

      const violations = budgetMembershipViolations(reading, surface);
      const named = (fragment: string) => violations.filter(v => v.includes(fragment));
      expect(
        named("ai-review-planted-growth.test.ts"),
        `the new unbudgeted suite was not reported — this is the whole gap #1172 is about:\n${violations.join("\n")}`,
      ).toHaveLength(1);
      expect(
        named("ai-review-wif.test.ts"),
        "a fast suite was reported, so the fix hands 120s ceilings to files that cost nothing",
      ).toHaveLength(0);
      expect(
        named("ai-review-restore-index.test.ts"),
        "a file already on the list was reported — its duration is taken UNDER the raised budget, so " +
          "reporting it makes the check red forever",
      ).toHaveLength(0);
      expect(
        named("scaffold-not-ai-review.test.ts"),
        "a slow file outside the surface was reported — the pattern is not scoping anything",
      ).toHaveLength(0);
      expect(violations, `exactly one file qualifies:\n${violations.join("\n")}`).toHaveLength(1);
      // Named WITH its duration: a count alone tells nobody which file to go
      // and look at, which is the only use this check has.
      expect(violations[0]).toMatch(/300(\.\d+)?ms|3\d\d\.\d\dms/);

      // The band is arithmetic, not "it was slow". Against an inherited
      // budget four times the size nothing qualifies, and against one small
      // enough that every planted sleep clears it, the two non-members on
      // the surface qualify and the member still does not.
      expect(
        budgetMembershipViolations(reading, { ...surface, inheritedMs: FIXTURE_INHERITED_MS * 4 }),
        "a 4x inherited budget still qualifies something — the comparison is not doing arithmetic",
      ).toHaveLength(0);
      const wide = budgetMembershipViolations(reading, { ...surface, inheritedMs: 50 });
      expect(wide.map(v => v.split(" ")[0]).sort(), `a tiny budget qualifies every non-member ON the surface`).toEqual(
        ["ai-review-planted-growth.test.ts", "ai-review-wif.test.ts"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

  test("widening the roster — the cheapest wrong fix — reports nothing about the new arrival", () => {
    // NAMED AND MEASURED, not dismissed in prose. "Add the near-misses to
    // GIT_FIXTURE_SUITES" changes who is on the roster without changing how
    // membership is DETERMINED, so the next arrival is exactly as invisible
    // as this one was.
    const dir = mkdtempSync(join(tmpdir(), "budget-growth-wrongfix-"));
    try {
      const { reading } = plantedReading(dir);

      const asShipped = ac3StyleViolations(dir, PLANTED_MEMBERS);
      const widened = ac3StyleViolations(dir, [...PLANTED_MEMBERS, "ai-review-wif.test.ts"]);
      const measured = budgetMembershipViolations(reading, fixtureSurface(dir));

      // The baseline row first: the roster mechanism is clean today, which
      // is why nobody has noticed it cannot grow.
      expect(asShipped, `the roster mechanism is already red, so its silence below proves nothing`).toEqual([]);
      // Widening it produces findings — about the file that was already fine.
      expect(widened, "widening the roster produced no finding at all").toHaveLength(1);
      expect(widened.join("\n")).toContain("ai-review-wif.test.ts");
      // …and NOT ONE of them is about the suite that is actually at risk.
      expect(
        widened.filter(v => v.includes("ai-review-planted-growth.test.ts")),
        "the roster mechanism saw the new arrival, so this is not the wrong fix after all",
      ).toHaveLength(0);
      // One input, two mechanisms, different answers. That difference is the
      // issue.
      expect(
        measured.filter(v => v.includes("ai-review-planted-growth.test.ts")),
        "the duration mechanism did not see it either, so nothing here is an improvement",
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

  test("coverage and membership are two questions: one input moves one of them", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-growth-split-"));
    for (const { file, sleepMs, declares } of PLANTED) {
      writeFileSync(
        join(dir, file),
        `import { setDefaultTimeout, test } from "bun:test";\n` +
          (declares ? `setDefaultTimeout(120000);\n` : "") +
          `test("c", async () => { await new Promise(r => setTimeout(r, ${sleepMs})); });\n`,
      );
    }
    // An empty reading, and a reading that saw everything EXCEPT the
    // surface, both satisfy the membership check perfectly by having nothing
    // on the surface in them. If coverage did not exist, "0 violations"
    // would mean both "clean" and "never looked", and no reader could tell.
    const surface = fixtureSurface(dir);

    const empty = parseJunitDurations(
      '<?xml version="1.0"?>\n<testsuites name="bun test" tests="0"></testsuites>\n',
    );
    expect(empty.durations, "an empty report is a measurement, not a refusal").toEqual([]);
    expect(budgetSurfaceCoverage(empty, surface, "an empty report")).not.toEqual([]);
    expect(
      budgetMembershipViolations(empty, surface),
      "membership also refused an empty reading, so the two are one question with two names",
    ).toEqual([]);

    // A full report of some OTHER surface. This is the dangerous one: it has
    // thousands of durations, so `durationCoverageViolations` calls it
    // complete, and it contains none of the files this check is about.
    const offSurface = parseJunitDurations(
      '<?xml version="1.0"?>\n<testsuites name="bun test" tests="1">\n' +
        '<testsuite name="test/scaffold-not-ai-review.test.ts" file="test/scaffold-not-ai-review.test.ts">\n' +
        '<testcase name="slow" classname="" time="4.0" file="test/scaffold-not-ai-review.test.ts" />\n' +
        "</testsuite>\n</testsuites>\n",
    );
    expect(durationCoverageViolations(offSurface, "an off-surface report")).toEqual([]);
    expect(
      budgetSurfaceCoverage(offSurface, surface, "an off-surface report").join("\n"),
      "a report that never saw the surface was accepted as coverage of it",
    ).toContain("UNMEASURED");

    // A PARTIAL reading of the surface is also not coverage: a qualifying
    // file outside the part that was run is invisible to it.
    const partial = parseJunitDurations(
      '<?xml version="1.0"?>\n<testsuites name="bun test" tests="1">\n' +
        '<testsuite name="test/ai-review-wif.test.ts" file="test/ai-review-wif.test.ts">\n' +
        '<testcase name="fast" classname="" time="0.1" file="test/ai-review-wif.test.ts" />\n' +
        "</testsuite>\n</testsuites>\n",
    );
    expect(
      budgetSurfaceCoverage(partial, surface, "a partial report").join("\n"),
      "a reading missing a file already on the list was accepted as complete",
    ).toContain("UNMEASURED");

    // An unreadable report refuses for a DIFFERENT reason, and says which.
    const missing = readJunitDurations(join(tmpdir(), "no-such-junit-report-1172.xml"));
    expect(missing.durations).toBeNull();
    expect(budgetSurfaceCoverage(missing, surface, "a missing report").join("\n")).toContain("could not be read");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the live ai-review surface, when a run supplies a reading of it", () => {
    // A `bun test` run cannot read its own JUnit report — it is written when
    // the run ends — so the real population arrives from outside, exactly as
    // in #621. Unset is UNMEASURED and says so; it is not a pass.
    const path = process.env.SUITE_JUNIT_REPORT;
    if (!path) {
      console.error(
        `[#1172] UNMEASURED: no suite JUnit report was provided. Set SUITE_JUNIT_REPORT to one written by ` +
          `\`bun test test/ai-review-*.test.ts --reporter=junit --reporter-outfile=<path>\` to hold ` +
          `${GIT_FIXTURE_SUITES.length} members against the whole ai-review surface.`,
      );
      return;
    }
    const reading = readJunitDurations(path);
    const surface = gitFixtureSurface();
    const coverage = budgetSurfaceCoverage(reading, surface, path);
    if (coverage.length > 0) {
      // Still UNMEASURED rather than red: a reading that did not cover the
      // surface says nothing about membership, in either direction.
      console.error(`[#1172] UNMEASURED: ${coverage.join("\n")}`);
      return;
    }
    const violations = budgetMembershipViolations(reading, surface);
    console.error(
      `[#1172] read ${reading.count} testcase durations from ${path}; ` +
        `${violations.length} ai-review-* files qualify for GIT_FIXTURE_SUITES and are not on it`,
    );
    expect(violations.join("\n"), `GIT_FIXTURE_SUITES has gone stale in the growth direction`).toBe("");
  }, 180000);
});
