import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { coverageClaimIds } from "../scripts/sync-sc-status";
import { scScanTestTimeout } from "./helpers/sc-scan-budget";
// The per-test budget for a case that scans the whole test tree (#1223).
// Calibrated on this machine and this tree rather than written down, so it
// has no expiry — see test/helpers/sc-scan-budget.ts.
setDefaultTimeout(scScanTestTimeout());

/**
 * #149 — a test that merely embeds an SC line as fixture data was counted as
 * testing that SC.
 *
 * `findTestFilesForSCs` credited a file with covering a criterion if the file
 * MENTIONED the id anywhere. Tests of the spec tooling embed spec lines and SC
 * records as input: they assert how an SC is parsed, flipped or scanned, and
 * nothing at all about the criterion the id names. Nine files were credited
 * with covering SC-9111, every one of them as fixture data, and a real
 * unimplemented bootstrap criterion was certified done by the first of them
 * to pass.
 *
 * #148 removed the two worst shapes by name — `- [ ] SC-N:` and `id: "SC-N"` —
 * with a pair of regex replacements, and said in its own docblock that
 * replacing the convention itself was this issue.
 *
 * ## The rule the issue proposed, and why it is not the rule here
 *
 * #149's body says a coverage claim is "a mention in a `describe`/`test` title
 * or a comment header". Measured against the tree, that demotes three real
 * criteria it should not:
 *
 *     test/harness-standard-security.test.ts:235
 *       const EXPECTED_REREVIEW_SCS = ["SC-9121", "SC-9122", "SC-9123", "SC-9124"];
 *
 * That is a criterion registry driving a per-criterion loop — the pattern
 * .claude/rules/checks-must-be-able-to-fail.md holds up as the worked example
 * for that very spec. It is a BETTER coverage mechanism than a hand-written
 * title, because the ids cannot drift from the assertions. A rule that counted
 * only titles and comments would strip coverage from the most rigorously
 * tested criteria in the repo and push authors toward the weaker pattern.
 *
 * So the rule is one question instead of a list of shapes: **is the id the
 * whole of what was written, or is it embedded in something else?**
 *
 *   claim   a comment, a test title, or a complete string literal ("SC-9122")
 *   data    an id inside a longer literal ("SC-9100:", "- [ ] SC-9111: whatever")
 *
 * That replaces #148's spec-checkbox regex. It does NOT replace its other one,
 * and the attempt to is what proved the case has to stay: `{ id: "SC-9111" }` and
 * `["SC-9121"]` are the same literal, and only the `id:` position separates a
 * record from a registry. An earlier draft of this file asserted both answers
 * in different tests before that collision surfaced.
 *
 * ## Why this is not urgent, and is worth doing anyway
 *
 * Measured on main before the change: of the 32 ids credited only by a
 * non-claim mention, 16 belong to no spec at all (deliberately fake fixture
 * ids), 16 are real, and **0 of the real ones are unticked**. Nothing can
 * currently be falsely ticked; the nine-files-certify-SC-9111 scenario was the
 * pre-#148 state.
 *
 * What is still wrong is the measurement. #260 ranks work by how many
 * criteria are genuinely checked, and a coverage number that counts fixture
 * strings cannot be used to rank anything. A metric that can only be wrong in
 * the flattering direction is the same defect as a check that cannot fail.
 */

const ROOT = join(import.meta.dir, "..");

describe("#149: a coverage claim is the id itself, not the id inside something else", () => {
  test("an id inside a longer string literal is fixture data", () => {
    // The assertion-string shape that survived #148: the spec-checkbox regex
    // does not match `toContain("SC-9100:")`, so it was still credited.
    expect(coverageClaimIds('expect(content).toContain("SC-9100:");').has("SC-9100")).toBe(false);
  });

  test("a spec checkbox line inside a template literal is fixture data", () => {
    const fixture = ["const spec = `", "- [ ] SC-9111: API responds within 200ms", "`;"].join("\n");
    expect(coverageClaimIds(fixture).has("SC-9111")).toBe(false);
  });

  test("an id in an object-literal record is fixture data", () => {
    expect(coverageClaimIds('const scs = [{ id: "SC-9111", done: true }];').has("SC-9111")).toBe(false);
  });

  test("a comment that is TEXT INSIDE a fixture string is fixture data", () => {
    // The case that defeats a rule written against raw lines. The fixture
    // contains a comment, so a detector that asked "does this line start with
    // //" would be fooled by its own test data — and the only reason this is
    // safe is that the LINE is a function call, not a comment.
    const fixture = 'fixtureTestDir("punctuation", "// covers SC-9110: and SC-9192, and (SC-9193)\\n");';
    const claims = coverageClaimIds(fixture);
    expect(claims.has("SC-9192")).toBe(false);
    expect(claims.has("SC-9193")).toBe(false);
    expect(claims.has("SC-9110")).toBe(false);
  });

  test("a real comment is a claim", () => {
    expect(coverageClaimIds("// covers SC-9142\nconst x = 1;").has("SC-9142")).toBe(true);
  });

  test("a test title is a claim, even though the literal is longer than the id", () => {
    // Titles are the exception the "complete literal" rule has to carve out,
    // because a title is prose by definition and is the project's oldest way
    // of declaring what a file covers.
    expect(coverageClaimIds('test("SC-9107: the gate refuses", () => {});').has("SC-9107")).toBe(true);
    expect(coverageClaimIds('describe("SC-9108: binding", () => {});').has("SC-9108")).toBe(true);
    expect(coverageClaimIds('it("SC-9109 holds", () => {});').has("SC-9109")).toBe(true);
    expect(coverageClaimIds('test.each(CASES)("SC-9130: x", () => {});').has("SC-9130")).toBe(true);
  });

  test("the spec-checkbox shape #148 special-cased is handled by the general rule", () => {
    // The id is inside a longer literal, so the general rule catches it and
    // #148's first regex is no longer needed.
    expect(coverageClaimIds('const s = "- [x] SC-9155 done";').has("SC-9155")).toBe(false);
  });

  test("no bare-id literal is a claim, however it is written", () => {
    // The four shapes that defeated the "a complete literal counts" rule. All
    // are a bare id in quotes; none declares coverage. An earlier draft of
    // this file credited the second one, which would have certified whichever
    // criterion a test happened to take as a parameter.
    for (const src of [
      'const COVERED = ["SC-9156"];',
      'const SHORTEST_ID = "SC-9156";',
      'const scs = [{ id: "SC-9156", done: true }];',
      'findTestFilesForSCs(new Set(["SC-9156"]), dir);',
    ]) {
      expect(coverageClaimIds(src).has("SC-9156"), `credited coverage from: ${src}`).toBe(false);
    }
  });

  test("a registry declares itself in a comment, and that is what counts", () => {
    // The replacement for inferring intent from an array literal. One line,
    // explicit, and it cannot be wrong in the flattering direction.
    const declared = '// Covers SC-9156.\nconst COVERED = ["SC-9156"];';
    expect(coverageClaimIds(declared).has("SC-9156")).toBe(true);
  });
});

describe("#149: the detector is able to fail, and is pointed at real files", () => {
  test("the live test suite still yields claims — the rule is not blind", () => {
    // A classifier that returned nothing would satisfy every negative case
    // above and nothing else. This is the vacuity guard: the repo genuinely
    // does declare coverage, and the rule has to still see it.
    const dir = join(ROOT, "test");
    let total = 0;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
      total += coverageClaimIds(readFileSync(join(dir, f), "utf-8")).size;
    }
    expect(total, "no coverage claims found anywhere in test/ — the rule sees nothing").toBeGreaterThan(150);
  });

  test("a real criterion registry still counts as coverage", () => {
    // The case the issue's proposed rule would have silently dropped, checked
    // over the real file rather than a fixture.
    //
    // The ids are READ OUT of the registry rather than written here, for two
    // reasons. They cannot drift from the file. And — the reason this file had
    // to be rewritten once — writing them here would make THIS file claim
    // coverage of them, because an id in a bare array literal is exactly the
    // registry shape the rule is built to credit. A test that asserts who
    // covers a criterion must not become one of the answers.
    const src = readFileSync(join(ROOT, "test", "harness-standard-security.test.ts"), "utf-8");
    const registry = /const EXPECTED_REREVIEW_SCS = \[([^\]]*)\]/.exec(src);
    expect(registry, "the registry this case is about is no longer in that file").not.toBeNull();
    const ids = [...registry![1].matchAll(/SC-\d+/g)].map(m => m[0]);
    expect(ids.length, "the registry is empty, so this case would be vacuous").toBeGreaterThan(2);

    const claims = coverageClaimIds(src);
    const lost = ids.filter(id => !claims.has(id));
    expect(lost, `registry entries lost their coverage claim: ${lost.join(", ")}`).toEqual([]);
  });

  test("real fixture ids in a real file do NOT survive, which is the point", () => {
    // The converse, over a real file. Without it the suite is satisfied by a
    // rule that credits everything.
    //
    // Derived for the same two reasons as the case above: the ids come out of
    // the fixture itself, so they cannot drift and so this file does not end
    // up naming them. `audit-specs.test.ts` embeds a spec in a template
    // literal purely as scanner input.
    const src = readFileSync(join(ROOT, "test", "audit-specs.test.ts"), "utf-8");
    const lines = src.split("\n");

    // Ids that appear ONLY on embedded spec-checkbox lines. An id mentioned
    // somewhere else in the same file may well be claimed there, legitimately
    // — restricting to the pure-fixture ones is what keeps this a statement
    // about fixtures rather than about the file.
    //
    // Computed from raw line shapes, deliberately not from the same
    // comment-scanner the detector uses, so the two cannot agree by sharing a
    // mistake.
    const onFixtureLine = new Set<string>();
    const elsewhere = new Set<string>();
    for (const line of lines) {
      const isFixture = /^- \[[ xX]\] SC-\d+/.test(line.trim());
      for (const m of line.matchAll(/\bSC-\d+(?!\d)/g)) {
        (isFixture ? onFixtureLine : elsewhere).add(m[0]);
      }
    }
    const pureFixture = [...onFixtureLine].filter(id => !elsewhere.has(id));
    expect(
      pureFixture.length,
      "that file no longer embeds spec lines, so this case is vacuous",
    ).toBeGreaterThan(2);

    const claims = coverageClaimIds(src);
    const credited = pureFixture.filter(id => claims.has(id));
    expect(
      credited,
      `these appear only as fixture data and must not count as coverage: ${credited.join(", ")}`,
    ).toEqual([]);
  });
});
