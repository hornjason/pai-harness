/**
 * Covers SC-804, SC-805, SC-806, SC-807 (CONFIG-DRIVEN-TESTING-SPEC.md).
 *
 * #360 — a comment credits coverage, and a comment is also where this project
 * explains itself. `// covers SC-640` and `// SC-640 was the criterion the
 * collision broke` are the same shape to a position-only rule.
 *
 * Every id used as a FIXTURE here is in the 9900 range, deliberately, and the
 * reason is this file's own subject. A test about coverage attribution that
 * writes a real registry id in a declaring form claims that criterion — which
 * is exactly the bug, committed by the file arguing against it. #330 hit this
 * and #352 hit it again. The 9900s are declared by no spec, so no example
 * below can mint a credit however it is written.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commentClaimForm, type ClaimForm } from "../lib/sc-claim-forms";
import { structuralCut } from "../lib/source-slice";
import { commentMask, enclosingComment } from "../lib/strip-js-comments";
import { buildScRegistry } from "../lib/sc-ids";
import { coverageClaimSites, findTestFilesForSCs } from "../scripts/sync-sc-status";
import { scScanTestTimeout } from "./helpers/sc-scan-budget";

// The per-test budget for a case that scans the whole test tree (#1223).
// Calibrated on this machine and this tree rather than written down, so it
// has no expiry — see test/helpers/sc-scan-budget.ts. Every call in THIS
// file plants a scratch directory, so the budget is not load-bearing here;
// the roster is deliberately wider than the cases that need it.
setDefaultTimeout(scScanTestTimeout());

/** Ask the owner about the first id in a comment, the way the scanner does. */
function formOf(comment: string, id = "SC-9901"): ClaimForm | null {
  return commentClaimForm(comment, comment.indexOf(id), id);
}

describe("#360 SC-804: a declaring position is credited", () => {
  const DECLARING: Array<[string, string, ClaimForm]> = [
    ["a coverage verb before it", "// covers SC-9901", "covers"],
    ["covers, past tense, with a list", "// Covered by SC-9901 and SC-9902", "covers"],
    ["a bare label", "// SC-9901: the rate is a rate", "label"],
    ["a label at the END of an id list", "// AC-2 / SC-9900 / SC-9901: both", "label"],
    ["an issue-prefixed label", "// #178 / SC-9901: a worktree claims its files", "label"],
    ["the id opening a line", "/**\n * SC-9901 (SOME-SPEC.md)\n */", "line"],
    ["a range whose LAST id is asked about", " * SC-9898..SC-9901 (SPEC.md)", "line"],
    ["an issue-prefixed list", " * #173 — SC-9900, SC-9901, SC-9902.", "line"],
    ["a SPEC-REF line", " * SPEC-REF: A-SPEC.md § Success Criteria (SC-9901)", "spec-ref"],
    ["a trailing parenthetical", "// Nothing here reads the source (SC-9901).", "attribution"],
    ["a parenthetical of two ids", "// tests the extractor (SC-9900, SC-9901)", "attribution"],
    ["a parenthetical with an issue", "// resolved per the brief (#190, SC-9901)", "attribution"],
    ["a parenthetical LABEL", "// ── Extraction floor (SC-9901: the home) ──", "attribution"],
  ];

  test.each(DECLARING)("%s", (_label, comment, expected) => {
    expect(formOf(comment)).toBe(expected);
  });

  test("every declaring form is reachable — none is dead code", () => {
    // A form in the type that no case produces is a branch nobody measures,
    // and it would read as covered because the other twelve rows pass.
    const produced = new Set(DECLARING.map(([, , f]) => f));
    expect([...produced].sort()).toEqual(
      ["attribution", "covers", "label", "line", "spec-ref"],
    );
  });
});

describe("#360 SC-805: a citation is not credited", () => {
  // Every one of these is REAL, lifted from the tree while shipping #360, and
  // each lost a credit it had been holding. A synthetic citation would prove
  // the regex rejects what it was written to reject.
  const CITATIONS: Array<[string, string]> = [
    ["a past-tense reference", "// SC-9901 was the criterion the collision broke"],
    ["a reintroduction note", "// which is #307 SC-9901 exactly, reintroduced"],
    ["another file's declaration", "// `other.test.ts` declares SC-9901 twice"],
    ["a sameness comparison", "// fails in CI because it reads machine state is the same defect as SC-9900/SC-9901"],
    ["a forward pointer", "// --commit, because SC-9900/SC-9901 below are about the commit"],
    ["what a criterion SAYS", "// Read as a positive requirement it inverts the SC: SC-9901 says ship.js must NOT"],
    ["a cautionary case", " * Assertions are on the RESOLVED VALUE, never on source text (SC-9901 is the"],
    ["a parenthetical citation", '// Prose cites ids constantly ("see SC-9901"). Counting citations would'],
    ["fixture content", "// Should contain both the original SC-9900 and a new SC-9901"],
    ["a quoted spec line", '// The SC statement in a spec file: "SC-9901: Something (behavioral)"'],
  ];

  test.each(CITATIONS)("%s", (_label, comment) => {
    expect(formOf(comment), comment).toBeNull();
  });

  test("the quoted-example case is why the label rule is paren-scoped", () => {
    // `SC-9901:` is a label everywhere EXCEPT inside a quoted spec line, and
    // a bare "an id followed by a colon anywhere" rule credits it. The
    // parenthetical label and the quoted example are the same three
    // characters; only the bracket tells them apart.
    expect(formOf('// in a spec file: "SC-9901: Something"')).toBeNull();
    expect(formOf("// ── floor (SC-9901: the home) ──")).toBe("attribution");
  });
});

describe("#360 SC-806: the scanner reports the form rather than dropping the site", () => {
  test("a prose mention is still a site, carrying no form", () => {
    // #358 added `unqualifiedClaims` so an uncredited mention is REPORTED
    // instead of vanishing. Filtering inside coverageClaimSites re-created
    // that silent drop one layer down, and turned #358's test red. The
    // scanner reports; the credit rule decides.
    const sites = coverageClaimSites("// SC-9901 was the id the collision broke\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ id: "SC-9901", kind: "comment", form: null });
  });

  test("a declaring mention carries its form", () => {
    const sites = coverageClaimSites("// covers SC-9901\n");
    expect(sites[0]).toMatchObject({ kind: "comment", form: "covers" });
  });

  test("a title is a declaring position by construction, so it has no form", () => {
    const sites = coverageClaimSites('test("SC-9901: the rate is a rate", () => {});\n');
    expect(sites[0]).toMatchObject({ kind: "title", form: null });
  });
});

describe("#360 SC-806: the credit rule is the thing that consults the form", () => {
  /**
   * WHY THIS EXISTS, measured: deleting the `if (kind === "comment" && !form)`
   * line from `findTestFilesForSCs` — reverting the whole of #360 in place —
   * scored **0 red** across 131 tests. Every case above asserts what
   * `commentClaimForm` ANSWERS; not one asserted that anything asks it.
   *
   * A predicate nobody consults is the decorative check
   * `.claude/rules/checks-must-be-able-to-fail.md` is about, and it is worse
   * here than usual: the suite would have certified a rule that had been
   * switched off.
   */
  function creditsFor(source: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), "sc-claim-forms-"));
    try {
      writeFileSync(join(dir, "fixture.test.ts"), source);
      // Built rather than hand-written. A registry literal drifts from the
      // real shape the moment the shape grows a field — #392 added
      // `declaredById` and this fixture silently stopped being a registry.
      const reg = buildScRegistry([
        { file: "SOME-SPEC.md", content: "- [ ] SC-9901: a criterion\n" },
      ]);
      const found = findTestFilesForSCs([{ id: "SC-9901", specFile: "SOME-SPEC.md" }], reg, dir);
      return (found.get("fixture.test.ts") ?? []).map(c => c.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a declaring comment earns the credit", () => {
    // The positive control. Without it, a mutation that refuses EVERYTHING
    // satisfies the negative case below and reads as the rule working.
    expect(creditsFor("// covers SC-9901\nexport const x = 1;\n")).toEqual(["SC-9901"]);
  });

  test("a citation earns nothing", () => {
    expect(creditsFor("// `other.test.ts` declares SC-9901 twice\nexport const x = 1;\n")).toEqual([]);
  });

  test("one file doing both is credited once, by the claim", () => {
    // The shape that makes the per-(file, id) dedup matter: a file may
    // legitimately cite a criterion in one paragraph and declare it in
    // another, and the citation must not be what disqualifies the claim.
    const both =
      "// SC-9901 was the criterion the collision broke.\n" +
      "export const x = 1;\n" +
      "// covers SC-9901\n";
    expect(creditsFor(both)).toEqual(["SC-9901"]);
  });
});

describe("#360 SC-807: the enclosing comment is recovered, not guessed", () => {
  test("a multi-line docblock comes back whole", () => {
    // The bug that made #360's first census wrong in 192 of 220 cases.
    // stripJsComments blanks with a SPACE and leaves newlines, so a maximal
    // run of differing offsets stops at the first space — the enclosing
    // comment came back as `SC-633,` and every docblock looked like a bare
    // id, which put almost every credit in the DECLARING bucket by accident.
    const src = "/**\n * A heading\n *\n * covers SC-9901\n */\nconst x = 1;\n";
    const at = src.indexOf("SC-9901");
    const { text, offset } = enclosingComment(src, commentMask(src), at);
    expect(text.startsWith("/**")).toBe(true);
    expect(text.trimEnd().endsWith("*/")).toBe(true);
    expect(text).toContain("A heading");
    expect(text[offset]).toBe("S");
    // #664: `offset` is checked by asking the string whether the id STARTS
    // there, not by cutting seven characters and comparing — a count that
    // happens to equal the id's length today and silently stops meaning that
    // the moment the id does. The recovered comment is then compared to the
    // docblock cut to its own close, which is the claim this case is about.
    expect(text.startsWith("SC-9901", offset), "offset does not point at the id").toBe(true);
    const docblock = structuralCut(src, "/**", { endAnchor: "*/" });
    expect(docblock.length, "the cut is the whole source — it bounds nothing").toBeLessThan(
      src.length,
    );
    expect(text, "the recovered comment is not the docblock").toBe(`${docblock}*/`);
  });

  test("a truncated comment would turn every citation into a heading", () => {
    // What the mask actually buys, asserted rather than described. Every
    // rule here is line-relative, and `offset` is where the id sits inside
    // the recovered text. Truncate the comment at the id — which is what the
    // broken version returned — and the id is at offset 0 of a one-line
    // "comment", so a prose citation reads as a line-leading heading.
    // Real shape, from test/hook-registration-reconciler.test.ts.
    const src = " * fails in CI because it reads machine state is the same defect as SC-9900/SC-9901\n";
    const at = src.indexOf("SC-9901");
    const { text, offset } = enclosingComment(src, commentMask(src), at);
    expect(commentClaimForm(text, offset, "SC-9901"), "a citation was credited").toBeNull();

    // The broken recovery stopped at the first space, so this pair of ids
    // WAS the whole comment: nothing before them, nothing after, and the
    // line-leading rule fires. Asserted, because if it did not fire the
    // fixture above would be proving nothing.
    const truncated = "SC-9900/SC-9901";
    expect(
      commentClaimForm(truncated, truncated.indexOf("SC-9901"), "SC-9901"),
      "the truncated view does NOT mint a false credit — the fixture above proves nothing",
    ).toBe("line");
  });

  test("code outside the comment is not swallowed", () => {
    const src = "// covers SC-9901\nconst SC = 1; // SC-9902 here\n";
    const mask = commentMask(src);
    const codeAt = src.indexOf("const SC");
    expect(mask[codeAt]).toBe(false);
    const { text } = enclosingComment(src, mask, src.indexOf("SC-9901"));
    expect(text).not.toContain("const SC");
  });

  test("an offset outside any comment yields nothing, not a slice of code", () => {
    const src = "const SC_X = 1;\n";
    expect(enclosingComment(src, commentMask(src), 6)).toEqual({ text: "", offset: -1 });
  });
});
