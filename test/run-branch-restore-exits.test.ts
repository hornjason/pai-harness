/**
 * Covers SC-2117, SC-2118 (HARNESS-STANDARD.md), #640.
 *
 * #692 built `scripts/check-run-branch.ts`, wired its three modes into
 * `workflows/ship.js`, and proved criteria 3, 4 and 6 against a real branch.
 * The restore was step 5 of the post-prove finalize prompt — so it ran on the
 * SUCCESS path and nowhere else. Run `wf_9d22ecf5-aed` ended SHIP_FAILED,
 * never reached step 5, and left the shared primary on `rungate/run-631`,
 * where a second session found it the next morning.
 *
 * That is the half of criterion 1 the happy path hides, and it is the reason
 * this file exists rather than another case in the existing run-branch tests:
 * **the defect is a position, not a value.** Every assertion anyone could
 * make about the restore shell was true of the version that never ran. What
 * had to be asserted is WHERE it is called from.
 *
 * So the first describe reads the two terminal funnels out of ship.js and
 * asks whether each one takes the step, and the mutation that proves it is
 * the pre-fix source: the real file reports both funnels restoring, a copy
 * with the two calls removed reports neither.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { anchorOccurrences, structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

const RESTORE_BLOCK = block("RUN-BRANCH-RESTORE-STEP");

/** The call that makes an exit restore. One literal, so there is one thing to mutate. */
const RESTORE_CALL = "await restorePrimaryCheckout(";

/** The two funnels, by the signature each is declared with. */
const FUNNELS = [
  "async function terminalFailure(",
  "async function shipFailed(",
] as const;

/**
 * The end of a funnel's body: its closing brace at column zero.
 *
 * NOT `{ balanced: "{" }`, and the reason is worth recording rather than
 * discovering twice. `balancedEnd` searches for the first `{` from the
 * ANCHOR's start, and both of these functions take `extra = {}` — so the
 * balanced form matches that empty object literal inside the signature and
 * cuts a region that ends before the body begins. `structuralCut` refuses it
 * rather than returning the short cut, which is the whole point of #664's
 * helper and is how this was caught in one run instead of silently asserting
 * against a signature.
 */
const FUNNEL_END = { endAnchor: "\n}" } as const;

/**
 * Which terminal funnels in `source` take the restore step, and which do not.
 *
 * The slice is STRUCTURAL — `structuralCut` with a balanced brace, so the
 * region ends where the function ends. A fixed character window would be a
 * guess about how long these funnels stay their current size, which is #664
 * exactly: the guess decays silently and the day it fails it accuses the
 * wrong code.
 *
 * A funnel whose slice could not be taken is a VIOLATION, not a pass. An
 * empty string contains nothing, and "contains nothing" is indistinguishable
 * from "does not call the restore" — the same way round as every other
 * unreadable-position refusal in this tree (#621).
 */
function funnelBody(source: string, anchor: string): string {
  try {
    return structuralCut(source, anchor, FUNNEL_END);
  } catch {
    return "";
  }
}

/**
 * The SINGLE place a funnel is cut, and the reason it is a parameter.
 *
 * #668's scan reads `structuralCut` call sites out of `test/` and refuses a
 * COMPUTED anchor pointed at `workflows/ship.js`, because an anchor it cannot
 * read is an anchor whose uniqueness it cannot check. That is a real bound
 * and this file was tripping it — so rather than exempt the file, the
 * property the scan wanted is asserted here directly, by name, in the case
 * below. The loop stays, because two hand-written copies of the same cut are
 * a pair that can drift (#585).
 */
function exitRestoreReadings(source: string): Array<{ funnel: string; restores: boolean; readable: boolean }> {
  return FUNNELS.map((anchor) => {
    const body = funnelBody(source, anchor);
    return {
      funnel: anchor,
      readable: body.length > 0,
      restores: body.length > 0 && body.includes(RESTORE_CALL),
    };
  });
}

describe("SC-2117: both terminal funnels restore the shared checkout", () => {
  test("every funnel's body is readable, and names the thing that is NOT the subject", () => {
    // The vacuity guard. Without it, a rename of either funnel turns every
    // case below into a claim about an empty string — which contains neither
    // the restore call nor anything else, and so would read as a detected
    // violation for a reason that has nothing to do with the restore.
    const readings = exitRestoreReadings(shipSource);
    expect(readings).toHaveLength(2);
    for (const r of readings) expect(r.readable).toBe(true);

    // The positive control: both funnels already preserved worktrees before
    // #640 touched them, and that call is NOT what this file is about. If it
    // is missing, the slice is wrong rather than the restore.
    for (const anchor of FUNNELS) {
      expect(funnelBody(shipSource, anchor)).toContain("preserveSeenWorktrees(");
    }
  });

  test("each funnel anchor occurs exactly once in ship.js", () => {
    // The property #668's scan asks of every literal anchor, asserted here
    // because these are computed and the scan cannot read them. It is not a
    // formality: `structuralCut` refuses an ambiguous anchor by throwing, and
    // `funnelBody` turns a throw into an empty string — so without this, a
    // duplicated signature would read as a funnel that does not restore,
    // which is a true-looking failure pointed at the wrong code.
    for (const anchor of FUNNELS) {
      expect(anchorOccurrences(shipSource, anchor), `${anchor} is not unique`).toBe(1);
    }
  });

  test("both funnels take the restore step", () => {
    for (const r of exitRestoreReadings(shipSource)) {
      expect({ funnel: r.funnel, restores: r.restores }).toEqual({ funnel: r.funnel, restores: true });
    }
  });

  test("the restore runs AFTER preservation in each funnel, not before", () => {
    // Order is the property, not presence. The restore moves the shared
    // checkout; work with no ref of its own at that moment is work nobody
    // can find afterwards, which is #232's whole subject.
    for (const anchor of FUNNELS) {
      const body = funnelBody(shipSource, anchor);
      const preserveAt = body.indexOf("preserveSeenWorktrees(");
      const restoreAt = body.indexOf(RESTORE_CALL);
      expect(preserveAt).toBeGreaterThanOrEqual(0);
      expect(restoreAt).toBeGreaterThan(preserveAt);
    }
  });

  test("the pre-#640-phase-2 source reports NEITHER funnel restoring", () => {
    // The mutation, and it is the defect verbatim rather than a
    // reconstruction of it: removing the two calls is exactly the state
    // `workflows/ship.js` was in when wf_9d22ecf5-aed left the primary on
    // rungate/run-631.
    //
    // Both halves are asserted. "The mutant reports a violation" alone passes
    // over a binding that reports a violation for everything; the real-source
    // half above is what says this one can come back clean.
    const mutant = shipSource.split(RESTORE_CALL).join("await Promise.resolve(");
    expect(mutant).not.toBe(shipSource);

    const readings = exitRestoreReadings(mutant);
    expect(readings).toHaveLength(2);
    for (const r of readings) {
      expect(r.readable).toBe(true);
      expect({ funnel: r.funnel, restores: r.restores }).toEqual({ funnel: r.funnel, restores: false });
    }
  });
});

// ── the shell, and the reading of what it reported ────────────────────────

interface RestoreRead {
  reading: string;
  restoreOutcome: string;
  lines: string[];
}

interface Harness {
  shell: (opts: { withDelete: boolean }) => string;
  read: (reply: unknown, opts: { withDelete: boolean }) => RestoreRead;
  schema: () => Record<string, unknown>;
}

const PROJECT = "/Users/dev/proj";
const HARNESS = "/Users/dev/rungate";
const ISSUE = 640;

/**
 * The real block, evaluated with its module-scope dependencies injected.
 *
 * `primaryBranchBefore` is a parameter here because its VALUE is the thing
 * several cases vary, and an empty one is a reading rather than a default:
 * a run that never read where the checkout started cannot claim to have put
 * it back.
 */
function load(primaryBranchBefore: string): Harness {
  const fn = new Function(
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    "ISSUE",
    "primaryBranchBefore",
    "shellQuote",
    "runRefName",
    "log",
    "timedAgent",
    `${RESTORE_BLOCK}\nreturn { shell: runBranchRestoreShell, read: readRunBranchRestore, schema: runBranchRestoreSchema }`,
  );
  return fn(
    PROJECT,
    HARNESS,
    ISSUE,
    primaryBranchBefore,
    (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`,
    (issue: number) => `rungate/run-${issue}`,
    () => {},
    async () => ({}),
  ) as Harness;
}

const DELETE_COMMAND = "--mode delete";

describe("SC-2118: the shell is one binding, and a failing run deletes nothing", () => {
  test("the delete is attempted on the shipping path and NOT on the failing one", () => {
    // The pair varies exactly one input (#585), so the difference can only be
    // explained by `withDelete`.
    const h = load("main");
    const shipping = h.shell({ withDelete: true });
    const failing = h.shell({ withDelete: false });

    expect(shipping).toContain(DELETE_COMMAND);
    expect(failing).not.toContain(DELETE_COMMAND);
    expect(failing).toContain("DELETE: NOT_ATTEMPTED");

    // Non-vacuous: the two differ ONLY around the delete. Everything else —
    // the conditional switch, the drift reading — is in both, so this is a
    // measurement of the delete and not of two unrelated strings.
    for (const shared of ['git switch "$before"', "--mode drift", 'echo "AFTER: $after"']) {
      expect(shipping).toContain(shared);
      expect(failing).toContain(shared);
    }
  });

  test("the switch is conditional on the checkout being on THIS run's ref", () => {
    const shell = load("main").shell({ withDelete: true });
    expect(shell).toContain("rungate/run-640");
    // A peer that moved the shared checkout onto a third branch must not have
    // it yanked away by a run that never put it there.
    expect(shell).toContain("FOREIGN_BRANCH");
  });

  test("a run that never read the starting branch switches nothing and says so", () => {
    const shell = load("").shell({ withDelete: true });
    expect(shell).toContain("RESTORE: NOT_READ");
    expect(shell).not.toContain("git switch");
    expect(shell).not.toContain(DELETE_COMMAND);
  });

  test("the shell literal appears exactly once in ship.js", () => {
    // One binding, so there is one thing to mutate. A second hand-written
    // copy at another call site would survive any mutation of this one and
    // the case above would stay green over a dead binding
    // (.claude/rules/checks-must-be-able-to-fail.md, the fourth shape).
    expect(shipSource.split('git switch "$before"')).toHaveLength(2);
    expect(shipSource.split("function runBranchRestoreShell(")).toHaveLength(2);
    // …and both callers — the failing exits and the finalize step — reach it
    // through that one function.
    expect(shipSource.split("runBranchRestoreShell({").length - 1).toBe(2);
  });

  test("every field the shell asks for is declared by the schema", () => {
    // A schema is a FILTER on the reply: an undeclared field is stripped
    // silently on the way back, and the caller then reads a reply missing
    // exactly what it did not ask for (#646). Both callers use this one
    // literal, so they cannot drift apart.
    const props = Object.keys((load("main").schema() as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(
      ["branchAfter", "driftReading", "driftRefusal", "runBranchDeleted", "runBranchDetail", "restoreOutcome"].sort(),
    );
    // Three: the declaration, and the two call sites that cannot drift apart.
    expect(shipSource.split("runBranchRestoreSchema()").length - 1).toBe(3);
  });
});

describe("SC-2118: silence is UNMEASURED, on both paths", () => {
  const joined = (r: RestoreRead) => r.lines.join(" | ");

  test("a clean drift reading says the checkout came back", () => {
    const r = load("main").read({ driftReading: "UNCHANGED", restoreOutcome: "SWITCHED_BACK" }, { withDelete: false });
    expect(joined(r)).toContain("back on main");
    expect(joined(r)).not.toContain("UNMEASURED");
  });

  test("an empty reply is UNMEASURED and never clean", () => {
    // The pair varies one thing against the case above. `{}` is what an
    // agent that did not run the step returns, and it must not be
    // indistinguishable from success.
    const r = load("main").read({}, { withDelete: false });
    expect(joined(r)).toContain("RUN_BRANCH_UNMEASURED");
    expect(joined(r)).not.toContain("back on main");
  });

  test("a run that never read the starting branch is UNMEASURED whatever it reports", () => {
    // The dangerous input: an agent restating UNCHANGED for a run that had
    // no `before` to compare against. Comparing two empty strings is
    // equality, which is how a check that never happened passes.
    const r = load("").read({ driftReading: "UNCHANGED", restoreOutcome: "ALREADY_ON_START" }, { withDelete: false });
    expect(joined(r)).toContain("RUN_BRANCH_UNMEASURED");
    expect(joined(r)).toContain("never read");
  });

  test("a refusal is printed verbatim rather than summarised", () => {
    const r = load("main").read(
      { driftReading: "MOVED", driftRefusal: "the checkout moved from main to rungate/run-640" },
      { withDelete: false },
    );
    expect(joined(r)).toContain("RUN_BRANCH_DRIFT");
    expect(joined(r)).toContain("rungate/run-640");
  });

  test("a failing run states that it kept the branch, rather than saying nothing", () => {
    // The silence this replaces is the one that cost #640 a morning: an exit
    // that neither deleted nor explained reads exactly like an exit that
    // forgot the step.
    const r = load("main").read({ driftReading: "UNCHANGED" }, { withDelete: false });
    expect(joined(r)).toContain("rungate/run-640 kept");
    expect(joined(r)).toContain("unmerged work");
  });

  test("a shipping run that did not say whether the branch went is UNMEASURED", () => {
    const r = load("main").read({ driftReading: "UNCHANGED" }, { withDelete: true });
    expect(joined(r)).toContain("RUN_BRANCH_UNMEASURED");
    expect(joined(r)).toContain("was removed");
  });

  test("a foreign branch is reported even when the drift reading is clean", () => {
    // The two answer different questions — "is it where it started" and "did
    // this run decline to touch it" — so one must not be able to silence the
    // other.
    const r = load("main").read(
      { driftReading: "UNCHANGED", restoreOutcome: "FOREIGN_BRANCH" },
      { withDelete: false },
    );
    expect(joined(r)).toContain("RUN_BRANCH_FOREIGN");
    expect(joined(r)).toContain("back on main");
  });

  test("a failed switch is reported, not folded into the drift reading", () => {
    const r = load("main").read(
      { driftReading: "MOVED", driftRefusal: "still on rungate/run-640", restoreOutcome: "SWITCH_FAILED" },
      { withDelete: false },
    );
    expect(joined(r)).toContain("RUN_BRANCH_RESTORE_FAILED");
  });
});
