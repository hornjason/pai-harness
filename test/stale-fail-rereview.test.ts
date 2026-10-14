/**
 * Covers SC-864, SC-865, SC-866, SC-867 (HARNESS-STANDARD.md).
 *
 * #244, split out of #171 — a stale security FAIL could not be re-reviewed,
 * so the run refused on findings about code the branch had moved past.
 *
 * #171's re-review handled exactly one of the two stale cases, because the
 * verdict refusal sat 49 lines ABOVE the currency check:
 *
 * | verdict | stale | what happened |
 * |---|---|---|
 * | PASS | yes | re-reviewed the new tip — what #171 added |
 * | PASS | no  | shipped |
 * | FAIL | no  | refused, correctly (#129) |
 * | **FAIL** | **yes** | **refused on findings about code no longer there** |
 *
 * The stale-FAIL cell is not the rare one. A FAIL is a reason to remediate,
 * and the verify gate's self-heal loop is what produces the commit that makes
 * the review stale — so the case most likely to need a re-review was the one
 * case that could not get one. On run `wf_edc73e78-275` rook's two findings
 * were both real about `82c4c6a1` and both resolved in `f2487030`, and the
 * run refused anyway.
 *
 * ## The first attempt was a fail-open; read this before changing anything
 *
 * `46034035`, reverted by `44ac641d`, flagged within minutes as
 * `fail-open-security-gate`. A re-review is DIFF-SCOPED — it reads the diff
 * between the commit the previous review read and the tip. Correct for a
 * stale PASS, because the base was read and found clean. Wrong for a stale
 * FAIL, because `base..tip` does not contain the flagged code:
 *
 *   1. Rook FAILs commit A on a finding in A.
 *   2. A remediation commits B, touching something else.
 *   3. The verdict is stale, so it enters the re-review loop.
 *   4. Rook reads `A..B`, sees nothing wrong, returns PASS.
 *   5. The verdict is overwritten wholesale. The run ships. The finding is
 *      erased.
 *
 * So the two stale cases need different re-review MODES, not one shared
 * loop — and the clearing may never be a wholesale overwrite.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  SECURITY_FINDINGS_OUTLIVED_REREVIEW,
  reReviewBaseFor,
  reReviewScope,
  resolveReReview,
  securityRefusalName,
} from "../lib/security-verdict";

const SHA = "82c4c6a1f1e2b8d9a0c5e6f7081a2b3c4d5e6f70";
const TIP = "f2487030c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f";

const FAILING = {
  spawned: true,
  verdict: "FAIL",
  failures: ["command injection in scripts/x.ts:40", "unvalidated path in lib/y.ts:12"],
};
const PASSING = { spawned: true, verdict: "PASS", failures: [] as string[] };

describe("#244 SC-864: a stale FAIL is re-reviewed in FULL, a stale PASS by diff", () => {
  test("a PASS gets the diff since the commit that was read and found clean", () => {
    expect(reReviewScope(PASSING)).toBe(REVIEW_SCOPE_DIFF);
    expect(reReviewBaseFor(PASSING, SHA)).toBe(SHA);
  });

  test("a FAIL gets a full review — the base is null, so no --base is passed", () => {
    // Null is the answer, not a fallback. `rookScopeCommand` omits `--base`
    // when it gets one and the scope script reads the whole branch.
    expect(reReviewScope(FAILING)).toBe(REVIEW_SCOPE_FULL);
    expect(reReviewBaseFor(FAILING, SHA), "a FAIL would be re-reviewed against the flagged commit")
      .toBeNull();
  });

  test("anything not readable as a PASS gets the full review", () => {
    // Fails closed TOWARD READING MORE. The cost of being wrong here is one
    // extra review of a whole tip; the cost of the other default is the
    // revert this issue documents.
    for (const held of [
      undefined, null, "PASS", 7, [],
      { verdict: "pass" }, { verdict: "UNKNOWN" }, { verdict: null }, {},
    ]) {
      expect(reReviewScope(held), JSON.stringify(held)).toBe(REVIEW_SCOPE_FULL);
      expect(reReviewBaseFor(held, SHA), JSON.stringify(held)).toBeNull();
    }
  });

  test("a PASS with an unreadable tested commit gets no base either", () => {
    // The diff case still needs a real commit to diff against. A ref name
    // there is the #129 empty diff one argument over.
    expect(reReviewBaseFor(PASSING, "origin/main")).toBeNull();
    expect(reReviewBaseFor(PASSING, undefined)).toBeNull();
  });
});

describe("#244 SC-865: a diff-scoped pass may never clear a FAIL", () => {
  test("the reverted fail-open, reconstructed, is refused", () => {
    // Step 4 of the sequence in this file's header: rook reads A..B, sees
    // nothing, returns PASS. The clearing must not happen.
    const out = resolveReReview(FAILING, PASSING, REVIEW_SCOPE_DIFF, 1, SHA, TIP);
    expect(out.verdict, "a diff-scoped PASS cleared a FAIL — 46034035 again").toBe("FAIL");
    expect(out.cleared).toBeUndefined();
    expect(out.failures.join(" ")).toContain("does not contain the flagged code");
  });

  test("the original findings survive the refusal verbatim", () => {
    // A refusal that drops them cannot say what to fix, and the next round
    // would have nothing to compare a clearing against.
    const out = resolveReReview(FAILING, PASSING, REVIEW_SCOPE_DIFF, 1, SHA, TIP);
    for (const f of FAILING.failures) expect(out.failures).toContain(f);
  });

  test("an unrecognised scope is refused too, not read as full", () => {
    for (const scope of [undefined, null, "", "FULL", "whole", 1]) {
      const out = resolveReReview(FAILING, PASSING, scope, 1, SHA, TIP);
      expect(out.verdict, String(scope)).toBe("FAIL");
    }
  });
});

describe("#244 SC-865: a FULL pass clears it, and records what it cleared", () => {
  test("the measured case from wf_edc73e78-275 clears", () => {
    const out = resolveReReview(FAILING, { ...PASSING, testedSha: TIP }, REVIEW_SCOPE_FULL, 1, SHA);
    expect(out.verdict, "a full review of the tip did not clear a stale FAIL").toBe("PASS");
    expect(out.failures).toEqual([]);
  });

  test("the clearing is recorded rather than the verdict overwritten (SC-4)", () => {
    // The first attempt assigned the re-review's result over `securityVerdict`
    // and the original findings stopped existing — so a reader could not tell
    // a branch that was never flagged from one whose findings were erased.
    const out = resolveReReview(FAILING, { ...PASSING, testedSha: TIP }, REVIEW_SCOPE_FULL, 2, SHA);
    expect(out.cleared).toBeTruthy();
    expect(out.cleared!.priorVerdict).toBe("FAIL");
    expect(out.cleared!.priorFailures).toEqual(FAILING.failures);
    expect(out.cleared!.priorSha).toBe(SHA);
    expect(out.cleared!.clearedBySha).toBe(TIP);
    expect(out.cleared!.clearedByRound).toBe(2);
    expect(out.cleared!.scope).toBe(REVIEW_SCOPE_FULL);
  });

  test("a full pass that does not say which commit it read clears nothing", () => {
    // Without the commit there is nothing to record the clearing against, and
    // a clearing nobody can attribute is the overwrite under another name.
    const out = resolveReReview(FAILING, { ...PASSING, testedSha: "origin/main" }, REVIEW_SCOPE_FULL, 1, SHA);
    expect(out.verdict).toBe("FAIL");
    expect(out.failures.join(" ")).toContain("did not say which commit it read");
    for (const f of FAILING.failures) expect(out.failures).toContain(f);
  });

  test("the caller's own target is accepted as the reviewed commit", () => {
    const out = resolveReReview(FAILING, PASSING, REVIEW_SCOPE_FULL, 1, SHA, TIP);
    expect(out.verdict).toBe("PASS");
    expect(out.cleared!.clearedBySha).toBe(TIP);
  });

  test("a PASS replacing a PASS carries nothing extra — #171's case is untouched", () => {
    const out = resolveReReview(PASSING, { ...PASSING, testedSha: TIP }, REVIEW_SCOPE_DIFF, 1, SHA);
    expect(out.verdict).toBe("PASS");
    expect(out.cleared, "a clean re-review invented a clearing").toBeUndefined();
  });
});

describe("#244 SC-866: a re-review that did not pass refuses, whatever it returned", () => {
  test("a FAIL from the re-review carries its OWN findings", () => {
    const fresh = { spawned: true, verdict: "FAIL", failures: ["new finding in the remediation"] };
    const out = resolveReReview(FAILING, fresh, REVIEW_SCOPE_FULL, 1, SHA, TIP);
    expect(out.verdict).toBe("FAIL");
    expect(out.failures).toEqual(fresh.failures);
  });

  test("a FAIL with nothing attached still says so rather than recording an empty list", () => {
    const out = resolveReReview(FAILING, { spawned: true, verdict: "FAIL", failures: [] }, REVIEW_SCOPE_FULL, 1);
    expect(out.verdict).toBe("FAIL");
    expect(out.failures[0]).toContain("no findings attached");
  });

  test("no verdict at all is a FAIL, not an inherited pass", () => {
    for (const fresh of [undefined, null, {}, { verdict: "pass" }, "PASS", 1]) {
      const out = resolveReReview(FAILING, fresh, REVIEW_SCOPE_FULL, 1, SHA, TIP);
      expect(out.verdict, JSON.stringify(fresh)).toBe("FAIL");
      expect(out.cleared).toBeUndefined();
    }
  });
});

describe("#244 SC-867: exhaustion holding findings refuses under its own name", () => {
  test("rounds spent on a verdict that is still not a PASS", () => {
    expect(securityRefusalName(FAILING, 1)).toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
    expect(securityRefusalName(FAILING, 2)).toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
  });

  test("a FAIL nobody re-reviewed is the ordinary refusal, not this one", () => {
    // "We ran out of rounds and the last thing we knew was a finding" is a
    // different fact from "we refused on the first reading", and conflating
    // them makes the name say nothing.
    expect(securityRefusalName(FAILING, 0)).not.toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
    expect(securityRefusalName(FAILING, undefined)).not.toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
  });

  test("a PASS never refuses under it, however many rounds were spent", () => {
    expect(securityRefusalName(PASSING, 2)).not.toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
  });

  test("an unreadable round count is read as none spent, not as many", () => {
    for (const n of ["2", -1, 1.5, null, {}]) {
      expect(securityRefusalName(FAILING, n), String(n)).not.toBe(SECURITY_FINDINGS_OUTLIVED_REREVIEW);
    }
  });

  test("the name does not contain the exhaustion constant it sits beside", () => {
    // test/security-verdict-blocks.test.ts asserts SECURITY_REREVIEW_EXHAUSTED
    // appears as a literal exactly once in ship.js. A name containing it would
    // be a second spelling that assertion cannot tell from a second
    // declaration — which is the thing the single-spelling rule exists for.
    expect(SECURITY_FINDINGS_OUTLIVED_REREVIEW).not.toContain("SECURITY_REREVIEW_EXHAUSTED");
  });
});

describe("#244 SC-867: ship.js and the library agree, and the refusal stayed unconditional", () => {
  const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

  test("the verdict refusal has no currency term", () => {
    // The second finding against 46034035. #244 moved this refusal BELOW the
    // re-review loop rather than conditioning it: what is judged is still
    // "is the verdict in hand a PASS", with no `reviewCurrency` in the test.
    const start = shipSource.indexOf("// ──── SECURITY-REFUSAL-START ────");
    const end = shipSource.indexOf("// ──── SECURITY-REFUSAL-END ────");
    expect(start, "the SECURITY-REFUSAL markers are gone").toBeGreaterThan(-1);
    const block = shipSource.slice(start, end);
    expect(block).toContain("securityVerdict.verdict !== 'PASS'");
    expect(block, "the refusal was conditioned on currency").not.toMatch(
      /if\s*\([^)]*reviewCurrency[^)]*\)/,
    );
  });

  test("the loop runs ahead of the refusal, which is how a stale FAIL gets its review", () => {
    expect(shipSource.indexOf("// ──── REREVIEW-LOOP-END ────"))
      .toBeLessThan(shipSource.indexOf("// ──── SECURITY-REFUSAL-START ────"));
  });

  test("the loop picks its base through the shared helper, not by hand", () => {
    const start = shipSource.indexOf("// ──── REREVIEW-LOOP-START ────");
    const end = shipSource.indexOf("// ──── REREVIEW-LOOP-END ────");
    const block = shipSource.slice(start, end);
    expect(block).toContain("reReviewBaseFor(securityVerdict, testedSha)");
    expect(block, "the verdict is assigned wholesale again").toContain("resolveReReview(");
    expect(block, "the loop still pins every re-review to the reviewed commit")
      .not.toContain("rookReviewSha(testedSha)");
  });

  test("each helper has exactly one definition in ship.js", () => {
    for (const name of ["reReviewScope", "reReviewBaseFor", "resolveReReview", "securityRefusalName"]) {
      expect(
        (shipSource.match(new RegExp(`function ${name}\\b`, "g")) ?? []).length,
        `${name} is defined more than once, so there is no single binding to mutate`,
      ).toBe(1);
    }
  });
});
