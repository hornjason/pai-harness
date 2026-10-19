import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  acBaseline,
  alreadySatisfiedIds,
  measureEvidencePrevalidation,
  prevalidateEvidence,
  thresholdSatisfiedBy,
} from "../lib/evidence-prevalidator";
import { EvidencePrevalidationSchema, EVIDENCE_PREVALIDATION_FIELDS } from "../gates/schema";
import { prevalidationViolations } from "../gates/workflow.test";

/**
 * #669 — the baseline output is recorded beside the threshold it will be
 * judged against, and an AC that already clears its own bar before the work
 * starts is named rather than counted as fine.
 *
 * Two separate failures lived in the same gap:
 *
 *   1. The pre-validator ran every AC's evidence command at SCOPE and threw
 *      the OUTPUT away, keeping only `ok` / `broken` / `empty` / `skipped`.
 *      So the one tree on which a threshold is known not to be satisfied —
 *      the pre-change tree — was measured and then forgotten, and a reader
 *      wanting to know what `AC-2` printed before Marcus ran had to re-run
 *      the command against a tree that no longer exists.
 *   2. Nothing compared that output to the AC's own threshold. An AC whose
 *      command already prints a satisfying value before any code is written
 *      cannot fail at VERIFY, so it certifies the change without observing
 *      it — the defect `.claude/rules/checks-must-be-able-to-fail.md` is
 *      entirely about, arriving in the harness's own acceptance criteria.
 *
 * Every fixture here is MEASURED rather than hand-written wherever the claim
 * is about the producer: a hand-written `{baseline: {...}}` would assert that
 * the schema can destructure an object. Running the real pre-validator over a
 * command whose output is known tests that the two halves agree.
 */

const ROOT = join(import.meta.dir, "..");

/** One AC that already clears its bar, one that does not. */
const ACS = [
  {
    // `echo 7` prints 7 before anything is implemented, and 7 >= 3. This AC
    // is satisfied by the pre-change tree and can never observe the work.
    id: "AC-1",
    evidenceMethod: { type: "COMMAND", command: "echo 7" },
    threshold: { op: ">=", value: 3 },
  },
  {
    // `echo 1` prints 1, and 1 >= 5 is false. This is what a correct AC looks
    // like before the work is done.
    id: "AC-2",
    evidenceMethod: { type: "COMMAND", command: "echo 1" },
    threshold: { op: ">=", value: 5 },
  },
];

describe("#669 AC-1: the baseline output is persisted beside the threshold", () => {
  test("every AC result carries the command's own output and the AC's threshold", async () => {
    const results = await prevalidateEvidence(ACS as never, ROOT);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    for (const ac of ACS) {
      const baseline = byId[ac.id]?.baseline;
      expect(baseline, `${ac.id} carries no baseline at all`).toBeDefined();
      expect(baseline!.threshold, `${ac.id}'s threshold was not recorded beside its output`).toEqual(
        ac.threshold,
      );
    }

    // Both readable without re-running anything: the output is the literal the
    // command printed on the pre-change tree, not a verdict derived from it.
    expect(byId["AC-1"]!.baseline!.output).toBe("7");
    expect(byId["AC-2"]!.baseline!.output).toBe("1");
  });

  test("an AC with no command records a baseline that says so, rather than none", async () => {
    // Absence is the thing this issue exists to stop. A missing `baseline` key
    // and a command that produced nothing read the same to every consumer, so
    // the no-command case carries its own UNMEASURED reason.
    const [r] = await prevalidateEvidence(
      [{ id: "AC-9", threshold: { op: ">=", value: 1 } }] as never,
      ROOT,
    );
    expect(r.status).toBe("skipped");
    expect(r.baseline?.verdict).toBe("UNMEASURED");
    expect(r.baseline?.reason).toBeTruthy();
    expect(r.baseline?.satisfiesThreshold).toBeNull();
  });

  test("the reading is taken at scope, before IMPLEMENT begins", () => {
    // The chain this depends on: the scope gate's preflight stamps the reading
    // with `takenAt: "scope"`, which is the only phase whose tree is the
    // pre-change one. Asserted at the call site because the phase is what makes
    // the baseline a BASELINE — the same measurement at verify is a result.
    const executor = readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8");
    expect(executor).toContain('stampEvidencePrevalidation(state, "scope")');
  });
});

describe("#669 AC-2: the reading names every AC already satisfied on the pre-change tree", () => {
  test("the derived list names AC-1 and not AC-2", async () => {
    const reading = await measureEvidencePrevalidation(ACS as never, ROOT);
    expect(reading.verdict, `expected a clean reading, got ${JSON.stringify(reading)}`).toBe("PASS");
    expect(reading.alreadySatisfied).toEqual(["AC-1"]);
  });

  test("the derivation and the persisted list come from one binding", async () => {
    // `broken` taught this lesson at a cost of a heal round (#295): a reader
    // that derives the list its own way is a second source of truth for one
    // fact. `alreadySatisfiedIds` is the only binding that answers it, and the
    // persisted key is compared against it by the schema.
    const reading = await measureEvidencePrevalidation(ACS as never, ROOT);
    expect(reading.alreadySatisfied).toEqual(alreadySatisfiedIds(reading.acs));
  });

  test("the gate's single refusal site refuses, naming the ids", async () => {
    const reading = {
      ...(await measureEvidencePrevalidation(ACS as never, ROOT)),
      takenAt: "scope" as const,
    };
    const violations = prevalidationViolations(reading);
    expect(violations.length, `a vacuous scope reading produced no refusal: ${JSON.stringify(reading)}`)
      .toBeGreaterThan(0);
    const joined = violations.join("\n");
    expect(joined).toContain("AC-1");
    // A refusal that lists every AC is as useless as one that lists none.
    expect(joined).not.toContain("AC-2");
  });

  test("a reading in which nothing is already satisfied is not refused", async () => {
    const reading = {
      ...(await measureEvidencePrevalidation([ACS[1]] as never, ROOT)),
      takenAt: "scope" as const,
    };
    expect(reading.alreadySatisfied).toEqual([]);
    expect(prevalidationViolations(reading)).toEqual([]);
  });

  test("the refusal is scoped to the pre-change reading", async () => {
    // At verify and at ship the tree HAS changed, so an AC that satisfies its
    // threshold there is an AC that passed. Refusing on those would turn every
    // successful run red, which is the fastest way to build a refusal everyone
    // learns to click past.
    const measured = await measureEvidencePrevalidation(ACS as never, ROOT);
    expect(prevalidationViolations({ ...measured, takenAt: "verify" })).toEqual([]);
  });
});

describe("#669 AC-4: the schema refuses a reading that contradicts itself", () => {
  const base = {
    verdict: "PASS" as const,
    checkedAt: "2026-10-19T00:00:00.000Z",
    reason: null,
    broken: [],
  };
  const satisfiedAC = {
    id: "AC-1",
    status: "ok" as const,
    baseline: {
      verdict: "MEASURED" as const,
      output: "7",
      reason: null,
      threshold: { op: ">=", value: 3 },
      satisfiesThreshold: true,
    },
  };

  test("the honest reading validates", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [satisfiedAC],
      alreadySatisfied: ["AC-1"],
    });
    expect(r.success, JSON.stringify((r as { error?: unknown }).error)).toBe(true);
  });

  test("an alreadySatisfied list that disagrees with its own results is refused", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [satisfiedAC],
      alreadySatisfied: ["AC-4"],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("alreadySatisfied");
  });

  test("a reading that omits the list while its results carry one is refused", () => {
    const r = EvidencePrevalidationSchema.safeParse({ ...base, acs: [satisfiedAC] });
    expect(r.success).toBe(false);
  });

  test("a MEASURED baseline carrying a reason is refused", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [{ ...satisfiedAC, baseline: { ...satisfiedAC.baseline, reason: "because" } }],
      alreadySatisfied: ["AC-1"],
    });
    expect(r.success).toBe(false);
  });

  test("a MEASURED baseline with no output is refused", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [{ ...satisfiedAC, baseline: { ...satisfiedAC.baseline, output: "" } }],
      alreadySatisfied: ["AC-1"],
    });
    expect(r.success).toBe(false);
  });

  test("a threshold comparison recorded against no threshold is refused", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [{ ...satisfiedAC, baseline: { ...satisfiedAC.baseline, threshold: null } }],
      alreadySatisfied: ["AC-1"],
    });
    expect(r.success).toBe(false);
  });

  test("a reading written before the field existed still validates", () => {
    // Backward compatibility, the same amnesty `broken` and `takenAt` have: an
    // AC result with no `baseline` derives an empty list, so an old reading
    // agrees with its own absent key.
    const r = EvidencePrevalidationSchema.safeParse({
      ...base,
      acs: [{ id: "AC-1", status: "ok" }],
    });
    expect(r.success, JSON.stringify((r as { error?: unknown }).error)).toBe(true);
  });
});

describe("#669 AC-4: SCHEMA-GUIDE.md documents every field added", () => {
  const guide = readFileSync(join(ROOT, "gates", "SCHEMA-GUIDE.md"), "utf-8");
  const section = (() => {
    const start = guide.indexOf("## evidencePrevalidation");
    const next = guide.indexOf("\n## ", start + 1);
    return guide.slice(start, next === -1 ? undefined : next);
  })();

  test("the section was found", () => {
    // Search the slice, not the document: a claim about this section asserted
    // against the whole guide is satisfied by a match anywhere in it, and an
    // empty slice contains nothing, which reads exactly like a clean result.
    expect(section.length).toBeGreaterThan(0);
  });

  test("alreadySatisfied is in the top-level field table", () => {
    // The parity test in test/unit/evidence-prevalidation-gate.test.ts compares
    // that table against EVIDENCE_PREVALIDATION_FIELDS in both directions; this
    // asserts the field reached the schema in the first place.
    expect(EVIDENCE_PREVALIDATION_FIELDS).toContain("alreadySatisfied");
  });

  test("every baseline field is documented in the section", () => {
    for (const field of ["baseline", "verdict", "output", "reason", "threshold", "satisfiesThreshold"]) {
      expect(section, `the guide does not document \`${field}\``).toContain(`\`${field}\``);
    }
  });
});

describe("#669: the threshold comparison itself", () => {
  test("numeric operators compare the printed value against the bar", () => {
    expect(thresholdSatisfiedBy("7", { op: ">=", value: 3 })).toBe(true);
    expect(thresholdSatisfiedBy("1", { op: ">=", value: 5 })).toBe(false);
    expect(thresholdSatisfiedBy("0", { op: "==", value: 0 })).toBe(true);
    expect(thresholdSatisfiedBy("4", { op: "<", value: 4 })).toBe(false);
  });

  test("contains and exists read the text", () => {
    expect(thresholdSatisfiedBy("all good", { op: "contains", value: "good" })).toBe(true);
    expect(thresholdSatisfiedBy("all good", { op: "contains", value: "bad" })).toBe(false);
    expect(thresholdSatisfiedBy("anything", { op: "exists", value: "true" })).toBe(true);
  });

  test("a comparison that cannot be made is null, not false", () => {
    // `false` would say the bar was tested and missed. Null says nobody could
    // test it — the distinction this whole reading exists to keep.
    expect(thresholdSatisfiedBy("not a number", { op: ">=", value: 3 })).toBeNull();
    expect(thresholdSatisfiedBy("7", undefined)).toBeNull();
  });

  test("acBaseline never reduces an unmeasurable output to a comparison", () => {
    const b = acBaseline("", { op: ">=", value: 0 });
    expect(b.verdict).toBe("UNMEASURED");
    expect(b.satisfiesThreshold).toBeNull();
    // `>= 0` is satisfied by every non-negative number, so a comparison here
    // would have said `true` and named the AC vacuous for the wrong reason.
  });
});
