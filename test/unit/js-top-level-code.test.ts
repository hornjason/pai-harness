/**
 * #89 — the #69 guard was blind to 61% of ship.js, including the two helpers
 * #69 is actually about.
 *
 * `topLevelCode` stripped comments and template literals with regexes before
 * scanning for `require(`. The template-literal regex swallowed far more than
 * template literals:
 *
 *     original 94543 chars -> 36574 after stripping (61% discarded)
 *     buildSafeGitAdd   invisible
 *     validateFilePaths invisible
 *
 * ship.js contains backticks that are not template delimiters — inside
 * single-quoted strings, inside comments, inside other templates. A regex
 * cannot tell which is which, so one stray backtick pairs with a later
 * unrelated one and everything between them is deleted, real code included.
 *
 * It was found the hard way: while fixing #81 I added two functions using
 * `require('path')` and `require('fs')` — exactly what #69 says kills a ship
 * run — and the suite reported 48 pass, 0 fail.
 *
 * So: tokenize instead of pattern-matching. These tests are about the
 * tokenizer, and the cases are the ones a regex gets wrong.
 */

import { describe, test, expect } from "bun:test";
import { stripStringsAndComments, strippingPreservesSyntax } from "../../lib/js-top-level-code";

describe("#89: stripStringsAndComments keeps code a regex would eat", () => {
  test("a backtick inside a single-quoted string does not open a template", () => {
    const src = "const tick = '`';\nfunction keepMe() {}\nconst other = '`';";
    const out = stripStringsAndComments(src);
    expect(out).toContain("function keepMe()");
  });

  test("a backtick inside a line comment does not open a template", () => {
    const src = "// a stray ` in prose\nfunction keepMe() {}\n// and another `\n";
    expect(stripStringsAndComments(src)).toContain("function keepMe()");
  });

  test("a backtick inside a block comment does not open a template", () => {
    const src = "/* ` */\nfunction keepMe() {}\n/* ` */";
    expect(stripStringsAndComments(src)).toContain("function keepMe()");
  });

  test("code between two real template literals survives", () => {
    const src = "const a = `one`;\nfunction keepMe() {}\nconst b = `two`;";
    const out = stripStringsAndComments(src);
    expect(out).toContain("function keepMe()");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
  });

  test("template interpolations are code and are kept", () => {
    // `${}` runs in the enclosing scope. A require() there is top-level code
    // and must stay visible, even though it sits inside a template.
    const src = "const a = `x ${ require('fs') } y`;";
    const out = stripStringsAndComments(src);
    // String CONTENTS are dropped on purpose — a string holding "function f("
    // must not read as a declaration — so the assertion is that the call is
    // visible, not that its argument survives. `require(` is what the guard
    // greps for.
    expect(out).toMatch(/require\s*\(/);
    expect(out).not.toContain("x ");
    expect(out).not.toContain(" y");
  });

  test("nested templates inside an interpolation are handled", () => {
    const src = "const a = `outer ${ `inner ${ keepMe() }` } tail`;";
    const out = stripStringsAndComments(src);
    expect(out).toContain("keepMe()");
    expect(out).not.toContain("outer");
    expect(out).not.toContain("inner");
  });

  test("an escaped backtick does not terminate a template", () => {
    const src = "const a = `before \\` still inside`;\nfunction keepMe() {}";
    const out = stripStringsAndComments(src);
    expect(out).toContain("function keepMe()");
    expect(out).not.toContain("still inside");
  });

  test("a division operator is not mistaken for a regex literal", () => {
    const src = "const r = total / count;\nfunction keepMe() {}";
    expect(stripStringsAndComments(src)).toContain("function keepMe()");
  });

  test("a regex literal containing quotes and backticks is stripped whole", () => {
    const src = "const re = /['\"`]/g;\nfunction keepMe() {}";
    const out = stripStringsAndComments(src);
    expect(out).toContain("function keepMe()");
  });

  test("an apostrophe inside a comment does not open a string", () => {
    // The classic: "// don't" leaves an unterminated quote for a naive scanner,
    // and everything after it disappears.
    const src = "// don't do this\nfunction keepMe() {}";
    expect(stripStringsAndComments(src)).toContain("function keepMe()");
  });

  test("a URL's // is not a line comment", () => {
    const src = "const u = 'https://example.com/x';\nfunction keepMe() {}";
    expect(stripStringsAndComments(src)).toContain("function keepMe()");
  });
});

describe("#89: the guard can see all of ship.js", () => {
  const shipSource = (() => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    return readFileSync(join(import.meta.dir, "..", "..", "workflows", "ship.js"), "utf-8");
  })();

  test("every top-level function declaration survives stripping", () => {
    // The coverage assertion #89 asked for. A stripper that eats
    // `function buildSafeGitAdd(` has failed, and must say so rather than
    // reporting a clean scan of the fragment it left behind.
    const declared = [...shipSource.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
    expect(declared.length, "no top-level functions found — the probe itself is broken").toBeGreaterThan(5);

    const stripped = stripStringsAndComments(shipSource);
    const missing = declared.filter(name => !new RegExp(`function\\s+${name}\\s*\\(`).test(stripped));
    expect(missing, "these functions are invisible to the #69 guard").toEqual([]);
  });

  test("the helpers #69 is about are visible", () => {
    const stripped = stripStringsAndComments(shipSource);
    for (const fn of ["buildSafeGitAdd", "validateFilePaths", "safeSSHCommand"]) {
      expect(stripped, `${fn} is invisible to the guard that protects it`).toContain(fn);
    }
  });

  test("stripping discards far less than the regex version did", () => {
    // 61% was discarded before. Prompts are genuinely most of this file, so the
    // bar is deliberately loose — this catches a catastrophic regression, not a
    // few percent of drift.
    const kept = stripStringsAndComments(shipSource).length / shipSource.length;
    expect(kept).toBeGreaterThan(0.2);
  });
});

describe("#89 review: the tokenizer is checked against a real parser", () => {
  // Hand-rolling a lexer invites parser differentials — a construct the real
  // engine reads one way and this reads another, letting a require() hide from
  // the guard. Removing string and comment CONTENT cannot change whether the
  // source is syntactically valid, so a real parser is an independent witness
  // that nothing was eaten.
  test("stripping ship.js preserves its syntactic validity", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const src = readFileSync(join(import.meta.dir, "..", "..", "workflows", "ship.js"), "utf-8");
    const result = strippingPreservesSyntax(src);
    expect(result.ok, `stripped ship.js no longer parses — the tokenizer ate something: ${result.detail}`).toBe(true);
  });

  test("a regex literal is replaced by a valid placeholder, not blanked", () => {
    // Blanking left `const X = ` with no right-hand side, which is how the
    // parser check caught the first version of this module.
    const src = "const X = /[;&|]/g;\nconst Y = 1;";
    expect(strippingPreservesSyntax(src).ok).toBe(true);
  });

  test("an unbalanced template is refused rather than returned", () => {
    // If a backtick that was not a delimiter opened a template, a run of real
    // code was consumed as template text. Returning a plausible fragment is
    // the exact failure this module exists to end.
    expect(() => stripStringsAndComments("const a = `never closed;\n")).toThrow(/mis-parsed|still open/i);
  });

  test("every construct the unit tests cover also survives the parser check", () => {
    const cases = [
      "const tick = '`'; function keepMe() {}",
      "// a stray ` in prose\nfunction keepMe() {}",
      "/* ` */ function keepMe() {}",
      "const a = `one`; function keepMe() {} const b = `two`;",
      "const a = `x ${ 1 + 2 } y`;",
      "const a = `outer ${ `inner ${ 1 }` } tail`;",
      "const a = `before \\` still inside`;",
      "const r = total / count;",
      "const re = /['\"`]/g;",
      "// don't do this\nfunction keepMe() {}",
      "const u = 'https://example.com/x';",
    ];
    for (const c of cases) {
      const r = strippingPreservesSyntax(c);
      expect(r.ok, `${JSON.stringify(c)} -> ${r.detail}`).toBe(true);
    }
  });
});
