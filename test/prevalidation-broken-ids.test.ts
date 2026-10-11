import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { prevalidationViolations } from "../gates/workflow.test";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #295 — the refusal could not name which AC was broken, because it read a key
 * no writer produces.
 *
 * `prevalidationViolations` read `reading.broken`. `EvidencePrevalidationShape`
 * declares `verdict`, `checkedAt`, `acs`, `reason` and `takenAt` — there is no
 * `broken`, and `lib/evidence-prevalidator.ts` returns `acs`. So the array was
 * empty on every run, every FAIL fell through to "no broken AC ids were
 * recorded", and the refusal that exists to say what to fix could not say it.
 *
 * This is the shape #317 made mechanical at the top level of the state file.
 * It survived because `evidencePrevalidation` is a nested object: the
 * reconciliation checks that `evidencePrevalidation` itself is declared, not
 * which of its keys a reader reaches for. The last test here closes that gap
 * for this block specifically.
 *
 * The fixture is MEASURED rather than hand-written, for the reason
 * .claude/rules/checks-must-be-able-to-fail.md gives against the first version
 * of the #235 proof: a hand-written `{verdict: "FAIL", acs: [...]}` tests that
 * the reader can destructure an object. Running the real pre-validator over a
 * command that cannot succeed tests that the two halves agree.
 */

describe("#295: a pre-validation refusal names the broken ACs", () => {
  /** One AC whose command cannot succeed, one whose command can. */
  const ACS = [
    {
      id: "AC-1",
      evidenceMethod: { type: "COMMAND", command: "exit 1" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "AC-2",
      evidenceMethod: { type: "COMMAND", command: "echo ok" },
      threshold: { op: "contains", value: "ok" },
    },
  ];

  test("the pre-validator classifies the unsatisfiable command as broken", async () => {
    // The producing half. Without it, the refusal test below stays green when
    // the pre-validator stops validating — a test of JSON parsing wearing a
    // gate's clothes.
    const results = await prevalidateEvidence(ACS as never, process.cwd());
    const broken = results.filter(r => r.status === "broken").map(r => r.id);
    expect(broken, `the pre-validator found nothing broken in ${JSON.stringify(results)}`).toContain("AC-1");
  });

  test("the refusal names the measured broken AC, not a generic message", async () => {
    const results = await prevalidateEvidence(ACS as never, process.cwd());
    const reading = {
      verdict: "FAIL" as const,
      checkedAt: "2026-10-11T00:00:00Z",
      acs: results,
      reason: null,
    };
    const violations = prevalidationViolations(reading);
    expect(violations.length, "a FAIL reading produced no refusal").toBe(1);
    expect(
      violations[0],
      "the refusal fell through to the generic branch — it is reading a key " +
        "the producer does not write (#295)",
    ).toContain("AC-1");
    expect(violations[0]).not.toContain("no broken AC ids were recorded");
    // The passing AC must not be blamed. A refusal that lists every AC is as
    // useless as one that lists none.
    expect(violations[0]).not.toContain("AC-2");
  });

  test("a FAIL carrying no broken AC is still a refusal, and says so", () => {
    // The contradiction case: a writer that records FAIL while classifying
    // nothing as broken is reporting something it cannot substantiate. It must
    // still refuse, and the message must be distinguishable from the one above
    // so the two are not confused in a heal prompt.
    const violations = prevalidationViolations({
      verdict: "FAIL",
      checkedAt: "2026-10-11T00:00:00Z",
      acs: [{ id: "AC-1", status: "ok" }],
      reason: null,
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("no broken AC ids were recorded");
  });

  test("a PASS reading with every AC ok is clean", () => {
    // The positive control. Without it, a reader that refuses unconditionally
    // satisfies every case above.
    expect(
      prevalidationViolations({
        verdict: "PASS",
        checkedAt: "2026-10-11T00:00:00Z",
        acs: [{ id: "AC-1", status: "ok" }, { id: "AC-2", status: "ok" }],
        reason: null,
      }),
    ).toEqual([]);
  });

  test("the reader reaches only for keys the schema declares", () => {
    // The mechanical half, and the one that would have caught #295 on the day
    // it was written. #317 reconciles the TOP-LEVEL state fields; this block is
    // nested, so its keys were never compared against anything.
    const schema = readFileSync(join(import.meta.dir, "..", "gates", "schema.ts"), "utf-8");
    const shape = schema.slice(
      schema.indexOf("const EvidencePrevalidationShape = {"),
      schema.indexOf("};", schema.indexOf("const EvidencePrevalidationShape = {")),
    );
    const declared = new Set(
      (shape.match(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm) || []).map(m => m.trim().replace(":", "")),
    );
    expect(declared.size, "no fields parsed out of EvidencePrevalidationShape").toBeGreaterThan(3);

    // Comments stripped first. The docblock on the fix NAMES the key it
    // removed, so a detector that reads prose would report the very defect
    // the fix deleted — the self-reference trap this repo keeps meeting.
    const reader = stripJsComments(
      readFileSync(join(import.meta.dir, "..", "gates", "workflow.test.ts"), "utf-8"),
    );
    const body = reader.slice(
      reader.indexOf("export function prevalidationViolations"),
      reader.indexOf("\n}", reader.indexOf("export function prevalidationViolations")),
    );
    const used = [...body.matchAll(/\breading\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1]);
    expect(used.length, "the reader destructures nothing — this check is vacuous").toBeGreaterThan(0);
    const undeclared = [...new Set(used)].filter(k => !declared.has(k));
    expect(
      undeclared,
      `prevalidationViolations reads keys EvidencePrevalidationShape does not ` +
        `declare, so no writer produces them: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });
});
