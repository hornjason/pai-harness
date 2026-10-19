/**
 * Covers #676 — a run tests only what its changed files can reach.
 *
 * The direction this is allowed to be wrong in is TOWARD running too much.
 * A selection that is too large costs minutes; a selection that is too small
 * reports a green suite over a regression, wearing the most convincing
 * disguise available — a passing test run.
 *
 * So most of this file is about the refusal rather than the selection. An
 * empty `tests` list is never an instruction to run nothing: `0`, `{}`,
 * `null` and `SKIP` are indistinguishable from success
 * (`.claude/rules/config-access.md`), and the caller has to be able to tell
 * "nothing is affected" from "I could not work out what is affected".
 *
 * THE CASE THAT CARRIES THIS FILE is `transitive`. The cheapest wrong fix
 * for #676 is the method already in use by hand — `grep -rl "<basename>"
 * test/` — and the only input on which it and a real import graph differ is
 * a test that reaches a changed file THROUGH AN INTERMEDIATE MODULE without
 * ever naming it. Every fixture here that is meant to witness the graph
 * asserts the test file does not contain the changed file's name, so the
 * grep method cannot reach the assertion.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

import { affectedTests } from "../lib/affected-tests";

const made: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "affected-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Write a file and every directory above it. */
function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/**
 * A project with one test, one helper the test imports, and one module the
 * helper imports. The test never names `lib/deep.ts`.
 */
function chainProject(): string {
  const root = dir();
  put(root, "lib/deep.ts", "export const deep = 1;\n");
  put(root, "lib/middle.ts", 'import { deep } from "./deep";\nexport const middle = deep + 1;\n');
  put(
    root,
    "test/chain.test.ts",
    'import { middle } from "../lib/middle";\nimport { test, expect } from "bun:test";\n' +
      'test("middle", () => { expect(middle).toBe(2); });\n',
  );
  put(root, "test/unrelated.test.ts", 'import { test } from "bun:test";\ntest("nothing", () => {});\n');
  return root;
}

describe("#676: a test is selected when it can reach a changed file", () => {
  test("a direct import selects the test", () => {
    const root = chainProject();
    const r = affectedTests(root, ["lib/middle.ts"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/chain.test.ts");
  });

  test("transitive: the test reaches the change through an intermediate module it never names", () => {
    // The witness for this whole issue. `test/chain.test.ts` imports
    // `lib/middle.ts`, which imports `lib/deep.ts`. A filename grep over
    // test/ for "deep" finds nothing, so the incumbent method drops this
    // test and reports green over a change it never exercised.
    const root = chainProject();
    const source = readFileSync(join(root, "test/chain.test.ts"), "utf-8");
    expect(source, "the fixture must not name the changed file, or grep would also find it")
      .not.toContain("deep");

    const r = affectedTests(root, ["lib/deep.ts"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/chain.test.ts");
  });

  test("a test that cannot reach the change is not selected", () => {
    const root = chainProject();
    const r = affectedTests(root, ["lib/deep.ts"]);
    expect(r.tests).not.toContain("test/unrelated.test.ts");
  });

  test("a changed test file selects itself", () => {
    const root = chainProject();
    const r = affectedTests(root, ["test/unrelated.test.ts"]);
    expect(r.tests).toContain("test/unrelated.test.ts");
  });

  test("a runtime read of the changed file selects the test", () => {
    // #484: an import and a `readFileSync(join(import.meta.dir, ...))` are
    // one question in two syntaxes. A graph that knows only imports reads
    // exactly like a graph that is satisfied.
    const root = dir();
    put(root, "gates/subject.ts", "export const subject = 1;\n");
    put(
      root,
      "test/reads.test.ts",
      'import { readFileSync } from "fs";\nimport { join } from "path";\n' +
        'const src = readFileSync(join(import.meta.dir, "..", "gates", "subject.ts"), "utf-8");\n' +
        'export const n = src.length;\n',
    );
    const r = affectedTests(root, ["gates/subject.ts"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/reads.test.ts");
  });

  test("a sweep over a directory is always selected, and says so", () => {
    // A test that walks a tree is affected by any change under it, and the
    // graph cannot express that. Excluding it would be the silent half of
    // this feature, so it is included unconditionally AND named.
    const root = chainProject();
    put(
      root,
      "test/sweep.test.ts",
      'import { readdirSync } from "fs";\nexport const all = readdirSync("test");\n',
    );
    const r = affectedTests(root, ["lib/deep.ts"]);
    expect(r.tests).toContain("test/sweep.test.ts");
    expect(r.sweeps, "a sweep included silently is indistinguishable from one the graph selected")
      .toContain("test/sweep.test.ts");
  });
});

describe("#676: what the graph cannot see is UNMEASURED, and the caller runs everything", () => {
  test("a non-TypeScript change refuses and names the file", () => {
    // Nothing imports a template, a rule file or a YAML. Tests reach them
    // with readFileSync against a path the graph has no reason to resolve.
    const root = chainProject();
    const r = affectedTests(root, ["lib/deep.ts", "templates/brief.md"]);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join("\n")).toContain("templates/brief.md");
  });

  test("an empty changed set is UNMEASURED, not an empty selection", () => {
    const root = chainProject();
    const r = affectedTests(root, []);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.length).toBeGreaterThan(0);
  });

  test("a tree with no test files is UNMEASURED, not a clean zero", () => {
    // #492's one-byte lesson: a walk that reached nothing reports the same
    // result as a walk that found nothing wrong.
    const root = dir();
    put(root, "lib/only.ts", "export const only = 1;\n");
    const r = affectedTests(root, ["lib/only.ts"]);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join("\n")).toMatch(/no test files/i);
  });

  test("an UNMEASURED reading carries no selection a caller could mistake for one", () => {
    // The conflation this issue exists to prevent: "nothing is affected" and
    // "I could not work out what is affected" must not render the same.
    //
    // The fixture carries a SWEEP deliberately. Without one, a mutant that
    // computed the selection and returned it under UNMEASURED anyway would
    // still produce `[]` here — nothing reaches an empty target set — and
    // this case would go green over the exact conflation it exists to
    // catch. The sweep is the one thing selected unconditionally, so it is
    // the only input on which "refused" and "computed, then refused" differ.
    const root = chainProject();
    put(root, "test/sweep.test.ts", 'import { readdirSync } from "fs";\nexport const all = readdirSync("test");\n');

    const unmeasured = affectedTests(root, []);
    const measuredButEmpty = affectedTests(root, ["lib/orphan.ts"]);

    expect(unmeasured.reading).toBe("UNMEASURED");
    expect(unmeasured.tests, "an UNMEASURED reading must not carry the sweep it would have selected")
      .toEqual([]);
    expect(unmeasured.sweeps).toEqual([]);

    expect(measuredButEmpty.reading).toBe("MEASURED");
    expect(measuredButEmpty.tests, "the sweep is still selected when the reading is real")
      .toEqual(["test/sweep.test.ts"]);

    expect(
      unmeasured.reading === measuredButEmpty.reading,
      "an unmeasured reading and a genuinely empty one are the same object",
    ).toBe(false);
  });
});

describe("#676: the reading reports its own coverage", () => {
  test("selected of seen is stated, so 1 of 3 and 3 of 3 are distinguishable", () => {
    // A scan that reports a verdict should report its own coverage —
    // `.claude/rules/checks-must-be-able-to-fail.md`. Without this, a
    // selection of one test and a selection of every test print the same.
    const root = chainProject();
    const r = affectedTests(root, ["lib/deep.ts"]);
    expect(r.testFilesSeen).toBe(2);
    expect(r.selected).toBe(r.tests.length);
    expect(r.selected).toBeLessThan(r.testFilesSeen);
  });
});
