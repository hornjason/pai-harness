/**
 * #832 (#830 Phase 2) — the new suite's case count is an assertion, not an
 * assumption.
 *
 * #830 Phase 1's suite is meant to be runnable one criterion at a time. This
 * file holds that as a property the repository asserts rather than one a
 * reader assumes: an AC-filtered run of it must RUN at least twelve cases,
 * and no case in the file may be invisible to such a run.
 *
 * The property is MEASURED, not greped. Counting `AC-` in the source text is
 * the cheap proxy, and a proxy is a thing people can satisfy directly — a
 * comment, a string literal, or a `describe` title none of the cases inherit
 * would all pass it while a filtered run still reached nothing. This file
 * runs the filter and reads what came back.
 *
 * ## Half of #832's stated premise is false, measured
 *
 * The issue motivates the floor with: a pattern matching zero tests "reports
 * zero failures and exits green". On bun 1.3.14 it does not. The runner
 * prints `error: regex "…" matched 0 tests. Searched 1 file (skipping 14
 * tests)` and **exits 1**. A zero-match is loud, and there is a case below
 * asserting exactly that — recorded rather than quietly dropped, because a
 * floor justified by a hazard nobody can reproduce is a floor the next
 * reader deletes, and because this is the half that could regress.
 *
 * ## The half that is real, and bit this file
 *
 * bun's JUnit report lists every testcase in the file whether it ran or not.
 * A filtered-out case is `<testcase …><skipped /></testcase>` — present,
 * named, and under `failures="0"`. So the REPORT from a run that executed
 * nothing is byte-shaped like the report from a clean run of everything, and
 * a consumer counting `<testcase name=` reads fourteen either way.
 *
 * This file's first draft did precisely that, and all of its readings were
 * green over an instrument that could not tell a run from a skip. That is
 * #532's trap, in the format #532 was recorded about. `parseJunitOutcomes`
 * in `lib/junit-checks.ts` is the one binding that already separates the
 * two, so the count comes from there and the two readings are compared
 * against each other below rather than trusted.
 *
 * Twelve is a FLOOR and not an equality on purpose. #830 Phase 1 carries six
 * acceptance criteria, each needing at least a witness and a control, and the
 * claim is about non-emptiness per criterion rather than about a total — an
 * equality is a number somebody else's work moves (#507, #637).
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Count `AC-` in the subject's source text and assert the count.** One
 * `match`, no spawn, no report to read, and it is green on a file whose
 * labels live in comments, in a `describe` title, or on cases that are
 * `.skip`ped. Row B2 is the same wrong instinct one level down — reading
 * the report by counting `<testcase` — applied and counted.
 *
 * ## What was broken to prove it
 *
 * Counted over this file + `test/reported-path-refusal.test.ts` (19 tests).
 * Every count predicted before the battery ran, in
 * `/tmp/832-battery/predictions.md`, and **the baseline row was read before
 * any mutation row**.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** | 19 pass, 0 fail | **19 pass, 0 fail** | — |
 * | B1 every `AC-` label stripped from the subject's titles — the pre-#832 state | 2 | **2 of 19** — the floor case, "no case is invisible" | the subject file: an AC-filtered run of the original runs 14 cases, of the mutant 0 |
 * | B2 the reading replaced by a count of `<testcase name=` — this file's own first draft | 1 | **1 of 19** — "a ZERO-match is loud" | the zero-match report: `parseJunitOutcomes` says 0 ran, a `<testcase` count says 14 |
 * | B3 `FLOOR` raised to 15 | 1 | **1 of 19** — the floor case | the same report: 14 ran, which clears 12 and not 15 |
 * | B4 three AC cases deleted from the subject, leaving 11 | 1 of 16 | **1 of 16** — the floor case | the subject file: 14 labelled cases against 11 |
 * | B5 `reportedPathRefusal` short-circuited to `return null` — the pre-#830 defect | 10 | **10 of 19** — AC-1, AC-2, AC-3, AC-3b, AC-5, AC-9, AC-10, AC-11, and this file's two green-reading cases | `['/etc/passwd']`: the original refuses, the mutant returns null |
 *
 * **B1 and B3 red the floor case from opposite ends and do NOT red the same
 * set**: only B1 touches "no case is invisible", because only B1 changes
 * which cases an AC pattern reaches. **B4 is 11 and not 12 deliberately** —
 * deleting to exactly the floor is a mutation on which mutant and original
 * behave identically with respect to the assertion, which is the code run
 * twice (#485, #297).
 *
 * **B5 is the row that says the three cases #832 added to the subject are
 * witnesses and not padding.** AC-9, AC-10 and AC-11 did not exist in Phase
 * 1, and all three are red over the defect the whole suite is about. A row
 * of 7 would have meant one of them was green on the pre-#830 source.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `workflows/ship.js`, `test/reported-path-refusal.test.ts` and this file
 * were confirmed byte-identical to the measured source afterwards by SHA-256,
 * never by `git checkout --`.
 */

// Covers #832 AC-7.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseJunitOutcomes, readJunitOutcomes } from "../lib/junit-checks";

const REPO_ROOT = join(import.meta.dir, "..");
const SUBJECT = join(REPO_ROOT, "test", "reported-path-refusal.test.ts");

/** The floor #832 states. */
const FLOOR = 12;

/** A pattern no case title can match, used to reproduce the silent-zero. */
const UNMATCHABLE = "AC-NO-SUCH-CRITERION-9401";

/** `ran` is pass ∪ fail — a `<skipped />` testcase is in neither. */
type Run = { exitCode: number; ran: string[]; red: string[]; reason?: string; output: string };

let TMP = "";
let JUNIT_OF_NOTHING = "";
let labelled: Run;
let everything: Run;
let nothing: Run;

/** Each run writes its own report, so a later spawn cannot overwrite it. */
function runSuite(pattern: string | null, outfile: string): Run {
  if (existsSync(outfile)) rmSync(outfile);
  const argv = ["test", SUBJECT, "--reporter=junit", `--reporter-outfile=${outfile}`];
  if (pattern !== null) argv.push("--test-name-pattern", pattern);
  const r = spawnSync("bun", argv, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 180000 });
  const outcomes = existsSync(outfile)
    ? readJunitOutcomes(outfile)
    : { passed: [] as string[], failed: [] as string[], reason: "no report was written" };
  return {
    exitCode: r.status ?? -1,
    ran: [...(outcomes.passed ?? []), ...outcomes.failed],
    red: outcomes.failed,
    reason: outcomes.passed === null ? outcomes.reason : undefined,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "ac-case-census-"));
  JUNIT_OF_NOTHING = join(TMP, "nothing.xml");
  everything = runSuite(null, join(TMP, "everything.xml"));
  labelled = runSuite("AC-", join(TMP, "labelled.xml"));
  nothing = runSuite(UNMATCHABLE, JUNIT_OF_NOTHING);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("#832 AC-7: the suite is dense enough to be run selectively", () => {
  test("the instrument reported: the unfiltered run came back with cases", () => {
    // Read before any count below. A spawn that failed to resolve its
    // imports reports no failures, and that is the same output as a suite
    // in which everything passed (#60).
    expect(everything.reason, "the unfiltered run's report could not be read").toBeUndefined();
    expect(
      everything.ran.length,
      `the unfiltered spawn of ${SUBJECT} ran no cases at all:\n${everything.output}`,
    ).toBeGreaterThan(0);
    expect(everything.red, "the subject suite is not green — every count below is uninterpretable").toEqual([]);
  });

  test("an AC-filtered run RUNS at least twelve cases, and they are green", () => {
    expect(
      labelled.ran.length,
      `an AC-filtered run of the suite ran ${labelled.ran.length} case(s), below the floor of ${FLOOR}. `
        + `A --test-name-pattern run that matches too few cases reports a near-empty verdict and exits green.`,
    ).toBeGreaterThanOrEqual(FLOOR);
    expect(labelled.red).toEqual([]);
    expect(labelled.exitCode, "the filtered run did not exit 0").toBe(0);

    // Each case is labelled in its own title, not inherited from a describe
    // block somebody could rename — asserted, because a labelled describe
    // would satisfy the count above while leaving every individual case
    // unaddressable by the id it claims.
    const unlabelled = labelled.ran.filter(c => !/AC-\d/.test(c.split(" > ").pop() ?? c));
    expect(unlabelled, "these ran only through an ancestor's label").toEqual([]);
  });

  test("no case in the file is invisible to an AC pattern", () => {
    // The floor alone is satisfied by twelve labelled cases beside ten
    // unlabelled ones, and the unlabelled ten are exactly what a selective
    // run would silently skip.
    const missed = everything.ran.filter(c => !labelled.ran.includes(c));
    expect(missed, "these cases are in the file and no AC-filtered run reaches them").toEqual([]);
    expect(labelled.ran.length).toBe(everything.ran.length);
  });

  test("measured: a ZERO-match is loud — bun refuses it and exits non-zero", () => {
    // #832's stated motivation is that a pattern matching nothing "reports
    // zero failures and exits green". Measured on bun 1.3.14, that half of
    // the premise is FALSE: the runner prints
    // `error: regex "…" matched 0 tests. Searched 1 file (skipping 14 tests)`
    // and exits 1. Recorded as a case rather than as a sentence, because a
    // floor justified by a hazard nobody can reproduce is a floor the next
    // reader deletes — and because this is the half that could regress back.
    expect(nothing.ran, `"${UNMATCHABLE}" ran a case, so it is not an unmatchable pattern`).toEqual([]);
    expect(nothing.red).toEqual([]);
    expect(nothing.exitCode, "bun stopped refusing a pattern that matches nothing").toBe(1);
    expect(nothing.output, "bun stopped saying how many tests the pattern matched").toContain("matched 0 tests");
  });

  test("the hazard that IS real: the report lists skipped cases as testcases", () => {
    // What survives the row above. The JUnit report from the zero-match run
    // is not empty — it carries all fourteen testcases, each with
    // `<skipped />`, under `failures="0"`. Any consumer counting `<testcase`
    // reads fourteen cases where none ran, and that is byte-identical to a
    // clean run of the whole file.
    //
    // This file's own first draft did exactly that and was green over an
    // instrument that could not tell a run from a skip. #532 records the
    // trap and `lib/junit-checks.ts` is the one binding that answers it, so
    // the two readings are compared here rather than trusted.
    const xml = readFileSync(JUNIT_OF_NOTHING, "utf-8");
    const listed = (xml.match(/<testcase name=/g) || []).length;
    expect(listed, "the zero-match report lists no testcases, so there is nothing to confuse").toBeGreaterThan(0);
    expect(listed, "the report lists fewer cases than the file declares").toBe(everything.ran.length);
    expect(xml, "the skipped testcases carry no marker distinguishing them from a run").toContain("<skipped");
    expect(
      parseJunitOutcomes(xml).passed,
      "parseJunitOutcomes counted a skipped testcase as one that ran",
    ).toEqual([]);
  });
});
