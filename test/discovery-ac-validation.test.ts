/**
 * Discovery refuses an AC set the state schema will reject (#269)
 *
 * Run `wf_3335abda-d71` on #254 wrote six ACs, one of them carrying
 * `threshold: >= 1` — a threshold that passes on any non-zero result, which
 * is this repo's central defect class wearing an acceptance criterion. The run
 * then skipped the scope gate (LIGHT), briefed Marcus, implemented the whole
 * change, ran the tests, committed `cf33b6e5` and pushed — and only THEN did
 * anything look at the AC:
 *
 *     record-build-commit: Workflow state validation failed:
 *     acs.5.threshold: AC-6: threshold too weak (>= 1) — effectively always passes
 *
 * The rule is right. `gates/schema.ts` should refuse that threshold. What was
 * wrong is that the first validating write is the commit recorder, four phases
 * after the cheapest moment to catch it, so an entire implementation was
 * produced against a criterion nobody can measure.
 *
 * Fourth instance in one day of a check whose phase has nothing to do with the
 * phase that can act on it — #261, #264, #267, this. The others were refusals
 * the branch could not satisfy; this one arrives after everything it could
 * have saved.
 *
 * ## Why this is a copy, and what holds the copy honest
 *
 * `workflows/ship.js` runs in a sandbox with no module loading (#69), so it
 * cannot import `ACSchema`. The rules are therefore reimplemented inline, and
 * a duplicate rule is a rule that drifts — unless something runs both over the
 * same inputs. That is the #224 pattern, and the parity matrix below is the
 * whole reason this fix is allowed to duplicate anything: every case is run
 * through the inlined `acDiscoveryViolations` AND through the real `ACSchema`,
 * and a disagreement in EITHER direction fails.
 *
 * A copy proven equal on one example is a copy proven nothing. The table is
 * the test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ACSchema } from "../gates/schema";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** Slice a marked block out of ship.js. */
function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

type AcViolations = (acs: unknown) => string[];

const acDiscoveryViolations: AcViolations = new Function(
  `${block("AC-VALIDATION")}\nreturn acDiscoveryViolations`,
)();

/** A valid AC, which every case below varies exactly one field of. */
const ok = (over: Record<string, unknown> = {}) => ({
  id: "AC-1",
  type: "CODE",
  statement: "the collection lands where the commit step may commit",
  threshold: { op: ">=", value: 5, unit: "tests" },
  evidenceMethod: { type: "BUN_TEST", command: "bun test" },
  evidence: null,
  ...over,
});

/**
 * Every case, with what the rule is meant to say about it.
 *
 * `reject: true` means BOTH the inlined copy and `ACSchema` must refuse it;
 * `false` means both must accept. Nothing here asserts the two produce the
 * same TEXT — only the same verdict — because the inlined copy exists to
 * refuse early, not to reproduce Zod's formatting.
 */
const CASES: Array<{ name: string; ac: Record<string, unknown>; reject: boolean }> = [
  { name: "a well-formed AC", ac: ok(), reject: false },
  { name: "the #254 threshold, verbatim", ac: ok({ threshold: { op: ">=", value: 1, unit: "x" } }), reject: true },
  { name: ">= 0, which passes on nothing happening", ac: ok({ threshold: { op: ">=", value: 0, unit: "x" } }), reject: true },
  { name: ">= 2 is a real threshold", ac: ok({ threshold: { op: ">=", value: 2, unit: "x" } }), reject: false },
  { name: "== 1 is a real threshold — only >= is weak", ac: ok({ threshold: { op: "==", value: 1, unit: "x" } }), reject: false },
  { name: "== 0 is a real threshold", ac: ok({ threshold: { op: "==", value: 0, unit: "x" } }), reject: false },
  { name: "a non-numeric >= value is not the weak case", ac: ok({ threshold: { op: "contains", value: "PASS" } }), reject: false },
  { name: "no threshold at all", ac: ok({ threshold: undefined }), reject: true },
  { name: "a four-word statement", ac: ok({ statement: "the thing is done" }), reject: true },
  { name: "a five-word statement is enough", ac: ok({ statement: "the collect target is chosen" }), reject: false },
  { name: "tautology: it works", ac: ok({ statement: "it works" }), reject: true },
  { name: "tautology: tests pass", ac: ok({ statement: "tests pass" }), reject: true },
  { name: "tautology: no errors", ac: ok({ statement: "no errors" }), reject: true },
  { name: "behavioural language", ac: ok({ statement: "DA should check the collection target before committing" }), reject: true },
  { name: "behavioural language, other form", ac: ok({ statement: "remember to run the suite before pushing the branch" }), reject: true },

  // The base shape, not only the heuristics. Security review of 41edf8e5
  // called this a validator differential, and it was right: a copy that
  // checks the clever rules and skips the dull ones lets an AC through here
  // that the state schema still rejects at the commit recorder — #269
  // surviving its own fix for a narrower set of inputs.
  { name: "an operator outside the enum", ac: ok({ threshold: { op: "~=", value: 5 } }), reject: true },
  { name: "a threshold with no value", ac: ok({ threshold: { op: ">=" } }), reject: true },
  { name: "a threshold that is not an object", ac: ok({ threshold: "lots" }), reject: true },
  { name: "an evidenceMethod type outside the enum", ac: ok({ evidenceMethod: { type: "VIBES" } }), reject: true },
  { name: "a lowercase evidenceMethod type is allowed", ac: ok({ evidenceMethod: { type: "grep", command: "grep -c x f" } }), reject: false },
  { name: "no evidenceMethod at all is allowed", ac: ok({ evidenceMethod: undefined }), reject: false },
  { name: "a type outside CODE|OUTCOME", ac: ok({ type: "VIBES" }), reject: true },
  { name: "no type at all is allowed", ac: ok({ type: undefined }), reject: false },
  { name: "a non-string id", ac: ok({ id: 6 }), reject: true },
  // The schema's `z.string()` accepts "". The copy must too, however much an
  // empty id deserves refusing: a copy stricter than the schema refuses runs
  // that are fine, and nothing downstream ever contradicts it. The matrix
  // caught this when the check was first written to reject empty ids.
  { name: "an empty id, which the schema allows", ac: ok({ id: "" }), reject: false },
  { name: "a missing statement", ac: ok({ statement: undefined }), reject: true },
  { name: "contains with a string value", ac: ok({ threshold: { op: "contains", value: "SHIPPED" } }), reject: false },
  { name: "exists with a string value", ac: ok({ threshold: { op: "exists", value: "true" } }), reject: false },
];

/**
 * There is no deliberate divergence, and that is worth one test rather than a
 * sentence.
 *
 * I expected one. `ACSchema` lists `evidence` without `.optional()` at the
 * field, and Discovery does not produce it, so I wrote this block to document
 * a gap the copy had to leave. The matrix said otherwise: `EvidenceSchema` is
 * itself `.nullable().optional()` (gates/schema.ts:45), so an AC with no
 * evidence is simply valid and there is nothing to diverge about.
 *
 * It stays as a test because the premise could become true. If `evidence`
 * ever stops being optional, every Discovery AC starts failing `ACSchema`,
 * and the copy would then have to refuse every run or knowingly diverge —
 * a decision someone should be forced to make rather than discover.
 */
describe("#269: the copy has no exceptions, and the schema has no trap in it", () => {
  test("an AC with no evidence is valid to BOTH, so no divergence is needed", () => {
    const noEvidence = { ...ok() } as Record<string, unknown>;
    delete noEvidence.evidence;
    expect(
      ACSchema.safeParse(noEvidence).success,
      "`evidence` became required — Discovery does not produce it, so either the copy must " +
        "now refuse every run or it must knowingly diverge. Decide which, here.",
    ).toBe(true);
    expect(acDiscoveryViolations([noEvidence])).toEqual([]);
  });
});

describe("#269: the inlined rules agree with the schema they stand in for", () => {
  test.each(CASES.map(c => [c.name, c.ac, c.reject] as const))(
    "%s",
    (_name, ac, reject) => {
      const inlined = acDiscoveryViolations([ac]).length > 0;
      const schema = !ACSchema.safeParse(ac).success;

      // Both directions, in one assertion, so a copy that refuses everything
      // and a copy that refuses nothing are each caught. The schema's verdict
      // is the reference; the copy must match it.
      expect(
        { inlined, schema },
        inlined === schema
          ? ""
          : `the inlined copy and ACSchema disagree — inlined ${inlined ? "refused" : "accepted"}, ` +
            `schema ${schema ? "refused" : "accepted"}`,
      ).toEqual({ inlined: reject, schema: reject });
    },
  );

  test("the matrix covers every rule the schema applies to an AC", () => {
    // A parity matrix that happens to miss a rule proves parity on the rules
    // it has and silence on the rest. Each rule the schema can raise must
    // appear as at least one rejecting case, so adding a rule to the schema
    // without adding it here is visible.
    const rejectedMessages = CASES.filter(c => c.reject).flatMap(c => {
      const r = ACSchema.safeParse(c.ac);
      return r.success ? [] : r.error.issues.map(i => i.message);
    });
    for (const rule of ["missing threshold", "behavioral language", "statement too short", "tautological", "threshold too weak"]) {
      expect(
        rejectedMessages.some(m => m.includes(rule)),
        `no case in the matrix exercises the schema rule "${rule}"`,
      ).toBe(true);
    }
  });
});

describe("#269: the refusal is usable and the run stops before implementing", () => {
  test("the refusal names the AC and what is wrong with it", () => {
    // A refusal that says "invalid" costs a round and teaches nothing — the
    // same lesson as #263. The next run has to be able to fix rather than
    // guess, so the id and the rule both appear.
    const v = acDiscoveryViolations([ok({ id: "AC-6", threshold: { op: ">=", value: 1, unit: "x" } })]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("AC-6");
    expect(v[0]).toMatch(/threshold/i);
  });

  test("every bad AC is named, not just the first", () => {
    const v = acDiscoveryViolations([
      ok({ id: "AC-1", threshold: { op: ">=", value: 1, unit: "x" } }),
      ok({ id: "AC-2" }),
      ok({ id: "AC-3", statement: "it works" }),
    ]);
    expect(v.join(" ")).toContain("AC-1");
    expect(v.join(" ")).toContain("AC-3");
    expect(v.join(" "), "a valid AC was reported as a violation").not.toContain("AC-2");
  });

  test("a list that is not a list is refused, not treated as empty", () => {
    // Security review of 41edf8e5 called this a fail-open default and was
    // right. `acs` is REQUIRED by DISCOVERY_SCHEMA, so anything that is not a
    // list is a defect rather than a run with nothing to check — and the
    // first version of this function returned [] for it, which is the shape
    // of the bug it exists to catch. #251 learned the same thing about the
    // success criteria: an unreadable list is not an empty one.
    expect(acDiscoveryViolations([]), "an empty AC list is a different thing and is allowed here")
      .toEqual([]);
    for (const notAList of [null, undefined, 42, "AC-1", { "0": {} }]) {
      const v = acDiscoveryViolations(notAList as unknown);
      expect(v.length, `an unreadable AC list was treated as clean: ${JSON.stringify(notAList)}`)
        .toBeGreaterThan(0);
    }
  });

  test("junk entries do not throw and do not silently pass", () => {
    // The ACs arrive from a structured-output layer, so the shape is usually
    // right — but "usually" is not a guard, and an exception here would take
    // down the Discovery phase rather than refusing it.
    for (const junk of [null, undefined, 42, "string", []]) {
      expect(() => acDiscoveryViolations([junk]), `threw on ${JSON.stringify(junk)}`).not.toThrow();
      expect(acDiscoveryViolations([junk]).length, `junk AC accepted: ${JSON.stringify(junk)}`)
        .toBeGreaterThan(0);
    }
  });

  test("the check is wired into Discovery, before anything is implemented", () => {
    // Position is the entire point of this issue. The rule already existed;
    // it fired four phases too late. A validation nothing calls at Discovery
    // leaves the defect exactly where it was.
    const discovery = shipSource.slice(
      shipSource.indexOf("async function runDiscovery"),
      shipSource.indexOf("PHASE 4: IMPLEMENT"),
    );
    expect(discovery.length, "could not find the Discovery phase").toBeGreaterThan(500);
    expect(discovery).toContain("acDiscoveryViolations(discovery.acs)");
    expect(discovery, "the violations are computed and never refused on").toMatch(
      /acViolations[\s\S]{0,600}?discoveryRefusal = shipFailed/,
    );
  });

  test("the refusal does not claim to know where the run has got to", () => {
    // `runDiscovery` runs twice on some runs — once at the start, and again
    // from the verify-regression path, where the commit ALREADY EXISTS. An
    // earlier draft of this refusal said "so this run could not record its
    // own commit", which is true on the first pass and false on the second.
    // Security review of 41edf8e5 called that a control misfire and it was
    // right: a refusal that misstates the run's state sends the next reader
    // looking for the wrong thing, which is most of what #261 and #267 cost.
    const refusal = shipSource.slice(
      shipSource.indexOf("const acViolations = acDiscoveryViolations(discovery.acs)"),
      shipSource.indexOf("// Nothing is dropped in silence"),
    );
    expect(refusal.length, "the AC-validation refusal moved").toBeGreaterThan(100);
    expect(
      refusal,
      "the refusal asserts a commit state it cannot know on the regression path",
    ).not.toMatch(/could not record its own commit|before any commit|nothing has been committed/);
  });

  test("the Discovery prompt states the rule rather than only enforcing it", () => {
    // SC-4. Refusing a model for a rule it was never told is a round spent
    // teaching it something the prompt could have said for free.
    expect(shipSource).toMatch(/>= 1[\s\S]{0,200}?always passes|always passes[\s\S]{0,200}?>= 1/);
  });
});
