/**
 * #1540: a `beforeState` nobody wrote is UNMEASURED, not a before-state of "none".
 *
 * Measured on 2026-10-24 over the `workflow-state.json` corpus under
 * `~/.rungate`: of the STANDARD and THOROUGH runs, **none** carried a
 * `beforeState`. Not one, ever. The field has three readers and no producer.
 *
 * The part that makes it a defect rather than a gap is what the readers do
 * about it. `gates/prove.test.ts` wrote
 *
 *     beforeEvidence: wf.beforeState ?? {
 *       type: "none", path: null, capturedAt: <now>,
 *       description: "no before-state captured",
 *     }
 *
 * into `prove-evidence.json` — and `type: "none"` is a value the schema
 * admits and `reference/prompts/goal-skill.md` tells /goal to write for LIGHT
 * tier. So a run where /goal looked and found nothing worth capturing, and a
 * run where nothing ever looked, produce **byte-identical** evidence apart
 * from a timestamp. `comparisonSummary` then reported an AC pass count as
 * though a before/after comparison had happened.
 *
 * `.claude/rules/config-access.md`: "`0`, `{}`, `null` and `SKIP` are all
 * indistinguishable from success; `UNMEASURED` is not."
 *
 * This is the same shape as #307 one field over, and it is deliberately fixed
 * the same way — a three-armed reading, a recorder with mutually exclusive
 * keys, and a consumer that cannot collapse the arms. See
 * `test/test-baseline-unmeasured.test.ts` for the pattern being copied.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  beforeEvidenceFor,
  comparisonSummaryFor,
  readBeforeState,
  recordBeforeState,
} from "../gates/gate-executor";

const REPO_ROOT = join(import.meta.dir, "..");

/** A captured before-state, as `reference/prompts/goal-skill.md` describes one. */
const CAPTURED = {
  type: "text",
  path: "/tmp/before.txt",
  capturedAt: "2026-10-24T00:00:00.000Z",
  description: "the list rendered empty",
};

/** The one /goal is told to write when it looked and there was nothing to capture. */
const DECLARED_NONE = {
  type: "none",
  path: null,
  capturedAt: "2026-10-24T00:00:00.000Z",
};

describe("#1540: the reading separates an absent before-state from a declared one", () => {
  test("a workflow state with no beforeState reads UNMEASURED - not a before-state of none", () => {
    // The whole corpus. Every STANDARD+ run measured for #1540 took this
    // branch, and the old code answered it with `type: "none"`.
    const reading = readBeforeState({ sizing: { ceremonyTier: "STANDARD" } });

    expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("unmeasured");
    if (reading.status !== "unmeasured") throw new Error("unreachable");
    // Actionable: the reason has to name the thing that would write one.
    // "No before-state" sends an operator looking for a key nothing sets.
    expect(reading.reason).toContain("beforeState");
    expect(reading.reason).toContain("/goal");
  });

  test('a beforeState of type "none" reads DECLARED-NONE - /goal looked and said so', () => {
    // The arm that makes the one above meaningful. If these two collapsed
    // into a single answer the reading would be exactly the fallback it
    // replaced, and every assertion in this file would still pass.
    const reading = readBeforeState({ beforeState: DECLARED_NONE });

    expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("declared-none");
  });

  test("a real before-state reads CAPTURED and keeps every field - the arm that must stay reachable", () => {
    // The positive control. A `readBeforeState` that had stopped being able
    // to answer "captured" at all would satisfy both cases above, and the
    // producer this issue leaves unbuilt would land on a reader that cannot
    // see it.
    const reading = readBeforeState({ beforeState: CAPTURED });

    expect(reading.status, `reading was: ${JSON.stringify(reading)}`).toBe("captured");
    if (reading.status !== "captured") throw new Error("unreachable");
    expect(reading.type).toBe("text");
    expect(reading.path).toBe("/tmp/before.txt");
    expect(reading.capturedAt).toBe(CAPTURED.capturedAt);
    expect(reading.description).toBe(CAPTURED.description);
  });

  test("a malformed beforeState is UNMEASURED, never captured", () => {
    // A present-but-unreadable field is not a measurement. Reading it as
    // `captured` would put an undefined `type` into the evidence artefact
    // and claim a comparison off it — the fail-open shape
    // `.claude/rules/checks-must-be-able-to-fail.md` names first.
    for (const bad of [{}, { type: "wat" }, { path: "/x" }, "text", 42, []]) {
      const reading = readBeforeState({ beforeState: bad });
      expect(reading.status, `${JSON.stringify(bad)} did not read as unmeasured`).toBe("unmeasured");
    }

    // ...and an explicit null is the absent case, not a malformed one.
    expect(readBeforeState({ beforeState: null }).status).toBe("unmeasured");
  });
});

describe("#1540: what the reading does once it is taken", () => {
  test("the evidence artefact names UNMEASURED and carries no manufactured type", () => {
    // The defect in one assertion. The old fallback put a `type` into
    // `beforeEvidence` that no /goal ever wrote.
    const evidence = beforeEvidenceFor(readBeforeState({}));

    expect(evidence.status).toBe("UNMEASURED");
    expect(evidence.type, "a type was manufactured for a before-state nobody captured").toBeUndefined();
    expect(evidence.reason).toContain("beforeState");
  });

  test("UNMEASURED and a declared none produce different evidence - the collision this issue is about", () => {
    // Asserted against each other in one test so they cannot drift back into
    // agreeing. Under the old fallback these two objects differed only in
    // their timestamp, which is to say a reader could not tell them apart.
    const absent = beforeEvidenceFor(readBeforeState({}));
    const declared = beforeEvidenceFor(readBeforeState({ beforeState: DECLARED_NONE }));

    // Both named explicitly rather than only asserted unequal: a mutant that
    // restored the old fallback leaves `absent.status` undefined, which is
    // "different from DECLARED_NONE" and passes an inequality while being
    // exactly the defect. Measured — it survived M1 until this line was added.
    expect(absent.status).toBe("UNMEASURED");
    expect(declared.status).toBe("DECLARED_NONE");
    expect(absent.status).not.toBe(declared.status);
    expect(declared.capturedAt).toBe(DECLARED_NONE.capturedAt);

    // And a captured one is a third thing, not a dressed-up version of either.
    const captured = beforeEvidenceFor(readBeforeState({ beforeState: CAPTURED }));
    expect(captured.status).toBe("CAPTURED");
    expect(captured.type).toBe("text");
  });

  test("the comparison summary says UNMEASURED instead of reporting a pass count as a comparison", () => {
    // `comparisonSummary` is the field a reader looks at to learn whether
    // before and after were compared. It said "3/3 criteria passed" on every
    // run in the corpus — a true sentence about the ACs, and no answer at all
    // to the question the field name asks.
    const absent = comparisonSummaryFor(readBeforeState({}), 3, 3);
    expect(absent).toContain("UNMEASURED");

    // The counts survive. They are the only thing the old summary carried and
    // losing them would be a regression dressed as a fix.
    expect(absent).toContain("3/3");

    const captured = comparisonSummaryFor(readBeforeState({ beforeState: CAPTURED }), 3, 3);
    expect(captured, "a captured before-state still reported UNMEASURED").not.toContain("UNMEASURED");
    expect(captured).toContain("3/3");
  });

  test("the recorder's keys are mutually exclusive in both directions", () => {
    // Same property as `recordTestBaseline` (#307): a stale reason sitting
    // beside a fresh reading gives a consumer two answers to choose from, and
    // `?? ` picks the wrong one.
    const state: Record<string, any> = {};

    recordBeforeState(state, readBeforeState({}));
    expect(state.beforeStateUnmeasured).toContain("beforeState");
    expect(state.beforeStateStatus).toBe("UNMEASURED");

    recordBeforeState(state, readBeforeState({ beforeState: CAPTURED }));
    expect(state.beforeStateStatus).toBe("CAPTURED");
    expect(state.beforeStateUnmeasured, "the stale reason survived a real capture").toBeUndefined();
  });
});

/**
 * The binding half. Everything above tests the reading; a pure reading that
 * nothing calls is the state this field was already in.
 */
describe("#1540: prove-evidence.json carries the reading", () => {
  /** Plant a workflow state, run the real prove suite over it, read what it wrote. */
  function proveOver(workflowState: Record<string, unknown>): Record<string, any> {
    const dir = mkdtempSync(join(tmpdir(), "rg-1540-"));
    try {
      writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(workflowState));
      const res = spawnSync("bun", ["test", join(REPO_ROOT, "gates/prove.test.ts")], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: 120000,
        env: { ...process.env, GATE: "prove", TEST_WORK_DIR: dir, PROJECT_ROOT: REPO_ROOT },
      });

      const written = join(dir, "prove-evidence.json");
      // A suite that never reached the writer leaves no artefact, and an
      // absent file would otherwise read as a check that found nothing wrong.
      expect(
        existsSync(written),
        `gates/prove.test.ts wrote no prove-evidence.json.\n${res.stdout}\n${res.stderr}`,
      ).toBe(true);
      return JSON.parse(readFileSync(written, "utf-8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A STANDARD run with one trivially-satisfied AC, so the suite reaches the writer. */
  const RUN = (beforeState?: unknown) => ({
    issue: 1540,
    sizing: { ceremonyTier: "STANDARD" },
    ...(beforeState === undefined ? {} : { beforeState }),
    acs: [
      {
        id: "AC-1",
        statement: "the prove suite reaches its writer",
        type: "CODE",
        evidenceMethod: { command: "true" },
      },
    ],
  });

  test("a run with no beforeState writes UNMEASURED - this is every STANDARD+ run in the corpus", () => {
    const evidence = proveOver(RUN());

    expect(evidence.beforeEvidence.status).toBe("UNMEASURED");
    expect(
      evidence.beforeEvidence.type,
      'prove-evidence.json claimed a before-state of "none" that no /goal wrote',
    ).toBeUndefined();
    expect(evidence.comparisonSummary).toContain("UNMEASURED");
  });

  test('a run whose /goal declared type "none" is written as a different fact', () => {
    // The control for the case above: both runs have nothing to compare
    // against, and only one of them has been looked at.
    const evidence = proveOver(RUN(DECLARED_NONE));

    expect(evidence.beforeEvidence.status).toBe("DECLARED_NONE");
    expect(evidence.comparisonSummary).not.toContain("UNMEASURED");
  });
});
