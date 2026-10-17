/**
 * Covers SC-1968..SC-1970 (HARNESS-STANDARD.md), #508.
 *
 * The seven `test/evidence-prevalidation-at-verify.test.ts` cases that fail
 * only in full runs spawn a real gate per case. They did so through
 * `execSync(…, { timeout: 300000 })` inside a test with bun's default
 * **5000ms** ceiling, so the subprocess budget was sixty times the budget of
 * the test containing it and could never be reached. What reported the
 * failure was bun's own clock, which names nothing.
 *
 * Underneath, one `catch` took a run killed by the budget and a gate that
 * refused on the merits and made them the same value — `e?.stdout || ""` —
 * and a killed run's stdout is empty. The next assertion then says *"the
 * verify gate never recorded a result"*, which is true of the file and false
 * about the cause. Two full runs of triage could not separate resource
 * contention from order dependence, and that sentence is why.
 *
 * ## What is measured here, and what is not
 *
 * Testable, and asserted below: a run that exceeds its budget says so, with
 * the elapsed time and the budget, instead of arriving as silence that reads
 * like a verdict.
 *
 * NOT testable, and named rather than quietly omitted: that the suite
 * survives a machine under memory pressure. #508 records two full runs that
 * died at exit 144 with another session active on the machine. That is a
 * property of the machine; no fixture in this repo can assert it, and
 * `.claude/rules/checks-must-be-able-to-fail.md` asks for the half the repo
 * owns to be enforced and the other half to be said out loud.
 *
 * The evidence for which reading #508's second half is, recorded here because
 * the issue asks for it and the answer is not in the code: a full `bun test`
 * on 2026-10-17 ran that file in its natural position after every one of its
 * neighbours and all nine passed (11857 pass, 0 fail, 12628 tests), and one
 * gate spawn measures 398/328/374/358 ms on an idle machine against a 5000ms
 * ceiling. Order dependence reproduces given the same order; this did not.
 * Fourteen times' headroom does not evaporate from ordinary variance, and it
 * does under the jetsam pressure the issue describes. **Resource contention,
 * and the fix belongs in the harness** — which is what this file's subject is.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  GATE_RUN_BUDGET_MS,
  GATE_TEST_TIMEOUT_MS,
  gateRunRefusal,
  runGateProcess,
} from "./helpers/gate-run";

/** A stand-in gate runner with the behaviour a case needs and nothing else. */
function fakeRunner(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rg-508-gate-"));
  const path = join(dir, "fake-gate.ts");
  writeFileSync(path, body);
  return { dir, path };
}

describe("#508: a gate run that never finished is not a gate verdict", () => {
  test("SC-1968: a run killed by its budget is reported as timed out, with the clock", () => {
    // A runner that writes nothing and outlives its budget — the starved
    // spawn, reproduced without needing a starved machine.
    const { dir, path } = fakeRunner(`await Bun.sleep(30_000);\nconsole.log("never reached");\n`);
    try {
      const run = runGateProcess({
        runner: path,
        gate: "verify",
        slug: "budget",
        issue: 508,
        workDir: dir,
        budgetMs: 600,
      });

      expect(run.timedOut, "a run the budget killed was not reported as timed out").toBe(true);
      expect(run.exitCode, "a killed run reported an exit status it never set").toBeNull();
      expect(run.signal).not.toBeNull();
      expect(run.elapsedMs, "the clock was not read").toBeGreaterThanOrEqual(500);

      // The refusal, and the half that makes the reading act on anything. It
      // has to quote both numbers: "it timed out" sends a reader to the
      // machine, and "it timed out after 600ms of a 600ms budget" sends them
      // to the budget.
      const refusal = gateRunRefusal(run);
      expect(refusal, "a timed-out run produced no refusal").not.toBeNull();
      expect(refusal).toContain("600ms budget");
      expect(refusal).toContain("UNMEASURED");

      // The old reading's whole problem: the output is empty, and empty is
      // what the previous `catch` handed on as if the gate had spoken.
      expect(run.output, "the fixture produced output, so silence is not what is being distinguished").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1969: a run that refuses on the merits is not a timeout, and its output survives", () => {
    // The positive control, and the case the old `catch` existed for. Half
    // the cases in evidence-prevalidation-at-verify.test.ts are SUPPOSED to
    // exit non-zero, so a reading that called every failure a timeout would
    // satisfy the case above and break every one of them.
    const { dir, path } = fakeRunner(`console.log("gate-verify FAIL: the reading is absent");\nprocess.exit(7);\n`);
    try {
      const run = runGateProcess({
        runner: path,
        gate: "verify",
        slug: "refused",
        issue: 508,
        workDir: dir,
        budgetMs: 20_000,
      });

      expect(run.timedOut, "a gate that refused on the merits was called a timeout").toBe(false);
      expect(run.exitCode, "the exit status the gate set was lost").toBe(7);
      expect(run.output, "the gate's own words were discarded").toContain("gate-verify FAIL");
      expect(gateRunRefusal(run), "a refusing gate was refused as an unfinished run").toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1970: the test ceiling is above the subprocess budget, not below it", () => {
    // The arrangement that produced #508's second half, asserted so that
    // sizing the two independently reintroduces it as a red rather than as a
    // misattributed timeout. Twice, because the heal case spawns the gate
    // twice inside one test.
    expect(
      GATE_TEST_TIMEOUT_MS,
      "a test may time out before the subprocess it is waiting for, which is the defect this module removes",
    ).toBeGreaterThan(2 * GATE_RUN_BUDGET_MS);
  });
});
