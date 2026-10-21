/**
 * One binding decides what a test declaration is (#883).
 *
 * Two bindings used to. `lib/test-census.ts` had its own `DECLARATION`
 * expression and `gates/gate-executor.ts` refused a round on ITS count, while
 * the deletion reading named cases from `lib/test-case-bodies.ts`. Measured
 * 2026-10-21, before the change:
 *
 *     files=483  countTestDeclarations total=8040  caseNames total=7597
 *     DISAGREE on 174 of 483 files
 *
 * An operator handed *"30 test(s) before, 27 after"* beside a list of 8 case
 * names could not reconcile them, because the two numbers came from different
 * instruments. `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape
 * with the two deciders giving DIFFERENT answers rather than the same one.
 *
 * Classifying 275 of the 443 extra matches the census counted: 153 the word
 * *test* before a backtick in prose, 50 real `test.each([…])` declarations the
 * case reader could not see, 47 the word *it* in prose before a paren, 20
 * `test(s)` in a message, 5 `test()` in prose. So ~225 of 275 were the census
 * counting PROSE and 50 were a real form it alone could see.
 *
 * ## Why the inflation was not harmless, which is what the old docblock said
 *
 * "Only a DECREASE is refused" is true and does not make inflation safe,
 * because the inflation MOVES. Deleting three occurrences of `test(` from
 * prose in one file dropped that file's census by three with no test touched,
 * and `censusReport` refused the round naming a file whose coverage had not
 * changed.
 *
 * ## The comment policy was backwards, and this file is where that is pinned
 *
 * The old docblock read *"Comments are NOT stripped. A commented-out test is
 * a removed test, and stripping would make 'comment the block out' a way past
 * the guard."* The second clause is inverted. Only a decrease is refused, so
 * COUNTING the commented-out test is what let it through — measured on the
 * pre-#883 reader, `// test("a", …)` counted 1, identical to the live form.
 * AC-5 is the case.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * The first round after the reader changes compares an old number against a
 * new one, and every file whose count moved reads as a deleted test. **The
 * 5pm repair is to make `censusRegressions` ignore a drop below some
 * threshold**, or to clear the banked census on upgrade. Both make the red go
 * away; the first blinds the guard permanently to small real deletions, and
 * the second is indistinguishable from the erasure #494 exists to catch.
 *
 * The repair here is a reader stamp: a census taken by another instrument is
 * UNMEASURED, and the round banks a fresh reading so the NEXT one compares.
 * AC-9 is the case, and AC-10 is the half that makes the migration end — a
 * verdict that held the old reading would leave every subsequent round
 * unmeasured forever.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { caseDeclarations, testDeclarations } from "../../lib/test-case-bodies";
import { caseNames } from "../../lib/test-case-deletion";
import {
  TEST_CENSUS_READER,
  censusOf,
  censusRegressions,
  countTestDeclarations,
} from "../../lib/test-census";
import {
  censusReport,
  censusVerdict,
  nextCensus,
  persistTestCensus,
  readPersistedCensus,
  verifiedCensus,
} from "../../gates/gate-executor";

const REPO = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-883-"));
  scratch.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const at = join(root, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
  }
  return root;
}

/** The pre-#883 census expression, kept as the thing being compared against. */
const OLD_DECLARATION =
  /(?<![.\w$])(?:test|it)(?:\.(?:skip|todo|only|failing|each|skipIf|todoIf|only))?\s*[(`]/g;
const oldCount = (src: string) => [...src.matchAll(OLD_DECLARATION)].length;

describe("#883: one binding", () => {
  test("AC-1: countTestDeclarations and caseNames are projections of the same reading", () => {
    // Not a tautology dressed as a check: it asserts the SHAPE the one
    // binding buys — the count is the length of the list, and every name is
    // one of that list's entries, in order. A census that grew its own
    // expression again would satisfy neither.
    const src = readFileSync(join(REPO, "test", "test-census.test.ts"), "utf-8");
    const all = testDeclarations(src);
    expect(all.length).toBeGreaterThan(5);
    expect(countTestDeclarations(src)).toBe(all.length);
    const named = all.map(d => d.name).filter((n): n is string => n !== null);
    expect(caseNames(src)).toEqual(named);
    expect(caseDeclarations(src).length).toBeLessThanOrEqual(all.length);
  });

  test("AC-2: lib/test-census.ts declares no declaration pattern of its own", () => {
    // The structural half, and the one that goes red if somebody reintroduces
    // the second decider. A behavioural test cannot see it: a second
    // expression that agrees with the first is invisible until the day it
    // does not.
    const census = readFileSync(join(REPO, "lib", "test-census.ts"), "utf-8");
    const code = census.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // The function body, exactly. A pattern scan alone is a detector
    // narrower than what it detects — a second decider written with
    // `indexOf` or a `split` carries no regex at all — so the binding's
    // whole implementation is the assertion, and it is one call.
    const body = code.match(
      /export function countTestDeclarations\(source: string\): number \{\n([\s\S]*?)\n\}/,
    )?.[1];
    expect(body, "countTestDeclarations was not found in lib/test-census.ts").toBeDefined();
    expect(
      body!.trim(),
      "the census must not decide what a test declaration is — testDeclarations in " +
        "lib/test-case-bodies.ts is the one binding (#883)",
    ).toBe("return testDeclarations(source).length;");

    // …and the pattern scan beside it, narrowed to the declaration
    // ALTERNATION rather than the word `test`. `TEST_FILE` is a filename
    // matcher and must not be reported: a check that fires on it is one
    // somebody silences rather than reads.
    const patterns = [...code.matchAll(/\/[^\n/][^\n]*\/[gimsuy]*/g)]
      .map(m => m[0])
      .filter(p => /test\|it|it\|test/.test(p));
    expect(patterns).toEqual([]);
    expect(census, "the census no longer reads the one binding").toContain("testDeclarations");
  });

  test("AC-3: every file in this tree agrees, and the two totals are real", () => {
    // The live-tree control. `named <= counted` is the invariant the
    // projection guarantees; the floors are what stop it holding vacuously
    // over an empty walk (#637 — a count is the proxy, non-emptiness is the
    // property).
    const census = censusOf(REPO);
    const files = Object.keys(census);
    expect(files.length).toBeGreaterThan(300);
    let counted = 0;
    let named = 0;
    const disagree: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(REPO, f), "utf-8");
      const all = testDeclarations(src);
      if (all.length !== census[f]) disagree.push(f);
      counted += all.length;
      named += caseDeclarations(src).length;
    }
    expect(disagree).toEqual([]);
    expect(counted).toBeGreaterThan(5000);
    expect(named).toBeGreaterThan(5000);
    expect(named).toBeLessThanOrEqual(counted);
  });
});

describe("#883: what is and is not a declaration", () => {
  test("AC-4: test.each is a declaration with no name, and BOTH readings say so", () => {
    // 50 of these on this tree. The census saw them and the case reader did
    // not, which is half of the 174-file disagreement.
    const src = `test.each([[1],[2]])("adds %i", n => { expect(n).toBeGreaterThan(0); });\n`;
    expect(countTestDeclarations(src)).toBe(1);
    expect(testDeclarations(src).map(d => d.name)).toEqual([null]);
    // Not a CASE: a rename pairs on a name and a deletion is reported by one,
    // and this declaration has neither.
    expect(caseNames(src)).toEqual([]);
  });

  test("AC-5: a commented-out test makes the count DROP", () => {
    // The inverted policy, pinned. Before #883 both of these counted 1 and
    // the round that commented the test out was clean.
    const live = `test("a", () => { expect(1).toBe(1); });\n`;
    expect(countTestDeclarations(live)).toBe(1);
    expect(countTestDeclarations(`// ${live}`)).toBe(0);
    expect(countTestDeclarations(`/* ${live} */`)).toBe(0);
    expect(oldCount(`// ${live}`), "the pre-#883 reader counted the commented-out form").toBe(1);
    // …and the guard now refuses it, which is the point of the drop.
    expect(
      censusRegressions({ "a.test.ts": 1 }, { "a.test.ts": 0 }),
    ).toEqual(["a.test.ts: 1 test(s) before, 0 after"]);
  });

  test("AC-6: the word test or it in prose, a string or a regex counts for NEITHER", () => {
    // ~225 of the old reader's 443 extra matches on this tree, by kind.
    const prose = [
      "const GATE = 'test(\"a free port passes\", 0)';", // a string constant
      "// the it (#669) case",                             // prose in a comment
      "const msg = `${n} test(s) collected`;",            // a template
      "const RX = /test\\(/g;",                            // a regex
      "/** mentions test() there in good faith */",       // a block comment
    ].join("\n");
    expect(countTestDeclarations(prose)).toBe(0);
    expect(caseNames(prose)).toEqual([]);
    expect(oldCount(prose), "the pre-#883 reader counted these").toBeGreaterThan(0);
  });

  test("AC-7: a backtick after the word test is not a declaration — by two guards", () => {
    // 153 of the 443, and they are NOT all stopped by the same thing. Two
    // guards, each with an input only it reaches
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape's
    // second remedy) — without the split, restoring the old `[(`]`
    // alternative would be 0 red and read as a collapsed pair.
    //
    // Only `literalSpans` reaches this one: the word sits INSIDE a template,
    // so no anchor change can see it either way.
    const inTemplate = "const s = html`<p>test` + `x`;\n";
    expect(countTestDeclarations(inTemplate)).toBe(0);
    expect(oldCount(inTemplate)).toBeGreaterThan(0);

    // Only the open-paren requirement reaches this one: a tagged template
    // named `test` is at the top level, so `literalSpans` marks the backtick
    // and after, not the word before it.
    const tagged = "const t = test`x`;\n";
    expect(countTestDeclarations(tagged)).toBe(0);
    expect(oldCount(tagged)).toBe(1);
  });

  test("AC-8: the forms bun does have all still count, in one assertion", () => {
    // Narrowing the pattern is the change most likely to buy agreement with
    // blindness, so the whole family is asserted together.
    const src =
      `test("a",0);it("b",0);test.each([1])("c",0);it.skip("d",0);test.failing("e",0);` +
      `test.todo("f");it.only("g",0);test.runIf(1)("h",0);`;
    expect(countTestDeclarations(src)).toBe(8);
    // Six names from eight declarations. `.each` and `.runIf` take their
    // first argument before the title — the table, the condition — so the
    // title is in a SECOND call and there is no name at this one. They are
    // declarations with a `null` name, which is what AC-4 is about.
    expect(caseNames(src)).toEqual(["a", "b", "d", "e", "f", "g"]);
  });

  test("AC-8b: the condition-first family counts, and names nothing — as before", () => {
    // `skipIf`, `todoIf` and `runIf` take a condition and return the
    // declarer, so the title sits in the second call. Stated as its own case
    // because it is the one place the broadened anchor changes what the CASE
    // reader sees, and the answer is "nothing": these were invisible to it
    // before #883 too, so no rename or deletion reading moves. What DOES
    // change is that they are now counted, which they were before only
    // because the census had its own expression.
    const src = `test.skipIf(1)("a",0);test.todoIf(0)("b",0);test.runIf(1)("c",0);`;
    expect(countTestDeclarations(src)).toBe(3);
    expect(testDeclarations(src).map(d => d.modifier)).toEqual([".skipIf", ".todoIf", ".runIf"]);
    expect(caseNames(src)).toEqual([]);
  });
});

describe("#883: a census from another reader is not comparable", () => {
  /** A state file carrying a census banked by `reader`, correctly signed. */
  function bankedAs(reader: string | null, census: Record<string, number>) {
    const root = project({ "workflow-state.json": "{}" });
    const sf = join(root, "workflow-state.json");
    persistTestCensus(sf, census, "slug-883");
    const on = JSON.parse(readFileSync(sf, "utf-8"));
    if (reader === null) delete on.gateContract.testCensusReader;
    else on.gateContract.testCensusReader = reader;
    writeFileSync(sf, JSON.stringify(on, null, 2));
    return sf;
  }

  test("AC-9: an unstamped banked census is UNMEASURED, not a regression", () => {
    // The migration. A pre-#883 census counted prose, so almost every file's
    // number drops — which is exactly what a deleted test looks like.
    const sf = bankedAs(null, { "a.test.ts": 40 });
    const previous = readPersistedCensus(sf, "slug-883");
    expect(previous.kind).toBe("stale-reader");

    const verdict = censusVerdict(previous, { "a.test.ts": 37 }, { kind: "ran", witnesses: 3 });
    expect(verdict.kind).toBe("reader-changed");
    // The two things it must not be: a refusal, and a silent pass.
    const report = censusReport(verdict, "/tmp/tree");
    expect(report.fails).toBe(0);
    expect(report.warns).toBe(1);
    expect(report.results[0]!.result).toBe("WARN");
    expect(report.results[0]!.detail).toContain("reader");
    expect(report.results[0]!.check).toContain("UNMEASURED");
  });

  test("AC-10: the migration ENDS — a reader change banks the fresh reading", () => {
    // Without this the old number stays banked, every subsequent round is
    // UNMEASURED, and the guard is off forever while reporting a warning
    // nobody can clear. Pairs with the regression arm, which must NOT bank.
    const stale = { "a.test.ts": 40 };
    const fresh = { "a.test.ts": 37 };
    const changed = censusVerdict(
      readPersistedCensus(bankedAs(null, stale), "slug-883"),
      fresh,
      { kind: "ran", witnesses: 3 },
    );
    expect(nextCensus(stale, fresh, changed)).toEqual(fresh);
    expect(
      nextCensus(stale, fresh, { kind: "regression", regressions: ["a.test.ts: 40 before, 37 after"] }),
      "a regression must still hold the previous reading",
    ).toEqual(stale);
  });

  test("AC-11: a census from THIS reader still compares, and still refuses a drop", () => {
    // The control. Every assertion above is satisfied by a gate that reports
    // reader-changed for everything, which would switch the guard off.
    const sf = bankedAs(TEST_CENSUS_READER, { "a.test.ts": 40 });
    const previous = readPersistedCensus(sf, "slug-883");
    expect(previous.kind).toBe("verified");
    expect(verifiedCensus(previous)).toEqual({ "a.test.ts": 40 });

    const verdict = censusVerdict(previous, { "a.test.ts": 37 }, { kind: "ran", witnesses: 3 });
    expect(verdict.kind).toBe("regression");
    expect(censusReport(verdict, "/tmp/tree").fails).toBe(1);
  });

  test("AC-12: a TAMPERED census is still a tamper, whatever reader stamped it", () => {
    // The order of the two questions. Asked reader-first, every pre-#883
    // rewrite would be reported as a migration — a WARN where #494 put a
    // refusal, which is the erasure wearing the migration's clothes.
    const sf = bankedAs(null, { "a.test.ts": 40 });
    const on = JSON.parse(readFileSync(sf, "utf-8"));
    on.gateContract.testCensus["a.test.ts"] = 1;
    writeFileSync(sf, JSON.stringify(on, null, 2));

    const previous = readPersistedCensus(sf, "slug-883");
    expect(previous.kind).toBe("unverified");
    expect(censusVerdict(previous, { "a.test.ts": 1 }, { kind: "ran", witnesses: 3 }).kind)
      .toBe("census-unverified");
  });

  test("AC-13: the gate stamps every census it banks", () => {
    // NOT through `bankedAs`, and the first draft was. That helper writes the
    // stamp itself after calling `persistTestCensus`, so the assertion read
    // back the value the FIXTURE set — a fixture reaching its assertion
    // without the feature (#500). Measured: with the stamp deleted from
    // `persistTestCensus` this case stayed green and three unrelated
    // round-trip cases went red. It calls the writer directly now.
    const root = project({ "workflow-state.json": "{}" });
    const sf = join(root, "workflow-state.json");
    persistTestCensus(sf, { "a.test.ts": 3 }, "slug-883");
    const on = JSON.parse(readFileSync(sf, "utf-8"));
    expect(on.gateContract.testCensusReader).toBe(TEST_CENSUS_READER);
    expect(on.gateContract.testCensus).toEqual({ "a.test.ts": 3 });
    expect(TEST_CENSUS_READER).not.toBe("1");
  });
});
