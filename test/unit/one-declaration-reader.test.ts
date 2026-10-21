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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  caseDeclarations,
  literalProbe,
  literalSpans,
  testDeclarations,
} from "../../lib/test-case-bodies";
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
  renderReaderStamp,
  verifiedCensus,
} from "../../gates/gate-executor";
import { signCensus, signStampedCensus } from "../../gates/witness";
import { ensureGateSalt } from "../../lib/paths";

// `gates/witness.ts` reads the salt and deliberately does NOT mint one —
// a verification that quietly creates the key it then validates against is
// not a verification (`lib/paths.ts`). So the salt is this file's own setup,
// exactly as `gates/adversarial.test.ts` establishes it.
//
// Without this the file passes only when some OTHER file in the same bun
// shard has already called `ensureGateSalt` — `test/test-census.test.ts`
// does, seven times. That is a dependency on shard assignment, and bun
// shards by FILE, so adding any test file anywhere reshuffles it. It did:
// #987's two new files moved this one into a shard with no minting caller
// and all eight signing cases went red in CI on a tree where nothing they
// test had changed. A fresh checkout has no salt either, so the same
// failure reproduces locally the moment the file is run alone.
beforeAll(() => {
  ensureGateSalt();
});

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

/**
 * A state file as the CURRENT gate writes one: census, stamp and signature
 * from `persistTestCensus`, untouched afterwards.
 */
function bankedNow(census: Record<string, number>) {
  const root = project({ "workflow-state.json": "{}" });
  const sf = join(root, "workflow-state.json");
  persistTestCensus(sf, census, "slug-883");
  return sf;
}

/**
 * A state file as a GENUINELY pre-#883 gate wrote one: a census, a v1
 * signature over `(slug, census)`, and no stamp at all.
 *
 * Not `persistTestCensus` with the stamp deleted afterwards, which is what
 * the first draft did. That file carries a v2 signature with its stamp
 * removed — a rewrite, which the signature now catches — so every case
 * built on it would have read `unverified` and the migration would have
 * looked broken. The fixture has to be the thing it claims to be.
 */
function bankedPre883(census: Record<string, number>) {
  const root = project({ "workflow-state.json": "{}" });
  const sf = join(root, "workflow-state.json");
  writeFileSync(
    sf,
    JSON.stringify(
      { gateContract: { testCensus: census, testCensusSignature: signCensus("slug-883", census) } },
      null,
      2,
    ),
  );
  return sf;
}

/** Rewrite one field of a banked state file in place, as an agent would. */
function rewrite(sf: string, edit: (contract: any) => void) {
  const on = JSON.parse(readFileSync(sf, "utf-8"));
  edit(on.gateContract);
  writeFileSync(sf, JSON.stringify(on, null, 2));
  return sf;
}

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

  test("AC-9: an unstamped banked census is UNMEASURED, not a regression", () => {
    // The migration. A pre-#883 census counted prose, so almost every file's
    // number drops — which is exactly what a deleted test looks like.
    const sf = bankedPre883({ "a.test.ts": 40 });
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
      readPersistedCensus(bankedPre883(stale), "slug-883"),
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
    const sf = bankedNow({ "a.test.ts": 40 });
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
    const sf = rewrite(bankedPre883({ "a.test.ts": 40 }), c => {
      c.testCensus["a.test.ts"] = 1;
    });

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

/**
 * The stamp is INSIDE the signature, and the first draft of #883 said it
 * need not be.
 *
 * That draft shipped with `TEST_CENSUS_READER` carrying a docblock arguing
 * the stamp "is NOT a security control… that agent can already delete the
 * census outright". Both halves were wrong, and writing the sentence is what
 * stopped the question being asked. Found by the security review of PR #890,
 * before the merge; AC-12 above was the nearest case and it tampers with the
 * CENSUS, so it could not see this.
 *
 * The bypass, in one edited byte: leave the census and its signature exactly
 * as the gate wrote them and change the stamp. The signature verifies — it
 * covered `(slug, census)` — the round reads `stale-reader`, reports a WARN
 * explaining an ordinary migration, refuses nothing, and `nextCensus` banks
 * the LOWERED reading so the next round is clean. Cheaper and far quieter
 * than deleting the census, which is what the docblock offered as the reason
 * not to bother.
 */
describe("#883: the reader stamp is signed with the census it describes", () => {
  test("AC-14: a FORGED stamp on an intact census is a tamper, not a migration", () => {
    // The bypass itself, with a real regression present so the consequence
    // is visible rather than theoretical: 40 tests banked, 1 now.
    const sf = rewrite(bankedNow({ "a.test.ts": 40 }), c => {
      c.testCensusReader = "99";
    });
    // The census and its signature are untouched — the edit is one field.
    const on = JSON.parse(readFileSync(sf, "utf-8"));
    expect(on.gateContract.testCensus).toEqual({ "a.test.ts": 40 });

    const previous = readPersistedCensus(sf, "slug-883");
    expect(previous.kind, "a forged stamp must not buy a migration verdict").toBe("unverified");

    const verdict = censusVerdict(previous, { "a.test.ts": 1 }, { kind: "ran", witnesses: 3 });
    expect(verdict.kind).toBe("census-unverified");

    // What the fix buys, stated exactly, because the first draft of this
    // case asserted `fails === 1` and was wrong about its own subject.
    //
    // `census-unverified` is a WARN that banks the fresh reading, and so is
    // `reader-changed` — so the forgery does NOT change the count of fails
    // either way. Turning a refusal into a warning by editing the state
    // file is #494's pre-existing exposure, deliberate and documented:
    // tamper-EVIDENT, not tamper-proof, with the salt as the boundary.
    //
    // What #883's first draft added was a way to make the erasure look
    // ROUTINE again — a warning whose text describes an ordinary instrument
    // upgrade, which is precisely the thing #494 exists to deny. So the
    // claim is about which sentence the operator is handed.
    const detail = censusReport(verdict, "/tmp/tree").results[0]!.detail;
    expect(detail).toContain("does not match its signature");
    expect(detail, "a forged stamp must not be reported as a migration").not.toContain(
      "This round banks a fresh reading",
    );
  });

  test("AC-15: DELETING the stamp from a banked census is a tamper too", () => {
    // The other direction, and the one a v1-only check would wave through:
    // strip the stamp and the file LOOKS pre-#883. It is not — its signature
    // is over the v2 payload, which no absent-stamp file can have.
    const sf = rewrite(bankedNow({ "a.test.ts": 40 }), c => {
      delete c.testCensusReader;
    });
    expect(readPersistedCensus(sf, "slug-883").kind).toBe("unverified");
  });

  test("AC-16: a stamp ADDED to a real pre-#883 census is a tamper", () => {
    // The mint. Writing the CURRENT reader onto a genuine v1 file would
    // otherwise promote an old reading to a comparable one.
    const sf = rewrite(bankedPre883({ "a.test.ts": 40 }), c => {
      c.testCensusReader = TEST_CENSUS_READER;
    });
    expect(readPersistedCensus(sf, "slug-883").kind).toBe("unverified");
  });

  test("AC-17: the two payloads cannot collide, and the reader changes the signature", () => {
    // Domain separation, asserted rather than argued. `reader=` sits before
    // `files=` and every entry line comes after it, so the one adversarial
    // input — a census whose only file is named `reader` — cannot be spelled
    // as a stamped payload.
    const census = { "a.test.ts": 40 };
    expect(signStampedCensus("s", census, "2")).not.toBe(signCensus("s", census));
    expect(signStampedCensus("s", census, "2")).not.toBe(signStampedCensus("s", census, "3"));
    expect(signCensus("s", { reader: 2 })).not.toBe(signStampedCensus("s", {}, "2"));
  });

  test("AC-18: the migration still works, and now NAMES the drops it is not refusing", () => {
    // The control for all four above: the honest pre-#883 file is still a
    // migration and still banks forward. Plus the half the security review
    // asked for — refusing the drops would make the migration never end
    // (every file's number moves), so the WARN says what the comparison
    // would have reported instead of staying silent about it.
    const previous = readPersistedCensus(bankedPre883({ "a.test.ts": 40, "b.test.ts": 7 }), "slug-883");
    expect(previous.kind).toBe("stale-reader");

    const verdict = censusVerdict(
      previous,
      { "a.test.ts": 37, "b.test.ts": 7 },
      { kind: "ran", witnesses: 3 },
    );
    expect(verdict.kind).toBe("reader-changed");
    const report = censusReport(verdict, "/tmp/tree");
    expect(report.fails).toBe(0);
    expect(report.warns).toBe(1);
    expect(report.results[0]!.detail).toContain("a.test.ts: 40 test(s) before, 37 after");
    expect(report.results[0]!.detail, "a file that did not move must not be named").not.toContain(
      "b.test.ts",
    );
  });

  test("AC-20: the binary literal probe agrees with a linear one, everywhere in this tree", () => {
    // `inLiteral` became a binary search because a linear probe made the
    // reader quadratic in the number of string literals — 8,794 ms for one
    // 520 KB source, against 29 ms now. A speedup is not a property a test
    // can assert without a clock, so what is asserted is the thing that
    // could actually be wrong: an off-by-one at a span boundary.
    //
    // Two syntaxes for one question, compared (#484). Over real files, at
    // every boundary offset the spans themselves name — not at round
    // numbers, which is where an off-by-one hides.
    const files = Object.keys(censusOf(REPO)).slice(0, 60);
    expect(files.length).toBeGreaterThan(40);
    let probes = 0;
    for (const f of files) {
      const src = readFileSync(join(REPO, f), "utf-8");
      const spans = literalSpans(src);
      const linear = (at: number) => spans.some(([s, e]) => at >= s && at < e);
      // The PRODUCTION probe, imported. The first draft wrote a second copy
      // of the binary search here and compared it to the linear one — two
      // reimplementations agreeing with each other, which is green under
      // every mutation of the real binding. Breaking the real one's
      // boundary comparison was 0 of 89 red, and that zero is what caught
      // this (#500).
      const binary = literalProbe(spans);
      for (const [s, e] of spans) {
        for (const at of [s - 1, s, s + 1, e - 1, e, e + 1]) {
          if (at < 0 || at >= src.length) continue;
          probes++;
          if (linear(at) !== binary(at)) {
            throw new Error(`${f}: the two probes disagree at offset ${at}`);
          }
        }
      }
    }
    // Not a vacuous walk: a tree with no literals would agree perfectly.
    expect(probes).toBeGreaterThan(5000);
  });

  test("AC-19: a stamp that could not be printed safely is not printed", () => {
    // Defence in depth and nothing more: the stamp is signed, so an
    // unsigned value never reaches a report. What this costs is one line,
    // and what it buys is that a WARN detail can never carry a newline or a
    // control character into whatever reads the gate's output.
    expect(renderReaderStamp("2")).toBe('"2"');
    expect(renderReaderStamp(null)).toBe("1 (unstamped, pre-#883)");
    expect(renderReaderStamp("2\nFAIL: everything is fine")).toBe("(unprintable)");
    expect(renderReaderStamp("x".repeat(64))).toBe("(unprintable)");
  });
});
