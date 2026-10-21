import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractSCs, isBehavioralSC, isMatchablePattern } from "../lib/conformity";
import { collectSpecFiles } from "../lib/spec-files";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #328 — appending "(behavioral)" to a success criterion removed it from
 * every instrument this project has.
 *
 * Four mechanisms, each individually defensible, composing into a bypass that
 * costs one word:
 *
 *  1. `lib/sc-guard.ts:89` — `if (isBehavioralSC(parsed)) continue;`. The
 *     guard that refuses criteria no matcher can bind skips them.
 *  2. `lib/conformity.ts` — the only executable check on them was
 *     `expect(true).toBe(true)`.
 *  3. Classification happens BEFORE `matchPattern`, so they never enter the
 *     `unmatched` list that `UNMATCHED_CHECKED_RATCHET` counts. The ratchet's
 *     docblock names two honest ways down; this is an unmentioned third.
 *  4. They are "routed to SESSION-AUDIT-SPEC", whose frontmatter is
 *     `status: draft`, `testable: false`, `compliance: permissive`.
 *
 * `behavioralCount` is written into `conformity-findings.json`, and the only
 * tests on it assert the field EXISTS and IS A NUMBER — an inventory with no
 * reconciler, the same shape as #199.
 *
 * ## What this file does, and what it deliberately does not
 *
 * It does NOT assert that a behavioral SC is satisfied. That is a runtime
 * question, and pretending otherwise would be a worse version of the defect.
 *
 * It asserts the population is BOUNDED and CONSERVED. Being unmeasurable today
 * is acceptable; being uncounted is not. The distinction matters because an
 * uncounted population grows for free, and 38 criteria already read as done on
 * the strength of a routing annotation.
 */

const ROOT = join(import.meta.dir, "..");
const SPECS = join(ROOT, "specs");

/**
 * Ticked SCs carrying the `(behavioral)` marker.
 *
 * May only ever FALL. A rise means a new criterion was written in a form that
 * exempts itself from the matcher registry, the SC-guard, and the unmatched
 * ratchet simultaneously — which is exactly the move this issue exists to
 * stop being free.
 *
 * 40 on the day it was first bounded. I reported 38 on the issue; that grep
 * used `SC-[0-9]+` and SC ids are not always numeric — `SC-A1` and `SC-A2` in
 * GITHUB-API-MIGRATION-SPEC.md were missed. `extractSCs` parses `SC-\w+`, and
 * this counts what it parses.
 *
 * The honest ways down: bind it to a matcher, rewrite it in a form that binds,
 * or untick it because the verification does not exist. Not: leave it and
 * raise the number.
 *
 * 40 -> 39 on 2026-10-14 (#327), by the third honest way. SC-502 of
 * GITHUB-API-MIGRATION-SPEC.md — "No `execSync.*gh` or `Bun.spawnSync.*gh`
 * patterns in lib/, hooks/, gates/" — is a mechanical absence check that
 * carried a `(behavioral)` tag, and the tag is precisely what this ratchet
 * is about: it exempted the criterion from every check, and the criterion
 * turned out to be FALSE. `gates/workflow.test.ts:1570` shells out to `gh`
 * with the command on the line after `execSync(`, which is why no grep had
 * ever seen it and why the tick survived. Unticked, banked here, and the
 * removal filed as #395. This is the ratchet doing the thing it was built
 * for, from the other end.
 *
 * 39 -> 35 on 2026-10-17 (#574), by the first honest way — four of the
 * ticks were never earned. `sync-sc-status.ts` credited a criterion whose
 * only test was a `test.todo`, which is the one test guaranteed never to
 * fail; 40 ticks across the tree rested on that and four of them were
 * behavioural. Nothing about those four criteria changed. The measurement
 * did.
 */
const BEHAVIORAL_TICKED_RATCHET = 35;

function allSCs(): { id: string; statement: string; checked: boolean; specFile: string }[] {
  const out: { id: string; statement: string; checked: boolean; specFile: string }[] = [];
  for (const rel of collectSpecFiles(SPECS)) {
    const src = readFileSync(join(SPECS, rel), "utf-8");
    for (const sc of extractSCs(src, rel)) {
      out.push({ id: sc.id, statement: sc.statement, checked: sc.checked, specFile: rel });
    }
  }
  return out;
}

describe("#328: the behavioral population is bounded", () => {
  test("ticked (behavioral) SCs may fall but never rise", () => {
    const ticked = allSCs().filter(sc => sc.checked && isBehavioralSC(sc));
    expect(
      ticked.length,
      `${ticked.length} ticked (behavioral) SCs, ratchet is ${BEHAVIORAL_TICKED_RATCHET}. ` +
        `A rise means a criterion was written in a form that exempts itself from ` +
        `the matcher registry, the SC-guard and the unmatched ratchet at once (#328). ` +
        `Bind it, rewrite it, or untick it — do not raise this number.`,
    ).toBeLessThanOrEqual(BEHAVIORAL_TICKED_RATCHET);
  });

  test("the ratchet is banked, not left slack", () => {
    // A ratchet set far above the real number is a number nobody lowers. If
    // the population has fallen, this says so and demands the credit be taken
    // in the same commit that earns it.
    const ticked = allSCs().filter(sc => sc.checked && isBehavioralSC(sc));
    expect(
      BEHAVIORAL_TICKED_RATCHET - ticked.length,
      `the population is now ${ticked.length}; lower BEHAVIORAL_TICKED_RATCHET to ` +
        `match and record why in the same commit`,
    ).toBeLessThanOrEqual(0);
  });

  test("the scan sees real specs, so the bound is not vacuous", () => {
    // Both assertions above are satisfied by an empty scan. If
    // `collectSpecFiles` or `extractSCs` silently stops returning anything,
    // the ratchet reads as fully drained.
    const all = allSCs();
    expect(all.length, "no SCs collected at all").toBeGreaterThan(400);
    expect(
      all.filter(sc => isBehavioralSC(sc)).length,
      "no behavioral SCs found — either they are gone, or the marker test broke",
    ).toBeGreaterThan(0);
  });
});

describe("#328: no criterion can leave every instrument by editing its text", () => {
  /**
   * The conservation property, and the part that actually closes the bypass.
   *
   * Before this, an unmatchable SC was counted by the unmatched ratchet;
   * appending "(behavioral)" moved it OUT of that population and into one
   * nothing bounded. The population it lands in is now bounded too, so the
   * edit relocates a criterion between two counted sets rather than removing
   * it from both.
   */
  const unmatchable = "the operator feels confident about the deploy";

  test("an unmatchable criterion is counted when it has no marker", () => {
    const sc = { id: "SC-9301", statement: unmatchable, specFile: "F.md", checked: true };
    expect(isBehavioralSC(sc)).toBe(false);
    expect(
      isMatchablePattern(sc, ROOT),
      "the fixture statement is matchable, so this case proves nothing — pick a wilder one",
    ).toBe(false);
  });

  test("appending the marker moves it into the behavioral population, not out of all of them", () => {
    // The bypass, performed. The same statement with four words appended must
    // still land somewhere counted.
    const marked = { id: "SC-9301", statement: `${unmatchable} (behavioral)`, specFile: "F.md", checked: true };
    expect(isBehavioralSC(marked), "the marker is not recognised, so this case is testing nothing").toBe(true);
    expect(
      isMatchablePattern(marked, ROOT),
      "the marked form became matchable, which would make this comparison meaningless",
    ).toBe(false);

    // Counted here: it satisfies the predicate the ratchet above counts over.
    // Before #328 that predicate fed no bound at all.
    expect(isBehavioralSC(marked)).toBe(true);
  });

  test("the marker is a suffix test, so it cannot be claimed mid-sentence", () => {
    // Narrowness worth asserting rather than assuming: if the match were
    // anywhere-in-string, any criterion DISCUSSING behavioral SCs would exempt
    // itself, and that is how an exemption spreads silently.
    const midSentence = { id: "SC-9302", statement: "the (behavioral) marker is parsed correctly", specFile: "F.md", checked: true };
    expect(isBehavioralSC(midSentence)).toBe(false);
  });
});

describe("#328: the vacuous test cannot come back", () => {
  test("the conformity engine asserts nothing about behavioral SCs in-place", () => {
    // The guard on the fix itself. The slot that held
    // `expect(true).toBe(true)` is now a report, and the risk is that someone
    // restores a `test()` there in good faith — the first repair attempt in
    // this very issue did exactly that, and the mutation harness measured it
    // at 0 red because the assertion was true by construction.
    //
    // Comments stripped first: the docblock above that code NAMES the
    // expression it removed, so a prose-reading detector reports the defect
    // the fix deleted.
    const src = stripJsComments(readFileSync(join(ROOT, "lib", "conformity.ts"), "utf-8"));
    const start = src.indexOf("if (behavioral.length > 0) {");
    expect(start, "the behavioral branch is not where this test expects it").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("if (unmatched.length > 0) {", start));

    expect(block, "the behavioral branch wraps its report in a test() again").not.toContain("test(");
    expect(block, "expect(true).toBe(true) is back").not.toContain("expect(true)");
    expect(block, "the behavioral listing stopped being emitted at all").toContain("console.log(");
  });

  test("the guard would catch a restored vacuous test", () => {
    // The mutation as a literal, so the three assertions above are not
    // satisfied by a block that failed to be located.
    const restored = 'if (behavioral.length > 0) {\n  test(`INFO`, () => { expect(true).toBe(true); });\n}';
    expect(restored).toContain("test(");
    expect(restored).toContain("expect(true)");
  });
});

/**
 * #211 — the same vacuous test, twenty lines below the one #328 repaired.
 *
 * The strict-mode matcher aggregate read:
 *
 * ```ts
 * if (unmatched.length > 0) {
 *   test(`${level}: ${unmatched.length} checked SCs have no pattern matcher`, () => {
 *     console.warn(...);
 *     expect(unmatched.length).toBeGreaterThan(0);
 *   });
 * }
 * ```
 *
 * The assertion is inside the branch that only runs when it is true, so it
 * has no failing input — and it was minting one PASSING test per strict spec,
 * named after a number nothing asserts. #328's own describe above sits
 * immediately before the block this guards, and its slice ENDS at the marker
 * this one starts from, so the two windows abut and no region between the
 * behavioral report and the `unimplemented` FAIL is left unwatched.
 *
 * The teeth are not being removed, because they were never here. #441 put
 * them in `test/sc-binding-split.test.ts`, which bounds `UNCLAIMED_RATCHET`
 * above and `CLAIMED_UNBINDABLE` in BOTH directions. That split is deliberate:
 * the per-spec unmatched count measures the matcher registry's vocabulary —
 * it rose 239 -> 242 -> 252 -> 258 across #397/#398/#399, every rise for a
 * criterion that executed tests already cover — so driving it to zero means
 * rewriting refusal criteria as weaker claims about file contents. This guard
 * therefore asserts the block is a REPORT, not that the number is small.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Delete the whole `if (unmatched.length > 0)` branch.** No vacuous test,
 * no noise, suite green. It does not survive: `start` below goes to -1 and
 * the first assertion reddens — and #328's guard reddens too, because it
 * slices UP TO this marker and `indexOf` returning -1 hands it most of the
 * file, which contains `test(`.
 */
describe("#211: the strict-mode matcher aggregate is a report, not a passing test", () => {
  test("the unmatched branch wraps no test() around a number nothing asserts", () => {
    const src = stripJsComments(readFileSync(join(ROOT, "lib", "conformity.ts"), "utf-8"));
    const start = src.indexOf("if (unmatched.length > 0) {");
    expect(start, "the unmatched branch is not where this test expects it").toBeGreaterThan(-1);
    const end = src.indexOf("if (unimplemented.length > 0) {", start);
    expect(end, "the unimplemented branch that bounds this window is gone").toBeGreaterThan(start);
    const block = src.slice(start, end);

    expect(block, "the unmatched aggregate wraps its report in a test() again").not.toContain("test(");
    expect(
      block,
      "expect(unmatched.length).toBeGreaterThan(0) is back — true by construction inside this branch",
    ).not.toContain("expect(");
    expect(block, "the unmatched listing stopped being emitted at all").toContain("console.warn(");
  });

  test("the guard would catch the restored form, and does not fire on the repair", () => {
    // The mutation and the repair as literals, so the assertions above cannot
    // be satisfied by a window that failed to locate anything.
    const restored =
      'if (unmatched.length > 0) {\n  test(`WARN`, () => { console.warn(x); expect(unmatched.length).toBeGreaterThan(0); });\n}';
    expect(restored).toContain("test(");
    expect(restored).toContain("expect(");

    const repaired = 'if (unmatched.length > 0) {\n  console.warn(`WARN: ${n}`);\n}';
    expect(repaired).not.toContain("test(");
    expect(repaired).not.toContain("expect(");
    expect(repaired).toContain("console.warn(");
  });
});
