/**
 * Covers SC-2096, SC-2097, SC-2098, SC-2099, SC-2100 (HARNESS-STANDARD.md).
 *
 * #664 converted eleven fixed-character windows in `test/` to structural cuts.
 * #666 is the measurement the conversion erases: how close to failing each
 * window already was. That measurement lives in two documents —
 * `specs/HARNESS-STANDARD.md` and `.claude/rules/checks-must-be-able-to-fail.md`
 * — and a measurement in a document has exactly one failure mode worth
 * guarding: **it gets dropped, and nothing notices.** A missing table is not
 * red anywhere. A table silently cut from eleven rows to two is not red
 * anywhere. A row whose `headroom` column was hand-edited to a comfortable
 * number is not red anywhere.
 *
 * So this file reads the record back and checks it as DATA.
 *
 * ## Why the two files are compared against each other
 *
 * #621 is the row: three documents named this project's test command, nothing
 * compared them, and two of them had been wrong for long enough that every
 * ship run reported a suite failure over a tree with zero failures. Two copies
 * of one measurement with nothing comparing them is that defect, not a
 * precaution against it — so the block is extracted from both and compared
 * byte for byte.
 *
 * ## The two ways this file could pass while reading nothing
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, third shape — *assertions
 * that hold vacuously*. Both are closed by refusals rather than by comments:
 *
 *  - **A slice that fails to find its section is an empty string, and an
 *    empty string contains nothing**, which reads exactly like a clean
 *    result. `recordBlock` throws `RecordSectionMissing` rather than
 *    returning `""`, and every caller goes through it.
 *  - **A table parser that matches nothing reports no rows, and zero rows
 *    satisfy every `every(...)` in this file.** So `tableRows` is run over a
 *    planted table as well as the real one, and the row counts are asserted
 *    as exact numbers rather than as lower bounds.
 *
 * ## The cheapest wrong fix, named
 *
 * The 5pm repair for "the record test is red because the rule file drifted"
 * is to stop reading the rule file and assert only against the spec. The
 * byte-for-byte case is the one that does not survive it: it names both
 * paths, and a version that reads one document cannot compare two.
 *
 * ## What was broken to prove it
 *
 * Recorded in `specs/HARNESS-STANDARD.md` beside SC-2096..SC-2100.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

/** The two documents that carry the #666 measurement. */
export const RECORD_FILES = [
  "specs/HARNESS-STANDARD.md",
  "reference/check-failure-worked-instances.md",
] as const;

/** The first heading of the shared block, and the only entry point to it. */
export const BLOCK_START = "#### The eleven pre-conversion windows, measured";

/** The block is not in the document, so there is nothing to read. */
export class RecordSectionMissing extends Error {
  constructor(file: string, heading: string) {
    super(
      `${file} no longer carries ${JSON.stringify(heading)} — the #666 measurement ` +
        `was dropped from a record file, which is silent everywhere else`,
    );
    this.name = "RecordSectionMissing";
  }
}

/** The section exists and holds no table, which satisfies every row check. */
export class RecordTableEmpty extends Error {
  constructor(heading: string) {
    super(`${JSON.stringify(heading)} carries no table rows, so any claim about its rows is vacuous`);
    this.name = "RecordTableEmpty";
  }
}

/**
 * The shared block — `BLOCK_START` through the next `### ` heading.
 *
 * Refuses rather than returning `""`: an empty slice contains nothing, which
 * is indistinguishable from a block that disagrees with nothing.
 */
export function recordBlock(doc: string, file: string): string {
  const from = doc.indexOf(BLOCK_START);
  if (from < 0) throw new RecordSectionMissing(file, BLOCK_START);
  const end = doc.indexOf("\n### ", from);
  const block = end < 0 ? doc.slice(from) : doc.slice(from, end + 1);
  if (block.trim().length === 0) throw new RecordSectionMissing(file, BLOCK_START);
  return block;
}

/** One `#### ` subsection of the block, sliced out and refused when absent. */
export function subsection(block: string, heading: string, file: string): string {
  const from = block.indexOf(heading);
  if (from < 0) throw new RecordSectionMissing(file, heading);
  const rest = block.slice(from + heading.length);
  const end = rest.search(/\n#{1,6} /);
  const cut = heading + (end < 0 ? rest : rest.slice(0, end));
  if (cut.trim().length === heading.trim().length) throw new RecordSectionMissing(file, heading);
  return cut;
}

/**
 * Every body row of every markdown table in `section`, as cell arrays.
 *
 * Header rows and `|---|` separators are dropped. A section with no rows
 * refuses, because `[].every(...)` is `true`.
 */
export function tableRows(section: string, heading: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map(c => c.trim());
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  if (rows.length === 0) throw new RecordTableEmpty(heading);
  return rows;
}

/** Every integer in a cell, with markdown emphasis and thousands commas gone. */
export function numbersIn(cell: string): number[] {
  return [...cell.replace(/\*/g, "").replace(/(\d),(?=\d\d\d\b)/g, "$1").matchAll(/\d+/g)].map(m =>
    Number(m[0]),
  );
}

const HEADROOM = "#### The eleven pre-conversion windows, measured";
const MUTATION = "#### The whole-document mutation, predicted and measured";
const WRONG_FIX = "#### The cheapest wrong fix, applied and measured";

interface HeadroomRow {
  index: number;
  site: string;
  window: number;
  farthestNeeded: number;
  headroom: number;
  construct: number;
  covered: boolean;
}

/** The eleven measured windows, read out of one record file. */
export function headroomTable(doc: string, file: string): HeadroomRow[] {
  const rows = tableRows(subsection(recordBlock(doc, file), HEADROOM, file), HEADROOM);
  const body = rows.filter(r => r.length === 8 && /^\d+$/.test(r[0]!));
  if (body.length === 0) throw new RecordTableEmpty(HEADROOM);
  return body.map(r => ({
    index: Number(r[0]),
    site: r[1]!,
    window: Number(r[3]),
    farthestNeeded: Number(r[4]),
    headroom: Number(r[5]),
    construct: Number(r[6]),
    covered: r[7]!.toLowerCase() === "yes",
  }));
}

const DOCS = RECORD_FILES.map(file => ({
  file,
  text: readFileSync(join(REPO_ROOT, file), "utf-8"),
}));

/** The eleven sites #664 converted, as the table must name them. */
const CONVERTED_SITES = [
  "test/worktree-repo.test.ts:764",
  "test/agent-timings.test.ts:344",
  "test/decomposition-waves.test.ts:269",
  "test/ac-coverage.test.ts:313",
  "test/recorder-command-executed.test.ts:350",
  "test/suite-measurement-parity.test.ts:304",
  "test/slug-derivation.test.ts:109",
  "test/ac-coverage.test.ts:485",
  "test/issue-close-guard-target.test.ts:160",
  "test/ship-and-heal.test.ts:74",
  "test/agent-timings-queued.test.ts:292",
];

describe("#666: the measurement #664 erases is written down and stays written down", () => {
  test("the parser fires on a planted table and refuses one with no rows", () => {
    // The dead-pattern vacuity. Without this, narrowing the row matcher to
    // something unmatchable buys a green file: every assertion below is
    // quantified over rows, and there would be none.
    const planted = ["#### H", "", "| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    expect(tableRows(planted, "#### H")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(() => tableRows("#### H\n\nno table here at all\n", "#### H")).toThrow(RecordTableEmpty);
    expect(() => recordBlock("# a document with no record in it\n", "fixture.md")).toThrow(
      RecordSectionMissing,
    );
    expect(numbersIn("**14** over **1,384** files")).toEqual([14, 1384]);
  });

  test("SC-2098: the two record files carry the same block, byte for byte", () => {
    // #621: two documents naming one measurement with nothing comparing them
    // is the defect, not the record. This is also the case that does not
    // survive the cheapest wrong fix — dropping the rule file and asserting
    // only against the spec — because it names both paths by construction.
    const blocks = DOCS.map(d => recordBlock(d.text, d.file));
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b.length).toBeGreaterThan(1000);
    expect(
      blocks[0],
      `${RECORD_FILES[0]} and ${RECORD_FILES[1]} disagree about the #666 measurement — ` +
        `one of them was edited and the other was not`,
    ).toBe(blocks[1]!);
  });

  for (const { file, text } of DOCS) {
    describe(file, () => {
      test(`SC-2096: eleven rows, one per converted site — ${file}`, () => {
        // A table cut down to the two interesting rows reads exactly like a
        // complete one, so the count is exact and the sites are compared as
        // a set rather than spot-checked.
        const rows = headroomTable(text, file);
        expect(rows).toHaveLength(11);
        expect(rows.map(r => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(rows.map(r => r.site).sort()).toEqual([...CONVERTED_SITES].sort());
      });

      test(`SC-2097: headroom is window minus farthest-needed — ${file}`, () => {
        // Every number read as a number. A row whose headroom was hand-edited
        // to something comfortable fails here and nowhere else.
        const rows = headroomTable(text, file);
        for (const r of rows) {
          for (const [name, n] of [
            ["window", r.window],
            ["farthest-needed", r.farthestNeeded],
            ["headroom", r.headroom],
            ["construct", r.construct],
          ] as const) {
            expect(Number.isInteger(n), `${r.site}: ${name} is not an integer`).toBe(true);
            expect(n, `${r.site}: ${name} is not positive`).toBeGreaterThan(0);
          }
          expect(r.headroom, `${r.site}: headroom does not equal window - farthest-needed`).toBe(
            r.window - r.farthestNeeded,
          );
          expect(
            r.covered,
            `${r.site}: the 'covered' column disagrees with window (${r.window}) vs construct (${r.construct})`,
          ).toBe(r.window >= r.construct);
        }
      });

      test(`a window shorter than its construct is named as passing for the wrong reason — ${file}`, () => {
        // #666's deliverable. Naming them is the point: a row that was never
        // reading its own subject is invisible once the structural cut lands,
        // and the first headroom column cannot see it either.
        const rows = headroomTable(text, file);
        const short = rows.filter(r => !r.covered);
        expect(short.map(r => r.site).sort()).toEqual(
          ["test/ac-coverage.test.ts:485", "test/agent-timings.test.ts:344"].sort(),
        );
        const named = subsection(
          recordBlock(text, file),
          "#### Two rows were passing for the wrong reason, named",
          file,
        );
        for (const r of short) {
          expect(named, `${r.site} is short by ${r.construct - r.window} and is not named`).toContain(
            r.site,
          );
        }
      });

      test(`SC-2099: both red counts are present and equal — ${file}`, () => {
        // A mutation row whose measured column was dropped is indistinguishable
        // from one that was never run, so both columns are read as numbers.
        const section = subsection(recordBlock(text, file), MUTATION, file);
        const rows = tableRows(section, MUTATION).filter(r => r.length === 3);
        const baseline = rows.find(r => r[0]!.includes("baseline"));
        const mutant = rows.find(r => r[0]!.includes("return doc"));
        expect(baseline, "the mutation table has no baseline row").toBeDefined();
        expect(mutant, "the mutation table has no whole-document row").toBeDefined();

        // The baseline is read FIRST and on purpose: an instrument that
        // stopped reporting takes the baseline down with it, and that is the
        // one row nobody mutates anything to produce.
        expect(numbersIn(baseline![1]!), "the predicted baseline is not 290 pass, 0 fail").toEqual([
          290, 0,
        ]);
        expect(numbersIn(baseline![2]!), "the measured baseline is not 290 pass, 0 fail").toEqual([
          290, 0,
        ]);

        const predicted = numbersIn(mutant![1]!);
        const measured = numbersIn(mutant![2]!);
        expect(predicted, "the predicted red count is not a single number").toHaveLength(1);
        expect(measured, "the measured red count is not a single number").toHaveLength(1);
        expect(predicted[0]).toBe(11);
        expect(
          measured[0],
          "the measured red count no longer equals the number of converted cases",
        ).toBe(predicted[0]!);
        expect(measured[0]).toBe(CONVERTED_SITES.length);
      });

      test(`SC-2100: the wrong fix is recorded as applied, with numbers — ${file}`, () => {
        // "The cheapest wrong fix was considered" is prose. "It was applied,
        // the case went green and the sweep stayed red" is a measurement, and
        // only the second one can decay into a lie somebody notices.
        const section = subsection(recordBlock(text, file), WRONG_FIX, file);
        expect(section, "the window that was widened is not named").toContain("6000");
        expect(section, "the value it was widened to is not named").toContain("9000");

        const rows = tableRows(section, WRONG_FIX).filter(r => r.length === 2);
        const row = (needle: string) => {
          const r = rows.find(x => x[0]!.includes(needle));
          expect(r, `the wrong-fix table has no row for ${JSON.stringify(needle)}`).toBeDefined();
          return numbersIn(r![1]!);
        };
        // Before the repair: the symptom exists.
        expect(row("window still 6000"), "SC-1446 is not recorded red before the widen").toEqual([
          0, 1,
        ]);
        // After it: the symptom is gone, which is what makes it the cheap fix.
        expect(row("widened to 9000"), "SC-1446 is not recorded green after the widen").toEqual([
          1, 0,
        ]);
        // And the sweep is still red, which is what makes it the WRONG fix.
        const scan = row("zero-fixed-windows scan");
        expect(scan[1], "the sweep is not recorded as still failing after the wrong fix").toBe(1);

        const still = row("windows the scan still reports");
        expect(still[0], "the surviving window count is not a positive number").toBeGreaterThan(0);
        expect(still[1], "the number of files the sweep read is not recorded above 100").toBeGreaterThan(
          100,
        );

        const converted = row("the same scan on the converted tree");
        expect(
          converted,
          "the converted tree is not recorded at 4 pass, 0 fail, 0 windows over 385 files",
        ).toEqual([4, 0, 0, 385]);
      });
    });
  }
});
