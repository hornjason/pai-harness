/**
 * Covers SC-1684..SC-1689 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #307 SC-A19.
 *
 * A heal agent is told a gate failed and asked to make it pass. Deleting the
 * test is a correct solution to that instruction and an incorrect solution to
 * the problem, and nothing downstream can tell the two apart: a suite with
 * the failing test removed is green, and green is what it was asked for.
 *
 * Measured, which is why this exists at all. Run `wf_5cdce852-1e2`'s heal loop
 * went from 34 tests to 23 across two rounds — no `skip` recorded, no `todo`
 * recorded, three guards with nothing replacing them, and
 * `SECURITY_REVIEW_STALE` was the only thing that noticed, while looking at
 * something else. Those three guards are back (#314,
 * `test/adr-002-regression-guards.test.ts`); this is the mechanism that stops
 * the fourth.
 *
 * Every heal round ends in a gate re-run, so "since the last gate run" and
 * "across a heal" are the same window, and the comparison can live in
 * `gates/gate-executor.ts` where a test can execute it. `workflows/ship.js`
 * has no filesystem access and could only have asked an agent to check — a
 * guard whose subject is an agent's edits cannot be an instruction to an
 * agent.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { censusOf, censusRegressions, countTestDeclarations } from "../lib/test-census";
import { censusVerdict, nextCensus } from "../gates/gate-executor";

describe("#307: counting what a file declares", () => {
  test("SC-1684: skipped and todo tests are counted - converting one is removing it", () => {
    // The cheapest way past a guard that only counts live tests is to turn
    // the failing one into `test.todo`. The check is gone either way, so the
    // count must not move when a heal does that.
    const live = `test("a", () => {});\ntest("b", () => {});\n`;
    const parked = `test.todo("a");\ntest.skip("b", () => {});\n`;
    expect(countTestDeclarations(live)).toBe(2);
    expect(countTestDeclarations(parked)).toBe(2);
    // ...and commenting it out is removing it too, so comments are NOT
    // stripped before counting.
    expect(countTestDeclarations(`// test("a", () => {});\ntest("b", () => {});\n`)).toBe(2);
  });

  test("SC-1685: a word ending in test is not a test - the counter is anchored", () => {
    // A counter that matched `test(` anywhere would count `subtest(`,
    // `latest(`, and `obj.test(` — and an inflated count is not harmless
    // here in one direction: a file whose number is inflated by a rename
    // reads as having LOST tests when the rename is undone.
    expect(countTestDeclarations(`subtest("x", () => {});\n`)).toBe(0);
    expect(countTestDeclarations(`re.test(value);\n`)).toBe(0);
    expect(countTestDeclarations(`const latest = f();\n`)).toBe(0);
    // ...while the forms bun actually uses all count, in one assertion so
    // narrowing the pattern cannot quietly drop one.
    expect(
      countTestDeclarations(
        `test("a",0);it("b",0);test.each([1])("c",0);it.skip("d",0);test.failing("e",0);`,
      ),
    ).toBe(5);
  });

  test("SC-1686: a deleted file is a regression of its whole count", () => {
    // The obvious way past a per-file comparison. A loop over `after`'s keys
    // would never visit a file that is gone.
    expect(censusRegressions({ "test/a.test.ts": 4 }, {})).toEqual([
      "test/a.test.ts: the file declared 4 test(s) and is gone",
    ]);
    // A drop is named with both numbers — "a file lost tests" is not
    // something a reader can act on.
    expect(censusRegressions({ "test/a.test.ts": 4 }, { "test/a.test.ts": 1 })).toEqual([
      "test/a.test.ts: 4 test(s) before, 1 after",
    ]);
    // New files and rises are not regressions, which is the common case —
    // a guard that fired on ordinary work would be switched off.
    expect(censusRegressions({ "test/a.test.ts": 4 }, { "test/a.test.ts": 9, "test/b.test.ts": 2 })).toEqual([]);
  });

  test("SC-1687: the census reads real files on disk - and only test files", () => {
    // `censusRegressions` is pure and could be right over a census nobody
    // took. This is the arm that says the walk reaches a subdirectory and
    // stops at non-test sources.
    const root = mkdtempSync(join(tmpdir(), "rg-census-"));
    try {
      mkdirSync(join(root, "test", "unit"), { recursive: true });
      mkdirSync(join(root, "gates"), { recursive: true });
      writeFileSync(join(root, "test", "a.test.ts"), `test("a",0);test("b",0);`);
      writeFileSync(join(root, "test", "unit", "deep.test.ts"), `it("c",0);`);
      writeFileSync(join(root, "gates", "g.test.ts"), `test("d",0);`);
      // Not a test file, and full of the token the counter looks for.
      writeFileSync(join(root, "test", "helper.ts"), `test("x",0);test("y",0);test("z",0);`);

      expect(censusOf(root)).toEqual({
        "test/a.test.ts": 2,
        "test/unit/deep.test.ts": 1,
        "gates/g.test.ts": 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#307: what a gate run does about it", () => {
  test("SC-1688: the first reading of a run is not a pass", () => {
    // Nothing to compare is not the same as nothing was removed, and a
    // verdict that collapsed them would be the reading nobody took wearing
    // the answer's clothes.
    expect(censusVerdict(undefined, { "test/a.test.ts": 3 })).toEqual({ kind: "first-reading", files: 1 });
    expect(censusVerdict({}, { "test/a.test.ts": 3 })).toEqual({ kind: "first-reading", files: 1 });

    // ...and with something to compare, the two real answers are distinct.
    expect(censusVerdict({ "test/a.test.ts": 3 }, { "test/a.test.ts": 3 })).toEqual({
      kind: "no-regression",
      files: 1,
    });
    expect(censusVerdict({ "test/a.test.ts": 3 }, { "test/a.test.ts": 2 })).toEqual({
      kind: "regression",
      regressions: ["test/a.test.ts: 3 test(s) before, 2 after"],
    });
  });

  test("SC-1689: a refused round does not bank the reduced census", () => {
    // The guard you only have to get past once. Banking the tree the
    // deletion produced means the next round compares against it, finds no
    // regression, and the refusal clears itself — so the reading stays where
    // it was until the test comes back.
    const before = { "test/a.test.ts": 3 };
    const after = { "test/a.test.ts": 2 };
    const verdict = censusVerdict(before, after);

    expect(nextCensus(before, after, verdict)).toEqual(before);
    // Restoring the test clears it, so the refusal is not permanent — a
    // guard with no way out gets deleted rather than satisfied.
    const restored = { "test/a.test.ts": 3 };
    expect(nextCensus(before, restored, censusVerdict(before, restored))).toEqual(restored);
    // And an ordinary round banks what it saw, which is what makes the
    // comparison move forward at all.
    const grown = { "test/a.test.ts": 5 };
    expect(nextCensus(before, grown, censusVerdict(before, grown))).toEqual(grown);
  });

  test("this repo's own census is substantial - the walk is not reading nothing", () => {
    // Every assertion above runs over hand-written objects or a four-file
    // fixture. An empty census compares clean against an empty census, so
    // the one thing none of them can catch is a walk that stopped finding
    // this project's tests.
    const real = censusOf(join(import.meta.dir, ".."));
    expect(Object.keys(real).length, "the census found suspiciously few test files").toBeGreaterThan(250);
    expect(real["test/test-census.test.ts"], "the census cannot see this file").toBeGreaterThan(5);
    expect(Object.values(real).reduce((a, b) => a + b, 0)).toBeGreaterThan(5000);
  });
});
