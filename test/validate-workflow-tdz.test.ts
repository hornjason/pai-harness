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

    const violation = (out: string) =>
      (out.split("\n").find((l) => l.includes("TDZ:")) || "").trim();

    expect(violation(zeroOut)).toContain("READ_ME");
    expect(violation(zeroOut)).toBe(violation(indentedOut));
  });
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

describe("the TDZ scan reports its own coverage", () => {
  test("ship.js's clean verdict carries non-zero tracked declarations and references", () => {
    const r = runValidator(SHIP_PATH);
    const line = r.out.split("\n").find((l) => l.includes("TDZ check")) || "";
    const decls = Number((line.match(/(\d+) tracked declaration/) || [])[1]);
    const refs = Number((line.match(/(\d+) reference/) || [])[1]);
    expect(decls).toBeGreaterThan(10);
    expect(refs).toBeGreaterThan(50);
  });
});
