import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { harnessRoot } from "../lib/paths";
import { structuralCut } from "../lib/source-slice";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #273 — the comment stripper that makes an ordering assertion about CODE.
 *
 * Six phase-ordering assertions in test/spec-compliance.test.ts located their
 * anchors with `indexOf` over the RAW text of workflows/ship.js, and five of
 * the eight strings they looked for occur only inside comments. Three of the
 * six therefore compared one comment to another and said nothing about code.
 *
 * The fix is to search a comment-stripped copy. That copy is only worth
 * anything if the stripper is right about what a comment IS, so this file
 * exercises the two directions that matter: a comment inside a string must
 * survive, and a comment outside one must not.
 */

const HR = harnessRoot();
const SHIP_JS = readFileSync(join(HR, "workflows/ship.js"), "utf-8");

describe("strip-js-comments: comments go, string contents stay", () => {
  test("SJC-1: a line comment is removed and a URL inside a string is not", () => {
    // The `//` in `http://` is the canonical false positive. AC-3's verify
    // command is this exact pair.
    const out = stripJsComments("const u = 'http://x/y' // PHASE 6: COMMIT\n");
    expect(out).toContain("http://x/y");
    expect(out).not.toContain("PHASE 6");
  });

  test("SJC-2: a template literal keeps both a shell token and a block-comment sequence", () => {
    const out = stripJsComments("const t = `bun scripts/github-op.ts pr-upsert /* keep */`");
    expect(out).toContain("pr-upsert");
    expect(out).toContain("/* keep */");
  });

  test("SJC-3: a double-quoted string keeps a block-comment sequence", () => {
    const out = stripJsComments('const s = "/* not a comment */"; /* a comment */');
    expect(out).toContain("/* not a comment */");
    expect(out).not.toContain("a comment */\n");
    expect(out.split('"')[2]).not.toContain("a comment");
  });

  test("SJC-4: a block comment is removed and the code around it survives", () => {
    const out = stripJsComments("const a = 1; /* gone\n still gone */ const b = 2;");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(out).not.toContain("gone");
  });

  test("SJC-5: offsets and line count are preserved, so an index into the raw text means the same thing", () => {
    // This is the property the anchor audit relies on: the stripped copy is
    // the raw copy with every comment character replaced by a space, so
    // `stripped.slice(i, i + a.length) === a` answers "is the anchor at
    // offset i code?" exactly.
    const src = "const a = 1; // tail\nconst b = `t`; /* mid */ const c = 2;\n";
    const out = stripJsComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.indexOf("const c")).toBe(src.indexOf("const c"));
  });

  test("SJC-6: a regex literal containing a slash-slash is not read as a comment", () => {
    const out = stripJsComments("const re = /https?:\\/\\//; const after = 1;");
    expect(out).toContain("const after = 1;");
    expect(out).toContain("https?:");
  });

  test("SJC-7: division is not mistaken for a regex literal", () => {
    const out = stripJsComments("const r = total / count; const after = 2; // tail");
    expect(out).toContain("const after = 2;");
    expect(out).not.toContain("tail");
  });

  test("SJC-8: a comment inside a template interpolation is still removed", () => {
    const out = stripJsComments("const t = `a${ b /* gone */ }c`;");
    expect(out).toContain("`a${");
    expect(out).toContain("}c`");
    expect(out).not.toContain("gone");
  });

  test("SJC-9: an escaped quote does not end the string early", () => {
    const out = stripJsComments("const s = 'it\\'s // fine'; // tail");
    expect(out).toContain("// fine");
    expect(out).not.toContain("tail");
  });
});

describe("strip-js-comments: run over the file the ordering checks read", () => {
  const stripped = stripJsComments(SHIP_JS);

  test("SJC-10: every phase banner comment is gone from workflows/ship.js", () => {
    for (const banner of [
      "PHASE 4: IMPLEMENT",
      "PHASE 5: VALIDATE",
      "PHASE 6: COMMIT",
      "PHASE 7: VERIFY",
      "PHASE 8: SHIP",
      "PHASE 9: PROVE",
    ]) {
      expect(SHIP_JS).toContain(banner);
      expect(stripped).not.toContain(banner);
    }
  });

  test("SJC-11: the bare create-pr comment token is gone, the executable pr-upsert is not", () => {
    expect(SHIP_JS).toContain("create-pr");
    expect(stripped).not.toContain("create-pr");
    expect(stripped).toContain("pr-upsert");
  });

  test("SJC-12: every executable ordering anchor survives", () => {
    for (const anchor of [
      "phase('Implement')",
      "phase('Validate')",
      "phase('Commit')",
      "phase('Verify')",
      "label: 'quinn-container'",
      "pr-upsert",
      "log('Running ship gate')",
      "phase('Prove')",
    ]) {
      expect(stripped.indexOf(anchor)).toBeGreaterThan(0);
      // Offsets are preserved, so the stripped anchor sits exactly where the
      // raw one does. A stripper that deleted bytes would break this.
      expect(stripped.indexOf(anchor)).toBe(SHIP_JS.indexOf(anchor));
    }
  });

  test("SJC-13: no whole-line comment survives, and the raw file had plenty", () => {
    const wholeLineComments = (src: string) =>
      src.split("\n").map((line, i) => ({ line, i })).filter(({ line }) => /^\s*\/\//.test(line));
    expect(wholeLineComments(SHIP_JS).length).toBeGreaterThan(50);
    expect(wholeLineComments(stripped).map(s => `${s.i + 1}: ${s.line.trim()}`)).toEqual([]);
  });
});

/**
 * #254 — `{ blankLiterals: true }`, the view a brace matcher may count over.
 *
 * Deciding WHERE a call site sits relative to a conditional means matching
 * braces, and `workflows/ship.js` is mostly prompts: `${WORK_DIR}`,
 * `{rebuild:'SKIP'}` and a JSON example all carry braces that are text, not
 * blocks. Counting over the comment-stripped copy closes the conditional in the
 * middle of a prompt. This option blanks literal CONTENTS as well, keeping the
 * delimiters and every offset, so one view can locate a token and the other can
 * measure the block it is in.
 */
describe("strip-js-comments: blankLiterals blanks literal contents, nothing else", () => {
  const blank = (src: string) => stripJsComments(src, { blankLiterals: true });

  test("SJC-14: default behaviour is unchanged — literals survive without the option", () => {
    const src = "const s = 'keep me'; const t = `keep me too`;";
    expect(stripJsComments(src)).toContain("keep me");
    expect(stripJsComments(src)).toContain("keep me too");
    expect(blank(src)).not.toContain("keep me");
  });

  test("SJC-15: a brace inside a string or template stops being a brace", () => {
    const src = "if (c) {\n  run(`a } and a { in prose`, \"another }\")\n}\nafter()";
    const out = blank(src);
    expect(out.split("{").length - 1).toBe(1);
    expect(out.split("}").length - 1).toBe(1);
    // The delimiters stay, so the shape of the code is still readable.
    expect(out).toContain("`");
    expect(out).toContain('"');
    expect(out).toContain("after()");
  });

  test("SJC-16: a template interpolation's braces go, the code inside it stays balanced", () => {
    const src = "const t = `a${ fn({ k: 1 }) }b`; const after = 2;";
    const out = blank(src);
    expect(out.split("{").length - 1).toBe(out.split("}").length - 1);
    expect(out).toContain("fn(");
    expect(out).toContain("const after = 2;");
  });

  test("SJC-17: offsets, length and line count are preserved exactly as without the option", () => {
    const src = "const a = 'x};'; /* c */ `t${ 1 }`\nconst b = 2;\n";
    const out = blank(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.indexOf("const b")).toBe(src.indexOf("const b"));
  });

  test("SJC-18: a brace inside a regex literal is not a brace either", () => {
    const src = "const re = /\\{|}/; if (x) { y() }";
    const out = blank(src);
    expect(out.split("{").length - 1).toBe(1);
    expect(out.split("}").length - 1).toBe(1);
  });

  test("SJC-19: ship.js's container conditional brace-matches to a brace that is code", () => {
    // The real file, which is the input that matters. The Ship phase's
    // `if (containerConfig) {` must close on a `}` the compiler would close it
    // on — the one followed by `else`.
    const skeleton = blank(SHIP_JS);
    const open = SHIP_JS.indexOf("if (containerConfig) {", SHIP_JS.indexOf("phase('Ship')"));
    expect(open).toBeGreaterThan(0);
    const start = open + "if (containerConfig) {".length - 1;
    // #664: the brace walk this case used to hand-roll is now the one shared
    // cut in lib/source-slice.ts, taken over the BLANKED view — which is the
    // subject of the case. One binding to mutate, and no `close + 8` window:
    // eight characters was a bet on the whitespace between `}` and `else`.
    expect(skeleton.indexOf("if (containerConfig) {"), "the conditional is not unique").toBe(open);
    const armCut = structuralCut(skeleton, "if (containerConfig) {", { balanced: "{" });
    expect(armCut.length, "the cut is the whole file — it bounds nothing").toBeLessThan(
      skeleton.length,
    );
    const close = open + armCut.length - 1;
    expect(close).toBeGreaterThan(start);
    expect(SHIP_JS[close]).toBe("}");
    const afterClose = skeleton.slice(close);
    expect(afterClose.startsWith("}")).toBe(true);
    expect(afterClose.slice(1).trimStart().startsWith("else")).toBe(true);

    // And the blanking is doing work on THIS input rather than being a no-op
    // that happens to agree: the arm carries braces that are prompt text.
    const arm = SHIP_JS.slice(start, close);
    const armSkeleton = skeleton.slice(start, close);
    const rawBraces = (arm.match(/[{}]/g) || []).length;
    const codeBraces = (armSkeleton.match(/[{}]/g) || []).length;
    expect(rawBraces).toBeGreaterThan(codeBraces);
    // Measured, not assumed: an unbalanced brace inside a literal is what makes
    // the naive view close early, and in this arm today the literal braces
    // happen to be balanced — so the early close is proven on the synthetic
    // inputs above (SJC-15, SJC-18) and the real file is held to the structural
    // claim instead. Dropping this inequality would let the option become a
    // no-op unnoticed.
    expect(codeBraces).toBeGreaterThan(0);
  });
});
