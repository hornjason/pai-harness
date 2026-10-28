/**
 * The status view's one load-bearing property: the column is mechanical and
 * the judgement is not in it.
 *
 * `lib/criterion-issue-census.ts` states the design. These cases hold it to
 * the three things that make it true rather than merely intended:
 *
 * 1. The column answers "an open issue NAMES this criterion" and nothing
 *    else, so two people running it get the same rows.
 * 2. A judgement is a dated, attributed record held OUTSIDE the row, and it
 *    stops applying when the criterion is reworded — the same rule
 *    `lib/spec-evidence.ts` applies to `proved-by:`.
 * 3. The ambiguity exclusions are the two documented ones, asserted by id
 *    rather than by whatever the predicate currently does.
 *
 * `scripts/criterion-issue-census.ts` is the IO around this and is not
 * exercised here: it fetches the live tracker, which is not a thing a test
 * may depend on.
 */

import { describe, expect, test } from "bun:test";

import {
  censusRows,
  isAmbiguousId,
  issueNames,
  renderCensus,
  unadjudicated,
  type Adjudication,
  type IssueRef,
  type SpecRef,
} from "../lib/criterion-issue-census";
import { criterionFingerprint } from "../lib/spec-evidence";

const TICKED = "- [x] SC-9101: the gate refuses an unsigned payload.\n      needs: test\n";
const UNTICKED = "- [ ] SC-9102: the gate also refuses an expired one.\n      needs: test\n";

function spec(body: string): SpecRef[] {
  return [{ file: "specs/FIXTURE-SPEC.md", content: `---\ndoc-type: spec\n---\n\n${body}` }];
}

function issue(number: number, text: string): IssueRef {
  return { number, title: text, body: "" };
}

describe("the mechanical column", () => {
  test("a ticked criterion named by an open issue is a row", () => {
    const rows = censusRows(spec(TICKED), [issue(42, "SC-9101 is not true")], []);
    expect(rows.map(r => [r.id, r.namedBy])).toEqual([["SC-9101", [42]]]);
  });

  test("an UNTICKED criterion named by an open issue is NOT a row", () => {
    // An issue naming unfinished work is the tracker working. Only a document
    // claiming something is done, with the tracker disagreeing, is a signal.
    const rows = censusRows(spec(UNTICKED), [issue(42, "SC-9102 needs doing")], []);
    expect(rows).toEqual([]);
    // And the control: the SAME issue text against the SAME criterion ticked
    // IS a row, so the empty reading above measured the tick and not the match.
    expect(
      censusRows(spec(UNTICKED.replace("- [ ]", "- [x]")), [issue(42, "SC-9102 needs doing")], [])
        .length,
    ).toBe(1);
  });

  test("the match is on a word boundary, so a longer id is not a hit", () => {
    expect(issueNames(issue(1, "SC-91010 is broken"), "SC-9101")).toBe(false);
    expect(issueNames(issue(1, "SC-9101 is broken"), "SC-9101")).toBe(true);
  });

  test("a criterion no open issue names produces no row at all", () => {
    expect(censusRows(spec(TICKED), [issue(42, "nothing relevant here")], [])).toEqual([]);
  });
});

describe("the judgement is not a column", () => {
  const fingerprint = criterionFingerprint("the gate refuses an unsigned payload.");

  const judged: Adjudication = {
    criterion: "SC-9101",
    issue: 42,
    verdict: "contradicts",
    by: "jason",
    collected: "2026-10-28",
    note: "the issue says nobody has observed the refusal on the live path",
    fingerprint,
  };

  test("an adjudication is carried as a dated, attributed record", () => {
    const [row] = censusRows(spec(TICKED), [issue(42, "SC-9101 is not true")], [judged]);
    const standing = row.standing[42];
    expect(standing.status).toBe("current");
    expect(standing.status === "current" && standing.record.by).toBe("jason");
    expect(standing.status === "current" && standing.record.collected).toBe("2026-10-28");
    // The row itself carries no verdict field. The judgement is reachable only
    // through a record that says who made it and when.
    expect(Object.keys(row)).not.toContain("verdict");
    expect(Object.keys(row)).not.toContain("contradicts");
  });

  test("rewording the criterion makes the judgement STALE, not carried", () => {
    const reworded = TICKED.replace("an unsigned payload", "a payload that is not signed");
    const [row] = censusRows(spec(reworded), [issue(42, "SC-9101 is not true")], [judged]);
    const standing = row.standing[42];
    expect(standing.status).toBe("stale");
    // And the stale row still owes a judgement, which is the point of saying so.
    expect(unadjudicated([row]).map(r => r.id)).toEqual(["SC-9101"]);
  });

  test("no record at all is UNADJUDICATED and owed", () => {
    const [row] = censusRows(spec(TICKED), [issue(42, "SC-9101 is not true")], []);
    expect(row.standing[42].status).toBe("none");
    expect(unadjudicated([row])).toHaveLength(1);
  });

  test("a current judgement clears the debt, whatever the verdict is", () => {
    for (const verdict of ["contradicts", "cites", "unrelated"] as const) {
      const rows = censusRows(spec(TICKED), [issue(42, "SC-9101")], [{ ...judged, verdict }]);
      expect(unadjudicated(rows), `verdict ${verdict} should clear the debt`).toEqual([]);
    }
  });

  test("the rendered view names the observer and the date, never a bare verdict", () => {
    const rows = censusRows(spec(TICKED), [issue(42, "SC-9101")], [judged]);
    const text = renderCensus(rows, "2026-10-28");
    expect(text).toContain("CONTRADICTS (jason, 2026-10-28)");
    // A verdict with no observer and no date is the shape this view exists to
    // refuse, so it must not be renderable.
    expect(text).not.toMatch(/CONTRADICTS\s*$/m);
  });
});

describe("the ambiguity exclusions are the two documented ones", () => {
  test("an issue-shaped id and an anti-criterion are excluded; an ordinary id is not", () => {
    const excluded = ["SC-1", "SC-9", "SC-A1", "SC-A12"];
    const kept = ["SC-10", "SC-640", "SC-9101", "CRC-B7", "CRC-M11"];
    expect(excluded.filter(id => !isAmbiguousId(id)), "these must be excluded").toEqual([]);
    expect(kept.filter(id => isAmbiguousId(id)), "these must be kept").toEqual([]);
  });

  test("an excluded id produces no row even when an issue names it", () => {
    const ambiguous = "- [x] SC-A1: the gate must not pass an unsigned payload.\n      needs: test\n";
    expect(censusRows(spec(ambiguous), [issue(42, "SC-A1 is wrong")], [])).toEqual([]);
    // Control on the same shape: change only the id, and the row appears. So
    // the empty reading above measured the exclusion and not the fixture.
    expect(
      censusRows(spec(ambiguous.replace(/SC-A1/g, "SC-9101")), [issue(42, "SC-9101 is wrong")], []),
    ).toHaveLength(1);
  });
});
