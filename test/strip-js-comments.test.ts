import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { harnessRoot } from "../lib/paths";
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
