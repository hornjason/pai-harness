/**
 * #968 — the per-test-timeout detector against every spelling of its subject.
 *
 * ## Why the fixtures are HERE and not in the file under guard
 *
 * The live consumer of `perTestTimeoutDeclarations` is
 * `test/scan-budget.test.ts`, which runs it over
 * `test/scratch-paths-unique.test.ts`. Putting these fixtures in either of
 * those files would plant `}, 60_000)` text in the very source the live case
 * reads, so the detector and its witness would be the same bytes and the
 * battery would measure nothing. That exact mistake was made in this repo
 * today — a mutant's spelling and its fixture's matched each other, and the
 * battery scored zero. The fixtures live in a third file for that reason.
 *
 * ## Every form here was measured against a real runner, not reasoned about
 *
 * bun 1.3.14, `bun test --timeout 300`, each case `await Bun.sleep(600)`:
 * the case with no override is killed (`this test timed out after 300ms`),
 * and every form below runs to completion. So each one is genuinely in the
 * detector's subject — they raise the budget, which is what takes a case out
 * of `timeoutProximityViolations` in `lib/junit-checks.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  describeTimeoutDeclarations,
  perTestTimeoutDeclarations,
} from "../lib/per-test-timeouts";

/** `perTestTimeoutDeclarations` or an explicit failure — never a silent `[]`. */
function declarations(src: string) {
  const found = perTestTimeoutDeclarations(src);
  expect(found, `source did not parse, so this reading is a refusal, not a clean result:\n${src}`).not.toBeNull();
  return found!;
}

describe("#968: every spelling that raises the per-test budget is seen", () => {
  /**
   * The form the regex this replaces DID match. Kept so a rewrite that only
   * handles the exotic spellings is caught.
   */
  test("the numeric-literal form with a semicolon", () => {
    const found = declarations('test("slow", () => {\n  expect(1).toBe(1);\n}, 60_000);\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("per-test");
    expect(found[0]!.caseName).toBe("slow");
  });

  /**
   * BLIND SPOT 1 of the old `/\}\s*,\s*([0-9_]+)\s*\)\s*;/`. This is the
   * cheapest walk-around of the whole guard: extract the number into a
   * constant and the detector written for `}, 60_000);` stops seeing the
   * defect it was written for.
   */
  test("a constant in place of the literal", () => {
    const found = declarations('const TIMEOUT = 60_000;\ntest("slow", () => {}, TIMEOUT);\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.expression).toBe("TIMEOUT");
  });

  /** BLIND SPOT 2 — an arithmetic expression is not a numeric literal. */
  test("an arithmetic expression in place of the literal", () => {
    const found = declarations('test("slow", () => {}, 60 * 1000);\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.expression.replace(/\s+/g, " ")).toBe("60 * 1000");
  });

  /** BLIND SPOT 3 — the old regex required a trailing semicolon. */
  test("the numeric form with no trailing semicolon", () => {
    const found = declarations('test("slow", () => {}, 60_000)\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("per-test");
  });

  /** BLIND SPOT 4 — bun also accepts an options object, measured to work. */
  test("the options-object form", () => {
    const found = declarations('test("slow", () => {}, { timeout: 5000 });\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.expression.replace(/\s+/g, " ")).toBe("{ timeout: 5000 }");
  });

  /**
   * BLIND SPOT 5 — a file-level default, which raises the budget for EVERY
   * case in the file and carries no `}` at all, so no variant of the old
   * regex could ever have reached it.
   */
  test("a file-level setDefaultTimeout", () => {
    const found = declarations('import { setDefaultTimeout } from "bun:test";\nsetDefaultTimeout(60_000);\ntest("a", () => {});\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("file-default");
    expect(found[0]!.expression).toBe("60000");
  });

  /**
   * A consequence of transpiling, pinned rather than discovered later.
   *
   * `expression` is sliced out of the TRANSPILED module, and
   * `Bun.Transpiler` normalises numeric separators — `60_000` arrives as
   * `60000`. Harmless here, because the field exists to be read by a human in
   * a failure message and the two spellings are the same number. It is
   * asserted so that the day it stops being true, a case says so rather than
   * a message quietly changing shape.
   */
  test("numeric separators are normalised by the transpile, and that is pinned", () => {
    expect(declarations('test("a", () => {}, 60_000);\n')[0]!.expression).toBe("60000");
  });

  /** `test.only`, `test.skip`, `test.if(…)`, `it` — one question, not a list. */
  test("the modified case forms carry the same budget", () => {
    const src =
      'test.only("a", () => {}, 1000);\n' +
      'test.skip("b", () => {}, 2000);\n' +
      'test.if(true)("c", () => {}, 3000);\n' +
      'it("d", () => {}, 4000);\n';
    expect(declarations(src).map(d => d.expression)).toEqual(["1000", "2000", "3000", "4000"]);
  });

  /**
   * BLIND SPOT 6 — a hook with a budget of its own. MEASURED: a `beforeAll`
   * that outruns the budget IS killed (bun 1.3.14), but its JUnit testcase
   * is named `(unnamed)`, so the proximity row cannot say which case died.
   * Work moved into a budgeted hook is as unreadable as a budgeted case.
   */
  test("a hook budget is a budget", () => {
    const found = declarations("beforeAll(() => { warm(); }, 120000);\nafterEach(() => {}, FOO);\n");
    expect(found.map(d => [d.kind, d.caseName, d.expression])).toEqual([
      ["hook", "beforeAll", "120000"],
      ["hook", "afterEach", "FOO"],
    ]);
  });

  test("a hook with no budget declares nothing", () => {
    expect(declarations("beforeAll(() => { warm(); });\nafterEach(() => {});\n")).toEqual([]);
  });

  test("test.each declares one budget, not one per row", () => {
    // `test.each([…])` is itself a CallExpression rooted at `test` with one
    // argument. Arity is what excludes it, so the array is not mistaken for
    // a case declaration and the real third argument is still read.
    const found = declarations('test.each([1, 2])("row %i", () => {}, 7000);\n');
    expect(found.map(d => d.expression)).toEqual(["7000"]);
  });
});

/**
 * FOUND BY THE REVIEW OF THIS PR — the defect class reproduced inside its
 * own fix. `CASE_ROOTS` matched the LOCAL identifier, so renaming the import
 * made the detector report clean on its own subject.
 *
 * Measured against the pre-fix implementation, all three returned `[]`.
 */
describe("#968: an import alias does not defeat the detector", () => {
  test("test aliased on import", () => {
    const found = declarations('import { test as t } from "bun:test";\nt("slow", () => {}, 60_000);\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.caseName).toBe("slow");
  });

  test("setDefaultTimeout aliased on import", () => {
    const found = declarations('import { setDefaultTimeout as sdt } from "bun:test";\nsdt(60_000);\n');
    expect(found.map(d => d.kind)).toEqual(["file-default"]);
  });

  test("a hook aliased on import is reported under its EXPORTED name", () => {
    // The message has to name `beforeAll`, not `bA` — a failure naming a
    // local alias sends the reader looking for a hook that does not exist.
    const found = declarations('import { beforeAll as bA } from "bun:test";\nbA(() => {}, 60_000);\n');
    expect(found.map(d => [d.kind, d.caseName])).toEqual([["hook", "beforeAll"]]);
  });

  test("a bun:test namespace import", () => {
    const found = declarations('import * as bt from "bun:test";\nbt.test("slow", () => {}, 60_000);\n');
    expect(found).toHaveLength(1);
    expect(found[0]!.caseName).toBe("slow");
  });

  test("the injected global still works in a file importing nothing", () => {
    // bun injects `test` when it is not imported. Resolution must not break
    // the ordinary case while closing the alias hole.
    expect(declarations('test("slow", () => {}, 60_000);\n')).toHaveLength(1);
  });

  /**
   * The other direction of the same resolution, and the reason it is worth
   * doing rather than just widening: a `test` that is NOT bun:test's is no
   * longer reported. This retires the one false positive the previous
   * revision had to name and accept.
   */
  test("a test imported from somewhere else is not bun:test's", () => {
    expect(declarations('import { test } from "./helpers";\ntest(1, 2, 3);\n')).toEqual([]);
  });

  /** The stated boundary, asserted so it is measured rather than assumed. */
  test("an indirection through a variable is NOT resolved, and is a known gap", () => {
    expect(declarations('import { test } from "bun:test";\nconst t = test;\nt("slow", () => {}, 60_000);\n')).toEqual([]);
  });
});

describe("#968: the widening did not cost precision", () => {
  /**
   * THE COST OF WIDENING, measured.
   *
   * #968 proposed `\}\s*,\s*([^)]+)\)\s*;?` as the wider regex. These are the
   * inputs that regex reports and the AST does not. Each is a call whose
   * second-to-last argument ends in `}` — the `expect(value, message)` form
   * this repo uses throughout, and any callback-then-argument call. A
   * detector that reports these refuses ordinary code, which is the same
   * failure as missing the defect, wearing the opposite sign.
   */
  const WIDE_REGEX_FALSE_POSITIVES = [
    'expect(() => { foo(); }, "message").toThrow();',
    "run(() => { work(); }, options);",
    "const x = reduce(items, (a, b) => { return a + b; }, 0);",
    "setTimeout(() => { tick(); }, 1000);",
  ];

  test("the wide regex #968 proposed reports all four, and the AST reports none", () => {
    const wide = /\}\s*,\s*([^)]+)\)\s*;?/g;
    for (const src of WIDE_REGEX_FALSE_POSITIVES) {
      expect([...src.matchAll(wide)].length, `the wide regex was expected to fire on: ${src}`).toBeGreaterThan(0);
      expect(declarations(src), `no budget is declared here: ${src}`).toEqual([]);
    }
  });

  test("an unimported local function named test is still reported", () => {
    // Named rather than hidden, and NARROWED by the alias resolution: a
    // `test` bound by a non-bun:test import is now excluded (asserted
    // above). A local `function test` with no import at all is still
    // reported, because that is indistinguishable from bun's injected
    // global, which must keep working. The 594-file census found no
    // instance of this shape.
    expect(declarations("function test(a, b, c) { return a; }\ntest(1, 2, 3);\n")).toHaveLength(1);
  });

  test("an ordinary case, and a describe, declare nothing", () => {
    expect(declarations('test("ordinary", () => {\n  expect(1).toBe(1);\n});\n')).toEqual([]);
    expect(declarations('describe("grp", () => {\n  test("a", () => {});\n});\n')).toEqual([]);
  });

  /**
   * The self-reference trap, closed. Every fixture above is a STRING in this
   * file, and a source-text detector run over this file would read them all
   * as real declarations. The AST reads them as `Literal` nodes.
   *
   * This is why `test/scratch-paths-unique.test.ts` had to exclude itself
   * from its own scan and why this detector does not need to.
   */
  test("timeout text inside a string literal is not a declaration", () => {
    const src = 'const SAMPLE = \'test("slow", () => {}, 60_000);\';\nconsole.log(SAMPLE);\n';
    expect(declarations(src)).toEqual([]);
  });
});

describe("#968: a reading that could not be taken says so", () => {
  /**
   * The refusal. A parser that stopped parsing and a file with no overrides
   * both produce an empty list unless the two answers stay distinct, and a
   * clean report from a detector that read nothing is the entire subject of
   * #968.
   */
  test("source that does not parse is null, not an empty list", () => {
    expect(perTestTimeoutDeclarations("test('a', () => {\n")).toBeNull();
  });

  test("an empty module is an empty list, not a refusal", () => {
    expect(perTestTimeoutDeclarations("")).toEqual([]);
  });
});

describe("#968: the failure message names the construct and the repair", () => {
  test("both kinds are described in words, with their expression", () => {
    const found = declarations('setDefaultTimeout(30_000);\ntest("slow", () => {}, TIMEOUT);\n');
    const text = describeTimeoutDeclarations(found);
    expect(text).toContain("setDefaultTimeout(30000)");
    expect(text).toContain('"slow" declares a per-test budget of TIMEOUT');
  });
});
