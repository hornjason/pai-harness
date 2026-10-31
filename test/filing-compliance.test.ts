import { describe, expect, test } from "bun:test";

import {
  complianceReading,
  targetOf,
  type CommentReading,
  type FilingComplianceRow,
} from "../lib/filing-compliance";

/**
 * Does a refused filing become the comment the refusal told it to be?
 *
 * ## The one thing every case here exists to protect
 *
 * **A rate of zero and a denominator of zero are different readings and must
 * never render the same.** The question this module answers has, as of the
 * day it was written, an empty population: the two refusals that route a
 * finding to a comment — `COMMENT_INSTEAD` and `OVER_CAP` — have fired zero
 * times in the production ledger, so the honest output is *nobody has been
 * refused yet*, not *nobody complied*. Every aggregate below is asserted for
 * `rate === null` on an empty denominator rather than `rate === 0`, and
 * `FC-4` is the case that fails if someone "simplifies" the division.
 *
 * ## Why the reading is an UPPER BOUND and says so
 *
 * The ledger does not record who attempted the filing, so a comment landing
 * on the target inside the window cannot be attributed to the agent that was
 * refused — it may be anyone's. Counting it as compliance can only ever
 * overstate. That is worth having (an upper bound of zero is decisive) but
 * it is not a compliance rate, and `compliedUpperBound` is named so that a
 * later reader cannot quote it as one.
 *
 * ## What was broken to prove these can fail
 *
 * Run against this tree, 11 tests. Every count predicted before the battery
 * ran, and **the baseline row was read first** — an instrument that has
 * stopped reporting takes the baseline down with it, and nobody mutates
 * anything to produce that row.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 11 pass, 0 fail | **11 pass, 0 fail** |
 * | M1 `rate` divides unconditionally — `NaN` instead of `null` | 3 | **3** |
 * | M2 the denominator becomes `rows.length` | 4 | **4** |
 * | M3 an `UNMEASURED` lookup reads as no-comment | 1 | **1** |
 * | M4 the window is ignored | 2 | **2** |
 * | M5 `targetOf` stops excluding emitted rows | 2 | **2** |
 * | M6 `unobservableByRefusal` never populated | 1 | **1** |
 * | M7 `issueNumber` accepts only numbers — the shipped defect | 1 | **1** |
 *
 * Before believing any row, the input on which mutant and original differ:
 * for M1 and M2 a population with no observable rows, where the original
 * withholds the number and the mutant prints `NaN` or `0`; for M3 a lookup
 * returning `UNMEASURED`; for M4 a comment one millisecond outside the
 * window; for M5 an emitted row carrying a `duplicateOf`; for M6 any
 * unobservable row; for M7 `duplicateOf: ["1214"]`, which the original reads
 * as issue 1214 and the mutant discards.
 *
 * **M1 and M2 are the cheapest wrong fixes, named in advance.** The symptom
 * a reader meets is a `null` where they wanted a percentage, and both
 * repairs are one expression: drop the guard, or divide by the row count to
 * make the guard unreachable. Each produces a confident number over a
 * population that does not support one.
 *
 * **M7 is not a hypothetical.** It is what this module shipped in its first
 * draft, and the real ledger reading it produced was a denominator of 0 over
 * 261 rows — indistinguishable from "no refusal has ever had a target". The
 * nine that did were discarded by the parser. The reading after the fix is
 * 9 observable and an upper bound of 2.
 *
 * None of the seven mutations is left in the tree; all were run and
 * reverted, and `lib/filing-compliance.ts` was confirmed byte-identical to
 * the measured source afterwards by sha256.
 */

const ROW: FilingComplianceRow = {
  at: "2026-10-24T12:00:00.000Z",
  title: "a refused finding",
  refusal: "DUPLICATE",
  emitted: false,
  duplicateOf: [1400],
};

const HOUR = 3_600_000;

const measured = (...at: string[]): CommentReading => ({
  reading: "MEASURED",
  comments: at.map(a => ({ at: a })),
});

const lookupOf =
  (byIssue: Record<number, CommentReading>) =>
  async (issue: number): Promise<CommentReading> =>
    byIssue[issue] ?? { reading: "MEASURED", comments: [] };

describe("targetOf", () => {
  test("FC-1: a refused row naming a duplicate names that issue as the target", () => {
    expect(targetOf(ROW)).toEqual({ reading: "NAMED", issues: [1400] });
  });

  test("FC-2: a refused row with no recorded target is UNOBSERVABLE and names the refusal", () => {
    const t = targetOf({ ...ROW, refusal: "NO_CLAIM", duplicateOf: [] });
    expect(t.reading).toBe("UNOBSERVABLE");
    // The reason has to say WHICH refusal could not be followed up, because
    // the fix is per-refusal: `OVER_CAP` needs the target persisted on the
    // row, `NO_CLAIM` needs it too, and `DROPPED_CATEGORY` never had one.
    expect(t.reading === "UNOBSERVABLE" && t.why).toContain("NO_CLAIM");
  });

  test("FC-11: the ledger writes duplicateOf as STRINGS, and those are targets", () => {
    // Not a hypothetical shape. Measured on the production ledger
    // 2026-10-25: all 14 `duplicateOf` elements across 261 rows are decimal
    // STRINGS — `["1214"]`, `["1173"]` — and a reader that accepted only
    // `number` dropped every one of them. The first run of this module did
    // exactly that and reported a denominator of 0 for the whole file, which
    // is the right answer to the wrong question: the population was not
    // empty, the parser was. A leading `#` is accepted for the same reason —
    // cheap, and the alternative is silently reading zero targets again.
    expect(targetOf({ ...ROW, duplicateOf: ["1214"] as never })).toEqual({
      reading: "NAMED",
      issues: [1214],
    });
    expect(targetOf({ ...ROW, duplicateOf: ["#1173"] as never })).toEqual({
      reading: "NAMED",
      issues: [1173],
    });
    // And a value that names no issue is still UNOBSERVABLE rather than NaN.
    expect(targetOf({ ...ROW, duplicateOf: ["not-an-issue"] as never }).reading).toBe(
      "UNOBSERVABLE",
    );
  });

  test("FC-3: a row that WAS emitted is not a refusal and is excluded", () => {
    const t = targetOf({ ...ROW, emitted: true, refusal: null });
    expect(t.reading).toBe("UNOBSERVABLE");
    expect(t.reading === "UNOBSERVABLE" && t.why).toContain("not refused");
  });
});

describe("complianceReading", () => {
  test("FC-4: an empty observable population reads null, NOT a rate of zero", async () => {
    const r = await complianceReading({
      rows: [{ ...ROW, refusal: "NO_CLAIM", duplicateOf: [] }],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    expect(r.observable).toBe(0);
    expect(r.unobservable).toBe(1);
    // The assertion this module exists for.
    expect(r.rate).toBeNull();
    expect(r.compliedUpperBound).toBe(0);
  });

  test("FC-5: a lookup that could not read is UNOBSERVABLE, never NOT_OBSERVED", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: async () => ({ reading: "UNMEASURED", why: "the tracker returned 502" }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("UNOBSERVABLE");
    expect(r.observable).toBe(0);
    expect(r.rate).toBeNull();
  });

  test("FC-6: a comment inside the window reads COMPLIED", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-24T13:00:00.000Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("COMPLIED");
    expect(r.observable).toBe(1);
    expect(r.compliedUpperBound).toBe(1);
    expect(r.rate).toBe(1);
  });

  test("FC-7: a comment PREDATING the refusal is not compliance with it", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-24T11:59:59.000Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("NOT_OBSERVED");
    expect(r.observable).toBe(1);
    expect(r.rate).toBe(0);
  });

  test("FC-8: a comment after the window closes is not compliance with it", async () => {
    const r = await complianceReading({
      rows: [ROW],
      lookup: lookupOf({ 1400: measured("2026-10-25T12:00:00.001Z") }),
      windowMs: 24 * HOUR,
    });
    expect(r.rows[0]?.state).toBe("NOT_OBSERVED");
    expect(r.rate).toBe(0);
  });

  test("FC-9: the rate's denominator is the OBSERVABLE rows, not every row", async () => {
    const r = await complianceReading({
      rows: [
        ROW,
        { ...ROW, title: "second", duplicateOf: [1401] },
        // Three rows that can never be read, which must not dilute the rate.
        { ...ROW, title: "third", refusal: "NO_CLAIM", duplicateOf: [] },
        { ...ROW, title: "fourth", refusal: "OVER_CAP", duplicateOf: [] },
        { ...ROW, title: "fifth", emitted: true, refusal: null },
      ],
      lookup: lookupOf({
        1400: measured("2026-10-24T13:00:00.000Z"),
        1401: measured(),
      }),
      windowMs: 24 * HOUR,
    });
    expect(r.observable).toBe(2);
    expect(r.unobservable).toBe(3);
    expect(r.compliedUpperBound).toBe(1);
    // 1/2, not 1/5. The cheapest wrong implementation divides by rows.length
    // and reads 0.2 here, which is the number a reader would act on.
    expect(r.rate).toBe(0.5);
  });

  test("FC-10: the reading names the refusals it could not observe at all", async () => {
    const r = await complianceReading({
      rows: [
        { ...ROW, refusal: "OVER_CAP", duplicateOf: [] },
        { ...ROW, refusal: "COMMENT_INSTEAD", duplicateOf: [] },
        { ...ROW, refusal: "COMMENT_INSTEAD", duplicateOf: [] },
      ],
      lookup: lookupOf({}),
      windowMs: 24 * HOUR,
    });
    expect(r.rate).toBeNull();
    expect(r.unobservableByRefusal).toEqual({ OVER_CAP: 1, COMMENT_INSTEAD: 2 });
  });
});
