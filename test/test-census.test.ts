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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  censusOf,
  censusRegressions,
  countTestDeclarations,
  MAX_CENSUS_FILE_BYTES,
} from "../lib/test-census";
import {
  censusVerdict,
  nextCensus,
  persistTestCensus,
  readPersistedCensus,
} from "../gates/gate-executor";

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

  test("SC-1690: a consumer that keeps tests beside its sources is censused too", () => {
    // Found by review. The walk was a fixed `["test", "gates"]` — rungate's
    // own layout — so `src/foo.test.ts`, the commonest JavaScript convention
    // there is, censused to `{}`. An empty census compares clean against an
    // empty census on every round, so the guard would have been permanently
    // and silently dead for exactly the consumers it exists to protect.
    const root = mkdtempSync(join(tmpdir(), "rg-census-src-"));
    try {
      mkdirSync(join(root, "src", "widgets"), { recursive: true });
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "src", "a.test.ts"), `test("a",0);`);
      writeFileSync(join(root, "src", "widgets", "b.spec.tsx"), `it("b",0);it("c",0);`);
      writeFileSync(join(root, "src", "c.test.js"), `test("d",0);`);
      // A dependency's own suite is not this project's, and build output is
      // a copy — counting either would make an `npm install` or a rebuild
      // read as tests appearing and disappearing.
      writeFileSync(join(root, "node_modules", "dep", "x.test.ts"), `test("no",0);`);
      writeFileSync(join(root, "dist", "y.test.js"), `test("no",0);`);

      expect(censusOf(root)).toEqual({
        "src/a.test.ts": 1,
        "src/c.test.js": 1,
        "src/widgets/b.spec.tsx": 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1696: a file too large to be a suite is skipped - and a symlink is never read", () => {
    // Found by review. Unbounded `readFileSync` over every matching name on
    // every gate run is a cost with nothing behind it, and a symlink named
    // `x.test.ts` pointing at a character device has size 0 and never ends.
    //
    // Skipping the oversized file is safe because the cap is STABLE: it is
    // absent from both censuses and so never reads as a deletion. The one
    // case that refuses falsely is a file crossing the cap between rounds,
    // which is loudly wrong and names the file.
    const root = mkdtempSync(join(tmpdir(), "rg-census-big-"));
    try {
      writeFileSync(join(root, "small.test.ts"), `test("a",0);`);
      writeFileSync(
        join(root, "huge.test.ts"),
        `test("x",0);`.repeat(1) + "/*" + "y".repeat(MAX_CENSUS_FILE_BYTES) + "*/",
      );
      // `isFile()` is false for a dirent that is a symlink, in both
      // directions — no followed directory loop, and no followed file.
      symlinkSync(join(root, "small.test.ts"), join(root, "link.test.ts"));
      mkdirSync(join(root, "real"), { recursive: true });
      writeFileSync(join(root, "real", "r.test.ts"), `it("b",0);`);
      symlinkSync(join(root, "real"), join(root, "loop"));

      const skipped: string[] = [];
      expect(censusOf(root, skipped)).toEqual({
        "small.test.ts": 1,
        "real/r.test.ts": 1,
      });
      // Named, not dropped. A file silently outside the comparison is the
      // shape this whole guard exists to refuse, so the skip is reportable
      // and the gate warns with the list.
      expect(skipped).toEqual(["huge.test.ts"]);
      // The symlinks are not in the skip list either — they were never
      // candidates, which is a different fact from being too large.
      expect(skipped).not.toContain("link.test.ts");
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

  test("SC-1691: a tree with no test file the walk can see is UNMEASURED - not clean", () => {
    // Found by review, and it is the arm that keeps this guard alive on a
    // project that is not this one. A pytest or `go test` consumer censuses
    // to `{}`; `{}` compares clean against `{}` on every subsequent round,
    // so without this the guard is dead and indistinguishable from a guard
    // that keeps finding nothing wrong.
    const v = censusVerdict({ "test/a.test.ts": 3 }, {});
    expect(v.kind).toBe("unmeasured");
    if (v.kind !== "unmeasured") throw new Error("unreachable");
    expect(v.reason).toContain("could not be seen");

    // An empty tree on the FIRST round too — `{}` against `undefined` must
    // not slip through as `first-reading`, which reads as ordinary.
    expect(censusVerdict(undefined, {}).kind).toBe("unmeasured");
  });

  test("SC-1692: an unmeasured round keeps the previous reading - no amnesia", () => {
    // Banking `{}` over a real census would turn a tree the walk briefly
    // could not read into permanent amnesia, and the round after it would
    // compare clean against nothing.
    //
    // The verdict is BUILT here rather than produced by `censusVerdict`,
    // and that is not stylistic. A mutation battery caught the two arms of
    // `nextCensus` agreeing: today the only way to be `unmeasured` is an
    // empty census, and an empty census ALSO makes every previously-known
    // file "gone", so `censusVerdict(before, {})` short-circuits to
    // `unmeasured` but would fall through to `regression` — which
    // `nextCensus` treats identically. Routing this case through
    // `censusVerdict` therefore tested the regression arm while claiming to
    // test the unmeasured one, and disabling the unmeasured branch left it
    // green.
    //
    // A literal verdict with a NON-empty current census is an input only
    // the unmeasured arm can reach (`.claude/rules/checks-must-be-able-to-fail.md`,
    // fourth shape: keep both deciders and give each an input only it
    // reaches, written down as a separate case saying which decider it is
    // for).
    const before = { "test/a.test.ts": 3 };
    const grown = { "test/a.test.ts": 3, "test/b.test.ts": 2 };
    expect(
      nextCensus(before, grown, { kind: "unmeasured", reason: "the walk could not read the tree" }),
      "an unmeasured round banked a reading it did not trust",
    ).toEqual(before);

    // The arm the two deciders share, kept as a case in its own right: the
    // empty census that arrives through `censusVerdict` must also keep the
    // previous reading, whichever of the two branches answers it.
    expect(nextCensus(before, {}, censusVerdict(before, {}))).toEqual(before);
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

  test("SC-1694: the banked census reaches the state FILE - and clobbers nothing", () => {
    // Found by review, and without it the guard was permanently dead.
    // `writeGateResult` does its own `readState(sf)` and writes THAT back,
    // so setting `state.gateContract.testCensus` in memory reaches disk only
    // by accident — and did not. Every subsequent run would have found no
    // census, answered `first-reading`, logged a reassuring line, and
    // compared nothing, forever.
    const dir = mkdtempSync(join(tmpdir(), "rg-persist-"));
    try {
      const sf = join(dir, "workflow-state.json");
      // Other keys, including a sibling under gateContract, because the gate
      // tests and any heal agent have been writing to this file since the
      // process loaded its copy. A whole-state write would lose their edits.
      writeFileSync(
        sf,
        JSON.stringify({
          slug: "x",
          acs: [{ id: "AC-1" }],
          gateContract: { baselines: { testBaseline: 3 }, environments: { local: "PASS" } },
        }),
      );

      persistTestCensus(sf, { "test/a.test.ts": 7 });

      const after = JSON.parse(readFileSync(sf, "utf-8"));
      expect(after.gateContract.testCensus).toEqual({ "test/a.test.ts": 7 });
      expect(after.gateContract.baselines, "a sibling under gateContract was lost").toEqual({
        testBaseline: 3,
      });
      expect(after.gateContract.environments).toEqual({ local: "PASS" });
      expect(after.acs, "unrelated state was lost").toEqual([{ id: "AC-1" }]);

      // Written in a form the next run can read back, which is the whole
      // point — a census persisted as `[object Object]` would compare clean
      // against everything.
      expect(censusVerdict(after.gateContract.testCensus, { "test/a.test.ts": 4 })).toEqual({
        kind: "regression",
        regressions: ["test/a.test.ts: 7 test(s) before, 4 after"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1697: the previous census is read off disk - not off a stale in-memory copy", () => {
    // Found by the third review pass. `state` is loaded when the process
    // starts; the gate tests and any heal agent write the file afterwards.
    // Comparing against the stale copy and then persisting over the fresh
    // one is how a round's reading quietly disappears, and the direction it
    // disappears in is toward not refusing.
    const dir = mkdtempSync(join(tmpdir(), "rg-stale-"));
    try {
      const sf = join(dir, "workflow-state.json");
      writeFileSync(sf, JSON.stringify({ gateContract: { testCensus: { "a.test.ts": 9 } } }));
      expect(readPersistedCensus(sf)).toEqual({ "a.test.ts": 9 });

      // The three shapes that must read as "nothing banked" rather than as
      // a census — each would otherwise reach `censusRegressions` and
      // compare against nonsense.
      writeFileSync(sf, JSON.stringify({ gateContract: {} }));
      expect(readPersistedCensus(sf)).toBeUndefined();
      writeFileSync(sf, JSON.stringify({ gateContract: { testCensus: [] } }));
      expect(readPersistedCensus(sf), "an array was accepted as a census").toBeUndefined();
      writeFileSync(sf, "{ not json");
      expect(readPersistedCensus(sf)).toBeUndefined();
      expect(readPersistedCensus(join(dir, "nope.json"))).toBeUndefined();

      // ...and `undefined` becomes first-reading, which is reported rather
      // than passed quietly. The catch above is the one place this guard
      // swallows an error, so the thing it hands on must not read as clean.
      expect(censusVerdict(readPersistedCensus(sf), { "a.test.ts": 1 }).kind).toBe("first-reading");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1695: the census block persists before writeGateResult re-reads the file", () => {
    // The ordering half of SC-1694. The write landing in the right shape is
    // worth nothing if it happens after the read that discards it.
    const src = readFileSync(join(import.meta.dir, "..", "gates", "gate-executor.ts"), "utf-8");
    const persist = src.indexOf("persistTestCensus(sf,");
    const writeResult = src.indexOf("writeGateResult(sf, gate,");

    expect(persist, "the census is no longer persisted").toBeGreaterThan(-1);
    expect(writeResult, "writeGateResult's call site moved — move this guard with it").toBeGreaterThan(-1);
    expect(persist, "the census is persisted after writeGateResult re-reads the file").toBeLessThan(writeResult);
  });

  test("SC-1693: the census refusal is counted after the baseline subtraction - not before", () => {
    // Found by review, and it was a live fail-open. The census `fails++` was
    // written ABOVE the verify gate's `subtractTestBaseline`, which cannot
    // tell a census refusal from a suite failure — so a run carrying three
    // pre-existing failures would have had the deleted-test refusal
    // subtracted to zero. A baseline is a statement about the SUITE and can
    // say nothing about whether a heal round removed a test.
    //
    // Ordering is not something a pure decider can express, so this is a
    // source-position assertion, the same shape as the `if (rebuildCmd)`
    // enclosure guard in test/adr-002-regression-guards.test.ts.
    const src = readFileSync(join(import.meta.dir, "..", "gates", "gate-executor.ts"), "utf-8");
    const subtraction = src.indexOf("Subtract test baseline at verify gate");
    const census = src.indexOf("Did a heal round delete a test?");
    const report = src.indexOf("`\\nTest results: ${passes} pass");

    expect(subtraction, "the baseline subtraction block is gone").toBeGreaterThan(-1);
    expect(census, "the census block is gone").toBeGreaterThan(-1);
    expect(report, "the results line is gone — if it moved, move this guard with it").toBeGreaterThan(-1);
    expect(
      census,
      "the census refusal is counted before the baseline subtraction, which can erase it",
    ).toBeGreaterThan(subtraction);
    // ...and still before anything reports the counts, or the refusal would
    // be added after the number a human reads.
    expect(census, "the census runs after the results are already reported").toBeLessThan(report);
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
