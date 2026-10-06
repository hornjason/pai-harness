/**
 * Evidence commands are ref-normalized at the point they EXECUTE (#118).
 *
 * `lib/evidence-prevalidator.ts` already rewrites bare `main` at Scope. That is
 * not a chokepoint: the verify-gate re-implementation path authors NEW ACs
 * after Scope has run, so a command can reach `autoPopulateACs` having never
 * been prevalidated. Normalizing only at Scope would repair the commands that
 * were already least likely to be wrong, and miss the ones written during a
 * retry — which is the exact path #103 died on.
 *
 * These tests drive `autoPopulateACs` directly with throwaway state. They are
 * about ref rewriting only; verdict logic is covered elsewhere.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { autoPopulateACs } from "../../gates/gate-executor";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function stateWith(command: string) {
  return {
    projectRoot: REPO_ROOT,
    acs: [
      {
        id: "AC-1",
        verdict: "PENDING",
        threshold: { op: "==", value: "0" },
        evidenceMethod: { type: "COMMAND", command },
      },
    ],
  } as Record<string, any>;
}

function run(state: Record<string, any>) {
  const dir = mkdtempSync(join(tmpdir(), "gate-ev-"));
  const sf = join(dir, "state.json");
  writeFileSync(sf, JSON.stringify(state));
  try {
    autoPopulateACs(state, sf);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return state.acs[0];
}

describe("#118: the executing command is the corrected one", () => {
  test("a bare main ref is rewritten onto the AC", () => {
    // Written BACK onto the AC, not just used locally: a human reading the
    // failure has to see the command that actually ran, and the persisted
    // state is what the next phase reads.
    const ac = run(stateWith("git rev-parse main >/dev/null 2>&1; echo $?"));
    expect(ac.evidenceMethod.command).toBe("git rev-parse origin/main >/dev/null 2>&1; echo $?");
  });

  test("the exact #103 command is corrected at execution time", () => {
    const ac = run(stateWith(
      "git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?",
    ));
    expect(ac.evidenceMethod.command).toContain("origin/main");
    expect(ac.evidenceMethod.command).not.toMatch(/--exit-code main\b/);
  });

  test("and that command no longer produces a false FAIL", () => {
    // The payoff, asserted against the real repository rather than a fixture.
    // `hooks/TestSuiteGuard.hook.ts` is identical to origin/main; against the
    // local `main` ref it may not be. This is the AC that produced a confident,
    // detailed, wrong FAIL and spawned a second Marcus to "fix" a correct file.
    //
    // PASS where origin/main is present. SKIP where it is not — CI checks out
    // the PR merge ref and has no refs/remotes/origin/main, and the first
    // version of this test asserted a bare PASS and went red there. The point
    // of #118 is that the gate must not FAIL on something it did not measure;
    // asserting "PASS or SKIP, never FAIL" states that directly, where
    // asserting PASS stated an accident of the local clone.
    const ac = run(stateWith(
      "git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?",
    ));
    expect(["PASS", "SKIP"], `evidence ran: ${ac.evidenceMethod.command}`).toContain(ac.verdict);
  });

  test("an unresolvable ref is UNMEASURED, never FAIL", () => {
    // The environment-fault path, forced deterministically. A ref that cannot
    // be fetched must not be scored as a code failure — that is the same false
    // FAIL as #103, one layer down, and it is what CI hit.
    const ac = run(stateWith(
      "git diff --exit-code origin/branch-that-does-not-exist-9f3a -- README.md; echo $?",
    ));
    expect(ac.verdict, "a missing remote ref was scored as a code failure").toBe("SKIP");
    expect(ac.evidence.type).toBe("unmeasured");
    expect(ac.evidence.content).toContain("environment fault");
  });

  test("a command with no bare ref is left byte-identical", () => {
    const cmd = "echo 0";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });

  test("an already-qualified ref is not double-qualified", () => {
    const cmd = "git rev-parse origin/main >/dev/null 2>&1; echo $?";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });

  test("a path that merely contains 'main' is untouched", () => {
    // Over-rewriting would manufacture failures instead of removing them.
    const cmd = "test -f lib/main-loop.ts; echo $?";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });
});
