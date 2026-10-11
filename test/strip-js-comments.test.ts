import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #273 — the six phase-ordering assertions in test/spec-compliance.test.ts
 * located their anchors with `indexOf` over the RAW text of workflows/ship.js,
 * and five of the eight strings they looked for occur only inside comments.
 * Three of the six therefore compared one comment to another.
 *
 * `stripJsComments` is the narrow fix: a copy of the source with every comment
 * blanked and every string, template and regex left exactly as written, so an
 * ordering assertion that finds a token has found CODE.
 *
 * The thing that makes this stripper dangerous is the thing
 * .claude/rules/checks-must-be-able-to-fail.md's second example warns about —
 * a regex-based stripper that pairs a backtick in a comment with an unrelated
 * one deleted 61% of a file and the suite still reported 48 pass. So this is a
 * character scanner, and the tests below are about what it must NOT eat.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_JS = readFileSync(join(REPO_ROOT, "workflows/ship.js"), "utf-8");

describe("strip-js-comments: comments go, literals stay", () => {
  test("STRIP-1: a line comment after a string holding '//' is removed, the string is not", () => {
    // The AC-3 case, verbatim: `http://x/y` must survive, the trailing banner
    // must not. A naive `//`-to-end-of-line regex eats the URL's path.
    const out = stripJsComments("const u = 'http://x/y' // PHASE 6: COMMIT\n");
    expect(out).toContain("http://x/y");
    expect(out).not.toContain("PHASE 6");
  });

  test("STRIP-2: a template literal keeps a comment sequence inside it", () => {
    // The other AC-3 case: ship.js's PR step is a SHELL command inside a
    // template literal. Its text is code the workflow executes, so a stripper
    // that treats `/* */` inside a template as a comment would delete the one
    // anchor PO-3 and PO-4 depend on.
    const out = stripJsComments("const t = `bun scripts/github-op.ts pr-upsert /* keep */`");
    expect(out).toContain("pr-upsert");
    expect(out).toContain("/* keep */");
  });

  test("STRIP-3: single and double quoted literals keep comment-looking contents", () => {
    const out = stripJsComments(`const a = '/* not a comment */'; const b = "// also not";`);
    expect(out).toContain("'/* not a comment */'");
    expect(out).toContain('"// also not"');
  });

  test("STRIP-4: block comments are removed, including multi-line ones", () => {
    const out = stripJsComments("a\n/* gone\n   also gone */\nb\n");
    expect(out).not.toContain("gone");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  test("STRIP-5: a template substitution is code, so comments inside it go", () => {
    const out = stripJsComments("const t = `x ${ y /* gone */ } z`");
    expect(out).not.toContain("gone");
    expect(out).toContain("x ${");
    expect(out).toContain("} z`");
  });

  test("STRIP-6: nested template literals inside a substitution are not mistaken for the end", () => {
    const src = "log(`PR ${ok ? `#${n} /* inner */` : 'none'}`) // banner\n";
    const out = stripJsComments(src);
    expect(out).toContain("/* inner */");
    expect(out).toContain("'none'");
    expect(out).not.toContain("banner");
  });

  test("STRIP-7: a regex literal containing slashes is not read as a comment", () => {
    const out = stripJsComments("const re = /a\\/\\/b/g // banner\nconst keep = 1\n");
    expect(out).toContain("/a\\/\\/b/g");
    expect(out).toContain("const keep = 1");
    expect(out).not.toContain("banner");
  });

  test("STRIP-8: division is not read as a regex", () => {
    const out = stripJsComments("const r = (a) / b / c // banner\nconst keep = 2\n");
    expect(out).toContain("const keep = 2");
    expect(out).not.toContain("banner");
  });

  test("STRIP-9: offsets are preserved — the output is the same length as the input", () => {
    // Blanking rather than deleting is what lets a stripped index be compared
    // with a raw one, and it is also the cheapest possible proof that the
    // scanner did not silently swallow a region it failed to parse.
    expect(stripJsComments(SHIP_JS).length).toBe(SHIP_JS.length);
    const out = stripJsComments("a // b\nc\n");
    expect(out).toBe("a     \nc\n");
  });

  test("STRIP-10: newlines inside removed comments survive, so line numbers do not shift", () => {
    const out = stripJsComments("a\n/* one\ntwo */\nb\n");
    expect(out.split("\n").length).toBe(5);
  });
});

describe("strip-js-comments: over the real workflows/ship.js", () => {
  const stripped = stripJsComments(SHIP_JS);

  test("STRIP-11: every PHASE banner is comment-only and is gone from the stripped copy", () => {
    for (const banner of [
      "PHASE 4: IMPLEMENT",
      "PHASE 5: VALIDATE",
      "PHASE 6: COMMIT",
      "PHASE 7: VERIFY",
      "PHASE 8: SHIP",
      "PHASE 9: PROVE",
    ]) {
      expect(SHIP_JS).toContain(banner);
      expect(stripped, `${banner} survived the strip`).not.toContain(banner);
    }
  });

  test("STRIP-12: the create-pr token is comment-only and is gone", () => {
    expect(SHIP_JS).toContain("create-pr");
    expect(stripped).not.toContain("create-pr");
  });

  test("STRIP-13: every executable ordering anchor survives exactly once", () => {
    const anchors = [
      "phase('Implement')",
      "phase('Validate')",
      "phase('Commit')",
      "phase('Verify')",
      "label: 'quinn-container'",
      "pr-upsert",
      "log('Running ship gate')",
      "phase('Prove')",
    ];
    for (const a of anchors) {
      expect(stripped.split(a).length - 1, `${a} occurrences in the stripped copy`).toBe(1);
    }
  });
});
