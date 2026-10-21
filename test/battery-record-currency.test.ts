/**
 * #795 — a measurement recorded in two documents, corrected in one.
 *
 * #652's battery is written down twice, deliberately: once in
 * `.claude/rules/checks-must-be-able-to-fail.md` as a worked example of a
 * matrix whose cells are not equally load-bearing, and once in
 * `specs/HARNESS-STANDARD.md` beside the criteria it proves. Both tables
 * carry the same eleven rows and the same counts.
 *
 * Both also carried the same caveat: the rows were measured on a `git
 * archive` export under `/tmp` holding an implementation the repository did
 * not have, so every row except the pre-#652 one was — in this repository's
 * own words — *a claim rather than a count*. Both ended by instructing the
 * next reader to re-run them once the implementation landed.
 *
 * It landed. `workflows/ship.js` has carried #652's four-cell composition
 * since the issue merged, and #653 re-ran the battery: all ten mutations
 * reproduce, same counts, same named criteria. PR #794 wrote that into
 * `specs/HARNESS-STANDARD.md`. It touched exactly one file.
 *
 * So for the time between those two events the two documents disagreed about
 * whether an implementation was in the tree, and **nothing could see it**.
 * #666's byte-identity check compares one block of these same two files —
 * measured on `origin/main` at `bff1a435`, 7,664 bytes, sha256 `0b944efa…`
 * in both — and the #652 provenance sits outside it. The suite was green.
 *
 * ## What this asserts, and why it is a REQUIREMENT rather than a refusal
 *
 * The obvious check is to forbid the stale sentence. It does not work, and
 * the reason is the third shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * met from the permissive side: the corrected spec QUOTES the sentence it
 * replaced — *"re-run them against the tree once the implementation lands"* —
 * because recording what the paragraph used to say is the honest way to
 * correct it. A detector that greps for that phrase reports the fixed
 * document and the broken one identically. Telling an instruction from a
 * quotation of one is the problem `.claude/rules/claiming-sc-coverage.md`
 * exists about, and it is not solvable by matching text.
 *
 * So the property asserted is positive: **a document carrying #652's battery
 * must also carry the record of the re-measurement.** A document that says
 * nothing about currency fails; a document that quotes its own history and
 * then states the current reading passes.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Delete the stale sentence from the rules file and stop.** One line, the
 * contradiction is gone, and the rules file then records eleven rows with no
 * provenance at all — strictly worse than a stale caveat, because a reader
 * has nothing to distrust. This case survives it: the marker is still
 * absent, so it is still red. That is the whole reason the assertion is a
 * requirement and not a prohibition.
 *
 * ## What this does NOT catch, said here rather than left as an omission
 *
 * - **A document carrying the marker AND a contradicting instruction.** The
 *   check reads one direction only. Distinguishing a live imperative from a
 *   quoted one needs a detector keyed to bolding or to italic quoting, which
 *   is a detector keyed to formatting, and a reformat defeats it.
 * - **The two tables disagreeing about a count.** They are deliberately not
 *   byte-identical — the spec carries a twelfth row for #653's own cheapest
 *   wrong fix, and several cells differ in wording (`SC-2084 and SC-2085`
 *   against `SC-2084, SC-2085`). A row-by-row comparison would be red today
 *   for reasons that have nothing to do with the measurement, which is the
 *   false-positive generator `.claude/rules/self-referential-tests.md`
 *   warns about. The rows agreeing is currently a fact nobody checks.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file alone (5 tests). Counts predicted in
 * `/tmp/795-battery/predictions.md` before the battery ran, and **the
 * baseline row read first** — an instrument that has stopped reporting takes
 * the baseline down with it, and that is the row nobody mutates anything to
 * produce.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | read first | **5 pass, 0 fail** | — |
 * | P1 `batteryCurrencyViolations` short-circuited to `return []` | 3 | **3 of 5** | the planted rules-without-marker tree — original 1 violation, mutant `[]` — and both refusal trees stop throwing |
 * | P2 the currency requirement deleted, the two refusals left | 1 | **1 of 5** | the same tree: original 1 violation, mutant `[]`. Strictly smaller than P1, which is what says the refusals are reachable separately from the requirement |
 * | P3 the `workflows/ship.js` instrument refusal deleted | 1 | **1 of 5** | a tree whose ship.js lacks #652's composition: the original throws `RecordUnreadable`, the mutant reads two well-formed documents and returns `[]` |
 * | P4 the battery-presence refusal deleted | 1 | **1 of 5** | a tree whose spec carries no battery row: the original throws, the mutant reports it as an ordinary missing-currency violation and loses the distinction |
 * | P5 the genuinely pre-#795 `.claude/rules/checks-must-be-able-to-fail.md` | 1 | **1 of 5** | the real repository tree: the original returns `[]`, the pre-fix rules file returns one violation naming itself |
 *
 * **P1 is 3 and not 5 on purpose.** The first two cases are satisfied by an
 * empty list and by reading the documents directly, so neither can witness
 * the binding — which is why the three that drive it exist. A P1 of 5 would
 * have meant the binding was being read somewhere it is not.
 *
 * **P5 is the only row measured against a real pre-fix tree** rather than a
 * reconstruction of one, and its count matching P2's is the evidence that
 * the reconstruction is faithful.
 *
 * None of the five mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and both mutated files were
 * confirmed byte-identical by sha256 afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The two documents that carry #652's battery. */
export const RECORD_FILES = [
  "specs/HARNESS-STANDARD.md",
  "reference/check-failure-worked-instances.md",
] as const;

/**
 * A row label no other table in either document uses.
 *
 * Presence of the battery is established by this rather than by a heading:
 * the two documents head the section differently, and a heading is the part
 * most likely to be reworded by someone improving the prose.
 */
export const BATTERY_ROW = "the genuinely pre-#652";

/**
 * The composition #652 shipped, as it stands in `workflows/ship.js`.
 *
 * This is the INSTRUMENT. Every claim below is conditional on the
 * implementation being in the tree, so a reading taken against a tree
 * without it is not a reading — it refuses rather than passing.
 */
export const IMPLEMENTATION_ANCHOR = "so the shared checkout has been moved (#652)";

/** The record of the re-measurement, in the words PR #794 landed. */
export const REMEASUREMENT_MARKER = "all ten reproduce";

export class RecordUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordUnreadable";
  }
}

/**
 * Every record document that does not state the battery's currency.
 *
 * REFUSES rather than returning `[]` when it cannot establish its own
 * premise: a document that no longer carries the battery, and a tree whose
 * `workflows/ship.js` no longer carries the implementation, are both facts
 * that make every row below meaningless. An empty violation list from an
 * unreadable input is indistinguishable from agreement.
 */
export function batteryCurrencyViolations(root: string): string[] {
  const ship = readFileSync(join(root, "workflows", "ship.js"), "utf-8");
  const implementations = ship.split(IMPLEMENTATION_ANCHOR).length - 1;
  if (implementations !== 1) {
    throw new RecordUnreadable(
      `workflows/ship.js carries ${implementations} occurrences of ${JSON.stringify(IMPLEMENTATION_ANCHOR)}, not 1 — ` +
        "every claim in this file is conditional on #652's composition being in the tree, so a tree " +
        "without it is UNMEASURED rather than clean (#795)",
    );
  }

  const violations: string[] = [];
  for (const file of RECORD_FILES) {
    const doc = readFileSync(join(root, file), "utf-8");
    if (!doc.includes(BATTERY_ROW)) {
      throw new RecordUnreadable(
        `${file} no longer carries ${JSON.stringify(BATTERY_ROW)}, so #652's battery was dropped from a ` +
          "record document — which is silent everywhere else (#795)",
      );
    }
    if (!doc.includes(REMEASUREMENT_MARKER)) {
      violations.push(
        `${file} records #652's battery and does not say it was re-measured against the tree. ` +
          `workflows/ship.js carries the implementation, so the rows in this document are a claim ` +
          `rather than a count by this repository's own standard. Port the paragraph PR #794 landed ` +
          `in specs/HARNESS-STANDARD.md rather than writing a second one — two independent accounts ` +
          `of one measurement is the pair this document warns about (#795)`,
      );
    }
  }
  return violations;
}

describe("#795: a battery recorded twice is corrected in both places", () => {
  test("every record document states that #652's battery was re-measured", () => {
    expect(batteryCurrencyViolations(REPO_ROOT)).toEqual([]);
  });

  test("the scan read both documents, so an empty result is not an empty scan", () => {
    // The control. `[].every(...)` is true and so is `[].toEqual([])`, so a
    // check over a population it failed to find reads exactly like a check
    // that is satisfied (#492).
    expect(RECORD_FILES.length).toBe(2);
    for (const file of RECORD_FILES) {
      const doc = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(doc.includes(BATTERY_ROW), `${file} does not carry the battery`).toBe(true);
    }
  });

  test("a tree without the implementation is UNMEASURED, not clean", () => {
    // The instrument check, driven rather than described. Without it a
    // revert of #652 would leave this file green over documents whose
    // caveat had become true again.
    const root = plantedRoot({ ship: "function waveCommitFailure() { return 'nothing' }" });
    expect(() => batteryCurrencyViolations(root)).toThrow(RecordUnreadable);
  });

  test("a document that dropped the battery is UNMEASURED, not clean", () => {
    const root = plantedRoot({ spec: "# a spec with no battery in it\n" });
    expect(() => batteryCurrencyViolations(root)).toThrow(RecordUnreadable);
  });

  test("a document carrying the battery and no currency record is named", () => {
    // The input on which this case and a deleted-sentence repair differ:
    // a document with the rows and nothing about when they were taken.
    const root = plantedRoot({
      rules: `| ${BATTERY_ROW} \`workflows/ship.js\` | 6 | **6 of 22** |\n`,
    });
    const violations = batteryCurrencyViolations(root);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(RECORD_FILES[1]);
    expect(violations[0]).toContain("re-measured");
  });
});

/**
 * A minimal tree the binding will read, with one part replaced.
 *
 * Built under `mkdtemp` rather than in the repository — a fixed in-repo
 * scratch directory is refused by `test/scratch-paths-unique.test.ts`.
 */
function plantedRoot(replace: { ship?: string; spec?: string; rules?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "rg-795-"));
  scratch.push(root);

  const goodShip = `const m = \`...\${runRef}, ${IMPLEMENTATION_ANCHOR}\`\n`;
  const goodDoc = `| ${BATTERY_ROW} \`workflows/ship.js\` | 6 | **6 of 22** |\n\n#653 did, and ${REMEASUREMENT_MARKER}.\n`;

  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows", "ship.js"), replace.ship ?? goodShip);

  // Planted FROM `RECORD_FILES`, not from two spelled paths. #1009 moved the
  // second record out of `.claude/rules/` and a hand-written fixture path kept
  // pointing at a file the binding no longer reads — the planted tree then had
  // nothing at the path under test, and the case threw ENOENT instead of
  // measuring anything.
  const bodies = [replace.spec ?? goodDoc, replace.rules ?? goodDoc];
  RECORD_FILES.forEach((file, i) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bodies[i]!);
  });
  return root;
}
