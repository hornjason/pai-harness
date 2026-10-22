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

describe("#89 review round 2: the witness does not fail open", () => {
  test("unparseable input is reported as a failure, not a pass", () => {
    // The first version returned ok:true when the input did not parse, on the
    // reasoning that there was no differential to draw. That makes an
    // unparseable ship.js silently turn the witness into a no-op — a check
    // reporting green because of what it could not look at, which is the
    // precise failure this whole module exists to end.
    const w = strippingPreservesSyntax("function broken( {");
    expect(w.ok).toBe(false);
    expect(w.verdict).toBe("input-unparseable");
  });

  test("clean input is distinguishable from merely-not-checked", () => {
    const w = strippingPreservesSyntax("const a = 1;");
    expect(w.verdict).toBe("clean");
    expect(w.ok).toBe(true);
  });

  test("a stripper that breaks syntax is reported distinctly", () => {
    // Guards the invariant rather than the current implementation: whatever
    // the stripper does later, breaking parseability must surface as its own
    // verdict and never be confused with "input was bad".
    const verdicts = new Set(
      ["const a = 1;", "function broken( {"].map(s => strippingPreservesSyntax(s).verdict),
    );
    expect(verdicts.has("clean")).toBe(true);
    expect(verdicts.has("input-unparseable")).toBe(true);
  });
});

/**
 * #905 — the regex-vs-division decision read the preceding CHARACTER, so a
 * regex literal after a keyword was read as division.
 *
 * `regexCanFollow` tested `prev` against `/[A-Za-z0-9_$)\]]/`. The last
 * character of `return` is `n`, which is in that class, so `return /re/` never
 * entered regex state. The literal was then emitted as CODE, and the first
 * `/` the tokenizer did accept was one INSIDE the literal — so a regex started
 * in the middle of a regex.
 *
 * Punctuators were already right: `=`, `(`, `,`, `:`, `[`, `!`, `&&`, `||`,
 * `?`, `{` and `;` are all outside that character class. The whole gap was
 * word tokens, which is why the fix is to decide on a TOKEN rather than on the
 * character the token happens to end with.
 *
 * ## This fails OPEN, which is what makes it worth fixing properly
 *
 * The two consumers both GREP the stripped output — `test/workflow-security-
 * integration.test.ts` for `require\s*\(` (#69) and `lib/package-closure.ts`
 * for module-relative `join(...)` (#484/CLOSURE-8). A call that the stripper
 * has blanked is a call they do not see, and a scan that cannot see a call
 * reports PASS. Measured here, in `theGuardsGoBlind` below: a `require(` after
 * a quote-bearing literal is invisible with no error raised, and two
 * backtick-bearing literals pair up across the code between them and delete
 * it — which is #89's original defect reached through a different door.
 *
 * ## The parser witness does NOT cover this, and must not be counted twice
 *
 * `strippingPreservesSyntax` catches only the subset where the corrupted
 * remainder stops parsing, and it is pointed exclusively at
 * `workflows/ship.js` — the ten corrupted sites this census found are all
 * `.ts` files that `new Function` could not parse even if it were aimed at
 * them. It is unchanged by #905 and is not evidence about this class.
 */
describe("#905: a regex literal after a keyword is not division", () => {
  const SCANNED_DIRS = ["lib", "gates", "scripts", "workflows", "hooks", "bin"];

  const repoRoot = (() => {
    const { join } = require("path") as typeof import("path");
    return join(import.meta.dir, "..", "..");
  })();

  function scannedFiles(root: string): string[] {
    const { readdirSync, statSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const walk = (dir: string, acc: string[]): string[] => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (/\.(ts|js)$/.test(entry)) acc.push(p);
      }
      return acc;
    };
    return SCANNED_DIRS.flatMap(d => walk(join(root, d), []));
  }

  /**
   * The census oracle, and it needs no second tokenizer.
   *
   * In the default mode every construct that can legally carry a backslash —
   * a regex literal, a string body, a comment, template text — has its
   * content removed. So a backslash surviving into the output is proof that
   * the tokenizer read one of them as CODE. (A `\u` escape in an identifier
   * would be a legal exception; there are none in this tree, and one would
   * announce itself as a named violation rather than hide.)
   *
   * This is strictly stronger than the escaped-slash signature the issue
   * reported. `\/` finds the two sites where a mis-started regex re-closes;
   * a bare `\` finds those plus the eight where the literal is never
   * recognised at all, including `lib/ci-checkout.ts`, which the issue named
   * and which carries no surviving `\/`.
   */
  function backslashSurvivors(source: string): number {
    return (stripStringsAndComments(source).match(/\\/g) || []).length;
  }

  test("the reported shape: a keyword-preceded literal is stripped, not re-entered", () => {
    const src = "function f(x){ return /a\\/b/.test(x) }";
    const out = stripStringsAndComments(src);
    expect(out, "the literal's own escaped slash started a second regex inside it").not.toContain("\\");
    expect(out).toContain("function f(x){ return /x/");
    expect(out).toContain(".test(x) }");
  });

  test("every keyword that can precede a regex literal is handled, not a hand-picked few", () => {
    // Enumerated from the ECMAScript reserved-word list rather than from the
    // shapes that happened to break. Each is spelled in a position where a
    // regex literal is what a real parser reads.
    const cases: [string, string][] = [
      ["return", "function f(x){ return /a\\/b/.test(x) }"],
      ["typeof", "function f(){ const t = typeof /a\\/b/; return t }"],
      ["throw", "function f(){ throw /a\\/b/ }"],
      ["case", "function f(x){ switch(x){ case /a\\/b/: break } }"],
      ["in", "function f(x){ return x in /a\\/b/ }"],
      ["of", "function f(){ for (const c of /a\\/b/.source) g(c) }"],
      ["instanceof", "function f(x){ return x instanceof /a\\/b/.constructor }"],
      ["new", "function f(){ return new RegExp(/a\\/b/) }"],
      ["delete", "function f(o){ return delete o[/a\\/b/.source] }"],
      ["void", "function f(){ return void /a\\/b/.test('x') }"],
      ["do", "function f(x){ do x = /a\\/b/.test(x); while (x) }"],
      ["else", "function f(x){ if (x) g(); else /a\\/b/.test(x) }"],
      ["yield", "function* f(){ yield /a\\/b/ }"],
      ["await", "async function f(){ await /a\\/b/.test('x') }"],
      ["default", "function f(x){ switch(x){ default: /a\\/b/.test(x) } }"],
      ["extends", "const C = class extends /a\\/b/.constructor {};"],
    ];
    const leaked = cases
      .filter(([, src]) => backslashSurvivors(src) > 0)
      .map(([kw]) => kw);
    expect(
      leaked,
      "a `/` after each of these keywords starts a regex literal; these were read as division",
    ).toEqual([]);
  });

  test("NEGATIVE CONTROL: a division is still a division", () => {
    // A fix that treats everything after a word as a regex position trades one
    // misparse for another, and only this case catches it. Each token before
    // the `/` here is a VALUE, so the `/` divides.
    //
    // EVERY FIXTURE CARRIES A SECOND `/` ON THE SAME LINE, and that is the
    // load-bearing detail rather than a stylistic one. A mis-started regex
    // scans to the next `/` on the line and, finding none, reports `closed =
    // false` and falls through to division — so a single-division fixture
    // returns its input unchanged whether the tokenizer got the decision
    // right or wrong. The first draft of this case was fifteen such fixtures:
    // it reached its assertion without the feature and was green under two
    // of the mutations below.
    const divisions: [string, string][] = [
      ["const r = total / count; const s = a / b;", "const r = total / count; const s = a / b;"],
      ["const r = 10 / 2; const s = 8 / 4;", "const r = 10 / 2; const s = 8 / 4;"],
      ["const r = (a + b) / 2; const s = (c + d) / 2;", "const r = (a + b) / 2; const s = (c + d) / 2;"],
      ["const r = xs[0] / 2; const s = ys[1] / 2;", "const r = xs[0] / 2; const s = ys[1] / 2;"],
      ["const r = f() / g(); const s = h() / k();", "const r = f() / g(); const s = h() / k();"],
      ["const r = x / y / z;", "const r = x / y / z;"],
      // The five value keywords, each immediately before the `/`. Without
      // these the VALUE_KEYWORDS set is never consulted by any case: a
      // `this.total / this.count` fixture is decided by the member-access
      // rule and says nothing about `this`. (`super` has no valid bare
      // position before an operator, so it is covered by the `.n` case only.)
      ["class C { m(){ return this / 2 + this / 4 } }", "class C { m(){ return this / 2 + this / 4 } }"],
      ["const r = null / 2; const s = null / 4;", "const r = null / 2; const s = null / 4;"],
      ["const r = true / 2; const s = false / 4;", "const r = true / 2; const s = false / 4;"],
      // A reserved word used as a PROPERTY name is a value, not a keyword.
      ["class C { m(){ return super.n / 2 + super.m / 4 } }", "class C { m(){ return super.n / 2 + super.m / 4 } }"],
      ["const r = o.return / 2; const s = o.return / 4;", "const r = o.return / 2; const s = o.return / 4;"],
      ["const r = o.default / 2; const s = o.in / 4;", "const r = o.default / 2; const s = o.in / 4;"],
      ["const r = o.new / 2; const s = o.of / 4;", "const r = o.new / 2; const s = o.of / 4;"],
      // A completed string or template is a value too. Their CONTENTS are
      // dropped, which is the stripper's job; the division and the code after
      // it must survive.
      ['const r = "10" / 2; const s = "8" / 4;', 'const r = "" / 2; const s = "" / 4;'],
      ["const r = `10` / 2; const s = `8` / 4;", "const r = `` / 2; const s = `` / 4;"],
    ];
    const eaten = divisions
      .filter(([src, want]) => stripStringsAndComments(src) !== want)
      .map(([src]) => src);
    expect(eaten, "these divisions were read as regex literals and the code after them was eaten").toEqual([]);
  });

  test("the guards go blind: a mis-tokenized literal hides a call they grep for", () => {
    // Not a claim about what COULD happen — the two shapes below, run.
    const sameLine = "function f(s){ return /it's/.test(s) ? require(\"fs\") : 0 }\n";
    expect(
      /(?<![.\w$])require\s*\(/.test(stripStringsAndComments(sameLine)),
      "#69's guard cannot see a require() the stripper blanked, and reports PASS",
    ).toBe(true);

    const acrossLines =
      "function a(s){ return /[`]/.test(s) }\n" +
      "function keepMe(){ require(\"fs\") }\n" +
      "function b(s){ return /[`]/.test(s) }\n";
    const out = stripStringsAndComments(acrossLines);
    expect(out, "two backtick-bearing literals paired up and deleted the code between them").toContain("keepMe");
  });

  test("CENSUS: no file in the scanned set is corrupted by the stripper", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const files = scannedFiles(repoRoot);
    expect(files.length, "the census read no files — the probe itself is broken").toBeGreaterThan(100);

    const corrupted: string[] = [];
    for (const f of files) {
      const rel = f.slice(repoRoot.length + 1);
      let survivors: number;
      try {
        survivors = backslashSurvivors(readFileSync(f, "utf-8"));
      } catch (e) {
        corrupted.push(`${rel} (refused: ${(e as Error).message.slice(0, 60)})`);
        continue;
      }
      if (survivors > 0) corrupted.push(`${rel} (${survivors})`);
    }
    expect(
      corrupted,
      "a backslash survived into stripped output, so regex/string/comment content was read as code. " +
        "Fix lib/js-top-level-code.ts; do not add an exemption list.",
    ).toEqual([]);
  });

  test("CENSUS CONTROL: reverting the token decision turns the census red", async () => {
    // The census asserts an empty list, and an empty list is also what a
    // census that reads nothing produces. So the instrument is proven by
    // mutating the ONE binding the decision lives in — `regexCanFollowToken`
    // — back to the pre-#905 character test, and watching the same census go
    // red over the same tree.
    //
    // Planting a keyword-preceded literal in a fixture would NOT do it: the
    // fixed stripper handles that correctly, which is the point of the fix,
    // so the fixture goes green and witnesses nothing. That version of this
    // case was written first and passed only while the defect was present.
    const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const { tmpdir } = require("os") as typeof import("os");

    const modulePath = join(repoRoot, "lib", "js-top-level-code.ts");
    const source = readFileSync(modulePath, "utf-8");
    const ANCHOR = "export function regexCanFollowToken(token: string): boolean {";
    expect(
      source.split(ANCHOR).length - 1,
      "could not build the mutant: the decision binding appears other than once",
    ).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), "js-top-level-905-"));
    try {
      const mutantPath = join(dir, "mutant.ts");
      // Pre-#905: the decision read the last significant CHARACTER.
      writeFileSync(
        mutantPath,
        source.replace(
          ANCHOR,
          ANCHOR + '\n  return !/[A-Za-z0-9_$)\\]]/.test(token.slice(-1) || "\\n");',
        ),
      );
      const mutant = (await import(mutantPath)) as typeof import("../../lib/js-top-level-code");

      // The mutant and the real module must differ on a named input, or the
      // row below is the code having been run twice rather than mutated.
      const probe = "function f(x){ return /a\\/b/.test(x) }";
      expect(mutant.stripStringsAndComments(probe)).not.toBe(stripStringsAndComments(probe));

      const corrupted = scannedFiles(repoRoot).filter(f => {
        try {
          return (mutant.stripStringsAndComments(readFileSync(f, "utf-8")).match(/\\/g) || []).length > 0;
        } catch {
          return true; // a refusal is a reading too
        }
      });
      expect(
        corrupted.length,
        "the census is green over a tree the pre-#905 decision mis-tokenizes — it witnesses nothing",
      ).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the #89 parser witness is NOT evidence about this class", () => {
    // Recorded so the next reader does not count it twice. The witness is run
    // on workflows/ship.js and nowhere else; every site this census found is
    // a .ts file, which `new Function` refuses outright — so the witness
    // returns `input-unparseable` for them rather than inspecting anything.
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    for (const site of ["lib/test-suite-lock.ts", "lib/ci-checkout.ts", "lib/spec-change-conformity.ts"]) {
      const w = strippingPreservesSyntax(readFileSync(join(repoRoot, site), "utf-8"));
      expect(w.verdict, `${site}: the witness inspected this file after all`).toBe("input-unparseable");
    }
  });
});

/**
 * #1174 — `keepTemplateText`, added so `lib/package-closure.ts` can scan the
 * instructions this package prints.
 *
 * `keepStringContents` keeps quoted bodies and still blanks template text,
 * which is correct for #484's caller and wrong for #1174's: three of the six
 * live instructions naming an unpublished path are built around
 * `${HARNESS_ROOT}` inside a template, so the scanner read a clean tree over
 * three real defects. It is a flag on this one tokenizer rather than a
 * stripper in the calling module, for the reason that module's own docstring
 * gives: two functions deciding what a comment is are two deciders, and the
 * wrong one is invisible.
 */
describe("#1174: keepTemplateText", () => {
  const SRC = "const m = `run ${ROOT}/gates/x.ts now`;\n";

  test("template text is dropped without the flag", () => {
    const out = stripStringsAndComments(SRC, { keepStringContents: true });
    expect(out).not.toContain("gates/x.ts");
    // The interpolation and the backticks survive either way — only the
    // literal TEXT between them is at issue.
    expect(out).toContain("${");
  });

  test("template text survives with the flag", () => {
    const out = stripStringsAndComments(SRC, { keepTemplateText: true });
    expect(out).toContain("run ");
    expect(out).toContain("/gates/x.ts now");
  });

  test("a comment is still blanked when template text is kept", () => {
    // The half that makes the flag safe to use. Keeping template text must
    // not quietly become "scan raw source", which is the mistake #454 and
    // #484 each made once.
    const out = stripStringsAndComments("// `run ${ROOT}/gates/x.ts`\nconst a = 1;\n", {
      keepTemplateText: true,
    });
    expect(out).not.toContain("gates/x.ts");
    expect(out).toContain("const a = 1;");
  });

  test("an escaped character keeps its backslash rather than losing it", () => {
    // Under `keepStringContents` the tokenizer once dropped `\` and the
    // character after it, so `a\"b` came back as `ab` — not a truncated
    // answer but a DIFFERENT path, which a caller would then name in a
    // violation. Asserted here so the template branch cannot reintroduce it.
    const out = stripStringsAndComments("const m = `a\\`b`;\n", { keepTemplateText: true });
    expect(out).toContain("a\\`b");
  });

  test("line numbers survive a multi-line template either way", () => {
    const src = "const m = `one\ntwo\nthree`;\nconst after = 1;\n";
    for (const opts of [{ keepStringContents: true }, { keepTemplateText: true }]) {
      expect(stripStringsAndComments(src, opts).split("\n")).toHaveLength(src.split("\n").length);
    }
  });
});
