/**
 * #585: `scripts/validate-workflow.ts`'s TDZ check recognised a usage only
 * when the line ASSIGNED to the name (`^\s+NAME = `), and only when that line
 * was indented. A READ matched nothing, which is the far commoner temporal
 * dead zone and the one that actually fired: `workflows/ship.js` reached
 * `SINGLE_WORKTREE_EXEMPT` from a function invoked during module evaluation,
 * ~350 lines above the `const`, and died with
 * `Cannot access 'SINGLE_WORKTREE_EXEMPT' before initialization` — after the
 * validator had passed the same file in CI
 * (`test/workflow-security-integration.test.ts`), and after 11 agents and
 * ~724k tokens of a decomposed ship run had been spent.
 *
 * The detector is a script whose job is to exit non-zero, so this file follows
 * `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job is
 * to exit non-zero": every refusal routes through the single exported
 * `REFUSE_EXIT`, and every negative case runs TWICE — against the real script
 * and against a mutant copy with that constant set to `0`. The mutant must
 * still PRINT the violation while exiting zero; a mutant that prints nothing
 * crashed, and a crash is indistinguishable from a refusal by exit code alone.
 *
 * What was broken to prove each case can fail is recorded per-AC below.
 *
 * Covers SC-2161, SC-2162, SC-2163, SC-2164, SC-2165, SC-2166
 * (HARNESS-STANDARD.md), #585 and #598.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-workflow.ts");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");

const validatorSource = readFileSync(VALIDATOR, "utf-8");

/** The one line the mutant rewrites. Declared here so a drift aborts loudly. */
const REFUSE_EXIT_DECL = "export const REFUSE_EXIT = 1;";

let DIR = "";
let MUTANT_VALIDATOR = "";

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "tdz-585-"));

  const hits = validatorSource.split(REFUSE_EXIT_DECL).length - 1;
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the exit-code constant appears ${hits} times`,
    );
  }
  // An inlined `process.exit(1)` would bypass the mutation entirely, so the
  // refusal could stop being removable without any case noticing.
  const inlined = validatorSource.match(/process\.exit\(\s*[1-9]/g) || [];
  if (inlined.length > 0) {
    throw new Error(
      `could not build the mutant: ${inlined.length} inlined non-zero exit(s) bypass REFUSE_EXIT`,
    );
  }
  // The mutant runs from a temp directory. A relative import would make it die
  // on module resolution — exiting non-zero, which reads as the mutation
  // having been rejected on the merits.
  const relative = validatorSource.match(/from\s+["']\.\.?\//g) || [];
  if (relative.length > 0) {
    throw new Error(
      `could not build the mutant: the validator gained ${relative.length} relative import(s)`,
    );
  }

  MUTANT_VALIDATOR = join(DIR, "validate-workflow-refuse-exit-zero.ts");
  writeFileSync(
    MUTANT_VALIDATOR,
    validatorSource.replace(REFUSE_EXIT_DECL, "export const REFUSE_EXIT = 0;"),
  );
});

afterAll(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  out: string;
}

function runValidator(target: string, validator = VALIDATOR): Run {
  const r = spawnSync("bun", [validator, target], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function fixture(name: string, body: string): string {
  const p = join(DIR, name);
  writeFileSync(p, body);
  return p;
}

/**
 * Assert the real script refuses and the REFUSE_EXIT=0 mutant does not, over
 * one input. The mutant's OUTPUT is asserted first: a mutant that exits zero
 * having printed nothing failed to load, and that is not a measurement.
 */
function refusesAndMutantDoesNot(target: string, name: string): string {
  const real = runValidator(target);
  expect(real.out).toContain(`'${name}'`);
  expect(real.out).toContain("TDZ");
  expect(real.code).toBe(1);

  const mutant = runValidator(target, MUTANT_VALIDATOR);
  expect(mutant.out).toContain(`'${name}'`);
  expect(mutant.code).toBe(0);

  return real.out;
}

// ── AC-1: a module-scope READ before the declaration is a violation ──
//
// Three shapes, because the defect was the SHAPE of the match and not the
// name: an argument, an initialiser, and a read inside a module-scope `if`
// block — which is a block, not a function body, so it runs where it sits.
//
// Broken to prove it can fail: with the pre-#585 assignment-only regex all
// three exit 0 with "no temporal dead zone issues". Measured, not asserted —
// see the mutation table in the commit.

describe("AC-1: a module-scope read before the declaration is reported", () => {
  test("read as a call argument", () => {
    const f = fixture(
      "read-argument.js",
      [
        "const seen = []",
        "seen.push(THRESHOLD)",
        "const THRESHOLD = 3",
        "",
      ].join("\n"),
    );
    const out = refusesAndMutantDoesNot(f, "THRESHOLD");
    expect(out).toContain("read at line 2");
    expect(out).toContain("declared at line 3");
  });

  test("read in another declaration's initialiser", () => {
    const f = fixture(
      "read-initialiser.js",
      ["const doubled = LIMIT * 2", "const LIMIT = 5", ""].join("\n"),
    );
    const out = refusesAndMutantDoesNot(f, "LIMIT");
    expect(out).toContain("read at line 1");
  });

  test("read inside a module-scope if block, which runs where it sits", () => {
    const f = fixture(
      "read-in-block.js",
      [
        "if (globalThis) {",
        "  const picked = MODE",
        "  console.log(picked)",
        "}",
        "const MODE = 'x'",
        "",
      ].join("\n"),
    );
    const out = refusesAndMutantDoesNot(f, "MODE");
    expect(out).toContain("read at line 2");
  });
});

// ── AC-2: the pre-existing assignment shape survives the widening ──
//
// `test/workflow-security.test.ts`'s "catches TDZ in fixture" is a WRITE
// inside a function body. The widened rule defers READS in function bodies,
// and the cheapest way to implement that defers writes too — which would
// delete the only case the detector ever had. Both fixtures are executed in
// ONE test rather than assuming the old case survived.

describe("AC-2: the assignment shape and the read shape are both refused", () => {
  test("the pre-existing write-in-a-function fixture and a new read fixture, one run", () => {
    const write = fixture(
      "write-in-function.js",
      [
        "function useBefore() {",
        "  MY_VAR = null",
        "}",
        "let MY_VAR = 'hello'",
        "",
      ].join("\n"),
    );
    const read = fixture(
      "read-module-scope.js",
      ["console.log(MY_VAR)", "let MY_VAR = 'hello'", ""].join("\n"),
    );

    const writeOut = refusesAndMutantDoesNot(write, "MY_VAR");
    expect(writeOut).toContain("assigned at line 2");

    const readOut = refusesAndMutantDoesNot(read, "MY_VAR");
    expect(readOut).toContain("read at line 1");
  });
});

// ── AC-3: column zero is not a different language ──
//
// The pre-#585 regex was `^\s+NAME\s*=\s`: it required leading whitespace, so
// a usage at column 0 was invisible on top of being a write-only match. The
// pair below differs by exactly two leading spaces on the usage line and
// nothing else — the fixture must not be able to satisfy the assertion by a
// route that bypasses the property under test
// (.claude/rules/checks-must-be-able-to-fail.md, #500).

/** The first `✗ TDZ:` line of a run, trimmed, or "". */
function violationLine(out: string): string {
  return (out.split("\n").find((l) => l.includes("TDZ:")) || "").trim();
}

describe("AC-3: an indented usage and one at column zero are the same finding", () => {
  const COLUMN_ZERO = [
    "const seen = []",
    "seen.push(READ_ME)",
    "const READ_ME = 1",
    "",
  ].join("\n");
  const INDENTED = [
    "const seen = []",
    "  seen.push(READ_ME)",
    "const READ_ME = 1",
    "",
  ].join("\n");

  test("the two fixtures differ only in the indentation of the usage line", () => {
    // Establish the premise before comparing verdicts: if the two bodies
    // differed anywhere else, equal verdicts would prove nothing about column
    // position. #518 — establish presence before comparing.
    expect(INDENTED).not.toBe(COLUMN_ZERO);
    expect(INDENTED.replace("\n  seen", "\nseen")).toBe(COLUMN_ZERO);
  });

  test("both are refused, with equivalent violation text", () => {
    const zeroOut = refusesAndMutantDoesNot(
      fixture("column-zero.js", COLUMN_ZERO),
      "READ_ME",
    );
    const indentedOut = refusesAndMutantDoesNot(
      fixture("indented.js", INDENTED),
      "READ_ME",
    );

    expect(violationLine(zeroOut)).toContain("READ_ME");
    expect(violationLine(zeroOut)).toBe(violationLine(indentedOut));
  });
});

// ── AC-4 (#598): the name class is not the check ──
//
// Both regexes required `[A-Z_][A-Z_0-9]*`, so every identifier that is not
// SCREAMING_SNAKE_CASE sat outside the check while the success line still
// said "no temporal dead zone issues". The live instance is `let
// primaryBranchBefore` in workflows/ship.js, declared beside the worktree
// registry ~3,800 lines above the line that assigns it BECAUSE
// `terminalFailure` reads it on the way out of phases that run long before
// that assignment. Had it stayed where it is assigned the run would have died
// on the exit path, and this validator would have passed the file.
//
// Widening the character class is one character and it is the WRONG fix on
// its own: `testCommand`, `headSha`, `agentResults`, `scopeVerdict` and six
// more are module-scope consts in ship.js AND parameter names on functions
// declared above them, so the naive widening reports TEN violations on a
// correct ship.js. Over-detection is not the safe direction here — a
// validator that fails correct workflows is one people route around — so a
// name bound anywhere else is DROPPED, and the drop is named in the output.
//
// Which cases are witnesses and which are controls, said rather than counted:
//
//   - the name-class pair and the lowercase/`$` cases WITNESS the widening.
//     They also go green under the naive one-character widening, so they do
//     not protect against it. Saying so is the point.
//   - every control pair below, and AC-6's real-ship.js case, are what catch
//     the naive widening: each one is a correct file that the naive detector
//     refuses.

/** The pre-#598 identifier class, declared once so the premise can assert it. */
const PRE_598_NAME_CLASS = /^[A-Z_][A-Z_0-9]*$/;

describe("AC-4 / SC-2161 / SC-2162: a camelCase declaration is checked exactly like a SCREAMING_SNAKE one", () => {
  const SNAKE_SOURCE = [
    "const seen = []",
    "seen.push(SHIP_CONFIG)",
    "const SHIP_CONFIG = 3",
    "",
  ].join("\n");
  // DERIVED, not written twice: the only thing that varies between the two
  // halves is the identifier, because the second half is not written down
  // (#585). A hand-written twin can gain a second difference on the next edit.
  const CAMEL_SOURCE = SNAKE_SOURCE.replaceAll("SHIP_CONFIG", "shipConfig");

  test("the pair varies the name class and nothing else", () => {
    // The derivation makes divergence impossible, so what is worth asserting
    // is that the one thing varied CROSSES the old detector's boundary, and
    // that it is confined to the two lines the check reasons about.
    expect(PRE_598_NAME_CLASS.test("SHIP_CONFIG")).toBe(true);
    expect(PRE_598_NAME_CLASS.test("shipConfig")).toBe(false);
    expect(CAMEL_SOURCE).not.toBe(SNAKE_SOURCE);
    expect(CAMEL_SOURCE).not.toContain("SHIP_CONFIG");

    const a = SNAKE_SOURCE.split("\n");
    const b = CAMEL_SOURCE.split("\n");
    expect(b.length).toBe(a.length);
    const differing = a.map((l, i) => i).filter((i) => a[i] !== b[i]);
    expect(differing).toEqual([1, 2]);
  });

  test("both halves are refused, and the two findings differ only in the name", () => {
    const snakeOut = refusesAndMutantDoesNot(
      fixture("name-class-snake.js", SNAKE_SOURCE),
      "SHIP_CONFIG",
    );
    const camelOut = refusesAndMutantDoesNot(
      fixture("name-class-camel.js", CAMEL_SOURCE),
      "shipConfig",
    );
    expect(violationLine(camelOut)).toBe(
      violationLine(snakeOut).replaceAll("SHIP_CONFIG", "shipConfig"),
    );
  });

  test("an all-lowercase name and a $-prefixed one are refused too", () => {
    // camelCase is not the property; "anything a JS identifier can be" is.
    const lower = refusesAndMutantDoesNot(
      fixture("name-lowercase.js", ["console.log(threshold)", "const threshold = 1", ""].join("\n")),
      "threshold",
    );
    expect(lower).toContain("read at line 1");

    const dollar = refusesAndMutantDoesNot(
      fixture("name-dollar.js", ["console.log($cache)", "const $cache = 1", ""].join("\n")),
      "$cache",
    );
    expect(dollar).toContain("read at line 1");
  });

  test("the reachability rule is name-class-agnostic", () => {
    // AC-5's shape with a camelCase name: the read is inside a function body,
    // which a line-order comparison cannot see, and what makes it a crash is
    // the module-scope call above the declaration. This is the shape
    // `primaryBranchBefore` has in ship.js.
    const out = refusesAndMutantDoesNot(
      fixture(
        "reach-camel.js",
        [
          "function exitPath() {",
          "  return branchBefore",
          "}",
          "exitPath()",
          "let branchBefore = ''",
          "",
        ].join("\n"),
      ),
      "branchBefore",
    );
    expect(out).toContain("reached from the module-scope call to exitPath()");
  });
});

// ── AC-4, the other direction: forms that must NOT be reported ──
//
// Each case is a PAIR derived from one source by one substitution, so the
// clean half and the caught half cannot drift apart and the clean half cannot
// be clean for a reason the caught half shares. A control with no caught twin
// proves only that the scanner found nothing, which is what a scanner that
// reads nothing also reports.

interface ControlPair {
  /** What the pair varies, one dimension. */
  dimension: string;
  /** The file that must PASS. */
  clean: string;
  /** Applied once to `clean` to produce the file that must be REFUSED. */
  from: string;
  to: string;
  /** The tracked name both halves are about. */
  name: string;
  /**
   * Whether the clean half is clean because the name was DROPPED as re-bound
   * rather than because the scan looked and found nothing. The two are
   * different states and the output has to tell them apart.
   */
  dropped: boolean;
}

const CONTROL_PAIRS: ControlPair[] = [
  {
    dimension: "inside a string literal",
    clean: ["const note = 'shipConfig'", "const shipConfig = 3", ""].join("\n"),
    from: "'shipConfig'",
    to: "shipConfig",
    name: "shipConfig",
    dropped: false,
  },
  {
    dimension: "inside a comment",
    clean: ["// shipConfig", "const shipConfig = 3", ""].join("\n"),
    from: "// shipConfig",
    to: "shipConfig",
    name: "shipConfig",
    dropped: false,
  },
  {
    dimension: "a property of another object",
    clean: ["const bag = {}", "console.log(bag.shipConfig)", "const shipConfig = 3", ""].join("\n"),
    from: "bag.shipConfig",
    to: "shipConfig",
    name: "shipConfig",
    dropped: false,
  },
  {
    dimension: "an object-literal key, against the shorthand that reads it",
    clean: ["const held = { shipConfig: 1 }", "const shipConfig = 3", ""].join("\n"),
    from: "{ shipConfig: 1 }",
    to: "{ shipConfig }",
    name: "shipConfig",
    dropped: false,
  },
  {
    dimension: "a parameter that re-binds the name in an inner scope",
    clean: [
      "function render(shipConfig) {",
      "  return shipConfig",
      "}",
      "render(1)",
      "const shipConfig = 2",
      "",
    ].join("\n"),
    from: "function render(shipConfig) {",
    to: "function render(given) {",
    name: "shipConfig",
    dropped: true,
  },
  {
    dimension: "an inner const that re-binds the name",
    clean: [
      "function render() {",
      "  const shipConfig = 1",
      "  return shipConfig",
      "}",
      "render()",
      "const shipConfig = 2",
      "",
    ].join("\n"),
    from: "const shipConfig = 1",
    to: "const given = 1",
    name: "shipConfig",
    dropped: true,
  },
  {
    dimension: "a catch binding that re-binds the name",
    clean: [
      "function parse() {",
      "  try {",
      "    return JSON.parse('x')",
      "  } catch (shipConfig) {",
      "    return shipConfig",
      "  }",
      "}",
      "parse()",
      "const shipConfig = 2",
      "",
    ].join("\n"),
    from: "catch (shipConfig) {",
    to: "catch (given) {",
    name: "shipConfig",
    dropped: true,
  },
];

describe("AC-4 / SC-2164: the widened detector does not report a correct file", () => {
  for (const pair of CONTROL_PAIRS) {
    test(`${pair.dimension} — clean, and the one-substitution twin is refused`, () => {
      const exposed = pair.clean.replace(pair.from, pair.to);

      // Premise: one substitution, one line, same shape. Establish it before
      // comparing verdicts — two verdicts over two unrelated files say
      // nothing about the dimension either of them is named after (#518).
      expect(exposed).not.toBe(pair.clean);
      const a = pair.clean.split("\n");
      const b = exposed.split("\n");
      expect(b.length).toBe(a.length);
      expect(a.map((_, i) => i).filter((i) => a[i] !== b[i]).length).toBe(1);

      const slug = pair.dimension.replace(/[^a-z]+/gi, "-");
      const cleanRun = runValidator(fixture(`control-clean-${slug}.js`, pair.clean));
      expect(cleanRun.out).toContain("no temporal dead zone issues");
      expect(cleanRun.code).toBe(0);

      // A clean verdict has two causes and the output must say which: the
      // name was tracked and nothing was wrong, or the name was dropped. `0`,
      // `{}` and silence are indistinguishable from success.
      if (pair.dropped) {
        expect(cleanRun.out).toContain(`re-bound elsewhere and NOT checked: ${pair.name}`);
      } else {
        expect(cleanRun.out).not.toContain("re-bound elsewhere");
      }

      const out = refusesAndMutantDoesNot(
        fixture(`control-exposed-${slug}.js`, exposed),
        pair.name,
      );
      expect(out).toContain("TDZ");
    });
  }
});

// ── AC-5: the defect that actually shipped, rebuilt ──
//
// The crash was not a textual read above a `const`. `SINGLE_WORKTREE_EXEMPT`
// is read inside `auditWorktreeClaims`, which sits in the same marked block as
// the declaration — so moving the block moves both, and no line-order
// comparison can see anything wrong. What breaks is REACHABILITY: a decomposed
// run calls `runDecomposedShip` at module scope, that call reaches
// `auditWorktreeClaims` during module evaluation, and the `const` has not been
// initialised yet.
//
// The mutant relocates the whole COLLECT-CLAIM block — extracted by the same
// markers `test/collect-claim-enforcement.test.ts` uses — to below the
// module-scope call, which is exactly where it sat before the hand-fix.

describe("AC-5: the relocated COLLECT-CLAIM block is refused; real ship.js is not", () => {
  const START = "// ──── COLLECT-CLAIM-START ────";
  const END = "// ──── COLLECT-CLAIM-END ────";
  const CALL = "implementResult = await runDecomposedShip(mDecomposition.subIssues)";

  function relocatedMutant(): string {
    const src = readFileSync(SHIP_PATH, "utf-8");
    const s = src.indexOf(START);
    const e = src.indexOf(END);
    if (s < 0 || e < 0) {
      throw new Error("could not build the mutant: COLLECT-CLAIM markers not found in ship.js");
    }
    const block = src.slice(s, e + END.length);
    const rest = src.slice(0, s) + src.slice(e + END.length);
    const ci = rest.indexOf(CALL);
    if (ci < 0) {
      throw new Error("could not build the mutant: the module-scope runDecomposedShip call moved");
    }
    if (rest.indexOf(CALL, ci + 1) !== -1) {
      throw new Error("could not build the mutant: the runDecomposedShip call appears more than once");
    }
    const after = rest.indexOf("\n", ci) + 1;
    const out = `${rest.slice(0, after)}\n${block}\n${rest.slice(after)}`;
    const p = join(DIR, "ship-collect-claim-relocated.js");
    writeFileSync(p, out);
    return p;
  }

  test("the mutant is refused naming SINGLE_WORKTREE_EXEMPT and real ship.js exits 0", () => {
    const mutantShip = relocatedMutant();

    const refused = runValidator(mutantShip);
    expect(refused.out).toContain("SINGLE_WORKTREE_EXEMPT");
    expect(refused.code).toBe(1);

    // Same run, same validator: the real file must not be caught by the thing
    // that catches the mutant, or the mutant proves nothing.
    const real = runValidator(SHIP_PATH);
    expect(real.out).toContain("PASSED");
    expect(real.code).toBe(0);
  });

  test("the refusal is removable — REFUSE_EXIT=0 still reports it and exits 0", () => {
    const mutantShip = relocatedMutant();
    const mutated = runValidator(mutantShip, MUTANT_VALIDATOR);
    expect(mutated.out).toContain("SINGLE_WORKTREE_EXEMPT");
    expect(mutated.code).toBe(0);
  });
});

// ── AC-4: the live camelCase hazard, rebuilt on the real ship.js ──
//
// `let primaryBranchBefore = ''` sits beside the worktree registry with a
// docblock saying why: `terminalFailure` reads it, and `terminalFailure` is
// reachable from phases that run long before `establishRunRef` assigns it.
// Moving the declaration to where it is assigned — the position a reader who
// had not been told would put it — is a real TDZ on the exit path, and it is
// the exact shape this validator could not see before #598.

describe("AC-4 / SC-2163: the relocated primaryBranchBefore declaration is refused", () => {
  const DECL = "let primaryBranchBefore = ''";
  const ASSIGN = "  primaryBranchBefore =";

  function relocatedDeclarationMutant(): string {
    const src = readFileSync(SHIP_PATH, "utf-8");
    const decls = src.split(`${DECL}\n`).length - 1;
    if (decls !== 1) {
      throw new Error(
        `could not build the mutant: the primaryBranchBefore declaration appears ${decls} times`,
      );
    }
    const assigns = src.split(`\n${ASSIGN}`).length - 1;
    if (assigns !== 1) {
      throw new Error(
        `could not build the mutant: the primaryBranchBefore assignment appears ${assigns} times`,
      );
    }
    const without = src.replace(`${DECL}\n`, "");
    const at = without.indexOf(ASSIGN);
    const lineStart = without.lastIndexOf("\n", at) + 1;
    const p = join(DIR, "ship-primary-branch-relocated.js");
    writeFileSync(p, `${without.slice(0, lineStart)}${DECL}\n${without.slice(lineStart)}`);
    return p;
  }

  test("the mutant is refused naming primaryBranchBefore and real ship.js exits 0", () => {
    const refused = runValidator(relocatedDeclarationMutant());
    expect(refused.out).toContain("primaryBranchBefore");
    // Not merely "a violation": the finding has to be the reachability one,
    // because a line-order comparison cannot see this and reporting it for
    // the wrong reason would read identically.
    expect(refused.out).toContain("reached from the module-scope call to");
    expect(refused.code).toBe(1);

    const real = runValidator(SHIP_PATH);
    expect(real.out).toContain("PASSED");
    expect(real.code).toBe(0);
  });

  test("the refusal is removable — REFUSE_EXIT=0 still reports it and exits 0", () => {
    const mutated = runValidator(relocatedDeclarationMutant(), MUTANT_VALIDATOR);
    expect(mutated.out).toContain("primaryBranchBefore");
    expect(mutated.code).toBe(0);
  });
});

// ── AC-6: no false positive on a deferred forward reference ──
//
// A hoisted function may legitimately name a `const` declared below it: the
// call happens later. That is the whole reason this cannot be a line-order
// grep, and it is the property most at risk from the widening.

describe("AC-6: a forward reference called after the declaration is not reported", () => {
  function clean(name: string, body: string): Run {
    const r = runValidator(fixture(name, body));
    expect(r.out).toContain("no temporal dead zone issues");
    expect(r.out).toContain("PASSED");
    expect(r.code).toBe(0);
    return r;
  }

  test("a function whose only module-scope call site sits after the const", () => {
    clean(
      "clean-called-after.js",
      [
        "function later() {",
        "  return CONFIG.a",
        "}",
        "const CONFIG = { a: 1 }",
        "later()",
        "",
      ].join("\n"),
    );
  });

  test("a function that is never called at module scope at all", () => {
    clean(
      "clean-never-called.js",
      [
        "function helper() {",
        "  return SETTING",
        "}",
        "const SETTING = 1",
        "globalThis.exported = helper",
        "",
      ].join("\n"),
    );
  });

  test("a read after its own declaration, at module scope", () => {
    clean(
      "clean-ordinary.js",
      ["const READY = 1", "console.log(READY)", ""].join("\n"),
    );
  });

  test("real workflows/ship.js reports zero violations", () => {
    const r = runValidator(SHIP_PATH);
    expect(r.out).toContain("no temporal dead zone issues");
    expect(r.code).toBe(0);
  });
});

// ── Coverage: a clean verdict over a file nothing was read from looks exactly
// like a clean verdict over a file that was fully read (#492). The scan prints
// its own coverage, and that number is the only part of its output that can
// change when it stops working.

describe("SC-2165 / SC-2166: the TDZ scan reports its own coverage", () => {
  function coverage(out: string) {
    const line = out.split("\n").find((l) => l.includes("TDZ check")) || "";
    const m = line.match(/(\d+) of (\d+) module declaration\(s\) tracked, (\d+) reference/);
    return {
      line,
      tracked: Number(m?.[1]),
      found: Number(m?.[2]),
      refs: Number(m?.[3]),
    };
  }

  test("ship.js's clean verdict carries non-zero tracked declarations and references", () => {
    const c = coverage(runValidator(SHIP_PATH).out);
    expect(c.tracked).toBeGreaterThan(10);
    expect(c.refs).toBeGreaterThan(50);
  });

  // #598: the widening is what makes this number worth reading. A PASS over
  // 62 SCREAMING_SNAKE names and a PASS over 141 names of every shape print
  // the same word, and the count is the only part of the output that can say
  // which one happened.
  test("the widening is visible in the count, and the untracked ones are NAMED", () => {
    const out = runValidator(SHIP_PATH).out;
    const c = coverage(out);

    // The pre-#598 class found 62 module declarations in this file. Anything
    // at or below that is a scan that has stopped reading past the old class.
    expect(c.tracked).toBeGreaterThan(62);
    expect(c.found).toBeGreaterThanOrEqual(c.tracked);

    // Every name the scan declined is listed, not counted. ship.js has ten,
    // each a module-scope const that is also a parameter somewhere above it.
    const dropped = c.found - c.tracked;
    if (dropped > 0) {
      const named = (c.line.split("NOT checked: ")[1] || "").split(", ").filter(Boolean);
      expect(named.length).toBe(dropped);
      expect(named).toContain("testCommand");
    }
  });

  // Found by predicting a battery row and getting 0: making `bumpBindings`
  // count default values as bindings — `function f(projectRoot = PROJECT_ROOT)`
  // — drops HARNESS_ROOT and PROJECT_ROOT from ship.js's tracked set, and
  // nothing in this file noticed. A widening is allowed to cost nothing; it is
  // NOT allowed to pay for itself by quietly dropping names the check has
  // tracked since before #598.
  test("no name the pre-#598 class covered has been dropped from ship.js", () => {
    const c = coverage(runValidator(SHIP_PATH).out);
    const named = (c.line.split("NOT checked: ")[1] || "").split(", ").filter(Boolean);
    // Premise: the list is populated, or this asserts nothing about anything.
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => PRE_598_NAME_CLASS.test(n))).toEqual([]);
  });

  test("a file whose names are all re-bound says so instead of reporting nothing", () => {
    // The state this exists to make visible: a scan that checked NOTHING and
    // a scan that checked everything and found nothing print the same verdict
    // without it (#492).
    const r = runValidator(
      fixture(
        "all-shadowed.js",
        [
          "function render(shipConfig) {",
          "  return shipConfig",
          "}",
          "render(1)",
          "const shipConfig = 2",
          "",
        ].join("\n"),
      ),
    );
    const c = coverage(r.out);
    expect(c.tracked).toBe(0);
    expect(c.found).toBe(1);
    expect(r.out).toContain("re-bound elsewhere and NOT checked: shipConfig");
    expect(r.code).toBe(0);
  });
});
