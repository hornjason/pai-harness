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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "fs";
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
  // Present in the tree, imported by nothing. The genuinely-empty selection
  // has to come from a file the walk SAW, because a file it never saw is
  // now UNMEASURED — those are different answers and conflating them is
  // the defect this module exists to prevent.
  put(root, "lib/isolated.ts", "export const isolated = 1;\n");
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

  test("a module-relative read behind ONE const of indirection is still an edge", () => {
    // #484's shape, found by dogfooding this branch against itself. The
    // graph saw `join(import.meta.dir, ...)` and nothing else, so a single
    // const hid the read:
    //
    //   const REPO_ROOT = join(import.meta.dir, "..");
    //   readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8")
    //
    // Two real harnesses in this repository reach ship.js exactly that way
    // and both were silently unselected by a change to it. Resolving the
    // const means evaluating the module, so the quoted basename in code is
    // the edge instead — broader than the read, which is the safe side.
    const root = chainProject();
    put(root, "workflows/subject.js", "// not importable\n");
    put(
      root,
      "test/indirect-read.test.ts",
      'import { readFileSync } from "fs";\nimport { join } from "path";\n' +
        'const REPO_ROOT = join(import.meta.dir, "..");\n' +
        'export const n = readFileSync(join(REPO_ROOT, "workflows", "subject.js"), "utf-8").length;\n',
    );

    const r = affectedTests(root, ["workflows/subject.js"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/indirect-read.test.ts");
  });

  test("a resolvable read keeps its precision: a same-named file elsewhere is not an edge", () => {
    // The input only `runtimeReads` can reach, and the reason this module
    // has two deciders rather than one. Measured before this case existed:
    // deleting the `runtimeReads` call was 0 red and moved the real
    // selection by 0 files, because a resolvable read always quotes its own
    // basename — so the broad rule was silently answering for both. Every
    // fixture here had a unique basename, which is the one precondition
    // that makes the difference invisible (#492).
    const root = chainProject();
    put(root, "gates/a/config.ts", "export const a = 1;\n");
    put(root, "gates/b/config.ts", "export const b = 1;\n");
    put(
      root,
      "test/precise.test.ts",
      'import { readFileSync } from "fs";\nimport { join } from "path";\n' +
        'export const n = readFileSync(join(import.meta.dir, "..", "gates", "a", "config.ts"), "utf-8").length;\n',
    );

    const toA = affectedTests(root, ["gates/a/config.ts"]);
    expect(toA.tests, "the file it actually reads").toContain("test/precise.test.ts");

    const toB = affectedTests(root, ["gates/b/config.ts"]);
    expect(
      toB.tests,
      "a file that has shown it can name this basename precisely is not selected by a namesake",
    ).not.toContain("test/precise.test.ts");
  });

  test("a basename named only in a COMMENT is not an edge", () => {
    // The over-selection this buys has to stop somewhere, and the comment
    // strip is where. Without this the rule would select every file that
    // merely discusses the changed one, which on this repository is most
    // of them.
    const root = chainProject();
    put(root, "lib/subject.ts", "export const subject = 1;\n");
    put(
      root,
      "test/mentions.test.ts",
      '// This one is about "subject.ts" but never reads it.\n' +
        'import { test } from "bun:test";\ntest("unrelated", () => {});\n',
    );

    const r = affectedTests(root, ["lib/subject.ts"]);
    expect(r.tests).not.toContain("test/mentions.test.ts");
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
  test("a non-module change nothing in the tree names refuses, and names the file", () => {
    // Nothing imports a template, a rule file or a YAML, so the only thing
    // that can reach one is a file that writes its path down. When none
    // does, the reader — if there is one — is building the path at runtime
    // and the graph cannot see it, which is a refusal and not a clean zero.
    const root = chainProject();
    const r = affectedTests(root, ["lib/deep.ts", "templates/brief.md"]);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join("\n")).toContain("templates/brief.md");
  });

  test("a non-module change IS measured when a test names its path", () => {
    // The measurement that forced this: across eight real commits of this
    // repository, seven carried at least one non-module file, and the
    // blanket refusal above made the whole feature inert on them. A rule
    // file a test reads by name is reachable — and the test that reads it
    // is what has to run.
    const root = chainProject();
    put(root, ".claude/rules/some-rule.md", "# a rule\n");
    put(
      root,
      "test/rule.test.ts",
      'import { readFileSync } from "fs";\n' +
        'export const n = readFileSync(".claude/rules/some-rule.md", "utf-8").length;\n',
    );

    const r = affectedTests(root, [".claude/rules/some-rule.md"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toEqual(["test/rule.test.ts"]);
  });

  test("a test that only CITES a rule file in a comment is not selected by it", () => {
    // The measurement that forced the comment strip, and the case without
    // which nothing witnesses it: matching raw source,
    // `.claude/rules/checks-must-be-able-to-fail.md` selected 322 of 388
    // files here, because this repository cites that file in docstrings
    // everywhere. A citation is not a read — the same distinction
    // `.claude/rules/claiming-sc-coverage.md` draws for SC ids, in the
    // position where getting it wrong costs the whole saving.
    const root = chainProject();
    put(root, ".claude/rules/cited.md", "# a much-cited rule\n");
    put(
      root,
      "test/reader.test.ts",
      'import { readFileSync } from "fs";\n' +
        'export const n = readFileSync(".claude/rules/cited.md", "utf-8").length;\n',
    );
    put(
      root,
      "test/citer.test.ts",
      "// The direction of error here is argued in .claude/rules/cited.md,\n" +
        "/* and again in .claude/rules/cited.md for good measure. */\n" +
        'import { test } from "bun:test";\ntest("unrelated", () => {});\n',
    );

    const r = affectedTests(root, [".claude/rules/cited.md"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/reader.test.ts");
    expect(r.tests, "a citation in a comment is not a read, and selecting on it costs the saving")
      .not.toContain("test/citer.test.ts");
  });

  test("a non-module change reaches a test THROUGH the helper that names it", () => {
    // The textual edge is an edge like any other, so it composes with the
    // import graph rather than sitting beside it. The test never names the
    // rule file, which is what the filename-grep method cannot do.
    const root = chainProject();
    put(root, ".claude/rules/other.md", "# another rule\n");
    put(
      root,
      "lib/rule-reader.ts",
      'import { readFileSync } from "fs";\n' +
        'export const read = () => readFileSync(".claude/rules/other.md", "utf-8");\n',
    );
    put(
      root,
      "test/indirect.test.ts",
      'import { read } from "../lib/rule-reader";\nimport { test, expect } from "bun:test";\n' +
        'test("reads", () => { expect(read()).toBeDefined(); });\n',
    );
    const source = readFileSync(join(root, "test/indirect.test.ts"), "utf-8");
    expect(source, "the fixture must not name the rule file, or grep would also find it")
      .not.toContain("other.md");

    const r = affectedTests(root, [".claude/rules/other.md"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/indirect.test.ts");
  });

  test("an empty changed set is UNMEASURED, not an empty selection", () => {
    const root = chainProject();
    const r = affectedTests(root, []);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.length).toBeGreaterThan(0);
  });

  test("a changed file outside the walked tree is UNMEASURED, not unaffected", () => {
    // The finding that nearly shipped. `workflows/ship.js` passes the
    // extension check, so it was never refused — and `workflows` was not
    // walked, so nothing could have an edge to it, so every test came back
    // unaffected and the reading said MEASURED. Silent under-selection on
    // the most-changed file in the repository.
    //
    // `workflows` is in SCAN_DIRS now, so this case uses a directory that
    // is deliberately not walked, which is what keeps it witnessing after
    // the list changes.
    const root = chainProject();
    put(root, "vendor/thing.ts", "export const thing = 1;\n");

    const r = affectedTests(root, ["vendor/thing.ts"]);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join("\n")).toContain("vendor/thing.ts");
  });

  test("a change to workflows/ is now in the graph rather than silently empty", () => {
    const root = chainProject();
    put(root, "workflows/ship.js", "// a workflow script, which cannot be imported (#69)\n");
    put(
      root,
      "test/reads-workflow.test.ts",
      'import { readFileSync } from "fs";\nimport { join } from "path";\n' +
        'export const n = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8").length;\n',
    );
    const r = affectedTests(root, ["workflows/ship.js"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toContain("test/reads-workflow.test.ts");
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
    const measuredButEmpty = affectedTests(root, ["lib/isolated.ts"]);

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

describe("#676: the walk terminates on shapes a real repository has", () => {
  test("an import cycle does not hide a test that reaches the change through it", () => {
    // The first draft walked FORWARD from each test with a memo, which is
    // unsound here in a way that is hard to see: a `false` computed while a
    // cycle edge was cut gets cached and a later query reads it. Walking
    // dependents outward removes the interaction rather than guarding it,
    // so the thing to assert is that a cycle neither hangs nor drops a test.
    const root = dir();
    put(root, "lib/a.ts", 'import { b } from "./b";\nexport const a = () => b;\n');
    put(root, "lib/b.ts", 'import { a } from "./a";\nexport const b = 1;\nexport const useA = a;\n');
    put(
      root,
      "test/cycle.test.ts",
      'import { a } from "../lib/a";\nimport { test, expect } from "bun:test";\n' +
        'test("a", () => { expect(a).toBeDefined(); });\n',
    );

    const viaA = affectedTests(root, ["lib/a.ts"]);
    expect(viaA.reading).toBe("MEASURED");
    expect(viaA.tests).toContain("test/cycle.test.ts");

    // The far side of the cycle — the test never names `b`, and reaching it
    // means traversing the edge that closes the loop.
    const source = readFileSync(join(root, "test/cycle.test.ts"), "utf-8");
    expect(source, "the fixture must not name the far side, or grep would also find it")
      .not.toContain('"../lib/b"');
    const viaB = affectedTests(root, ["lib/b.ts"]);
    expect(viaB.tests).toContain("test/cycle.test.ts");
  });

  test("a symlink loop terminates, and a link out of the tree is declined", () => {
    // `readdirSync(withFileTypes)` reports a symlink as not-a-directory, so
    // a monorepo whose packages are linked into place is invisible without
    // a statSync (#500) — and following them is what makes a loop possible.
    const root = dir();
    put(root, "lib/real.ts", "export const real = 1;\n");
    put(
      root,
      "test/link.test.ts",
      'import { real } from "../lib/real";\nimport { test, expect } from "bun:test";\n' +
        'test("real", () => { expect(real).toBe(1); });\n',
    );
    symlinkSync(join(root, "lib"), join(root, "lib/loop"));

    const outside = dir();
    put(outside, "secret.ts", "export const secret = 1;\n");
    symlinkSync(outside, join(root, "lib/escape"));

    const r = affectedTests(root, ["lib/real.ts"]);
    expect(r.reading).toBe("MEASURED");
    expect(r.tests).toEqual(["test/link.test.ts"]);
    // Nothing from outside the root is in the graph, so nothing outside it
    // can be selected or reported as seen.
    expect(r.testFilesSeen).toBe(1);
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
