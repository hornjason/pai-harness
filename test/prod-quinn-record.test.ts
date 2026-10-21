/**
 * Covers SC-1583..SC-1586 (HARNESS-GATES.md), #423.
 *
 * `prod-quinn-pass` accepts PASS, or SKIP with a reason. Every arm of
 * `workflows/ship.js`'s record-env step wrote `quinn = 'SKIP'`, so for any
 * project configuring `prod.rebuild` the check had no reachable path to PASS.
 * It was not reporting anything false — the reasons were honest — but a check
 * whose only possible outcome is SKIP is counted in the gate's pass total and
 * measures nothing, which is #183's third finding.
 *
 * The measurement already existed. Container Quinn runs in the Verify phase
 * against the rebuilt container and its reply is held in
 * `quinnContainerResult` so the ship-phase recommit can report it; the
 * record-env prompt four hundred lines below ignored it and wrote a constant.
 *
 * The block is EXECUTED here rather than read, and `quinnVerdictFor` is
 * injected from ITS own markers rather than stubbed — a stub would let the
 * recorder and the artefact disagree about what one agent's reply said, which
 * is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function sliceBlock(name: string): string {
  const a = shipSource.indexOf(`// ──── ${name}-START ────`);
  const b = shipSource.indexOf(`// ──── ${name}-END ────`);
  expect(a, `ship.js is missing the ${name}-START marker`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing the ${name}-END marker`).toBeGreaterThan(a);
  // Exactly once each: a second copy would survive any mutation of the first.
  expect(shipSource.indexOf(`// ──── ${name}-START ────`, a + 1)).toBe(-1);
  expect(shipSource.indexOf(`// ──── ${name}-END ────`, b + 1)).toBe(-1);
  return shipSource.slice(a, b);
}

interface Record_ { quinn: string; reason: string }

const fns = new Function(
  `${sliceBlock("QUINN-VERDICT")}
   ${sliceBlock("PROD-QUINN")}
   return { prodQuinnRecord, prodQuinnAssignment };`,
)() as {
  prodQuinnRecord: (ran: boolean, result: unknown, probeKind: string) => Record_;
  prodQuinnAssignment: (r: Record_) => string;
};

describe("#423 — prod.quinn is a measurement", () => {
  test("SC-1583: a container Quinn PASS records PASS — the arm that did not exist", () => {
    const r = fns.prodQuinnRecord(true, { result: "PASS" }, "probe");
    expect(r.quinn, "prod.quinn still has no path to PASS").toBe("PASS");
    // No skip reason on a measured verdict: a reason explains an absence, and
    // writing one beside a PASS would read as a run that declined to measure.
    expect(r.reason).toBe("");
  });

  test("SC-1584: a FAIL is a FAIL, and a SKIP from the agent keeps its own reason", () => {
    expect(fns.prodQuinnRecord(true, { result: "FAIL" }, "probe").quinn).toBe("FAIL");

    const skipped = fns.prodQuinnRecord(true, { result: "SKIP" }, "probe");
    expect(skipped.quinn).toBe("SKIP");
    expect(skipped.reason).toMatch(/container Quinn ran/);

    // An unusable reply is a FAIL, not a PASS — this comes from
    // `quinnVerdictFor`, which is injected rather than reimplemented, and
    // that is the assertion: "Quinn did not tell us it passed" and "Quinn
    // told us it passed" are different facts.
    expect(fns.prodQuinnRecord(true, { result: "WEIRD" }, "probe").quinn).toBe("FAIL");
    expect(fns.prodQuinnRecord(true, null, "probe").quinn).toBe("FAIL");
  });

  test("SC-1585: no container Quinn is a SKIP that says which case it was", () => {
    const unreachable = fns.prodQuinnRecord(false, null, "probe");
    expect(unreachable.quinn).toBe("SKIP");
    expect(unreachable.reason).toMatch(/no reachable test container/);

    const unconfigured = fns.prodQuinnRecord(false, null, "unconfigured");
    expect(unconfigured.quinn).toBe("SKIP");
    expect(unconfigured.reason).toMatch(/no container is configured/);

    // Distinguishable, deliberately. "There is no container" and "the
    // container could not be reached" are different facts, and a reader who
    // cannot tell them apart cannot say which one to fix.
    expect(unreachable.reason).not.toBe(unconfigured.reason);
  });

  test("SC-2489: a container nothing could address is a FAIL, not a reachability SKIP", () => {
    // #312. The third parameter was `!!containerConfig`, so a container
    // declared with no host and no port fell into the arm below and recorded
    // `no reachable test container` — which asserts a probe. Nothing was
    // probed. The two are now three, and only one of them is a measurement
    // that came back empty.
    const unmeasured = fns.prodQuinnRecord(false, null, "unmeasured");
    expect(unmeasured.quinn, "a run that measured nothing recorded a SKIP").toBe("FAIL");
    expect(unmeasured.reason, "a FAIL carries no skip reason").toBe("");

    const unreachable = fns.prodQuinnRecord(false, null, "probe");
    expect(unreachable.reason).toMatch(/no reachable test container/);
    expect(unmeasured.quinn).not.toBe(unreachable.quinn);
  });

  test("SC-1586: every reachable record satisfies prod-quinn-pass's contract", () => {
    // The gate accepts PASS, or SKIP with a reason, and refuses anything
    // else. Asserted over the whole input matrix rather than the happy path,
    // because the defect being fixed was precisely that only one outcome was
    // reachable — so "the cases I thought of pass" is the wrong shape of
    // evidence here.
    const replies: unknown[] = [
      { result: "PASS" }, { result: "FAIL" }, { result: "SKIP" },
      { result: "WEIRD" }, {}, null, undefined, "PASS", 7,
    ];
    const records: Record_[] = [];
    for (const configured of ["probe", "unconfigured", "unmeasured"]) {
      records.push(fns.prodQuinnRecord(false, null, configured));
      for (const reply of replies) records.push(fns.prodQuinnRecord(true, reply, configured));
    }

    for (const r of records) {
      expect(["PASS", "FAIL", "SKIP"], `unexpected verdict ${r.quinn}`).toContain(r.quinn);
      if (r.quinn === "SKIP") {
        expect(r.reason.length, "a SKIP without a reason is refused by prod-quinn-pass")
          .toBeGreaterThan(10);
      }
      // The reason is interpolated into a single-quoted JS literal inside a
      // double-quoted shell string. One apostrophe would break the command
      // the agent is told to run, and the step would fail for a reason that
      // has nothing to do with Quinn.
      expect(r.reason, "a reason with a quote breaks the record-env command").not.toMatch(/['"`]/);
    }

    // The positive control for the matrix itself: PASS must actually occur in
    // it, or every assertion above is satisfied by a function that still only
    // returns SKIP — which is the bug.
    expect(records.filter(r => r.quinn === "PASS").length).toBeGreaterThan(0);
    expect(records.filter(r => r.quinn === "FAIL").length).toBeGreaterThan(0);
  });

  test("SC-1586: no record-env arm writes the verdict as a literal any more", () => {
    // Three arms, all of them previously hardcoding SKIP. The absence is the
    // assertion that catches a fourth arm being added with a constant; the
    // presence count is the weaker half, and is here so that deleting the
    // interpolation from all three does not read as success.
    expect(shipSource).not.toContain("s.environments.prod.quinn = 'SKIP'");
    expect(shipSource).not.toContain("quinn:'SKIP'");
    expect(shipSource.split("${prodQuinn}").length - 1, "an arm stopped reading the measurement")
      .toBe(4);
    // And the value handed to the prompt comes from the recorder, not from
    // anything the record-env step decides for itself.
    expect(shipSource).toContain(
      "prodQuinnAssignment(\n  prodQuinnRecord(quinnContainerRan, quinnContainerResult, containerProbe.kind),\n)",
    );
  });

  test("SC-1586: the assignment fragment is syntactically what the prompt needs", () => {
    const measured = fns.prodQuinnAssignment({ quinn: "PASS", reason: "" });
    expect(measured).toBe("s.environments.prod.quinn = 'PASS';");
    expect(measured, "a measured verdict must not carry a skip reason")
      .not.toContain("quinnSkipReason");

    const skipped = fns.prodQuinnAssignment({ quinn: "SKIP", reason: "no container here" });
    expect(skipped).toContain("s.environments.prod.quinn = 'SKIP';");
    expect(skipped).toContain("s.environments.prod.quinnSkipReason = 'no container here';");
  });
});
