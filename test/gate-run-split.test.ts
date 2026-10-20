/**
 * #737 — the summary was scoped to the last run and the markers to all of
 * them, so a retried gate reported two different failure counts.
 *
 * `parseGateResults` read one buffer two ways. Collecting every `N fail`
 * line and taking the last is not something anybody writes unless they know
 * the buffer can hold more than one run; three lines later
 * `parseTestResults(testOutput)` was handed the whole buffer with no scoping
 * at all. Two deciders for "how many checks failed", agreeing on every
 * single-run output — which is every output anyone had looked at — and
 * diverging only on a retry. `.claude/rules/checks-must-be-able-to-fail.md`,
 * the fourth shape.
 *
 * What makes this class expensive is that **the disagreement was printed**:
 * `1 fail` and `2 failures` eleven lines apart in every retried gate run the
 * project has produced, each individually believable, and #700 being
 * diagnosed off the corrupted one.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **De-duplicate `results` by `check` before counting.** `2 failures`
 * becomes `1 failure`, the two numbers agree, the duplicate name disappears
 * — and nothing is fixed. The surviving entry is whichever attempt happened
 * to be FIRST in the buffer, carrying attempt 1's detail under attempt 2's
 * heading, and a genuine case of one check failing in two different gates
 * inside one run is now silently collapsed.
 *
 * Any case asserting only "the counts agree" goes green under it. `AC-2b` is
 * the case that survives: it asserts WHICH RUN the surviving result came
 * from, by giving the two attempts different detail text.
 *
 * The issue names a second-cheapest wrong fix too — slice the buffer at the
 * last banner and leave everything else alone. Closer, and it fails on a
 * final run that printed no summary, which `AC-4` covers.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/parse-test-results-alignment.test.ts` +
 * `test/batch-diagnosis-detail.test.ts` (32 tests). Every count predicted
 * before the run, and **the baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 32 pass, 0 fail | **32 pass, 0 fail** | — |
 * | M1 **the defect restored**: `parseTestResults(testOutput)` handed the whole buffer | 2 | **3 of 32** | `TWO_RUNS`: the original reports 1 failing check against a summary of 1, the mutant reports 2 |
 * | M2 **the cheapest wrong fix**: de-duplicate by check name, whole buffer | 2 | **3 of 32** | the same, and `AC-3b`'s one-check buffer, where the counts AGREE and only the detail differs |
 * | M3 `splitGateRuns` always returns one run | 4 | **8 of 32** | `TWO_RUNS` |
 * | M4 the no-summary UNMEASURED branch removed | 3 | **2 of 32** | the truncated buffer: the original refuses, the mutant reports attempt 1's numbers as attempt 2's |
 * | M5 the empty-buffer reason removed | 1 | **1 of 32** | `""` |
 * | M6 `summaryOf` scoped to the whole buffer instead of the run slice | 2 | **2 of 32** | the truncated buffer: the last run inherits run 0's summary, so UNMEASURED stops firing |
 * | M7 bounds take every banner, so a preamble becomes its own run | 1 | **1 of 32** | `"warming up\\n" + ONE_RUN` |
 *
 * **The battery found a gap in these cases, which is why `AC-3` exists.**
 * M1's first measurement was **0 red**: every case drove `splitGateRuns` and
 * `parseTestResults` directly, and the DEFECT was in how `parseGateResults`
 * composed the two. A case that never calls the composer cannot see the
 * composition restored. `parseGateResults` is now exported and driven, and
 * the row is 3.
 *
 * **M2 is the row worth reading twice.** Measured against `AC-3b`'s buffer —
 * the issue's own scenario, one check failing in both attempts — the wrong
 * fix makes the counts AGREE: `1 fail` beside 1 failing check, true. The
 * surviving entry carries `error: attempt one detail`. So the count
 * assertion is satisfied by the repair it was written to block, and only
 * the detail assertion discriminates. Both are kept; the first is the
 * symptom and the second is the property.
 *
 * **M3 came back double** and every extra red is about the split — with one
 * run the retried buffer is unsplittable, so the AC-2 group, AC-4 and the
 * AC-6 control all fail. Not a crashing mutant: 19 cases still pass.
 *
 * **M4 came back LOW at 2** and is not a collapsed pair: the differing input
 * is named above and two cases witness it. The third I predicted was AC-3's
 * UNMEASURED case, which was added after the prediction was written.
 *
 * None of the seven mutations is left in the tree; all were run and
 * reverted, and `lib/gate-run-split.ts` and `gates/gate-executor.ts` were
 * confirmed byte-identical to the measured source by sha256.
 */
import { describe, expect, test } from "bun:test";

import { splitGateRuns } from "../lib/gate-run-split";
import { parseGateResults, parseTestResults } from "../gates/gate-executor";

const BANNER = "bun test v1.3.14 (d1632b29)";

/** Attempt 1: two checks fail. Attempt 2: one of them still does. */
const TWO_RUNS = [
  BANNER,
  "",
  "  error: attempt one detail",
  "(fail) brief-ac-alignment: brief covers all ACs [2.00ms]",
  "  error: fixed before attempt two",
  "(fail) evidence-chain: every AC cites evidence [1.00ms]",
  "(pass) something-else [0.10ms]",
  "",
  " 157 pass",
  " 2 fail",
  "Ran 159 tests.",
  BANNER,
  "",
  "  error: attempt two detail",
  "(fail) brief-ac-alignment: brief covers all ACs [2.00ms]",
  "(pass) evidence-chain: every AC cites evidence [1.00ms]",
  "(pass) something-else [0.10ms]",
  "",
  " 158 pass",
  " 1 fail",
  "Ran 159 tests.",
].join("\n");

const ONE_RUN = [
  BANNER,
  "",
  "  error: the only attempt",
  "(fail) brief-ac-alignment: brief covers all ACs [2.00ms]",
  "(pass) something-else [0.10ms]",
  "",
  " 158 pass",
  " 1 fail",
].join("\n");

describe("#737 AC-1: one binding splits the buffer, and both readings use it", () => {
  test("the runs concatenate back to the buffer byte for byte", () => {
    // The split cannot drop or duplicate a byte, or the two readings are
    // scoped differently again by a subtler route.
    const r = splitGateRuns(TWO_RUNS);
    expect(r.runs.map(x => x.text).join("")).toBe(TWO_RUNS);
    expect(r.runs.length).toBe(2);
  });

  test("text before the first banner belongs to the first run", () => {
    const withPreamble = `warming up\n${ONE_RUN}`;
    const r = splitGateRuns(withPreamble);
    expect(r.runs.length).toBe(1);
    expect(r.runs[0].text).toBe(withPreamble);
  });

  test("a buffer with no banner at all is one run", () => {
    const r = splitGateRuns("(fail) x\n 0 pass\n 1 fail\n");
    expect(r.runs.length).toBe(1);
    expect(r.verdict?.summary).toEqual({ pass: 0, fail: 1 });
  });
});

describe("#737 AC-2: the two counts agree on a retried buffer", () => {
  test("summary count and marker count are the same number", () => {
    const r = splitGateRuns(TWO_RUNS);
    expect(r.reading).toBe("MEASURED");

    const summaryFails = r.verdict!.summary!.fail;
    const markerFails = parseTestResults(r.verdict!.text).filter(x => x.result === "FAIL");

    expect(summaryFails, "the fixture's last run does not fail once").toBe(1);
    expect(
      markerFails.length,
      `the summary says ${summaryFails} and the markers say ${markerFails.length}: ` +
        markerFails.map(m => m.check).join(", "),
    ).toBe(summaryFails);
  });

  test("AC-2b: the surviving result came from the LAST run, not the first", () => {
    // The case that survives de-duplication by check name. Both attempts
    // name `brief-ac-alignment`, so a de-duplicating fix keeps one of them
    // and the counts agree — it keeps the FIRST, whose detail describes a
    // tree that has been superseded.
    const r = splitGateRuns(TWO_RUNS);
    const failing = parseTestResults(r.verdict!.text).filter(x => x.result === "FAIL");
    expect(failing.length).toBe(1);
    expect(
      failing[0].detail,
      `the surviving result carries attempt one's reason under attempt two's heading: ` +
        `${failing[0].detail}`,
    ).toContain("attempt two detail");
    expect(failing[0].detail).not.toContain("attempt one detail");
  });

  test("a check fixed between attempts is not reported as still failing", () => {
    const r = splitGateRuns(TWO_RUNS);
    const names = parseTestResults(r.verdict!.text)
      .filter(x => x.result === "FAIL")
      .map(x => x.check);
    expect(
      names,
      "evidence-chain passed on the second attempt and is still being reported",
    ).not.toContain("evidence-chain: every AC cites evidence");
  });

  test("no check is named twice in the verdict run", () => {
    const names = parseTestResults(splitGateRuns(TWO_RUNS).verdict!.text).map(x => x.check);
    expect(new Set(names).size, `a check is reported twice: ${names.join(", ")}`).toBe(names.length);
  });
});

describe("#737 AC-4: a final run with no summary is UNMEASURED", () => {
  const TRUNCATED = `${TWO_RUNS.slice(0, TWO_RUNS.lastIndexOf(" 158 pass"))}killed\n`;

  test("it does not silently take an earlier run's numbers", () => {
    const r = splitGateRuns(TRUNCATED);
    expect(r.runs.length, "the fixture does not hold two runs").toBe(2);
    expect(r.runs[0].summary, "the earlier run's numbers are there to be taken").not.toBeNull();
    expect(
      r.reading,
      "a buffer whose last run printed nothing was read as a measurement",
    ).toBe("UNMEASURED");
    expect(
      r.verdict,
      "a verdict was offered for a run that reported no counts — the caller will read " +
        "the previous attempt's numbers off it",
    ).toBeNull();
  });

  test("the reason names the run and says why an earlier one is not a substitute", () => {
    const r = splitGateRuns(TRUNCATED);
    const why = r.unmeasuredReasons.join(" ");
    expect(why).toContain("no summary");
    expect(why, "the reason does not say why falling back is wrong").toContain("superseded");
  });

  test("an empty buffer is UNMEASURED for its own reason, not for the summary's", () => {
    // Zero runs agrees with every claim about the runs. Distinguished,
    // because "the runner never started" and "the runner was killed
    // mid-run" are different facts and only one of them is a timeout.
    const r = splitGateRuns("");
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("no output at all");
    expect(r.unmeasuredReasons.join(" ")).not.toContain("no summary");
  });
});

describe("#737 AC-3: the composed reading, driven through parseGateResults", () => {
  // The cases above drive `splitGateRuns` directly, which is the binding —
  // but the DEFECT was in how `parseGateResults` composed two readings, and
  // a case that never calls it cannot see that composition restored. Found
  // by a battery row: restoring the unscoped `parseTestResults(testOutput)`
  // call measured 0 red against the split cases, because none of them went
  // near it.
  test("the gate's own two numbers agree on a retried buffer", () => {
    const r = parseGateResults(TWO_RUNS, [], 0);
    const markerFails = r.results.filter(x => x.result === "FAIL");
    expect(
      markerFails.length,
      `the gate reports '${r.fails} fail' beside ${markerFails.length} failing checks: ` +
        markerFails.map(m => m.check).join(", "),
    ).toBe(r.fails);
    expect(r.fails).toBe(1);
    expect(r.passes).toBe(158);
  });

  test("the reported failure is the last attempt's, with the last attempt's reason", () => {
    const r = parseGateResults(TWO_RUNS, [], 0);
    const failing = r.results.filter(x => x.result === "FAIL");
    expect(failing.length).toBe(1);
    expect(failing[0].detail).toContain("attempt two detail");
  });

  test("a buffer whose last run printed no summary fails as UNMEASURED", () => {
    const truncated = `${TWO_RUNS.slice(0, TWO_RUNS.lastIndexOf(" 158 pass"))}killed\n`;
    const r = parseGateResults(truncated, [], 0);
    expect(r.fails, "an unreadable run was reported as passing").toBeGreaterThan(0);
    const detail = r.results.map(x => x.detail).join(" ");
    expect(detail, `the gate did not say it was unmeasured: ${detail}`).toContain("UNMEASURED");
    expect(
      r.passes,
      "an earlier run's pass count was reported as this run's",
    ).toBe(0);
  });

  test("AC-3b: the issue's own scenario, where the counts agree under the wrong fix", () => {
    // One check, failing in both attempts, and nothing else — run
    // 39325676895 exactly. This is the input on which the cheapest wrong
    // fix is INDISTINGUISHABLE by count: de-duplicating by check name
    // leaves one entry, so `1 fail` beside 1 failing check, agreeing.
    //
    // Measured under that repair: counts agree (true), and the surviving
    // detail is `error: attempt one detail`. So the count assertion is
    // satisfied by the wrong fix and only the DETAIL assertion below is
    // load-bearing. Keep both; the first is the symptom, the second is the
    // property.
    const sameCheckTwice = [
      "bun test v1.3.14 (d1632b29)", "",
      "  error: attempt one detail",
      "(fail) brief-ac-alignment: brief covers all ACs [2.00ms]",
      "", " 157 pass", " 1 fail",
      "bun test v1.3.14 (d1632b29)", "",
      "  error: attempt two detail",
      "(fail) brief-ac-alignment: brief covers all ACs [2.00ms]",
      "", " 158 pass", " 1 fail",
    ].join("\n");

    const r = parseGateResults(sameCheckTwice, [], 0);
    const failing = r.results.filter(x => x.result === "FAIL");
    expect(failing.length, "the same check was reported once per attempt").toBe(r.fails);
    expect(
      failing[0].detail,
      `the gate reports attempt one's reason under attempt two's heading: ${failing[0].detail}`,
    ).toContain("attempt two detail");
  });

  test("a single-run buffer gives the gate the same numbers as before", () => {
    const r = parseGateResults(ONE_RUN, [], 0);
    expect(r.passes).toBe(158);
    expect(r.fails).toBe(1);
    expect(r.results.filter(x => x.result === "FAIL").length).toBe(1);
  });
});

describe("#737 AC-6: a single-run buffer is unchanged", () => {
  test("the verdict run is the whole buffer", () => {
    const r = splitGateRuns(ONE_RUN);
    expect(r.reading).toBe("MEASURED");
    expect(r.runs.length).toBe(1);
    expect(r.verdict!.text, "a single-run buffer was sliced").toBe(ONE_RUN);
  });

  test("the readings match what the pre-#737 whole-buffer code produced", () => {
    // The old expressions, inline, over the same input. For one run they
    // must agree exactly — this change is confined to the multi-run case
    // and that is asserted rather than claimed.
    const oldPass = [...ONE_RUN.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
    const oldFail = [...ONE_RUN.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
    const r = splitGateRuns(ONE_RUN);
    expect(r.verdict!.summary!.pass).toBe(parseInt(oldPass[oldPass.length - 1][1], 10));
    expect(r.verdict!.summary!.fail).toBe(parseInt(oldFail[oldFail.length - 1][1], 10));
    expect(parseTestResults(r.verdict!.text)).toEqual(parseTestResults(ONE_RUN));
  });

  test("and they do NOT match on the retried buffer — the change has an effect", () => {
    // The control. Without this, every case above is satisfied by a split
    // that never splits anything: AC-6 asserts agreement, and agreement is
    // also what doing nothing produces.
    const r = splitGateRuns(TWO_RUNS);
    expect(
      parseTestResults(r.verdict!.text).filter(x => x.result === "FAIL").length,
      "scoping to the verdict run changed nothing, so the split is not doing anything",
    ).not.toBe(parseTestResults(TWO_RUNS).filter(x => x.result === "FAIL").length);
  });
});
