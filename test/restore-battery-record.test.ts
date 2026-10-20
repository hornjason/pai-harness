/**
 * #837 AC-5: the #836 battery is recorded in the governing spec, in a shape a
 * later reader can check rather than take on trust.
 *
 * ## Why a test and not just a section
 *
 * A battery table is evidence, and evidence that nothing reads decays into
 * decoration. Three properties make the difference between a table and a
 * paragraph of numbers, and all three are things this repository has already
 * been bitten by:
 *
 *  - **The baseline row comes first.** A row of zeros with a believable
 *    baseline beside it is a finding; a row of zeros with no baseline is an
 *    instrument that stopped reporting, and it is the one row nobody mutates
 *    anything to produce (`.claude/rules/checks-must-be-able-to-fail.md`,
 *    #60).
 *  - **Every mutation row names a differing input.** Without one, the row may
 *    be the code run twice — the mutant and the original behaving identically
 *    on every input the suite has (#485, #297).
 *  - **No two rows share that input.** Four rows resting on one confound are
 *    one falsification reported as four.
 *
 * ## What this does NOT claim
 *
 * It does not check that the counts are true. Nothing in a repository can:
 * the only thing that establishes a count is running the mutation, and a test
 * that re-ran the battery would be the battery. What it establishes is that
 * the record has the shape a reader needs in order to re-run it — which is
 * the difference between a claim and a reproducible one.
 *
 * ## What was broken to prove THIS can fail
 *
 * A guard over a battery record is still a guard, and this file's whole
 * subject is that evidence nothing reads decays into decoration. Five rows
 * over these 5 tests, every count predicted before the run in
 * `/tmp/837-battery/predictions2.md`, **baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 5 pass, 0 fail | **5 pass, 0 fail** | — |
 * | N1 the baseline row moved to second place in the spec table | 1 | **2 of 5** | the table's row order |
 * | N2 one mutation row's differing-input cell emptied to `—` | 2 | **1 of 5** | that cell's text |
 * | N3 M3's input cell replaced by M1's | 1 | **1 of 5** | the two cells being equal |
 * | N4 the `M6 came back` explanation deleted from the prose | 1 | **1 of 5** | the prose below the table |
 * | N5 `batteryRows` short-circuited to `return []` | 4 | **3 of 5** | the spec text against nothing |
 *
 * **N1 came back 2 and the extra red is the real kind.** With the baseline
 * second, the row at index 0 is a mutation row and the row the
 * named-input case now reads as a mutation is the baseline, whose input
 * cell is `—` by definition. Both reds are about the mutated ordering.
 *
 * **N2 came back 1 against a predicted 2.** The prediction expected the
 * shared-input case to fire as well, on the reasoning that two rows would
 * then hold `—`. They do not: the baseline is excluded from that
 * comparison, so there is exactly one `—` among the mutation rows. The
 * prediction was wrong; the check behaves as designed.
 *
 * **N5 came back 3 against a predicted 4, and the shortfall names two
 * vacuous cases.** Over an empty table the named-input case and the
 * shared-input case both iterate nothing and pass — which is precisely why
 * the first case establishes non-emptiness before any of them runs, and
 * why that case is the one that must never be deleted as redundant.
 *
 * None of the mutations is left in the tree; all were run and reverted, and
 * `specs/HARNESS-STANDARD.md` and this file were confirmed byte-identical
 * to the measured source afterwards by SHA-256, never by `git checkout --`.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";


const SPEC = readFileSync(
  join(import.meta.dir, "..", "specs", "HARNESS-STANDARD.md"),
  "utf-8",
);

const HEADING = "## The ai-review baseline was read fifteen seconds before the restore (#836)";

/**
 * This section of the spec, and nothing either side of it.
 *
 * Cut rather than searched: `HARNESS-STANDARD.md` holds a dozen battery
 * tables, and a claim about this one asserted against the whole document is
 * satisfied by a row in any of them
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "search the slice, not
 * the document"). The first draft reached for `structuralCut` with
 * `### What was broken to prove it` as the end anchor and the helper refused
 * — that string appears **72** times — which is the loud abort a cut is
 * supposed to produce.
 *
 * So the boundary is the `##` heading, which is unique, and the section runs
 * to the end of the file. Both halves of that are asserted: a duplicated
 * heading and a later `##` appended after this one are each a cut that has
 * silently widened, and a widened cut is how a claim about one section comes
 * to be satisfied by another.
 */
function section(): string {
  const occurrences = SPEC.split(HEADING).length - 1;
  if (occurrences !== 1) {
    throw new Error(`the #836 section heading appears ${occurrences} times, so the cut is ambiguous`);
  }
  const body = SPEC.slice(SPEC.indexOf(HEADING) + HEADING.length);
  if (body.includes("\n## ")) {
    throw new Error(
      "a later `##` section was appended after the #836 one, so this cut now reaches past it — " +
        "give it an explicit end anchor rather than letting it run to the end of the file",
    );
  }
  return body;
}

/** The battery table's data rows, as cells. */
function batteryRows(): string[][] {
  const doc = section();
  const table = doc.slice(
    doc.indexOf("### What was broken to prove it"),
    doc.indexOf("**The instrument is a PAIR, deliberately.**"),
  );
  if (table.length === 0) throw new Error("the battery table is no longer between its two markers");
  return table
    .split("\n")
    .filter(l => l.startsWith("| ") && !/^\|\s*-+/.test(l) && !l.startsWith("| Row |"))
    .map(l => l.slice(1, l.lastIndexOf("|")).split(" | ").map(c => c.trim()));
}

describe("#837 AC-5: the #836 battery is recorded in a checkable shape", () => {
  test("the section exists and holds a table with more rows than the baseline", () => {
    const rows = batteryRows();
    // Non-vacuity first. Every assertion below iterates the rows, and an
    // empty list satisfies all of them.
    expect(rows.length, "the #836 battery table is gone or unparseable").toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.length, `a row has ${r.length} columns: ${r.join(" | ")}`).toBe(4);
    }
  });

  test("the unmutated baseline is the FIRST row", () => {
    const first = batteryRows()[0];
    expect(first[0].toLowerCase(), `the first row is not the baseline: ${first.join(" | ")}`).toContain(
      "baseline",
    );
    expect(first[2], "the baseline row records no measured reading").toMatch(/\d+\s*pass/);
  });

  test("every mutation row names an input on which mutant and original differ", () => {
    const [, ...mutations] = batteryRows();
    const missing = mutations
      .filter(r => r[3].length < 20 || r[3] === "—")
      .map(r => r[0]);
    expect(
      missing,
      "a row with no differing input may be the code run twice rather than a mutation",
    ).toEqual([]);
  });

  test("no two mutation rows rest on the same input", () => {
    // Four identical reds are one shared cause, not four falsifications.
    const [, ...mutations] = batteryRows();
    const seen = new Map<string, string>();
    const shared: string[] = [];
    for (const r of mutations) {
      const prior = seen.get(r[3]);
      if (prior !== undefined) shared.push(`${prior} and ${r[0]} share one input`);
      else seen.set(r[3], r[0]);
    }
    expect(shared).toEqual([]);
  });

  test("every row that missed its prediction is explained below the table", () => {
    // A measured count that differs from its prediction is the finding, and a
    // table that records the difference without saying what it means is the
    // number without the fact.
    const [, ...mutations] = batteryRows();
    const missed = mutations.filter(r => {
      const predicted = Number(r[1]);
      const measured = Number(/\*\*(\d+)/.exec(r[2])?.[1] ?? NaN);
      return Number.isFinite(predicted) && Number.isFinite(measured) && predicted !== measured;
    });
    expect(missed.length, "no row missed, so this case is asserting nothing").toBeGreaterThan(0);
    const doc = section();
    const prose = doc.slice(doc.indexOf("**The instrument is a PAIR, deliberately.**"));
    for (const r of missed) {
      const id = /^(M\d+[a-z]?)/.exec(r[0])?.[1];
      expect(id, `a row has no M-number: ${r[0]}`).toBeDefined();
      // A bolded lead naming the row and the words "came back". Rows that
      // missed for one shared reason are explained in one sentence — "M4
      // and M5 came back 2 against a predicted 1" — so the pattern spans
      // the id rather than demanding it sit immediately before the verb.
      const explained = new RegExp(`\\*\\*[^*]*\\b${id}\\b[^*]*came back[^*]*\\*\\*`);
      expect(
        explained.test(prose),
        `${id} missed its prediction and nothing below the table says why`,
      ).toBe(true);
    }
  });
});
