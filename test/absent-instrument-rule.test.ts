/**
 * Covers #657 (#646 Phase 2) — the absent-instrument section exists, says
 * what it is for, and every negative reading in it carries the command that
 * produced it.
 *
 * The thing this file is guarding against is specific and it has happened:
 * a rule section that reads well, is cited for months, and turns out to say
 * nothing a reader can act on because its numbers have no commands and its
 * subject is indistinguishable from the two sections either side of it.
 *
 * So every assertion here is made against a SLICE — the section cut out of
 * the file by its own heading — and the cut is asserted non-empty first. A
 * claim about one section asserted against the whole document is satisfied
 * by a match anywhere in it, which is the defect
 * `.claude/rules/checks-must-be-able-to-fail.md` names as "search the slice,
 * not the document", one section below the one under test here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
// #1009 moved the worked instances out of `.claude/rules/` and left the
// rules behind. This section is a worked instance, so it travelled; the
// heading, the fenced commands and the counts are byte-identical.
const RULES = join(REPO, "reference/check-failure-worked-instances.md");
const SPEC = join(REPO, "specs/INSTRUCTION-COMPLIANCE-SPEC.md");

const RULE_HEADING = "### Before you believe an empty search over a store you did not write (#646, #657)";
const SPEC_HEADING = "### The Phase 1 receipt checks can go red — baseline and four rows (#657)";

/**
 * The text under `heading`, up to the next heading of the same level.
 *
 * Refuses rather than returning "" when the heading is absent: an empty
 * string contains nothing, which is indistinguishable from a section that
 * is present and says nothing, and those are opposite findings.
 */
function section(doc: string, heading: string): string {
  const at = doc.indexOf(heading);
  if (at === -1) throw new Error(`the heading is not in the document: ${heading}`);
  if (doc.indexOf(heading, at + 1) !== -1) {
    throw new Error(`the heading appears more than once, so the cut is ambiguous: ${heading}`);
  }
  const from = at + heading.length;
  const next = doc.indexOf("\n### ", from);
  return doc.slice(from, next === -1 ? doc.length : next);
}

const ruleSection = (): string => section(readFileSync(RULES, "utf-8"), RULE_HEADING);
const specSection = (): string => section(readFileSync(SPEC, "utf-8"), SPEC_HEADING);

describe("#657 AC-4: the section exists and is distinguishable from its neighbours", () => {
  test("the cut is non-empty, and it is a section rather than a heading", () => {
    const s = ruleSection();
    expect(s.trim().length, "an empty cut reads exactly like a section that says nothing").toBeGreaterThan(800);
  });

  test("the whole file still carries the two neighbours this section is defined against", () => {
    // Vacuity guard. The differencing assertions below are only meaningful
    // while both neighbours exist; if one were renamed, a section claiming
    // to differ from it would be comparing itself to nothing.
    const doc = readFileSync(RULES, "utf-8");
    expect(doc).toContain("### Before you believe a 0, check the instrument (#60)");
    expect(doc).toContain("### The artifact everyone reaches for as ground truth, which always agrees (#530)");
  });

  test("it names both neighbours and says how it differs from each", () => {
    const s = ruleSection();
    expect(s, "the #60 battery section is one of the two instruments that cannot reach this")
      .toContain("#60");
    expect(s, "the #530 permissive-store section is the mirror case").toContain("#530");

    // The difference from #60 is the instrument: a battery has a baseline
    // row to read, a grep does not.
    expect(s).toContain("baseline row");
    // The difference from #530 is the POLARITY: that one is a positive
    // result believed too readily, this one is a zero.
    expect(s.toLowerCase()).toContain("mirror");
    expect(s.toLowerCase()).toContain("negative");
  });
});

describe("#657 AC-5: the check is phrased after the property, and the inverse is recorded", () => {
  test("the one-line check demands a string that must be present if the subsystem ran", () => {
    const s = ruleSection();
    expect(s).toContain("name a string that must be PRESENT if the store has anything");
    // Phrased after the property and not after a proxy a reader could
    // satisfy some other way. The section says so, and says which proxy.
    expect(s).toContain("the path exists");
    expect(s).toContain("satisfiable without answering the question");
  });

  test("the inverse — a populated result that is not evidence — is in the same section", () => {
    const s = ruleSection();
    expect(s, "108 hits, of which one is evidence of execution").toContain("108");
    expect(s.toLowerCase()).toContain("quoting the subject back");
    expect(s, "and it is distinguished from #530 rather than filed under it")
      .toContain("archives the code that");
  });
});

describe("#657 AC-7: every reading carries the command that produced it", () => {
  test("each count is inside the fenced block that carries its command", () => {
    // Per-LINE would be the wrong unit and would have let a real gap
    // through in both directions: a command wrapped across two lines puts
    // its count on a continuation line that names no command, and a count
    // written in prose beside an unrelated paragraph mentioning `grep`
    // would pass. The block is the unit a reader can actually re-run.
    const s = ruleSection();
    const chunks = s.split("```");
    const fenced = chunks.filter((_, i) => i % 2 === 1);
    const prose = chunks.filter((_, i) => i % 2 === 0);

    const counts = (t: string): number => (t.match(/→\s*\d/g) ?? []).length;
    const total = fenced.reduce((n, b) => n + counts(b), 0);
    expect(total, "a section about not trusting counts must carry some counts")
      .toBeGreaterThanOrEqual(6);

    const blocksWithCountButNoCommand = fenced.filter(
      b => counts(b) > 0 && !/\b(grep|ls|xargs)\b/.test(b),
    );
    expect(
      blocksWithCountButNoCommand,
      "a count with no command beside it cannot be re-run, and the store underneath it moves",
    ).toEqual([]);

    const strayInProse = prose.reduce((n, p) => n + counts(p), 0);
    expect(strayInProse, "a reading outside a command block is a number nobody can reproduce")
      .toBe(0);
  });

  test("the zero readings — the ones the whole section is about — are among them", () => {
    const s = ruleSection();
    // The control returning 0 over a path with 14 directories is the
    // finding. If that line lost its command, the section would be asking
    // readers to do something it does not itself do.
    const zeroBlocks = s.split("```").filter((b, i) => i % 2 === 1 && /→\s*0\b/.test(b));
    expect(zeroBlocks.length).toBeGreaterThanOrEqual(1);
    for (const b of zeroBlocks) expect(b).toMatch(/\b(grep|ls)\b/);
  });

  test("the spec section's readings are counted alongside the rule file's", () => {
    // AC-7 counts across BOTH documents. The spec's readings are table
    // rows rather than shell lines, so what has to be present there is the
    // command the whole table was produced by.
    const sp = specSection();
    expect(sp.trim().length).toBeGreaterThan(400);
    expect(sp, "the table is a measurement, so it names what was run")
      .toContain("bun test test/unit/hill-climb-receipt.test.ts test/unit/persist-compliance.test.ts");
  });
});

describe("#657 AC-6: the spec records a baseline row and at least three mutation rows", () => {
  const rows = (): string[][] =>
    specSection()
      .split("\n")
      .filter(l => l.trim().startsWith("|") && !/^\|\s*-+/.test(l.trim()))
      .map(l => l.split("|").slice(1, -1).map(c => c.trim()))
      .filter(r => r.length === 3 && r[0] !== "Row");

  test("the baseline row is present and is read first", () => {
    const r = rows();
    expect(r.length, "a table with no rows agrees with every claim made about it")
      .toBeGreaterThan(0);
    expect(r[0]?.[0]).toContain("baseline");
    expect(specSection()).toContain("The baseline row was read before any mutation row");
  });

  test("at least three mutation rows carry BOTH a predicted and a measured count", () => {
    const mutations = rows().filter(r => !r[0]?.includes("baseline"));
    expect(mutations.length).toBeGreaterThanOrEqual(3);
    for (const r of mutations) {
      expect(r[1], `row "${r[0]}" has no predicted count`).toMatch(/\d/);
      expect(r[2], `row "${r[0]}" has no measured count`).toMatch(/\d/);
    }
  });

  test("the collapse-to-a-bare-count row and the cheapest-wrong-fix row are both there", () => {
    const names = rows().map(r => r[0] ?? "").join("\n").toLowerCase();
    expect(names, "the pre-#646 shape is the row that says the distinction is load-bearing")
      .toContain("bare count");
    expect(names).toContain("cheapest wrong fix");
  });

  test("the cheapest wrong fix was APPLIED and its result stated, not merely named", () => {
    const sp = specSection();
    expect(sp).toContain("applied, not merely named");
    expect(sp, "and the section says which way the cases went under it")
      .toContain("do **not** survive it");
  });
});
