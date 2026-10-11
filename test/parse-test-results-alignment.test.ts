/**
 * parse-test-results-alignment.test.ts — #314 defect 1.
 *
 * `parseTestResults` collected a failure's detail by scanning FORWARD from the
 * `(fail)` line. Bun prints the source excerpt, the error and the stack BEFORE
 * that line, so every entry carried the NEXT failure's detail, and the last one
 * carried whatever trailed the final failure — usually the run summary.
 *
 * Measured on run `wf_5cdce852-1e2`, in
 * `~/.rungate/pai-harness-307/workflow-state.json`:
 *
 *   [0] check=evidence-prevalidation  detail=<quinn-on-ui-change's source>
 *   [1] check=quinn-on-ui-change      detail=<all-gates-pass's source>
 *   [2] check=all-gates-pass          detail=<witness-ac-verdict's source>
 *   [3] check=witness-ac-verdict      detail="217 pass 175 filtered out 4 fail"
 *
 * The heal prompt's entire input is this array, so a healing agent was handed
 * the wrong source for every failure it was asked to fix.
 *
 * The ordering is not assumed. It was probed against bun 1.3.14:
 *
 *   line  5  source excerpt for "alpha fails"
 *   line  7  error: expect(received).toBe(expected)
 *   line 13  (fail) alpha fails [0.23ms]
 *
 * The fixture below is that real shape.
 */
import { describe, test, expect } from "bun:test";
import { parseTestResults } from "../gates/gate-executor";

/** Real bun 1.3.14 output shape: detail precedes its own `(fail)` marker. */
const BUN_OUTPUT = [
  "bun test v1.3.14",
  "",
  "a.test.ts:",
  "2 | test(\"alpha fails\", () => { expect(\"AAA\").toBe(\"ZZZ\"); });",
  "        ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: \"ZZZ\"",
  "Received: \"AAA\"",
  "",
  "      at a.test.ts:2:35",
  "(fail) alpha fails [0.23ms]",
  "(pass) beta passes [0.01ms]",
  "4 | test(\"gamma fails\", () => { expect(\"BBB\").toBe(\"YYY\"); });",
  "        ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: \"YYY\"",
  "Received: \"BBB\"",
  "",
  "      at a.test.ts:4:35",
  "(fail) gamma fails [0.05ms]",
  "",
  " 1 pass",
  " 2 fail",
  "Ran 3 tests across 1 file. [12.00ms]",
].join("\n");

describe("#314 defect 1 — each failure carries its own detail", () => {
  const results = parseTestResults(BUN_OUTPUT);
  const byCheck = (name: string) => results.find((r) => r.check === name);

  test("both failures and the pass are parsed", () => {
    expect(results.map((r) => r.check).sort()).toEqual(
      ["alpha fails", "beta passes", "gamma fails"].sort(),
    );
  });

  test("alpha's detail is alpha's, not gamma's", () => {
    const alpha = byCheck("alpha fails");
    expect(alpha?.result).toBe("FAIL");
    expect(alpha?.detail, "alpha carries its own expected value").toContain("ZZZ");
    expect(alpha?.detail, "alpha carries its own received value").toContain("AAA");
    expect(
      alpha?.detail,
      "alpha's detail contains gamma's values — this is the off-by-one",
    ).not.toContain("YYY");
  });

  test("gamma's detail is gamma's, not the run summary", () => {
    const gamma = byCheck("gamma fails");
    expect(gamma?.result).toBe("FAIL");
    expect(gamma?.detail, "gamma carries its own expected value").toContain("YYY");
    expect(gamma?.detail, "gamma carries its own received value").toContain("BBB");
    expect(
      gamma?.detail,
      "the last failure fell off the end onto the run summary",
    ).not.toContain("Ran 3 tests");
  });

  test("no failure's detail belongs to a different check", () => {
    // The general form, so a future parser cannot pass the two cases above by
    // coincidence. Each failing check's own received-value must appear in its
    // own detail and in no other's.
    const owned: Record<string, string> = { "alpha fails": "AAA", "gamma fails": "BBB" };
    for (const [check, token] of Object.entries(owned)) {
      for (const r of results.filter((x) => x.result === "FAIL")) {
        if (r.check === check) {
          expect(r.detail, `${check} lost its own detail`).toContain(token);
        } else {
          expect(r.detail, `${r.check} carries ${check}'s detail`).not.toContain(token);
        }
      }
    }
  });

  test("a pass is not given a neighbouring failure's detail", () => {
    const beta = byCheck("beta passes");
    expect(beta?.result).toBe("PASS");
    expect(beta?.detail).not.toContain("error:");
  });
});
