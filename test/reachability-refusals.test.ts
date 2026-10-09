import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  PERMITTED_ENCLOSING,
  REACHABILITY_REFUSE,
  ReachabilityRefusal,
  UNCONDITIONAL_TERMINATORS,
  assertMarkedBlockReachable,
  enclosingChain,
} from "../lib/reachability";

/**
 * lib/reachability.ts — #200 Phase 1.
 *
 * The marker-extraction + `new Function` pattern this repo adopted as its
 * strong form of verification proves the extracted TEXT refuses correctly. It
 * does not prove the block runs. Measured on 2026-10-08, wrapping the marked
 * region in `if (false)` with the wrapper placed OUTSIDE the marker comments —
 * so the extracted slice stays byte-identical:
 *
 *   BLOCKING-GRADES     (#188)      19 pass / 0 fail
 *   SECURITY-DECISION   (#129)     113 pass / 0 fail
 *   COMMIT-STATE-GUARD  (#166)      52 pass / 0 fail
 *
 * The helper under test reads the block's position in the parsed program
 * instead of its text.
 *
 * Every refusal case runs TWICE: once against the real module, once against a
 * mutant copy whose single refusal constant is set to 0. The second run is the
 * evidence. "It threw" on its own cannot tell a refusal from a typo, a bad
 * fixture, or a helper that refuses everything —
 * .claude/rules/checks-must-be-able-to-fail.md counts five shipped bugs of
 * exactly that shape in one day. The mutant makes the REMOVAL of the refusal
 * observable: real refuses, mutant does not.
 *
 * The POSITIVE CONTROL group is the other half. A helper whose body is
 * `refuse("no")` satisfies every negative case for free; only the accept cases
 * separate it from a working one.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const MODULE_PATH = join(REPO_ROOT, "lib", "reachability.ts");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");

const source = readFileSync(MODULE_PATH, "utf-8");
const shipSource = readFileSync(SHIP, "utf-8");

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Deliberately tiny, and every mutation is of the SAME marked block, so the
// bytes between the markers are identical in all of them. Only the enclosing
// control flow changes — which is the whole point: a text-based check sees no
// difference at all between any two of these.

const START = "// ──── DEMO-START ────";
const END = "// ──── DEMO-END ────";
const MARKED = `${START}\nsideEffects.push("ran")\n${END}`;

const WIRED_IN = `const sideEffects = []\n${MARKED}\nexport { sideEffects }\n`;

const FIXTURES = {
  unparseable: `const sideEffects = []\n${MARKED}\nconst broken = (\n`,
  noStartMarker: WIRED_IN.replace(`${START}\n`, ""),
  noEndMarker: WIRED_IN.replace(`\n${END}`, ""),
  duplicatePair: `const sideEffects = []\n${MARKED}\nif (false) {\n${MARKED}\n}\nexport { sideEffects }\n`,
  // The two halves of the uniqueness check, separated. Measured 2026-10-08:
  // deleting ONLY the start-count branch left the suite at 51 pass / 0 fail,
  // because the end-count branch refused the combined fixture for it and the
  // "2 times" message was satisfied by the wrong marker. Each half now has a
  // case that only it can refuse.
  duplicateStartOnly: `const sideEffects = []\n${MARKED}\n${START}\nexport { sideEffects }\n`,
  duplicateEndOnly: `const sideEffects = []\n${MARKED}\n${END}\nexport { sideEffects }\n`,
  endBeforeStart: `const sideEffects = []\n${END}\nsideEffects.push("ran")\n${START}\nexport { sideEffects }\n`,

  // ── The four mutation cases named by AC-4 ──────────────────────────────
  //
  // 1. `if (false)` — the wrapper is OUTSIDE the markers, so the slice is
  //    byte-identical and no assertion about the extracted text can see it.
  ifFalseOutsideMarkers: `const sideEffects = []\nif (false) {\n${MARKED}\n}\nexport { sideEffects }\n`,
  // 2. wrapper outside the markers, in its weaker `if (true)` form: a check
  //    that pattern-matched on the literal `false` would miss this, and a
  //    conditional that happens to be true today is still a conditional.
  wrapperOutsideMarkersTruthy: `const sideEffects = []\nif (true) {\n${MARKED}\n}\nexport { sideEffects }\n`,
  // 3. early return — the block stays at top level, nothing in the chain
  //    changes, and control never gets there. This is the case an
  //    ancestor-chain check alone does NOT catch.
  earlyReturn: `const sideEffects = []\nreturn\n${MARKED}\n`,
  earlyReturnInsideTry: `const sideEffects = []\ntry {\nreturn\n${MARKED}\n} catch (err) {}\n`,
  earlyThrow: `const sideEffects = []\nthrow new Error("stop")\n${MARKED}\n`,
  // 4. never called — the block is relocated into a function nobody invokes.
  neverCalledFunction: `const sideEffects = []\nfunction neverCalled() {\n${MARKED}\n}\nexport { sideEffects }\n`,

  insideLoop: `const sideEffects = []\nfor (const each of []) {\n${MARKED}\n}\nexport { sideEffects }\n`,
  insideCatch: `const sideEffects = []\ntry { JSON.parse("{}") } catch (err) {\n${MARKED}\n}\nexport { sideEffects }\n`,
  insideTryBlock: `const sideEffects = []\ntry {\n${MARKED}\n} catch (err) {}\nexport { sideEffects }\n`,
  // A CONDITIONAL return before the block is not a refusal: workflows/ship.js
  // is full of `if (bad) return {...}` above every marked block, and a helper
  // that refused those would reject the real file. The positive-control group
  // asserts this one is accepted.
  conditionalReturnBefore: `const sideEffects = []\nif (globalThis.nope) { return }\n${MARKED}\n`,
};

/** The four names AC-4 requires, kept next to the fixtures they refer to. */
const FOUR_MUTATIONS: Array<[string, string]> = [
  ["if (false)", FIXTURES.ifFalseOutsideMarkers],
  ["wrapper outside the markers", FIXTURES.wrapperOutsideMarkersTruthy],
  ["early return", FIXTURES.earlyReturn],
  ["never called", FIXTURES.neverCalledFunction],
];

// ── The mutant ───────────────────────────────────────────────────────────
//
// Built in a temp directory OUTSIDE the repo. The module has exactly one
// non-relative import (the AST parser), rewritten to an absolute specifier so
// the mutant resolves from anywhere; a later relative import would make the
// mutant die on module resolution, which would throw, which would read as
// "the mutation was rejected on the merits" when in fact the mutant never ran.
// Both rewrites fail closed — if either stops matching, this file aborts
// instead of quietly running zero mutant assertions.

type Mutant = {
  assertMarkedBlockReachable: (source: string, markerName: string) => string[];
  enclosingChain: (source: string, start: number, end: number) => string[];
};

let MUTANT_DIR = "";
let mutant: Mutant;

beforeAll(async () => {
  const acorn = import.meta.resolve("acorn");

  const neutralised = source.replace(/REACHABILITY_REFUSE = 1\b/, "REACHABILITY_REFUSE = 0");
  if (neutralised === source) {
    throw new Error(
      "could not build the mutant: no `REACHABILITY_REFUSE = 1` in lib/reachability.ts",
    );
  }
  const relocated = neutralised.replace(/ from "acorn"/g, ` from ${JSON.stringify(acorn)}`);
  if (relocated === neutralised) {
    throw new Error(
      'could not build the mutant: no `from "acorn"` import to redirect out of the repo',
    );
  }

  MUTANT_DIR = mkdtempSync(join(tmpdir(), "reachability-mutant-"));
  const file = join(MUTANT_DIR, "reachability.ts");
  writeFileSync(file, relocated);
  mutant = (await import(file)) as Mutant;
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
});

/**
 * The real module refuses, and the mutant — the same code with the single
 * refusal constant zeroed — does not. Both halves are required.
 */
function refuses(fixture: string, markerName = "DEMO") {
  expect(() => assertMarkedBlockReachable(fixture, markerName)).toThrow(ReachabilityRefusal);
  expect(
    () => mutant.assertMarkedBlockReachable(fixture, markerName),
    "the mutant (REACHABILITY_REFUSE = 0) still threw — this case is not being " +
      "caught by the refusal under test",
  ).not.toThrow();
}

/** The bytes between the markers, which every mutation here leaves untouched. */
function between(src: string, name = "DEMO"): string {
  const a = src.indexOf(`${name}-START`);
  const b = src.indexOf(`${name}-END`);
  if (a === -1 || b === -1 || b < a) throw new Error(`fixture error: no ${name} pair`);
  return src.slice(a + `${name}-START`.length, b);
}

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────
//
// Without this group a helper whose entire body is `refuse("no")` passes every
// other test in this file.

describe("POSITIVE CONTROL — a correctly wired block is accepted", () => {
  for (const name of ["BLOCKING-GRADES", "SECURITY-DECISION", "COMMIT-STATE-GUARD"]) {
    test(`the real, unmutated workflows/ship.js ${name} pair is accepted`, () => {
      expect(
        shipSource.includes(`${name}-START`),
        `workflows/ship.js no longer has the ${name} marker pair — this control measures nothing`,
      ).toBe(true);
      expect(assertMarkedBlockReachable(shipSource, name)).toEqual(["Program"]);
    });
  }

  test("a fixture block at module top level is accepted", () => {
    expect(assertMarkedBlockReachable(WIRED_IN, "DEMO")).toEqual(["Program"]);
  });

  test("a block inside a `try` block is accepted — the try body runs unconditionally", () => {
    expect(assertMarkedBlockReachable(FIXTURES.insideTryBlock, "DEMO")).toEqual([
      "Program",
      "TryStatement",
      "BlockStatement",
    ]);
  });

  test("a CONDITIONAL return before the block is accepted — ship.js is full of them", () => {
    expect(assertMarkedBlockReachable(FIXTURES.conditionalReturnBefore, "DEMO")).toEqual([
      "Program",
    ]);
  });

  test("the accept path is reached for more than one input shape", () => {
    // Guards against an accept path that only ever fires on one memoised case.
    const accepted = [
      assertMarkedBlockReachable(WIRED_IN, "DEMO"),
      assertMarkedBlockReachable(FIXTURES.insideTryBlock, "DEMO"),
      assertMarkedBlockReachable(FIXTURES.conditionalReturnBefore, "DEMO"),
      assertMarkedBlockReachable(shipSource, "BLOCKING-GRADES"),
    ];
    expect(accepted.length).toBe(4);
    for (const chain of accepted) expect(chain[0]).toBe("Program");
  });
});

// ── The four mutation cases required by AC-4 ─────────────────────────────

describe("the four mutations: if (false), wrapper outside the markers, early return, never called", () => {
  test("if (false) — real refuses, mutant does not", () => {
    refuses(FIXTURES.ifFalseOutsideMarkers);
  });

  test("wrapper outside the markers — real refuses, mutant does not", () => {
    refuses(FIXTURES.wrapperOutsideMarkersTruthy);
  });

  test("early return — real refuses, mutant does not", () => {
    refuses(FIXTURES.earlyReturn);
  });

  test("never called — real refuses, mutant does not", () => {
    refuses(FIXTURES.neverCalledFunction);
  });

  test("all four leave the marked bytes identical to the accepted case", () => {
    // This is what makes them the right mutations. A text-based check cannot
    // tell any of these four from WIRED_IN, because the text is the same.
    for (const [name, fixture] of FOUR_MUTATIONS) {
      expect(between(fixture), `${name} changed the extracted slice`).toBe(between(WIRED_IN));
    }
    expect(FOUR_MUTATIONS.length).toBe(4);
    expect(new Set(FOUR_MUTATIONS.map(([, f]) => f)).size).toBe(4);
  });

  test("each refusal names the construct or statement responsible", () => {
    expect(() => assertMarkedBlockReachable(FIXTURES.ifFalseOutsideMarkers, "DEMO")).toThrow(
      /IfStatement/,
    );
    expect(() => assertMarkedBlockReachable(FIXTURES.wrapperOutsideMarkersTruthy, "DEMO")).toThrow(
      /IfStatement/,
    );
    expect(() => assertMarkedBlockReachable(FIXTURES.earlyReturn, "DEMO")).toThrow(
      /ReturnStatement/,
    );
    expect(() => assertMarkedBlockReachable(FIXTURES.neverCalledFunction, "DEMO")).toThrow(
      /FunctionDeclaration/,
    );
  });
});

// ── Everything else the ancestor chain refuses ───────────────────────────

describe("refuses on the enclosing control flow, not on the marked text", () => {
  test("inside a loop — real refuses, mutant does not", () => {
    refuses(FIXTURES.insideLoop);
  });

  test("inside a catch clause — real refuses, mutant does not", () => {
    refuses(FIXTURES.insideCatch);
  });

  test("end marker before start marker — real refuses, mutant does not", () => {
    refuses(FIXTURES.endBeforeStart);
  });
});

describe("refuses on an unconditional terminator before the block", () => {
  test("an early return at top level — real refuses, mutant does not", () => {
    refuses(FIXTURES.earlyReturn);
  });

  test("an early return inside the enclosing try — real refuses, mutant does not", () => {
    // The ancestor chain here is entirely permitted (Program > TryStatement >
    // BlockStatement). Only the preceding sibling makes it unreachable, so
    // this case fails if the terminator scan only looks at Program level.
    expect(enclosingChain(
      FIXTURES.earlyReturnInsideTry,
      FIXTURES.earlyReturnInsideTry.indexOf(START) + START.length,
      FIXTURES.earlyReturnInsideTry.indexOf(END),
    )).toEqual(["Program", "TryStatement", "BlockStatement"]);
    refuses(FIXTURES.earlyReturnInsideTry);
  });

  test("an unconditional throw before the block — real refuses, mutant does not", () => {
    refuses(FIXTURES.earlyThrow);
  });

  test("the terminator list is exported with a reason each", () => {
    expect(Object.keys(UNCONDITIONAL_TERMINATORS).sort()).toEqual([
      "BreakStatement",
      "ContinueStatement",
      "ReturnStatement",
      "ThrowStatement",
    ]);
    for (const [node, reason] of Object.entries(UNCONDITIONAL_TERMINATORS)) {
      expect(reason.length, `${node} has no stated reason`).toBeGreaterThan(20);
    }
  });
});

describe("refuses when the source does not parse", () => {
  test("real refuses, mutant does not", () => {
    refuses(FIXTURES.unparseable);
  });

  test("the reason names the parse failure rather than the markers", () => {
    expect(() => assertMarkedBlockReachable(FIXTURES.unparseable, "DEMO")).toThrow(/does not parse/);
  });

  test("enclosingChain fails closed on the same input", () => {
    expect(() => enclosingChain(FIXTURES.unparseable, 0, 1)).toThrow(ReachabilityRefusal);
    expect(() => mutant.enclosingChain(FIXTURES.unparseable, 0, 1)).not.toThrow();
  });
});

describe("refuses when a marker is absent", () => {
  test("start marker absent — real refuses, mutant does not", () => {
    refuses(FIXTURES.noStartMarker);
  });

  test("end marker absent — real refuses, mutant does not", () => {
    refuses(FIXTURES.noEndMarker);
  });

  test("both absent — real refuses, mutant does not", () => {
    refuses(WIRED_IN, "NO-SUCH-BLOCK");
  });

  test("the reason names the missing marker", () => {
    expect(() => assertMarkedBlockReachable(FIXTURES.noStartMarker, "DEMO")).toThrow(/DEMO-START/);
    expect(() => assertMarkedBlockReachable(FIXTURES.noEndMarker, "DEMO")).toThrow(/DEMO-END/);
  });
});

describe("refuses when the marker pair occurs more than once", () => {
  test("a second, dead copy of the pair — real refuses, mutant does not", () => {
    refuses(FIXTURES.duplicatePair);
  });

  test("the reason says how many times the marker was found", () => {
    expect(() => assertMarkedBlockReachable(FIXTURES.duplicatePair, "DEMO")).toThrow(/2 times/);
  });

  test("a duplicated START alone is refused, and the reason names START", () => {
    refuses(FIXTURES.duplicateStartOnly);
    expect(() => assertMarkedBlockReachable(FIXTURES.duplicateStartOnly, "DEMO")).toThrow(
      /DEMO-START occurs 2 times/,
    );
  });

  test("a duplicated END alone is refused, and the reason names END", () => {
    refuses(FIXTURES.duplicateEndOnly);
    expect(() => assertMarkedBlockReachable(FIXTURES.duplicateEndOnly, "DEMO")).toThrow(
      /DEMO-END occurs 2 times/,
    );
  });

  test("the live copy alone would have been accepted — the duplicate is what is refused", () => {
    expect(assertMarkedBlockReachable(WIRED_IN, "DEMO")).toEqual(["Program"]);
  });
});

// ── The measured regression, rerun against the real workflows/ship.js ────

describe("the measured regression, rerun against the real workflows/ship.js", () => {
  /** `if (false) { ... }` with the wrapper OUTSIDE the marker comments. */
  function wrapOutsideMarkers(src: string, name: string): string {
    const lines = src.split("\n");
    const first = lines.findIndex((l) => l.includes(`${name}-START`));
    const last = lines.findIndex((l) => l.includes(`${name}-END`));
    if (first < 0 || last <= first) throw new Error(`fixture error: no ${name} pair in ship.js`);
    lines.splice(last + 1, 0, "}");
    lines.splice(first, 0, "if (false) {");
    return lines.join("\n");
  }

  for (const name of ["BLOCKING-GRADES", "SECURITY-DECISION", "COMMIT-STATE-GUARD"]) {
    const mutated = wrapOutsideMarkers(shipSource, name);

    test(`${name}: the extracted slice is byte-identical — this is why the text-based suites saw nothing`, () => {
      expect(between(mutated, name)).toBe(between(shipSource, name));
    });

    test(`${name}: real refuses the unreachable block, mutant does not`, () => {
      refuses(mutated, name);
    });

    test(`${name}: the real file is still accepted — the refusal is about the wrapper`, () => {
      expect(assertMarkedBlockReachable(shipSource, name)).toEqual(["Program"]);
    });
  }
});

describe("enclosingChain reports the ancestors, outermost first", () => {
  function region(fixture: string) {
    return {
      start: fixture.indexOf(START) + START.length,
      end: fixture.indexOf(END),
    };
  }

  test("top-level block", () => {
    const { start, end } = region(WIRED_IN);
    expect(enclosingChain(WIRED_IN, start, end)).toEqual(["Program"]);
  });

  test("`if (false)` wrapper shows up as an ancestor", () => {
    const { start, end } = region(FIXTURES.ifFalseOutsideMarkers);
    expect(enclosingChain(FIXTURES.ifFalseOutsideMarkers, start, end)).toEqual([
      "Program",
      "IfStatement",
      "BlockStatement",
    ]);
  });

  test("a function body shows up as an ancestor", () => {
    const { start, end } = region(FIXTURES.neverCalledFunction);
    expect(enclosingChain(FIXTURES.neverCalledFunction, start, end)).toEqual([
      "Program",
      "FunctionDeclaration",
      "BlockStatement",
    ]);
  });

  test("the chain is a property of the parse, not of the marked text", () => {
    // Same two fixtures, same marked bytes, different chains.
    const a = region(WIRED_IN);
    const b = region(FIXTURES.ifFalseOutsideMarkers);
    expect(WIRED_IN.slice(a.start, a.end)).toBe(
      FIXTURES.ifFalseOutsideMarkers.slice(b.start, b.end),
    );
    expect(enclosingChain(WIRED_IN, a.start, a.end)).not.toEqual(
      enclosingChain(FIXTURES.ifFalseOutsideMarkers, b.start, b.end),
    );
  });
});

// ── The single refusal constant ──────────────────────────────────────────

describe("every refusal exits through one REACHABILITY_REFUSE constant", () => {
  test("REACHABILITY_REFUSE is declared exactly once in the source", () => {
    const declarations = source.match(/REACHABILITY_REFUSE\s*=/g) || [];
    expect(declarations.length).toBe(1);
  });

  test("the declaration is exported and lives on a single line", () => {
    const lines = source
      .split("\n")
      .filter((l) => /^export const REACHABILITY_REFUSE = 1;?$/.test(l.trim()));
    expect(lines.length).toBe(1);
    expect(REACHABILITY_REFUSE).toBe(1);
  });

  test("the source raises in exactly one place, and that place is guarded by the constant", () => {
    const raises = source.match(/\bthrow\b/g) || [];
    expect(raises.length).toBe(1);
    expect(source).toMatch(/if \(REACHABILITY_REFUSE\) throw new ReachabilityRefusal\(/);
  });

  test("the module has no relative imports — the mutant runs outside the repo", () => {
    const relative = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(relative, "a relative import would make every mutant fail to resolve").toEqual([]);
  });

  test("zeroing the constant neutralises every refusal — nothing bypasses it", () => {
    const everyRefusal = [
      FIXTURES.unparseable,
      FIXTURES.noStartMarker,
      FIXTURES.noEndMarker,
      FIXTURES.duplicatePair,
      FIXTURES.duplicateStartOnly,
      FIXTURES.duplicateEndOnly,
      FIXTURES.endBeforeStart,
      FIXTURES.ifFalseOutsideMarkers,
      FIXTURES.wrapperOutsideMarkersTruthy,
      FIXTURES.earlyReturn,
      FIXTURES.earlyReturnInsideTry,
      FIXTURES.earlyThrow,
      FIXTURES.neverCalledFunction,
      FIXTURES.insideLoop,
      FIXTURES.insideCatch,
    ];
    for (const fixture of everyRefusal) {
      expect(() => mutant.assertMarkedBlockReachable(fixture, "DEMO")).not.toThrow();
    }
    expect(everyRefusal.length).toBe(15);
  });
});

// ── The permitted list is stated, not inferred ───────────────────────────

describe("permitted enclosing constructs are written down with a reason each", () => {
  test("the allowlist is exported and small", () => {
    expect(Object.keys(PERMITTED_ENCLOSING).sort()).toEqual([
      "BlockStatement",
      "Program",
      "TryStatement",
    ]);
  });

  test("every entry carries a reason", () => {
    for (const [node, reason] of Object.entries(PERMITTED_ENCLOSING)) {
      expect(reason.length, `${node} has no stated reason`).toBeGreaterThan(20);
    }
  });

  test("the residual runtime gap is written down in the module", () => {
    // AC-5. This is a parse-time property; say what it cannot see rather than
    // letting a green suite imply coverage it does not have.
    expect(source).toMatch(/parse-time/);
    expect(source).toMatch(/cannot catch/i);
  });
});
