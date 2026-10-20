/**
 * #751 — nothing compared the union of the sub-issues' `filesToModify`
 * against `discovery.filesToModify`, so the issue's own central file could be
 * claimed by nobody.
 *
 * `workflows/ship.js` interpolates the discovered list into the to-issues
 * prompt as "Files to modify" and then validates the answer two ways — no
 * out-of-scope claim, no overlap between sub-issues. Both ask whether the
 * plan claims TOO MUCH. Nothing asked whether it claims too little.
 *
 * On asaCommandCenter#1585 the file the issue was about was claimed by no
 * sub-issue, edited by two worktrees, and SC-413 refused at Commit after
 * 2h06m and 2.03M subagent tokens. That refusal is correct and is untouched
 * here; this moves the detection to plan time, where it costs nothing.
 *
 * ## The decision, made rather than left open
 *
 * **Option 1 of the three #751 named: refuse the parallel plan and fall back
 * to single-agent implement**, the same branch `hasOverlap` already takes one
 * line away. The argument and both counter-arguments live in
 * `lib/plan-coverage.ts`, which is where someone will come to reverse it.
 *
 * ## Why a parity matrix
 *
 * `ship.js` runs in a sandbox with no imports (#69), so the decision exists
 * twice — `lib/plan-coverage.ts` and a marked block in the workflow. Every
 * case below runs over BOTH, so drift is red rather than invisible. The
 * inlined copy sits inside the SCOPE-DENYLIST block on purpose: `normalisePath`
 * decides whether two spellings are one file, and a second copy of that
 * decision would agree on every input anyone has and diverge on the one that
 * matters.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * #751 names it: **treat an absent or empty `discovery.filesToModify` as
 * satisfied.** It silences every synthetic fixture and leaves exactly the
 * #1585 case uncaught, because the thing that needs covering is a list
 * nobody is obliged to produce. `AC-3` is the case that survives it — the
 * empty reading must be UNMEASURED and must REFUSE, not pass.
 *
 * ## A precondition this battery cannot reach, said rather than omitted
 *
 * `ship.js` only decomposes when
 * `discovery.sizing === 'M' && (discovery.filesToModify || []).length >= 3`,
 * so **the empty-discovery branch is unreachable from today's call site.**
 * Every live plan arrives with at least three files. It is still built and
 * still refuses, because that precondition is one `if` in another function
 * and nothing holds it still — a branch that is only correct while an
 * unrelated guard keeps its shape goes silently wrong the day that guard
 * moves (#492). The cases here drive it directly for the same reason.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/scope-denylist.test.ts` (84 tests). Counts
 * predicted in `/tmp/751-battery/predictions.md` before the battery ran, and
 * **the baseline row read first.**
 *
 * Every case runs over BOTH copies, so the arithmetic has a shape worth
 * stating: a mutation applied to one copy reds that copy's half AND the
 * parity row, while a mutation applied to both reds both halves and leaves
 * parity green. A row that does not follow that pattern is a row to re-read.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 84 pass, 0 fail | **84 pass, 0 fail** | — |
 * | M1 **the defect restored**: ship.js drops the `else if (coverageRefusal)` branch | 1 | **1 of 84** | the workflow source: the original logs the refusal and falls back, the mutant uses the plan |
 * | M2 **the cheapest wrong fix**: an empty discovery list treated as satisfied, both copies | 6 | **6 of 84** | `planCoverage([], PLAN_COMPLETE)`: the original is UNMEASURED and refuses, the mutant is MEASURED with `uncovered: []` |
 * | M3 `uncovered` always `[]`, **lib only** | 7 | **6 of 84** | `planCoverage(DISCOVERED_1585, PLAN_1585)`: the original names `config-templates/solution-plays.json`, the mutant names nothing |
 * | M4 the claimed set built from raw strings, not `normalisePath`, both copies | 2 | **2 of 84** | a plan claiming `./lib/a.ts` against a discovery of `lib/a.ts` |
 * | M5 `planCoverageRefusal` returns `null` for UNMEASURED, both copies | 4 | **4 of 84** | the same empty-discovery reading: the original refuses, the mutant lets the plan run |
 * | M6 `uncovered` reports the normalised spelling, not discovery's | 2 | **2 of 84** | a discovery entry of `./lib/a.ts`: the original reports it verbatim, the mutant reports `lib/a.ts`, which is in no file |
 *
 * **M3 came back one LOW, and it is not a collapsed pair.** The five lib-half
 * cases and the parity row are red; the seventh I predicted was *"the matrix
 * contains rows that disagree with each other"*, which stays green for a true
 * reason — the readings still differ in `reading`, `discovered` and `claimed`
 * even with `uncovered` emptied, so more than three distinct readings remain.
 * The prediction counted a case that is about the matrix, not about the
 * field being mutated.
 *
 * **M1 is 1 and that is the number to want, not a weak row.** The wiring has
 * exactly one witness because there is exactly one thing to witness: that
 * `ship.js` consults the binding it defines. Everything else about the
 * behaviour is measured through the binding itself, twice.
 *
 * None of the six mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and `lib/plan-coverage.ts` and
 * `workflows/ship.js` were confirmed byte-identical by sha256 after each row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  type PlanCoverageReading,
  type PlanSubIssue,
  planCoverage,
  planCoverageRefusal,
} from "../lib/plan-coverage";

const REPO = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── SCOPE-DENYLIST-START ────";
const BLOCK_END = "// ──── SCOPE-DENYLIST-END ────";
const COVERAGE_START = "// ──── PLAN-COVERAGE-START ────";

/**
 * Module scope on purpose. A missing marker throws and every case in the file
 * fails to load, rather than skipping — which would turn "ship.js lost its
 * coverage check" into a quiet green.
 */
const inlined = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error(`ship.js is missing the ${BLOCK_START} / ${BLOCK_END} markers`);
  }
  if (!shipSource.includes(COVERAGE_START)) {
    throw new Error(`ship.js is missing ${COVERAGE_START} — the matrix would compare nothing`);
  }
  if (shipSource.indexOf(COVERAGE_START) > end) {
    throw new Error(
      `ship.js's plan-coverage block sits OUTSIDE the deny-list block, so it no longer shares ` +
        `normalisePath — two notions of "same path" in one workflow`,
    );
  }
  const body = shipSource.slice(start + BLOCK_START.length, end);
  const fns = new Function(`${body}\nreturn { planCoverage, planCoverageRefusal, normalisePath }`)();
  for (const name of ["planCoverage", "planCoverageRefusal", "normalisePath"]) {
    if (typeof fns[name] !== "function") {
      throw new Error(`ship.js's deny-list block does not define ${name}`);
    }
  }
  return fns as {
    planCoverage: typeof planCoverage;
    planCoverageRefusal: typeof planCoverageRefusal;
    normalisePath: (p: string) => string;
  };
})();

/** Every case runs over both copies, so a divergence is a failure here. */
const IMPLS: [string, typeof planCoverage, typeof planCoverageRefusal][] = [
  ["lib/plan-coverage.ts", planCoverage, planCoverageRefusal],
  ["workflows/ship.js (inlined)", inlined.planCoverage, inlined.planCoverageRefusal],
];

/** #1585's shape: the file the issue was about, allocated to nobody. */
const DISCOVERED_1585 = [
  "config-templates/solution-plays.json",
  "src/plays/loader.ts",
  "src/plays/render.tsx",
  "test/plays.test.ts",
];

const PLAN_COMPLETE: PlanSubIssue[] = [
  { title: "loader", filesToModify: ["src/plays/loader.ts", "config-templates/solution-plays.json"] },
  { title: "render", filesToModify: ["src/plays/render.tsx", "test/plays.test.ts"] },
];

/** The same plan with the central file dropped — the run that actually happened. */
const PLAN_1585: PlanSubIssue[] = [
  { title: "loader", filesToModify: ["src/plays/loader.ts"] },
  { title: "render", filesToModify: ["src/plays/render.tsx", "test/plays.test.ts"] },
];

for (const [name, coverage, refusal] of IMPLS) {
  describe(`#751 [${name}] AC-1: a file no sub-issue claims is found at plan time`, () => {
    test("the uncovered file is named, and the complete plan is clean", () => {
      // Both directions in one case. The positive half alone is satisfied by
      // a check that reports every file; the negative half alone by one that
      // reports none.
      const gap = coverage(DISCOVERED_1585, PLAN_1585);
      expect(gap.reading).toBe("MEASURED");
      expect(gap.uncovered).toEqual(["config-templates/solution-plays.json"]);

      const clean = coverage(DISCOVERED_1585, PLAN_COMPLETE);
      expect(clean.reading).toBe("MEASURED");
      expect(clean.uncovered, "a complete plan was reported as incomplete").toEqual([]);
    });

    test("the pair varies exactly one thing — the same discovery, one file dropped", () => {
      // #585's discipline: the two plans differ in one entry of one
      // sub-issue and in nothing else, so comparing their verdicts is a
      // measurement of that entry rather than of two hand-written fixtures
      // that happen to differ.
      const dropped = PLAN_COMPLETE.map(s => ({
        ...s,
        filesToModify: (s.filesToModify || []).filter(
          f => f !== "config-templates/solution-plays.json",
        ),
      }));
      expect(
        dropped.flatMap(s => s.filesToModify).length,
        "the derived plan is not one file shorter, so it varies something else",
      ).toBe(PLAN_COMPLETE.flatMap(s => s.filesToModify || []).length - 1);

      expect(coverage(DISCOVERED_1585, PLAN_COMPLETE).uncovered).toEqual([]);
      expect(coverage(DISCOVERED_1585, dropped).uncovered).toEqual([
        "config-templates/solution-plays.json",
      ]);
    });

    test("the refusal names the file and says what it costs", () => {
      // "1 file uncovered" sends nobody anywhere. The sentence a run logs is
      // the only artefact an operator sees.
      const r = refusal(coverage(DISCOVERED_1585, PLAN_1585));
      expect(r, "a plan with an unclaimed file was not refused").not.toBeNull();
      expect(r!).toContain("config-templates/solution-plays.json");
      expect(r!, "the refusal does not say what happens next").toContain("single-agent");
      expect(r!, "the refusal does not connect to the audit that catches it late").toContain("SC-413");

      expect(
        refusal(coverage(DISCOVERED_1585, PLAN_COMPLETE)),
        "a complete plan was refused",
      ).toBeNull();
    });

    test("a plan claiming a file discovery never named is not reported here", () => {
      // Deliberate. Claiming too much is `denylistViolations`' question and
      // `hasOverlap`'s; answering it again would make this a second decider
      // for a question that already has two, and a mutation of any of them
      // would leave the others holding the case up.
      const r = coverage(["a.ts"], [{ filesToModify: ["a.ts", "extra.ts"] }]);
      expect(r.uncovered).toEqual([]);
      expect(r.claimed, "the extra file was not counted in the plan's own total").toBe(2);
      expect(refusal(r)).toBeNull();
    });
  });

  describe(`#751 [${name}] AC-2: spellings are compared through one notion of "same path"`, () => {
    test("./lib/a.ts in the plan covers lib/a.ts in discovery", () => {
      // Reuses the deny-list's `normalisePath`, so the two checks cannot
      // disagree about whether a plan entry and a discovery entry are the
      // same file.
      expect(coverage(["lib/a.ts"], [{ filesToModify: ["./lib/a.ts"] }]).uncovered).toEqual([]);
      expect(coverage(["./lib/a.ts"], [{ filesToModify: ["lib/a.ts"] }]).uncovered).toEqual([]);
      expect(coverage(["lib/sub/../a.ts"], [{ filesToModify: ["lib/a.ts"] }]).uncovered).toEqual([]);
    });

    test("and a genuinely different path is still uncovered", () => {
      // The control. Without it, the three above are satisfied by a
      // normaliser that maps everything to one value.
      expect(coverage(["lib/a.ts"], [{ filesToModify: ["lib/b.ts"] }]).uncovered).toEqual([
        "lib/a.ts",
      ]);
    });

    test("the uncovered list reports discovery's spelling, not the normalised one", () => {
      // An operator greps the log for the path they wrote. Reporting
      // `lib/a.ts` for a discovery entry of `./lib/a.ts` sends them to a
      // string that is in no file.
      expect(coverage(["./lib/a.ts"], [{ filesToModify: ["lib/zzz.ts"] }]).uncovered).toEqual([
        "./lib/a.ts",
      ]);
    });
  });

  describe(`#751 [${name}] AC-3: an empty discovery is UNMEASURED and REFUSES`, () => {
    test("the cheapest wrong fix — empty means satisfied — is what this blocks", () => {
      // The union of nothing is covered by any plan at all. Reading that as
      // "the plan is complete" is the third shape, and #751 names it as the
      // cheapest wrong fix for this check specifically.
      for (const empty of [[], null, undefined]) {
        const r = coverage(empty as string[] | null, PLAN_COMPLETE);
        expect(r.reading, `discovery ${JSON.stringify(empty)} was read as a measurement`).toBe(
          "UNMEASURED",
        );
        expect(r.uncovered, "an unmeasured reading produced a file list").toEqual([]);
        expect(
          refusal(r),
          "a plan nobody could check was allowed to run in parallel",
        ).not.toBeNull();
      }
    });

    test("an empty PLAN is UNMEASURED too, for its own reason", () => {
      // "Discovery found nothing" and "the decomposer produced nothing" are
      // different facts with different fixes, and a single word for both
      // sends you to the wrong one.
      const r = coverage(DISCOVERED_1585, []);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join(" ")).toContain("no sub-issues");
      expect(r.unmeasuredReasons.join(" ")).not.toContain("named no files");
    });

    test("the two unmeasured reasons are distinguishable from each other", () => {
      const noFiles = coverage([], PLAN_COMPLETE);
      const noPlan = coverage(DISCOVERED_1585, []);
      expect(noFiles.unmeasuredReasons).not.toEqual(noPlan.unmeasuredReasons);
      expect(noFiles.unmeasuredReasons.join(" ")).toContain("named no files");
    });

    test("the UNMEASURED refusal says it could not measure, not that a file is missing", () => {
      // Two states, two sentences. An operator told "1 file uncovered" for a
      // run where discovery produced nothing goes looking for a file.
      const r = refusal(coverage([], PLAN_COMPLETE));
      expect(r!).toContain("UNMEASURED");
      expect(r!, "an unmeasured reading was reported as uncovered files").not.toContain(
        "claimed by\nno sub-issue",
      );
    });
  });

  describe(`#751 [${name}] AC-4: a PASS reports its own coverage`, () => {
    test("the reading carries how many files it compared", () => {
      // `36/426` and `426/426` are the same PASS today, and no reader can
      // tell them apart from the output
      // (`.claude/rules/checks-must-be-able-to-fail.md`).
      const r = coverage(DISCOVERED_1585, PLAN_COMPLETE);
      expect(r.discovered).toBe(4);
      expect(r.claimed).toBe(4);
    });
  });
}

describe("#751 AC-5: the two copies agree, and the matrix is not comparing nothing", () => {
  const MATRIX: [string[], PlanSubIssue[]][] = [
    [DISCOVERED_1585, PLAN_1585],
    [DISCOVERED_1585, PLAN_COMPLETE],
    [[], PLAN_COMPLETE],
    [DISCOVERED_1585, []],
    [["./lib/a.ts"], [{ filesToModify: ["lib/a.ts"] }]],
    [["lib/a.ts", "lib/a.ts"], [{ filesToModify: ["lib/b.ts"] }]],
  ];

  test("every matrix row produces an identical reading from both copies", () => {
    for (const [discovered, plan] of MATRIX) {
      const a: PlanCoverageReading = planCoverage(discovered, plan);
      const b: PlanCoverageReading = inlined.planCoverage(discovered, plan);
      expect(b, `ship.js and lib disagree on ${JSON.stringify({ discovered, plan })}`).toEqual(a);
      expect(inlined.planCoverageRefusal(b)).toEqual(planCoverageRefusal(a));
    }
  });

  test("the matrix contains rows that disagree with each other", () => {
    // Without this the agreement case is satisfied by two functions that
    // both return the same constant for every input.
    const readings = MATRIX.map(([d, p]) => JSON.stringify(planCoverage(d, p)));
    expect(new Set(readings).size, "every matrix row produces the same reading").toBeGreaterThan(3);
  });

  test("ship.js calls the check it defines, with discovery's list and the plan", () => {
    // A perfect binding nobody calls is #530's shape. The block can be
    // flawless while the decomposition branch never consults it.
    expect(
      shipSource,
      "ship.js defines planCoverage and never calls it from the decomposition branch",
    ).toContain("planCoverageRefusal(planCoverage(discovery.filesToModify, decompResult.subIssues))");
    expect(
      shipSource,
      "the refusal is computed and never logged, so a run would fall through silently",
    ).toContain("log(coverageRefusal)");
  });
});
