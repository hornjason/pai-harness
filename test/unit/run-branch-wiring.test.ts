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

import { runBranchSetupScript } from "../../lib/run-branch";
import { structuralCut } from "../../lib/source-slice";

/** The position the branch-setup shell occupies in the prompt since #702. */
const SETUP_CALL = "${runBranchSetupScript(shellQuote(ref))}";

const SHIP = readFileSync(join(import.meta.dir, "..", "..", "workflows", "ship.js"), "utf-8");

const ESTABLISH = structuralCut(SHIP, "async function establishRunRef(", { balanced: "{" });
const FINALIZE = structuralCut(SHIP, "const finalizeResult = await timedAgent(", { balanced: "(" });
const RESTORE = structuralCut(SHIP, "// ──── RUN-BRANCH-RESTORE-START ────", {
  endAnchor: "// ──── RUN-BRANCH-RESTORE-END ────",
});

/**
 * The shared restore binding, which is where the shell and the reading now
 * live (#640, phase 2).
 *
 * They were inlined in the finalize prompt and in the `RUN-BRANCH-RESTORE`
 * block below, and that is exactly why the two terminal funnels never had a
 * restore: the success path held the only copy, so there was nothing to call
 * from anywhere else. The cases in this file kept their properties and moved
 * their anchor — asserting against the position the code left would be a
 * source-text assertion that has stopped describing the code, which #235
 * records as a thing a grep cannot notice about itself.
 */
const STEP = structuralCut(SHIP, "// ──── RUN-BRANCH-RESTORE-STEP-START ────", {
  endAnchor: "// ──── RUN-BRANCH-RESTORE-STEP-END ────",
});

describe("#640 SC-1/SC-2: the checkout's starting branch is read before anything moves it", () => {
  test("the cuts found their sections and are bounded", () => {
    // A cut that failed to find its section is an empty string, and an
    // empty string contains nothing — indistinguishable from clean. Every
    // assertion below goes through this one.
    for (const [name, cut] of [["establish", ESTABLISH], ["finalize", FINALIZE], ["step", STEP]] as const) {
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
    // The shell moved behind `runBranchSetupScript` in #702, so the anchor
    // moved with it — the property is unchanged and is now asserted in two
    // links: the prompt interpolates the binding, and the binding emits a
    // checkout. Keeping the old literal here would be a source-text
    // assertion that has stopped describing the code (#235), and asserting
    // only the interpolation would let the binding stop switching entirely.
    expect(ESTABLISH).toContain(SETUP_CALL);
    expect(runBranchSetupScript("${shellQuote(ref)}")).toContain(
      "git switch -c ${shellQuote(ref)}",
    );
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
    const theSwitch = ESTABLISH.indexOf(SETUP_CALL);
    expect(before, "the BEFORE read is missing").toBeGreaterThan(-1);
    expect(theSwitch, "the switch is missing").toBeGreaterThan(-1);
    expect(before, "the branch must be read before the command that changes it").toBeLessThan(theSwitch);
  });

  test("an unreported starting branch is UNMEASURED, loudly", () => {
    // Empty is not main. A run that never read it cannot claim at the end
    // that it put anything back, and two empty strings compare equal.
    expect(ESTABLISH).toContain("reply && typeof reply.branchBefore === 'string'");
    expect(ESTABLISH).toContain("RUN_BRANCH_UNMEASURED");
    expect(ESTABLISH).toContain("branchBefore: { type: 'string' }");
  });

  /**
   * The value becomes the `--base` of a DESTRUCTIVE gate, and it arrives
   * from an agent. A reply naming the run's own ref makes the containment
   * check compare a ref against itself — which can only say yes — and the
   * branch is then deleted with nothing having been checked.
   *
   * `lib/run-branch.ts` refuses that too, and this is not a second decider
   * for one question: the library refuses by COMMIT IDENTITY in the repo,
   * this refuses a VALUE at the boundary it enters by. Each has an input
   * the other cannot see — a non-ref string never reaches git, and two
   * different names for one commit pass this and are caught there.
   *
   * Raised by the automated security review of `e0861fb8`.
   */
  test("an agent-supplied starting branch is validated before it can become a deletion base", () => {
    expect(ESTABLISH).toContain("/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(reportedBefore)");
    expect(ESTABLISH).toContain("reportedBefore === runRefName(ISSUE)");
    // Treated as UNREAD, not as a value to use carefully. An unread start
    // skips the restore and the delete, which leaves work alone.
    expect(ESTABLISH).toContain("looksLikeRef && reportedBefore !== runRefName(ISSUE) ? reportedBefore : ''");
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
    // Asserted in TWO LINKS, because the shell moved behind a function and a
    // single grep can no longer see both ends. #235 is the precedent: a
    // source-text assertion cannot notice that it has stopped describing the
    // code, so the call site and the thing it calls are each asserted.
    expect(FINALIZE).toContain("runBranchRestoreShell({ withDelete: true })");
    expect(STEP).toContain('git switch "$before"');
    expect(STEP).toContain("--mode delete");
    expect(STEP).toContain("--mode drift");

    // …and the delete is reachable ONLY from the shipping side. A failing
    // run's branch holds work nothing merged, so the one irreversible action
    // here must not be on the path every run that went wrong takes.
    const deleteAt = STEP.indexOf("--mode delete");
    const guardAt = STEP.indexOf("${withDelete ?");
    expect(guardAt, "the delete is no longer behind the withDelete guard").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deleteAt);
  });

  test("with no starting branch recorded, it skips the restore and says so", () => {
    // Switching to an empty string is a command that does something
    // unpredictable; skipping silently is a run that looks like it tidied up.
    expect(STEP).toContain("RESTORE: NOT_READ");
    expect(STEP).toContain("if (!primaryBranchBefore) {");
    // And nothing downstream of that branch can run: the early return is
    // what makes it a skip rather than a message printed beside a switch.
    const guardAt = STEP.indexOf("if (!primaryBranchBefore) {");
    const switchAt = STEP.indexOf('git switch "$before"');
    expect(switchAt).toBeGreaterThan(guardAt);
    expect(STEP.slice(guardAt, switchAt)).toContain("return `");
  });

  test("the agent is told not to force the deletion past a refusal", () => {
    // The cheapest wrong fix available to an agent that sees the delete
    // step refuse: run `git branch -D` by hand. That destroys the work the
    // refusal exists to protect.
    expect(FINALIZE).toMatch(/do NOT pass --force/);
    expect(FINALIZE).toMatch(/do NOT \\?`git branch -D\\?` it by hand/);
  });

  test("all four reported fields are declared, and the nullable ones admit null", () => {
    // The literal moved into one function so the finalize step and the two
    // terminal exits cannot declare different shapes. A schema is a FILTER
    // on the reply (#646), and a field one caller declares and the other
    // does not is dropped silently on the way back.
    expect(STEP).toContain("branchAfter: { type: 'string' }");
    expect(STEP).toContain("restoreOutcome: { type: 'string' }");
    expect(STEP).toContain("driftReading: { type: 'string' }");
    expect(STEP).toContain("driftRefusal: { type: ['string', 'null'] }");
    expect(STEP).toContain("runBranchDeleted: { type: 'boolean' }");
    expect(STEP).toContain("runBranchDetail: { type: ['string', 'null'] }");
    // …and finalize is handed that one literal rather than a second copy.
    expect(FINALIZE).toContain("schema: runBranchRestoreSchema()");
    expect(SHIP.split("properties: {\n      branchAfter:")).toHaveLength(2);
  });

  /**
   * SC-1 for the FAILING paths, which is the half #692 did not reach.
   *
   * The restore was step 5 of this finalize prompt, so it ran on the success
   * path and nowhere else. Run `wf_9d22ecf5-aed` ended SHIP_FAILED, never
   * reached it, and left the shared primary on `rungate/run-631`.
   *
   * The two funnels are asserted by name here and driven for behaviour in
   * `test/run-branch-restore-exits.test.ts`. Both, deliberately: this file
   * is about the wiring and that one is about what the wiring does, and a
   * case that did both would be two questions in one assertion (#484).
   */
  test("the terminal funnels take the same step, not only the finalize path", () => {
    // Written as two LITERAL cuts rather than a loop over an array.
    //
    // #668's scan reads `structuralCut` call sites out of `test/` and refuses
    // a computed anchor pointed at `workflows/ship.js`, because an anchor it
    // cannot read is one whose uniqueness it cannot check — and these two
    // signatures are exactly the kind that could gain a duplicate. Spelling
    // them out costs one repeated line and keeps the population scannable,
    // which is worth more than the loop.
    const TERMINAL = structuralCut(SHIP, "async function terminalFailure(", { endAnchor: "\n}" });
    const SHIP_FAILED = structuralCut(SHIP, "async function shipFailed(", { endAnchor: "\n}" });
    for (const [name, body] of [["terminalFailure", TERMINAL], ["shipFailed", SHIP_FAILED]] as const) {
      expect(body.length, `${name} cut is empty`).toBeGreaterThan(300);
      expect(body, `${name} does not restore the shared checkout`)
        .toContain("await restorePrimaryCheckout(");
    }
    // The failing path deletes nothing, and says so rather than going quiet.
    expect(STEP).toContain("runBranchRestoreShell({ withDelete: false })");
    expect(STEP).toContain("DELETE: NOT_ATTEMPTED");
  });
});

describe("#640: the run summary says where the checkout ended up", () => {
  test("the finalize path logs through the shared reader, and composes nothing itself", () => {
    // The block that used to hold the reader now holds one call. That is the
    // fix for the position defect, so it is asserted as a BOUND and not just
    // as a presence: a second copy of the composition re-growing here is how
    // the exits lost theirs the first time.
    expect(RESTORE).toContain("readRunBranchRestore(finalizeResult, { withDelete: true })");
    expect(RESTORE.length, "the finalize reader has re-grown its own composition").toBeLessThan(1200);
    expect(RESTORE).not.toContain("RUN_BRANCH_DRIFT:");
  });

  test("ship.js does not make the comparison itself", () => {
    // One binding. `checkoutDrift` in lib/run-branch.ts decides whether a
    // run moved the checkout; a second comparison here would be two
    // deciders that agree, and mutating either would leave the other
    // answering correctly.
    expect(STEP, "a comparison here is the second decider")
      .not.toMatch(/branchAfter\s*[!=]==?\s*primaryBranchBefore/);
    expect(STEP).toContain("r.driftReading");
  });

  test("an absent drift reading is UNMEASURED rather than silence", () => {
    expect(STEP).toContain("|| 'UNMEASURED'");
    expect(STEP).toContain("RUN_BRANCH_UNMEASURED");
    expect(STEP).toContain("is unknown");
  });

  test("a MOVED checkout prints the refusal, and a kept branch prints why", () => {
    expect(STEP).toContain("RUN_BRANCH_DRIFT");
    expect(STEP).toContain("RUN_BRANCH_KEPT");
  });

  test("a delete that reported nothing is UNMEASURED, not a deletion", () => {
    // `runBranchDeleted !== true` covers absent and false alike; without
    // the explicit UNMEASURED arm a reply that dropped the field looks the
    // same as a run with no branch to remove.
    expect(STEP).toContain("r.runBranchDeleted === true");
    expect(STEP).toContain("did not say whether");
  });

  test("every agent-supplied line is flattened and bounded before logging", () => {
    // A newline in an agent string forges a line that looks like ship.js's
    // own. The treatment is now ONE helper rather than four copies of the
    // same expression, which is a strictly stronger version of the property
    // this case has always asserted: there is one thing to mutate, and no
    // interpolation can quietly skip it.
    expect(STEP).toContain("const clean = v => String(v == null ? '' : v).replace(/[\\r\\n]+/g, ' ').slice(0, 500)");
    expect(STEP.split("const clean = v =>")).toHaveLength(2);

    // Every reply field that reaches a log line goes through it. Asserted by
    // enumeration rather than by a count, because a count is satisfied by
    // any four occurrences and the property is about WHICH fields (#532).
    for (const field of ["r.driftRefusal", "r.runBranchDetail", "r.restoreOutcome", "r.driftReading"]) {
      expect(STEP, `${field} reaches a log line unflattened`).toContain(`clean(${field})`);
    }
  });
});
