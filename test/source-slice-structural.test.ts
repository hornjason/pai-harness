/**
 * #664: a source-slice guard must cut to a CONSTRUCT, not to a character count.
 *
 * Ten guards in this directory cut `slice(at, at + N)`. One of them had 650
 * characters of headroom and nobody knew, so a 2,119-character insertion two
 * branches away pushed its target strings past the boundary and turned it red
 * while the `else` it guards was never touched. The failure message was the
 * opposite of the truth: the construct was still there, it had just moved.
 *
 * `lib/source-slice.ts` is the shared replacement. The property that makes it
 * one is in the signature rather than in the discipline of its callers —
 * **there is no numeric-length parameter to pass**, so a window cannot decay
 * because there is no window.
 *
 * Three refusals, each with an input only it reaches:
 *
 * | refusal | reached by |
 * |---|---|
 * | `AnchorNotFoundError` | an anchor, start anchor or end anchor absent from the document |
 * | `UnbalancedCutError` | a `{` with no matching close, or no opener at all after the anchor |
 * | `EmptyCutError` | an end that lands where the anchor ends, so the cut holds only the anchor |
 * | `AnchorOutsideCutError` | a two-sided cut whose region does not contain the anchor it is about |
 *
 * The last two are the ones `.claude/rules/checks-must-be-able-to-fail.md`
 * exists for: a cut that fails to find its own section is an empty string, and
 * an empty string contains nothing, which is indistinguishable from a clean
 * result. A caller that asserts `toContain(...)` on a cut that is nothing but
 * the anchor is asserting against text it typed itself.
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * `test/source-slice-structural.test.ts` (17 tests). Every count was predicted
 * before the battery ran, and the baseline row was read first — an instrument
 * that has stopped reporting takes the baseline down with it, and that is the
 * one row nobody checks.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 17 pass, 0 fail | **17 pass, 0 fail** | — |
 * | the primary-anchor refusal removed in `structuralCut` | 1 | **1 of 17** | `structuralCut("const a = 1\n}\n", <absent>, {endAnchor: "\n}"})`: the original refuses naming the anchor, the mutant slices from `-1` and returns text |
 * | the `refuseEmpty` call removed from `structuralCut` | 2 | **2 of 17** | `structuralCut("head\nconst probe = 1;\n}\ntail", "const probe = 1;", {endAnchor: "\n}"})`: the original refuses, the mutant returns `"const probe = 1;"` — the anchor and nothing else |
 * | the `AnchorOutsideCutError` guard removed | 1 | **1 of 17** | `"// START\nunrelated()\n// END\nSUBJECT\n"`: the original refuses, the mutant returns `"// START\nunrelated()\n"`, a well-formed region the subject is not in |
 * | the balanced scan returns the opener's index instead of the matching close | 5 | **5 of 17** | `structuralCut("function fn() { a; { b; } c; }", "function fn()", {balanced: "{"})`: the original returns the whole block, the mutant returns `"function fn() {"` |
 * | the never-closed refusal replaced by a cut to the end of the document | 1 | **1 of 17** | `"fn() { a;"`: the original refuses, the mutant returns the rest of the file |
 * | the no-opener refusal replaced by a cut to the end of the document | 1 | **1 of 17** | `"fn() is mentioned and nothing opens"`: same shape, and only this input reaches it — an opener that exists but never closes is the row above |
 * | the end-anchor refusal replaced by a cut to the end of the document | 1 | **1 of 17** | `structuralCut("const a = 1\n", "const a = 1", {endAnchor: <absent>})`: the original names the END anchor, the mutant returns the tail |
 * | the start-anchor refusal names the subject anchor instead of the missing one | 1 | **1 of 17** | a two-sided cut with an absent start anchor: the refusal must name the string that is missing, not the one that is present |
 * | a `window: number = 0` parameter added back to `structuralCut` | 1 | **1 of 17** | the signature itself |
 *
 * **The cheapest wrong fix, named: raise the number.** `at + 6000` becomes
 * `at + 9000`, the red case goes green, and the guard is exactly as blind as
 * it was — it has bought headroom nobody measured, which is the state #664
 * describes. There is no number here to raise, and the last row is why that
 * stays true: adding one back is red, measured, rather than a convention in a
 * comment. What these cases cannot see is a CALLER that keeps its window, so
 * they are not the whole of #664 — they are the thing a caller migrates to.
 *
 * None of the nine mutations is left in the tree; all were run and reverted,
 * and `lib/source-slice.ts` was confirmed byte-identical afterwards by
 * checksum (`ae9f4587`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  AnchorNotFoundError,
  AnchorOutsideCutError,
  EmptyCutError,
  structuralCut,
  structuralCutAround,
  UnbalancedCutError,
} from "../lib/source-slice";

const ROOT = join(import.meta.dir, "..");
const SLICE_SOURCE = readFileSync(join(ROOT, "lib/source-slice.ts"), "utf-8");
const SHIP_SOURCE = readFileSync(join(ROOT, "workflows/ship.js"), "utf-8");

// ── AC-1: the cut runs from the anchor to a structural end ───────────

describe("#664 AC-1: a cut ends where the construct ends", () => {
  test("a balanced cut runs to the matching close, not to the first one", () => {
    const doc = "prefix\nfunction fn() { a; { b; } c; }\nsuffix";
    expect(structuralCut(doc, "function fn()", { balanced: "{" })).toBe(
      "function fn() { a; { b; } c; }",
    );
  });

  test("brackets other than braces match their own kind", () => {
    const doc = "const xs = [1, [2, 3], 4];\n";
    expect(structuralCut(doc, "const xs =", { balanced: "[" })).toBe("const xs = [1, [2, 3], 4]");
  });

  test("a named end anchor ends the cut before the anchor text, as the tree already writes it", () => {
    const doc = "head\nfn() {\n  body()\n}\ntail";
    expect(structuralCut(doc, "fn() {", { endAnchor: "\n}" })).toBe("fn() {\n  body()");
  });

  test("a normal cut is strictly shorter than the whole document", () => {
    const whole = SHIP_SOURCE;
    const cut = structuralCut(whole, "for (const t of gradeResult.timing)", { balanced: "{" });
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(whole.length);
  });

  test("neither exported cut takes a numeric length", () => {
    for (const name of ["structuralCut", "structuralCutAround"]) {
      const at = SLICE_SOURCE.indexOf(`export function ${name}(`);
      expect(at, `${name} is not exported from lib/source-slice.ts`).toBeGreaterThan(-1);
      const close = SLICE_SOURCE.indexOf("\n", at);
      expect(close, `could not slice ${name}'s signature`).toBeGreaterThan(at);
      const signature = SLICE_SOURCE.slice(at, close);
      expect(signature.length).toBeGreaterThan(0);
      // The slice is one line. If a signature ever wraps, this refuses rather
      // than reading the first line and reporting a clean result over a
      // parameter list it never saw.
      expect(signature.endsWith("{"), `${name}'s signature spans lines: ${signature}`).toBe(true);
      // A window parameter is the defect #664 is about. It cannot decay if it
      // cannot be passed, so the prohibition is on the signature itself.
      expect(signature).not.toMatch(/\bnumber\b/);
    }
  });
});

// ── AC-2: the two refusals ───────────────────────────────────────────

describe("#664 AC-2: a cut that cannot be made refuses, and names what it could not find", () => {
  const ABSENT = "a-string-this-document-does-not-hold";

  test("an absent anchor refuses by name", () => {
    expect(() => structuralCut("const a = 1\n}\n", ABSENT, { endAnchor: "\n}" })).toThrow(
      AnchorNotFoundError,
    );
    expect(() => structuralCut("const a = 1\n}\n", ABSENT, { endAnchor: "\n}" })).toThrow(ABSENT);
  });

  test("an absent END anchor refuses by name — the offending anchor is the one that is missing", () => {
    let thrown: unknown;
    try {
      structuralCut("const a = 1\n", "const a = 1", { endAnchor: ABSENT });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AnchorNotFoundError);
    expect((thrown as Error).message).toContain(ABSENT);
    expect((thrown as AnchorNotFoundError).anchor).toBe(ABSENT);
  });

  test("an absent START anchor refuses by name", () => {
    let thrown: unknown;
    try {
      structuralCutAround("head\nmiddle\ntail\n}\n", "middle", {
        startAnchor: ABSENT,
        end: { endAnchor: "\n}" },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AnchorNotFoundError);
    expect((thrown as Error).message).toContain(ABSENT);
  });

  test("a cut holding nothing but the anchor refuses by name", () => {
    const anchor = "const probe = 1;";
    let thrown: unknown;
    try {
      structuralCut(`head\n${anchor}\n}\ntail`, anchor, { endAnchor: "\n}" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EmptyCutError);
    expect((thrown as Error).message).toContain(anchor);
    expect((thrown as EmptyCutError).anchor).toBe(anchor);
  });

  test("the empty-cut refusal is about the cut, not about the anchor being absent", () => {
    // The anchor IS present. A reader who conflates the two refusals would
    // look for a missing anchor and find it sitting there.
    const anchor = "const probe = 1;";
    const doc = `head\n${anchor}\n}\ntail`;
    expect(doc).toContain(anchor);
    expect(() => structuralCut(doc, anchor, { endAnchor: "\n}" })).toThrow(EmptyCutError);
    expect(() => structuralCut(doc, anchor, { endAnchor: "\n}" })).not.toThrow(AnchorNotFoundError);
  });

  test("a brace that never closes refuses rather than running to the end of the document", () => {
    let thrown: unknown;
    try {
      structuralCut("fn() { a;", "fn()", { balanced: "{" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnbalancedCutError);
    expect((thrown as Error).message).toContain("fn()");
  });

  test("no opener after the anchor refuses too", () => {
    expect(() => structuralCut("fn() is mentioned and nothing opens", "fn()", { balanced: "{" })).toThrow(
      UnbalancedCutError,
    );
  });
});

// ── AC-3: the two-sided variant ──────────────────────────────────────

describe("#664 AC-3: the before-and-after shape is cut structurally on both sides", () => {
  test("the region runs from a named start anchor to a structural end", () => {
    const doc = "lead\nblock() {\n  before()\n  SUBJECT\n  after()\n}\ntrail";
    expect(structuralCutAround(doc, "SUBJECT", { startAnchor: "block()", end: { balanced: "{" } })).toBe(
      "block() {\n  before()\n  SUBJECT\n  after()\n}",
    );
  });

  test("both sides may be named anchors", () => {
    const doc = "lead\n// START\nbefore()\nSUBJECT\nafter()\n// END\ntrail";
    expect(
      structuralCutAround(doc, "SUBJECT", { startAnchor: "// START", end: { endAnchor: "// END" } }),
    ).toBe("// START\nbefore()\nSUBJECT\nafter()\n");
  });

  test("it replaces slice(at - 1_500, at + 1_500) at test/agent-timings-queued.test.ts:292", () => {
    // The live shape: the claim is that the TIMING log line prints the wait
    // when there was one. The region that claim is about is the loop, which
    // is 13 lines long and 1,500 characters away from being a number.
    // The subject is spelled in full. The bare `TIMING: ${t.agent}` prefix
    // occurs THREE times in that loop — orphan, unterminated, and this one
    // — so it named a region by whichever the search reached first. #668
    // made that a refusal; before it, this cut answered about the orphan
    // line while the case was named after the wait.
    const cut = structuralCutAround(SHIP_SOURCE, "TIMING: ${t.agent} = ${t.seconds}s${queued}", {
      startAnchor: "for (const t of gradeResult.timing)",
      end: { balanced: "{" },
    });
    expect(cut).toContain("queuedSeconds");
    expect(cut).toContain("TIMING: ${t.agent}");
    expect(cut.length).toBeLessThan(SHIP_SOURCE.length);
  });

  test("a region that does not contain the anchor refuses rather than answering about the wrong code", () => {
    // The end anchor occurs BETWEEN the start anchor and the anchor, so the
    // region is well-formed, non-empty, and about something else entirely.
    const doc = "// START\nunrelated()\n// END\nSUBJECT\n";
    let thrown: unknown;
    try {
      structuralCutAround(doc, "SUBJECT", { startAnchor: "// START", end: { endAnchor: "// END" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AnchorOutsideCutError);
    expect((thrown as Error).message).toContain("SUBJECT");
  });
});

// ── AC-5: the citation exports are untouched ─────────────────────────

describe("#664 AC-5: lib/source-anchor.ts keeps its citation exports", () => {
  test("the structural cut is a sibling, not a replacement — source-anchor still resolves citations", async () => {
    const { anchorCitations, resolveCitation, citationFailures } = await import("../lib/source-anchor");
    expect(typeof anchorCitations).toBe("function");
    expect(typeof resolveCitation).toBe("function");
    expect(typeof citationFailures).toBe("function");
    const cites = anchorCitations('a line citing `lib/source-anchor.ts@"export const ANCHOR_CITATION"`.');
    expect(cites).toEqual([{ path: "lib/source-anchor.ts", anchor: "export const ANCHOR_CITATION" }]);
    expect(resolveCitation(ROOT, cites[0]).ok).toBe(true);
  });
});
