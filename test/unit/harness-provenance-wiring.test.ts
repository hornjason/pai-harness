/**
 * #602 SC-2 — the run SAYS which harness graded it.
 *
 * `lib/harness-provenance.ts` can take a perfect reading and
 * `scripts/record-harness-provenance.ts` can write a perfect record, and
 * a run will still print nothing if `ship.js` never calls either. An
 * unwired control is the defect this issue is about, one layer out: the
 * reading exists, nobody reads it, and the output is identical to a run
 * that never looked.
 *
 * So these cases are about the WIRING, and they are deliberately
 * separate from `harness-provenance.test.ts`, which is about the reading.
 * A case that both took a reading and checked the prompt would be two
 * questions in one assertion (#484) and would go green under half a fix.
 *
 * ## Why the cut is structural
 *
 * `structuralCut` and not `slice(at, at + N)`. A fixed window is a guess
 * about how long a construct will stay that size, it decays silently, and
 * the day it fails it accuses the wrong code (#664, #666). The setup
 * prompt is a template literal inside a function that other issues edit
 * constantly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { structuralCut } from "../../lib/source-slice";

const SHIP = readFileSync(join(import.meta.dir, "..", "..", "workflows", "ship.js"), "utf-8");

/** The setup agent's prompt and options, cut at the construct boundary. */
const SETUP = structuralCut(SHIP, "setupResult = await timedAgent(", { balanced: "(" });

describe("#602 SC-2: the recorder is invoked, and its answer is declared", () => {
  test("the cut found the setup call and is bounded", () => {
    // A slice that failed to find its section is an empty string, and an
    // empty string contains nothing — which is indistinguishable from a
    // clean result. Every assertion below goes through this one first.
    expect(SETUP.length).toBeGreaterThan(500);
    expect(SETUP.length, "a cut the size of the file is not a cut").toBeLessThan(SHIP.length / 2);
    expect(SETUP).toContain("label: 'setup'");
  });

  test("the setup agent is told to run the recorder, with both required arguments", () => {
    expect(SETUP).toContain("scripts/record-harness-provenance.ts");
    expect(SETUP).toContain("--state");
    expect(SETUP).toContain("--harness-root");
  });

  test("the command is SHELL-QUOTED, not interpolated bare", () => {
    // Every path here comes from an argument this run was launched with.
    // A bare interpolation is the inline-construction defect the workflow
    // validator refuses elsewhere; asserting it here keeps the refusal
    // pointed at this call rather than at the file as a whole.
    expect(SETUP).toContain("bun ${shellQuote(`${HARNESS_ROOT}/scripts/record-harness-provenance.ts`)}");
    expect(SETUP).toContain("--state ${shellQuote(`${WORK_DIR}/workflow-state.json`)}");
    expect(SETUP).toContain("--harness-root ${shellQuote(HARNESS_ROOT)}");
  });

  /**
   * The #646 shape, which is why this case exists at all: a
   * structured-output schema is a FILTER on the reply, not a description
   * of it. A field the schema does not declare is stripped on the way
   * back, silently, with no error and no shorter output — the object
   * simply arrives with fewer keys, and the caller reads a reply missing
   * exactly what it did not ask for.
   *
   * So asking the agent for a field is only half a wiring. The schema has
   * to admit it, and `harnessSha` has to admit NULL, because null is what
   * UNMEASURED looks like and `type: 'string'` would drop it — leaving the
   * field absent, which reads as a harness nobody asked about.
   */
  test("all three reported fields are declared, and the nullable ones admit null", () => {
    expect(SETUP).toContain("harnessReading: { type: 'string', enum: ['MEASURED', 'UNMEASURED'] }");
    expect(SETUP).toContain("harnessSha: { type: ['string', 'null'] }");
    expect(SETUP).toContain("harnessWarning: { type: ['string', 'null'] }");
  });

  test("the agent is told not to tidy the harness to silence the warning", () => {
    // The cheapest wrong fix available to an agent that sees a scary
    // stderr line: commit or stash the harness checkout so it stops
    // appearing. That changes the grader mid-run, which is the thing the
    // warning exists to make visible.
    expect(SETUP).toMatch(/Do NOT commit, stash, pull or otherwise tidy/);
  });
});

describe("#602 SC-2: the summary says it, and absence is UNMEASURED", () => {
  /** The block that logs the reading, cut at the function boundary. */
  const RUN_DISCOVERY = structuralCut(SHIP, "async function runDiscovery(", { balanced: "{" });

  test("the cut found runDiscovery and is bounded", () => {
    expect(RUN_DISCOVERY.length).toBeGreaterThan(500);
    expect(RUN_DISCOVERY.length).toBeLessThan(SHIP.length / 2);
  });

  test("an absent reading logs UNMEASURED rather than nothing", () => {
    // `|| 'UNMEASURED'` is the whole guard. Without it an agent that
    // dropped the field produces no log line at all, and no line is
    // indistinguishable from a harness that was fine.
    expect(RUN_DISCOVERY).toContain("setupResult?.harnessReading || 'UNMEASURED'");
    expect(RUN_DISCOVERY).toContain("HARNESS_UNMEASURED");
  });

  test("the SHA and the warning are logged separately", () => {
    // A run can know exactly which harness graded it AND that harness can
    // be the wrong one. One line carrying both would make a dirty
    // checkout indistinguishable from an unreadable one.
    expect(RUN_DISCOVERY).toContain("`Harness: ${setupResult?.harnessSha");
    expect(RUN_DISCOVERY).toContain("if (setupResult?.harnessWarning)");
  });

  test("a MEASURED reading with no sha still logs something, not an empty string", () => {
    // `|| '(no sha reported)'`. An empty interpolation would print
    // "Harness: " — a line that looks like a reading and carries none.
    expect(RUN_DISCOVERY).toContain("'(no sha reported)'");
  });
});
