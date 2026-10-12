/**
 * #277 — an AC with no evidence recorded passed verify for 11 of 13 types.
 *
 * `evidence-method-executed` opened with
 * `if (t !== "COMMAND" && t !== "command") return false`, so every other
 * member of `EVIDENCE_METHOD_TYPES` exited before anything was looked at.
 * `threshold-crosscheck` opened with `if (!ac.threshold || !ac.evidence)
 * continue`, so the one state it had no opinion about was the one that
 * mattered — and `EvidenceSchema` is `.nullable().optional()`, so absent is
 * schema-valid.
 *
 * An AC declaring `BUN_TEST` and `threshold: >= 5`, with nothing ever run and
 * nothing ever recorded, passed both. So did `PLAYWRIGHT`, `SCREENSHOT` and
 * `GREP_CHECK`. The first DailyBriefDashboard run uses two of those.
 *
 * ## Why the matrix, rather than an example
 *
 * The defect was not that one type was wrong. It was that twelve types had
 * never been considered, because the check was written for the one in front
 * of whoever wrote it. A single planted `BUN_TEST` case would be fixed by a
 * check that handled `BUN_TEST` and nothing else — the same mistake with a
 * different constant. So the table is generated FROM the enum, every member
 * must carry a declared verdict, and adding a member without declaring one
 * turns it red (SC-4).
 *
 * Covers SC-743, SC-744, SC-745, SC-746 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { EVIDENCE_METHOD_TYPES } from "../gates/schema";
// From the library, NOT from `gates/workflow.test.ts`. That file only runs
// when a gate spawns it with TEST_WORK_DIR; importing it to reach one
// function registered sixteen of its gate checks in the ordinary suite, where
// `sf()` reads nothing and all sixteen passed vacuously. Measured, not
// supposed — the first version of this file did it and the junit per-classname
// output named every one of them.
import {
  missingEvidenceViolations,
  thresholdCrosscheckViolations,
  evidenceExemption,
  EVIDENCE_EXEMPT_TYPES,
} from "../lib/evidence-required";

const ROOT = join(import.meta.dir, "..");

/** An AC with a bar to clear and nothing recorded against it. */
const bare = (type: string) => ({
  id: `AC-${type}`,
  type: "CODE",
  statement: "the thing that was supposed to happen did happen",
  threshold: { op: ">=", value: 5 },
  evidenceMethod: { type },
});

/**
 * The verdict each enum member must produce for `bare()`. Declared, not
 * derived — a map computed from the same predicate the code uses would agree
 * with any bug the code has.
 */
const EXPECTED_REFUSAL: Record<string, boolean> = {
  GREP_CHECK: true,
  FILE_EXISTS: true,
  CURL_CHECK: true,
  BUN_TEST: true,
  SCREENSHOT: true,
  PLAYWRIGHT: true,
  COMMAND: true,
  MANUAL: false,
  grep: true,
  command: true,
  api: true,
  screenshot: true,
  manual: false,
};

describe("#277: every evidence type is accounted for", () => {
  test("the matrix covers the enum exactly — it cannot fall behind it", () => {
    // SC-4. A member added to EVIDENCE_METHOD_TYPES with no row here turns
    // this red, which is the only thing stopping the table ossifying at
    // thirteen while the enum grows.
    const declared: string[] = [...EVIDENCE_METHOD_TYPES];
    expect(declared.sort()).toEqual(Object.keys(EXPECTED_REFUSAL).sort());
  });

  test("the enum is the size this was measured against", () => {
    // Not a style assertion: #277's table has thirteen rows and the count is
    // load-bearing for the claim "11 of 13". If it changes, the issue's
    // arithmetic needs rereading, not just the map above.
    expect(EVIDENCE_METHOD_TYPES.length).toBe(13);
  });

  for (const type of EVIDENCE_METHOD_TYPES) {
    const shouldRefuse = EXPECTED_REFUSAL[type];
    test(`${type}: a threshold with no evidence is ${shouldRefuse ? "REFUSED" : "exempt"}`, () => {
      const v = missingEvidenceViolations([bare(type)]);
      expect(v.length > 0, v.join("\n") || `${type} was waved through`).toBe(shouldRefuse);
      if (shouldRefuse) expect(v[0]).toContain(`AC-${type}`);
    });
  }

  test("eleven of the thirteen were unguarded before this — the issue's count", () => {
    // The old predicate, lifted verbatim from the issue, so the regression is
    // described by running it rather than by remembering it.
    const old = (ac: any) => {
      const t = ac.evidenceMethod?.type;
      if (t !== "COMMAND" && t !== "command") return false;
      return !ac.evidence || (typeof ac.evidence === "object" && !ac.evidence.content);
    };
    const unguarded = EVIDENCE_METHOD_TYPES.filter(t => !old(bare(t)));
    expect(unguarded.length).toBe(11);
    // And every one of them is refused now, except the two named exemptions.
    const stillUnguarded = unguarded.filter(t => missingEvidenceViolations([bare(t)]).length === 0);
    expect(stillUnguarded.sort()).toEqual(["MANUAL", "manual"]);
  });
});

describe("#277: the exemptions are chosen, not fallen through", () => {
  // SC-2. The eleven types were exempt because a comparison missed them, and
  // that is indistinguishable from a decision until somebody writes the
  // decision down.
  test("every exemption carries a reason", () => {
    expect(EVIDENCE_EXEMPT_TYPES.size).toBeGreaterThan(0);
    for (const [type, why] of EVIDENCE_EXEMPT_TYPES) {
      expect(why.length, `${type}'s exemption has no reason worth reading`).toBeGreaterThan(40);
    }
  });

  test("a SKIP verdict is an exemption, and it says so", () => {
    const ac = { ...bare("BUN_TEST"), verdict: "SKIP" };
    expect(evidenceExemption(ac)).toContain("SKIP");
    expect(missingEvidenceViolations([ac])).toEqual([]);
  });

  test("a PENDING verdict is not", () => {
    // The pairing that matters: SKIP is a declaration, PENDING is a silence.
    const ac = { ...bare("BUN_TEST"), verdict: "PENDING" };
    expect(evidenceExemption(ac)).toBeNull();
    expect(missingEvidenceViolations([ac]).length).toBe(1);
  });

  test("an unrecognised type is refused, not exempted", () => {
    // Fail-closed on the unknown. A type the enum gains and this file has not
    // seen must not be waved through while the matrix test is what catches it.
    expect(missingEvidenceViolations([bare("SOME_NEW_TYPE")]).length).toBe(1);
  });
});

describe("#277: recorded evidence satisfies the check", () => {
  // Paired controls throughout. A check that refuses everything satisfies
  // every refusal case above and is useless.
  test("content counts", () => {
    expect(missingEvidenceViolations([{ ...bare("BUN_TEST"), evidence: { type: "test-output", content: "42 pass" } }])).toEqual([]);
  });

  test("a numeric value counts, including zero", () => {
    // 0 is a measurement. Treating it as absent is how a real failing count
    // becomes an unmeasured one.
    expect(missingEvidenceViolations([{ ...bare("BUN_TEST"), evidence: { type: "test-output", value: 0 } }])).toEqual([]);
  });

  test("a url counts — a screenshot has no content or value", () => {
    expect(missingEvidenceViolations([{ ...bare("SCREENSHOT"), evidence: { type: "screenshot", url: "/tmp/x.png" } }])).toEqual([]);
  });

  test("an empty evidence object does not", () => {
    expect(missingEvidenceViolations([{ ...bare("BUN_TEST"), evidence: {} }]).length).toBe(1);
  });

  test("an AC with no threshold is not this check's business", () => {
    const { threshold, ...noThreshold } = bare("BUN_TEST");
    expect(missingEvidenceViolations([noThreshold])).toEqual([]);
  });

  test("a COMMAND AC still needs CONTENT, not merely something", () => {
    // The pre-existing rule is stricter than the new one and must not have
    // been loosened by widening the check around it.
    const v = missingEvidenceViolations([{ ...bare("COMMAND"), evidence: { type: "command-output", value: 7 } }]);
    expect(v.length, "a COMMAND AC was accepted with a value and no output").toBe(1);
  });
});

describe("#277: a non-array acs is UNMEASURED, not clean", () => {
  for (const v of [undefined, null, "acs", 7, {}]) {
    test(`${JSON.stringify(v) ?? "undefined"} is refused`, () => {
      expect(missingEvidenceViolations(v).length).toBe(1);
      expect(missingEvidenceViolations(v)[0]).toContain("UNMEASURED");
      expect(thresholdCrosscheckViolations(v).length).toBe(1);
    });
  }

  test("an empty array is clean — the refusal is not the catch-all", () => {
    expect(missingEvidenceViolations([])).toEqual([]);
    expect(thresholdCrosscheckViolations([])).toEqual([]);
  });
});

describe("#277: threshold-crosscheck's skips are decisions (SC-6)", () => {
  // Each `continue` proven reachable AND correct, rather than removed on the
  // assumption that a skip is always a hole.
  test("no evidence: skipped here, and caught by the other link", () => {
    const ac = bare("BUN_TEST");
    expect(thresholdCrosscheckViolations([ac])).toEqual([]);
    expect(
      missingEvidenceViolations([ac]).length,
      "BOTH links are quiet for an AC with no evidence — that is the #277 hole, reopened",
    ).toBe(1);
  });

  test("a non-numeric evidence shape: skipped, and it got past the other link", () => {
    const ac = { ...bare("SCREENSHOT"), evidence: { type: "screenshot", url: "/tmp/x.png" } };
    expect(thresholdCrosscheckViolations([ac])).toEqual([]);
    expect(missingEvidenceViolations([ac])).toEqual([]);
  });

  test("a non-numeric OPERATOR: skipped, because the comparison is meaningless", () => {
    const ac = {
      ...bare("GREP_CHECK"),
      threshold: { op: "contains", value: "the needle" },
      evidence: { type: "grep-output", value: 3 },
    };
    expect(thresholdCrosscheckViolations([ac])).toEqual([]);
  });

  test("a numeric value below its bar IS refused — the positive control", () => {
    const ac = { ...bare("BUN_TEST"), evidence: { type: "test-output", value: 2 } };
    const v = thresholdCrosscheckViolations([ac]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("2 >= 5 = false");
  });

  test("a numeric value at its bar is not", () => {
    expect(thresholdCrosscheckViolations([{ ...bare("BUN_TEST"), evidence: { type: "test-output", value: 5 } }])).toEqual([]);
  });

  test("zero is compared, not skipped", () => {
    // `val == null` would skip `undefined` and `null`; `0` must reach the
    // comparison, because a measured zero is the commonest real failure.
    const v = thresholdCrosscheckViolations([{ ...bare("BUN_TEST"), evidence: { type: "test-output", value: 0 } }]);
    expect(v.length, "a measured 0 was skipped rather than compared").toBe(1);
  });
});

describe("#277: the call sites route through the exported functions", () => {
  // Without this the refusal can be reintroduced inline and the mutation
  // harness has nothing to short-circuit.
  const gate = readFileSync(join(ROOT, "gates", "workflow.test.ts"), "utf-8");
  const lib = readFileSync(join(ROOT, "lib", "evidence-required.ts"), "utf-8");

  test("evidence-method-executed calls the function and nothing else", () => {
    expect(gate).toContain("const violations = missingEvidenceViolations(sf(\"acs\"));");
    expect(gate, "the COMMAND-only early return is back").not.toMatch(
      /if \(t !== "COMMAND" && t !== "command"\) return false/,
    );
  });

  test("threshold-crosscheck calls the function and nothing else", () => {
    expect(gate).toContain("const violations = thresholdCrosscheckViolations(sf(\"acs\"));");
  });

  test("each signature appears exactly once, in the library", () => {
    // Two refusal paths for the same fact would survive the mutation, and the
    // mutant would go red for a reason unrelated to the mutation working.
    //
    // Searched in the LIBRARY, which is where the functions now live. The
    // first version searched the gate suite and scored 0 occurrences — a
    // single-binding assertion that was in fact asserting the binding was
    // absent, and reported it as "not a single binding" by luck rather than
    // by looking in the right place.
    for (const sig of ["export function missingEvidenceViolations", "export function thresholdCrosscheckViolations"]) {
      expect(lib.split(sig).length - 1, `${sig} is not a single binding in lib/`).toBe(1);
      expect(gate.split(sig).length - 1, `${sig} was copied back into the gate suite`).toBe(0);
    }
  });
});
