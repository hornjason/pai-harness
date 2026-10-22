/**
 * A tick may not name a function nobody wrote (#1161).
 *
 * `specs/INSTRUCTION-COMPLIANCE-SPEC.md` carried a ticked criterion for
 * `runBehavioralCompliance`, 167 lines below its own statement that the
 * function was "(to be built)". There was no declaration, no export, no
 * caller and no test; the only occurrence of the name in executable source
 * was a docblock calling it future work. The sibling criterion in
 * `specs/bootstrap-data-flow/success-criteria.md` tracked the same thing and
 * was correctly unticked. The two disagreed, and the unticked one was right.
 *
 * ## What is being guarded, and what is not
 *
 * This asserts ONE property: no ticked criterion names a camelCase symbol
 * that occurs nowhere in the tree's executable source or structured data,
 * except the rows banked in `.claude/ticked-sc-absent-symbol-ratchet.json`
 * with a stated reason.
 *
 * It does NOT verify the SC list. Measured on the tree this shipped against:
 * 1,449 ticked criteria, 397 of them naming any symbol at all. The other
 * 1,052 state behaviours — "Auditor after every agent" — and nothing cheap
 * can tell whether those are true. A green run here means the weakest
 * possible thing, and it is still worth having, because the weakest possible
 * thing is what the tree was failing.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Index the raw source instead of stripping comments.** Faster, simpler,
 * and it reports zero on this tree — `runBehavioralCompliance` occurs in
 * `lib/compliance.ts` as a comment, so a raw-text reading clears the exact
 * defect the issue is about. The planted pair below runs that comparison on
 * every run instead of asserting it in prose: the same symbol, in a comment
 * and then in code, over one otherwise identical tree.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ABSENT_SYMBOL_RATCHET,
  SELF_REFERENTIAL_FILES,
  scanTickedScSymbols,
  symbolsNamedBy,
} from "../lib/ticked-sc-symbols";

const REPO = join(import.meta.dir, "..");
const SPECS = join(REPO, "specs");

function scanRepo(exclude?: readonly string[]) {
  return scanTickedScSymbols({ specsDir: SPECS, projectRoot: REPO, exclude });
}

function bankedRows(): Record<string, string> {
  const raw = readFileSync(join(REPO, ABSENT_SYMBOL_RATCHET), "utf-8");
  return JSON.parse(raw).rows as Record<string, string>;
}

describe("#1161: the real tree carries no unbanked absent symbol", () => {
  test("the scan read the tree, so an empty result would have meant something", () => {
    // Every assertion below is satisfied by a scan that read nothing: no
    // specs collected, no identifiers indexed, no criteria ticked. Those are
    // the three inputs, and each is asserted to be substantial before any
    // conclusion is drawn from their absence of disagreement.
    const scan = scanRepo();
    expect(scan.tickedScanned, "no ticked criteria were collected at all").toBeGreaterThan(400);
    expect(scan.identifiersIndexed, "no source was indexed").toBeGreaterThan(5_000);
    expect(
      scan.tickedNamingSymbols,
      "no ticked criterion names any symbol — the population at risk is empty, " +
        "so the check below cannot refuse anything",
    ).toBeGreaterThan(50);
  });

  test("every absent-symbol row is banked, and every banked row is still absent", () => {
    // An equality, not a ratchet. A rise means a criterion was ticked naming
    // something nobody wrote; a fall means a row was fixed and the entry has
    // to come out in the same commit, or the file rots into an artefact that
    // certifies nothing.
    const found = scanRepo().violations.map(v => v.key).sort();
    expect(
      found,
      "a ticked criterion names a symbol this tree does not contain. Build it, " +
        "untick the criterion, or — if the criterion is right and the detector " +
        `misread prose — add the row to ${ABSENT_SYMBOL_RATCHET} with a reason. ` +
        "If a row DISAPPEARED, delete its entry in the same commit.",
    ).toEqual(Object.keys(bankedRows()).sort());
  });

  test("every banked row carries a reason somebody can act on", () => {
    // A bank with blank reasons is a list nobody can audit, and the first
    // thing a stuck agent does is add an empty row.
    const thin = Object.entries(bankedRows())
      .filter(([, reason]) => reason.trim().length < 80)
      .map(([key]) => key);
    expect(thin, "a banked row has no usable reason").toEqual([]);
  });

  test("the two self-referential files are kept out, or they clear their own rows", () => {
    // The self-reference this whole area keeps producing, caught twice while
    // this was being written. The bank is a `.json` under `.claude/` listing
    // every identifier it banks; THIS file spells the original missing
    // function in a string literal, which is code and survives
    // comment-stripping. Indexed, either one is evidence that the missing
    // things exist.
    //
    // Measured, one input, both readings: 7 rows with the exclusions and 0
    // without them. Asserted as a relation rather than as the number 7, so
    // the case survives the bank changing size and still fails the moment
    // the exclusion stops being load-bearing.
    expect(SELF_REFERENTIAL_FILES.length, "the exclusion list is empty").toBe(2);
    const guarded = scanRepo().violations.length;
    const unguarded = scanRepo([]).violations.length;
    expect(guarded, "nothing is banked, so this comparison is vacuous").toBeGreaterThan(0);
    expect(
      unguarded,
      "indexing the bank and this suite did not change the reading — either " +
        "the exclusion is not applied, or they have stopped naming the symbols " +
        "they discuss",
    ).toBeLessThan(guarded);
  });

  test("the original criterion, replayed against the REAL tree, is still caught", () => {
    // The defect itself, permanently. The statement below is verbatim what
    // `specs/INSTRUCTION-COMPLIANCE-SPEC.md` carried ticked; the spec is
    // planted in a scratch directory while the project root stays the real
    // repository, so this asserts two things at once — that the tree still
    // does not contain the function, and that a tick naming it is refused.
    //
    // Without the exclusion of this file from the index, this case scored
    // ZERO red: the literal below put the name into the tree it was looking
    // for. That measurement is why `SELF_REFERENTIAL_FILES` exists.
    //
    // If layer 3 is ever built, this goes red. That is the correct reading
    // and the fix is to retire the case, not to weaken it.
    const ORIGINAL = "runBehavioralCompliance spawns fresh agent + auditor";
    const root = mkdtempSync(join(tmpdir(), "rg-1161-replay-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "REPLAY.md"), `- [x] SC-9715: ${ORIGINAL}\n`);
    try {
      const found = scanTickedScSymbols({
        specsDir: join(root, "specs"),
        projectRoot: REPO,
      }).violations;
      expect(found.map(v => v.symbol)).toEqual(["runBehavioralCompliance"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Both directions over one planted tree.
 *
 * Fixture ids are in the 9700 range on purpose: a real id written in a test
 * file is read as a coverage claim (#149), so a test ABOUT tick honesty would
 * otherwise tick the criteria it discusses.
 */
describe("#1161: the detector separates a present symbol from an absent one", () => {
  const PRESENT = "thePresentThing";
  const ABSENT = "theAbsentThing";

  /** `where` decides whether the absent symbol appears in code, a comment, or nowhere. */
  function plant(where: "nowhere" | "comment" | "code"): string {
    const root = mkdtempSync(join(tmpdir(), "rg-1161-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(root, "specs", "PLANTED-SPEC.md"),
      [
        "---", "doc-type: spec", "testable: true", "governs: a planted thing", "---", "",
        "# Planted", "", "## Success Criteria", "",
        `- [x] SC-9711: ${PRESENT} returns a verdict`,
        `- [x] SC-9712: ${ABSENT} returns a verdict`,
        `- [ ] SC-9713: ${ABSENT}Later returns a verdict`,
        `- [x] SC-9714: SUPERSEDED by SC-9712 — was "${ABSENT}Gone returns a verdict"`,
        "",
      ].join("\n"),
    );
    const body = [
      `export function ${PRESENT}() { return "PASS"; }`,
      where === "comment" ? `// ${ABSENT}() — spawns the thing (future)` : "",
      where === "code" ? `export function ${ABSENT}() { return "PASS"; }` : "",
      "",
    ].join("\n");
    writeFileSync(join(root, "lib", "planted.ts"), body);
    return root;
  }

  function scanPlanted(where: "nowhere" | "comment" | "code"): string[] {
    const root = plant(where);
    try {
      return scanTickedScSymbols({ specsDir: join(root, "specs"), projectRoot: root })
        .violations.map(v => v.key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a ticked criterion naming a symbol nothing declares is reported", () => {
    expect(scanPlanted("nowhere")).toEqual([`PLANTED-SPEC.md::SC-9712::${ABSENT}`]);
  });

  test("a ticked criterion naming a symbol that IS declared is not reported", () => {
    // The positive control. Without it the case above is satisfied by a
    // detector that flags every criterion it sees.
    expect(
      scanPlanted("nowhere"),
      "the present symbol was flagged too, so the scan is not reading source at all",
    ).not.toContain(`PLANTED-SPEC.md::SC-9711::${PRESENT}`);
  });

  test("a symbol that exists only in a COMMENT is still absent", () => {
    // The original defect, staged. `lib/compliance.ts` contained the name in
    // a docblock reading "(future)", and that is the only place it occurred.
    expect(scanPlanted("comment")).toEqual([`PLANTED-SPEC.md::SC-9712::${ABSENT}`]);
  });

  test("the same symbol in CODE clears it — one input, one difference", () => {
    // The pair that makes the case above mean something. Identical tree,
    // identical spec, the name moved out of the comment and into a
    // declaration. If comment-stripping were dropped, these two cases would
    // return the same answer and the one above would stop testing anything.
    expect(scanPlanted("code")).toEqual([]);
  });

  test("an UNTICKED criterion naming an absent symbol is not a violation", () => {
    // The whole subject is the tick. A criterion that claims nothing is
    // allowed to name anything, and flagging it would make every planned
    // feature a failure.
    expect(scanPlanted("nowhere").join("\n")).not.toContain("SC-9713");
  });

  test("a SUPERSEDED tick is a pointer, and its dead symbol is not demanded", () => {
    // Same exemption `test/ticked-sc-cover.test.ts` makes, for the same
    // reason: the line records what the criterion USED to say, so requiring
    // the old name to resolve would push specs to delete their history. It
    // is also the form this issue's own repair took.
    expect(scanPlanted("nowhere").join("\n")).not.toContain("SC-9714");
  });
});

describe("#1161: what counts as naming a symbol", () => {
  test("a camelCase word is a symbol, with or without a call site", () => {
    // Both forms, because the first draft of this detector required a `(`
    // and was therefore blind to the exact criterion it was written for —
    // "runBehavioralCompliance spawns fresh agent + auditor" has no parens.
    // It reported zero violations on a tree with a live one.
    expect(symbolsNamedBy("runBehavioralCompliance spawns fresh agent + auditor"))
      .toEqual(["runBehavioralCompliance"]);
    expect(symbolsNamedBy("`lib/compliance.ts → runBehavioralCompliance(root)` is built"))
      .toEqual(["runBehavioralCompliance"]);
  });

  test("English prose names no symbol", () => {
    // The filter that keeps this off 1,052 behavioural criteria. If an
    // ordinary sentence yielded candidates, every one of them would be
    // absent from the tree and the bank would be the whole SC list.
    expect(symbolsNamedBy("The gate refuses, and says which of two things happened")).toEqual([]);
    expect(symbolsNamedBy("Auditor after every agent")).toEqual([]);
    expect(symbolsNamedBy("Compliance surface = 4 file types only")).toEqual([]);
  });

  test("a leading capital is not a symbol reference", () => {
    // `PascalCase` at the start of a sentence is indistinguishable from a
    // proper noun, and a type name in a criterion is nearly always prose
    // about a shape rather than a claim that an identifier exists.
    expect(symbolsNamedBy("ComplianceReport is written to .rungate/")).toEqual([]);
  });
});
