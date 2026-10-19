import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  acBaseline,
  baselineUnmeasuredReason,
  measureEvidencePrevalidation,
  prevalidateEvidence,
} from "../lib/evidence-prevalidator";
import { EvidencePrevalidationSchema } from "../gates/schema";

/**
 * #669 — evidence that is only a tool announcing itself is UNMEASURED, and
 * carries its own reason rather than being reduced to a threshold comparison.
 *
 * The literal below is from run `wf_448af2c4-6c1`. An AC's evidence command
 * piped `bun test` somewhere that kept only the banner bun prints before it
 * runs anything:
 *
 *     bun test v1.3.14 (d1632b29)
 *
 * That string is 27 characters of output from a command that exited zero, so
 * the pre-validator classified it `ok` and every downstream reader saw an AC
 * with evidence. There is no measurement in it at all. `0`, `{}`, `null` and
 * a version banner are all indistinguishable from success; UNMEASURED is not.
 *
 * THE CHEAPEST WRONG FIX, named per `.claude/rules/checks-must-be-able-to-fail.md`:
 * make the threshold comparison return `false` for any output that is not a
 * number. The reported symptom — a banner counted as satisfying a threshold —
 * disappears, and the banner is still recorded as a MEASURED baseline that
 * merely has not reached its bar yet, which is the exact confusion this issue
 * is about. Every case below therefore asserts the VERDICT and its REASON, not
 * merely that the AC is absent from `alreadySatisfied`, so none of them goes
 * green under that repair.
 */

const ROOT = join(import.meta.dir, "..");
const OWNER = join(ROOT, "lib", "evidence-prevalidator.ts");

/** The literal from run wf_448af2c4-6c1, verbatim. */
const BANNER = "bun test v1.3.14 (d1632b29)";

describe("#669 AC-3: a tool version banner is UNMEASURED", () => {
  test("the run wf_448af2c4-6c1 literal is classified as a banner, with a reason", () => {
    const reason = baselineUnmeasuredReason(BANNER);
    expect(reason, `'${BANNER}' was read as a measurement`).toBeTruthy();
    // The reason has to be actionable on its own: "unmeasured" with no cause
    // is an absence nobody can explain.
    expect(reason!.toLowerCase()).toContain("banner");
    expect(reason!).toContain(BANNER);
  });

  test("the banner is never reduced to a threshold comparison", () => {
    const b = acBaseline(BANNER, { op: "contains", value: "bun test" });
    expect(b.verdict).toBe("UNMEASURED");
    expect(b.reason).toBeTruthy();
    // `contains "bun test"` is TRUE of the banner. A comparison here would
    // have reported the AC satisfied by the tool's own name.
    expect(b.satisfiesThreshold).toBeNull();
  });

  test("end to end: the real pre-validator records the banner as UNMEASURED", async () => {
    const [r] = await prevalidateEvidence(
      [
        {
          id: "AC-1",
          evidenceMethod: { type: "COMMAND", command: `echo '${BANNER}'` },
          threshold: { op: "contains", value: "bun test" },
        },
      ] as never,
      ROOT,
    );
    expect(r.baseline?.verdict).toBe("UNMEASURED");
    expect(r.baseline?.output).toBe(BANNER);
    expect(r.baseline?.satisfiesThreshold).toBeNull();
    expect(r.baseline?.reason).toContain(BANNER);
  });

  test("the banner AC is not named as already satisfied", async () => {
    const reading = await measureEvidencePrevalidation(
      [
        {
          id: "AC-1",
          evidenceMethod: { type: "COMMAND", command: `echo '${BANNER}'` },
          threshold: { op: "contains", value: "bun test" },
        },
      ] as never,
      ROOT,
    );
    expect(reading.alreadySatisfied).toEqual([]);
  });

  test("empty output is UNMEASURED with its OWN reason, not the banner one", async () => {
    // Two different absences. A command that printed nothing and a command
    // that printed only a banner are both unmeasured and are fixed by
    // different edits, so a shared sentence would be a warning nobody can act
    // on.
    const empty = baselineUnmeasuredReason("");
    expect(empty).toBeTruthy();
    expect(empty).not.toBe(baselineUnmeasuredReason(BANNER));

    const [r] = await prevalidateEvidence(
      [
        {
          id: "AC-1",
          evidenceMethod: { type: "COMMAND", command: "true" },
          threshold: { op: ">=", value: 0 },
        },
      ] as never,
      ROOT,
    );
    expect(r.baseline?.verdict).toBe("UNMEASURED");
    expect(r.baseline?.reason).toBe(empty);
    expect(r.baseline?.satisfiesThreshold).toBeNull();
  });

  test("a real value is MEASURED, and the detector does not widen onto it", () => {
    // The direction this is allowed to be wrong in is toward MEASURED: a
    // detector that swallowed ordinary output would convert real evidence into
    // an absence, which is strictly worse than the state it replaces.
    for (const measured of ["7", "0", "3.14", "42 files", "PASS", "v is for value"]) {
      expect(baselineUnmeasuredReason(measured), `'${measured}' was read as a banner`).toBeNull();
    }
    for (const banner of [BANNER, "bun v1.3.14", "node v20.11.0", "tsc Version 5.4.2"]) {
      expect(baselineUnmeasuredReason(banner), `'${banner}' was read as a measurement`).toBeTruthy();
    }
  });
});

describe("#669 AC-4: the schema refuses the contradictions in the new fields", () => {
  const reading = (baseline: unknown) => ({
    verdict: "PASS" as const,
    checkedAt: "2026-10-19T00:00:00.000Z",
    reason: null,
    broken: [],
    acs: [{ id: "AC-1", status: "ok" as const, baseline }],
  });

  const unmeasured = {
    verdict: "UNMEASURED" as const,
    output: BANNER,
    reason: `the only output is a tool version banner (${BANNER})`,
    threshold: { op: "contains", value: "bun test" },
    satisfiesThreshold: null,
  };

  test("the honest UNMEASURED baseline validates", () => {
    const r = EvidencePrevalidationSchema.safeParse(reading(unmeasured));
    expect(r.success, JSON.stringify((r as { error?: unknown }).error)).toBe(true);
  });

  test("an UNMEASURED baseline with no reason is refused", () => {
    // The same refusal the reading itself already carries one level up: an
    // absence nobody can explain is not actionable.
    const r = EvidencePrevalidationSchema.safeParse(reading({ ...unmeasured, reason: null }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("reason");
  });

  test("an UNMEASURED baseline carrying a threshold comparison is refused", () => {
    for (const verdict of [true, false]) {
      const r = EvidencePrevalidationSchema.safeParse(
        reading({ ...unmeasured, satisfiesThreshold: verdict }),
      );
      expect(r.success, `satisfiesThreshold: ${verdict} was accepted on an UNMEASURED baseline`).toBe(
        false,
      );
      expect(JSON.stringify(r)).toContain("satisfiesThreshold");
    }
  });
});

/**
 * The classifier is load-bearing, performed and observed.
 *
 * Without this, every case above is satisfied by a `baselineUnmeasuredReason`
 * that happens to be correct today and by one that was deleted and replaced
 * with something else answering the same question — the fourth shape. The
 * mutant removes the ONE binding and shows the banner then arrives as a
 * MEASURED baseline carrying a threshold verdict.
 */
describe("#669: the banner classifier can fail", () => {
  const SIGNATURE = "export function baselineUnmeasuredReason(output: string | null): string | null {";

  const buildMutant = (): string => {
    const src = readFileSync(OWNER, "utf-8");
    const hits = src.split(SIGNATURE).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: the binding signature appears ${hits} times in ${OWNER}`,
      );
    }
    // Neuter it, and rewrite the relative imports so the copy can run from a
    // temp directory. A mutant that dies on module resolution throws, which
    // reads exactly like the mutation having been rejected on the merits.
    let mutated = src.replace(SIGNATURE, `${SIGNATURE}\n  return null;`);
    mutated = mutated.replace(/from "\.\/([^"]+)"/g, (_m, rel) => `from "${join(dirname(OWNER), rel)}"`);
    const leftover = mutated.match(/from "\.[^"]*"/g) ?? [];
    if (leftover.length > 0) {
      throw new Error(`could not build the mutant: unrewritten relative import(s) ${leftover.join(", ")}`);
    }
    const dir = mkdtempSync(join(tmpdir(), "banner-mutant-"));
    const path = join(dir, "evidence-prevalidator.ts");
    writeFileSync(path, mutated);
    return path;
  };

  test("the real source refuses the banner and the mutant does not", async () => {
    const path = buildMutant();
    const mutant = (await import(path)) as typeof import("../lib/evidence-prevalidator");

    const real = acBaseline(BANNER, { op: "contains", value: "bun test" });
    const broken = mutant.acBaseline(BANNER, { op: "contains", value: "bun test" });

    expect(real.verdict, "the real source stopped classifying the banner").toBe("UNMEASURED");
    expect(real.satisfiesThreshold).toBeNull();

    // The input on which mutant and original differ, named and observed rather
    // than assumed: the same banner, the same threshold, opposite readings.
    expect(broken.verdict, "the mutation changed nothing — this measured the code twice").toBe(
      "MEASURED",
    );
    expect(broken.satisfiesThreshold).toBe(true);
  });
});
