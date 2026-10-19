/**
 * #640 — the restore and the deletion are WIRED, not merely available.
 *
 * `lib/run-branch.ts` can decide containment perfectly and
 * `scripts/check-run-branch.ts` can refuse perfectly, and the shared
 * checkout will still be left on `rungate/run-<issue>` if nothing in a run
 * calls either. That is #602's lesson arriving one issue later: an
 * unwired control is byte-identical to no control.
 *
 * So these cases are about the WIRING and are deliberately separate from
 * `run-branch.test.ts`, which is about the readings. A case that both built
 * a repository and read the prompt would be two questions in one assertion
 * (#484) and would go green under half a fix.
 *
 * Cuts are structural, never `slice(at, at + N)`: a fixed window is a guess
 * about how long a construct will stay that size, it decays silently, and
 * the day it fails it accuses the wrong code (#664, #666).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { structuralCut } from "../../lib/source-slice";

const SHIP = readFileSync(join(import.meta.dir, "..", "..", "workflows", "ship.js"), "utf-8");

const ESTABLISH = structuralCut(SHIP, "async function establishRunRef(", { balanced: "{" });
const FINALIZE = structuralCut(SHIP, "const finalizeResult = await timedAgent(", { balanced: "(" });
const RESTORE = structuralCut(SHIP, "// ──── RUN-BRANCH-RESTORE-START ────", {
  endAnchor: "// ──── RUN-BRANCH-RESTORE-END ────",
});

describe("#640 SC-1/SC-2: the checkout's starting branch is read before anything moves it", () => {
  test("the cuts found their sections and are bounded", () => {
    // A cut that failed to find its section is an empty string, and an
    // empty string contains nothing — indistinguishable from clean. Every
    // assertion below goes through this one.
    for (const [name, cut] of [["establish", ESTABLISH], ["finalize", FINALIZE], ["restore", RESTORE]] as const) {
      expect(cut.length, `${name} cut is empty or trivial`).toBeGreaterThan(300);
      expect(cut.length, `${name} cut is the size of the file`).toBeLessThan(SHIP.length / 2);
    }
  });

  /**
   * SC-2 as filed asks that the branch be created without checking it out,
   * "or created inside the worktree that uses it", and that a test PIN
   * which of the two the code does. This is that pin, and the answer is
   * neither: it checks out in the primary.
   *
   * That is not an oversight being papered over. `integrateWave` commits
   * each wave by running `git commit` in `PROJECT_ROOT` — the branch has to
   * be checked out there for those commits to land on it, and moving wave
   * commits into a worktree is a different change from this one. So the
   * code checks out, this case says so out loud, and SC-1's restore is what
   * makes that safe rather than a side effect nobody put back.
   *
   * If someone later moves wave commits into a worktree, this case goes red
   * and should be rewritten — which is the point of pinning it.
   */
  test("the pin: the run branch IS checked out in the shared primary, and here is why", () => {
    expect(ESTABLISH).toContain("git switch -c ${shellQuote(ref)}");
    expect(ESTABLISH).toContain("cd ${shellQuote(PROJECT_ROOT)}");
    // And the wave commit really does run in the primary, which is the
    // reason the checkout is needed. Without this the claim above is a
    // comment rather than a fact about the code.
    const integrate = structuralCut(SHIP, "async function integrateWave(", { balanced: "{" });
    expect(integrate.length).toBeGreaterThan(300);
    expect(integrate).toContain("cd ${shellQuote(PROJECT_ROOT)}");
    expect(integrate).toContain("git commit -m");
  });

  test("the starting branch is captured BEFORE the switch, not after", () => {
    // Reading it after would record the run's own ref as the thing to
    // restore to, and every run would then report UNCHANGED while having
    // moved the checkout. Order is the whole property, so order is asserted.
    const before = ESTABLISH.indexOf("before=$(git branch --show-current)");
    const theSwitch = ESTABLISH.indexOf("git switch -c ${shellQuote(ref)}");
    expect(before, "the BEFORE read is missing").toBeGreaterThan(-1);
    expect(theSwitch, "the switch is missing").toBeGreaterThan(-1);
    expect(before, "the branch must be read before the command that changes it").toBeLessThan(theSwitch);
  });

  test("an unreported starting branch is UNMEASURED, loudly", () => {
    // Empty is not main. A run that never read it cannot claim at the end
    // that it put anything back, and two empty strings compare equal.
    expect(ESTABLISH).toContain("primaryBranchBefore = reply && typeof reply.branchBefore === 'string'");
    expect(ESTABLISH).toContain("RUN_BRANCH_UNMEASURED");
    expect(ESTABLISH).toContain("branchBefore: { type: 'string' }");
  });
});

describe("#640 SC-4: a leftover branch is reported before the run commits onto it", () => {
  test("the leftover mode is invoked, shell-quoted, against the branch the checkout is on", () => {
    expect(ESTABLISH).toContain("scripts/check-run-branch.ts");
    expect(ESTABLISH).toContain("--mode leftover");
    expect(ESTABLISH).toContain('--base "$before"');
  });

  test("the reading and its notice are both declared, and the notice admits null", () => {
    // #646: an undeclared field is stripped on the way back, and `null` is
    // what "no leftover to report" looks like — `type: 'string'` would drop
    // it and leave the field absent, which reads as a step never asked about.
    expect(ESTABLISH).toContain("leftoverReading: { type: 'string' }");
    expect(ESTABLISH).toContain("leftoverNotice: { type: ['string', 'null'] }");
  });

  test("a non-ABSENT reading arriving with no notice is UNMEASURED, not quiet", () => {
    expect(ESTABLISH).toContain("reply.leftoverReading !== 'ABSENT'");
    expect(ESTABLISH).toContain("arrived with no notice");
  });

  test("a detached checkout still produces a reading rather than no output", () => {
    // `--base ""` would make the script refuse on an argument, which says
    // nothing about the branch. The shell answers with an UNMEASURED
    // reading instead, so the field is never simply missing.
    expect(ESTABLISH).toContain('if [ -n "$before" ]; then');
    expect(ESTABLISH).toContain('"reading":"UNMEASURED"');
  });
});

describe("#640 SC-1/SC-3: the run puts the checkout back and removes its branch", () => {
  test("finalize switches back and invokes the delete mode", () => {
    expect(FINALIZE).toContain("git switch ${shellQuote(primaryBranchBefore)}");
    expect(FINALIZE).toContain("--mode delete");
    expect(FINALIZE).toContain("--mode drift");
  });

  test("with no starting branch recorded, it skips the restore and says so", () => {
    // Switching to an empty string is a command that does something
    // unpredictable; skipping silently is a run that looks like it tidied up.
    expect(FINALIZE).toContain("RESTORE_SKIPPED");
    expect(FINALIZE).toContain("primaryBranchBefore ?");
  });

  test("the agent is told not to force the deletion past a refusal", () => {
    // The cheapest wrong fix available to an agent that sees the delete
    // step refuse: run `git branch -D` by hand. That destroys the work the
    // refusal exists to protect.
    expect(FINALIZE).toMatch(/do NOT pass --force/);
    expect(FINALIZE).toMatch(/do NOT \\?`git branch -D\\?` it by hand/);
  });

  test("all four reported fields are declared, and the nullable ones admit null", () => {
    expect(FINALIZE).toContain("branchAfter: { type: 'string' }");
    expect(FINALIZE).toContain("driftReading: { type: 'string' }");
    expect(FINALIZE).toContain("driftRefusal: { type: ['string', 'null'] }");
    expect(FINALIZE).toContain("runBranchDeleted: { type: 'boolean' }");
    expect(FINALIZE).toContain("runBranchDetail: { type: ['string', 'null'] }");
  });
});

describe("#640: the run summary says where the checkout ended up", () => {
  test("ship.js does not make the comparison itself", () => {
    // One binding. `checkoutDrift` in lib/run-branch.ts decides whether a
    // run moved the checkout; a second comparison here would be two
    // deciders that agree, and mutating either would leave the other
    // answering correctly.
    expect(RESTORE, "a comparison here is the second decider")
      .not.toMatch(/branchAfter\s*[!=]==?\s*primaryBranchBefore/);
    expect(RESTORE).toContain("finalizeResult?.driftReading");
  });

  test("an absent drift reading is UNMEASURED rather than silence", () => {
    expect(RESTORE).toContain("|| 'UNMEASURED'");
    expect(RESTORE).toContain("RUN_BRANCH_UNMEASURED");
    expect(RESTORE).toContain("is unknown");
  });

  test("a MOVED checkout prints the refusal, and a kept branch prints why", () => {
    expect(RESTORE).toContain("RUN_BRANCH_DRIFT");
    expect(RESTORE).toContain("RUN_BRANCH_KEPT");
  });

  test("a delete that reported nothing is UNMEASURED, not a deletion", () => {
    // `runBranchDeleted !== true` covers absent and false alike; without
    // the explicit UNMEASURED arm a reply that dropped the field looks the
    // same as a run with no branch to remove.
    expect(RESTORE).toContain("finalizeResult?.runBranchDeleted === true");
    expect(RESTORE).toContain("did not say whether");
  });

  test("every agent-supplied line is flattened and bounded before logging", () => {
    // A newline in an agent string forges a line that looks like ship.js's
    // own. Four interpolations here come from the reply; all four go
    // through the same treatment.
    const flattened = RESTORE.match(/replace\(\/\[\\r\\n\]\+\/g, ' '\)\.slice\(0, 500\)/g) ?? [];
    expect(flattened.length, "every logged agent string must be flattened").toBe(3);
  });
});
