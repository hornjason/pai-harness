/**
 * A run that does not ship leaves no mergeable PR behind (#252, criterion 3)
 *
 * Run `wf_e105dd33-220` returned `SHIP_FAILED` and left PR #250 open, not a
 * draft, `mergeable: MERGEABLE`, carrying the `resolveManagedWrite` defect that
 * destroyed a consumer's CI. Nothing had gone wrong with the refusal — the
 * refusal was correct. The problem is WHERE the PR is opened: `ship.js` opens
 * it in the `record-env-and-pr` step, and the ship gate, the blocking-grade
 * check, the security staleness refusal and the suite staleness refusal all
 * run AFTER it. Every one of those can refuse with a reviewable PR already
 * sitting on the branch, and a human reading the PR list cannot tell it from
 * one the harness stands behind.
 *
 * The fix is not a cleanup step. A cleanup step is another thing that has to
 * run, on a path that by definition is the one where things stopped running.
 * The PR is opened as a DRAFT and is marked ready only at the terminal, once
 * nothing is left that can refuse — so the default, including the default when
 * the run dies mid-flight or is killed, is the state the run actually earned.
 *
 * Two halves, tested two ways:
 *
 *  - Does `--draft` reach GitHub? `test/github-op.test.ts` answers that
 *    against a loopback server, asserting the request body, not the flag.
 *  - Does the run decide correctly WHETHER to undraft? That is this file, and
 *    the decision function is EXTRACTED BY MARKER AND EXECUTED rather than
 *    grepped — PROJECT-STATE.md records that every mutation surviving a first
 *    pass in this repo has been a source-text assertion.
 *
 * WHAT WAS BROKEN TO PROVE THESE FAIL (.claude/rules/checks-must-be-able-to-fail.md):
 * the mutants in the last describe are built here, on every run, from the real
 * block. Each builder throws if its substitution changes nothing, so a rename
 * aborts this file rather than passing it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

/**
 * Both blocks, because the readiness decision ranks a status on the strength
 * scale the status block owns. Slicing the readiness block alone would run it
 * with `SHIP_STATUS_STRENGTH` undefined, and a ReferenceError at call time
 * reads as "the function refused" in exactly the cases this file cares about.
 */
const STATUS_START = "// ──── PROVE-STATUS-START ────";
const STATUS_END = "// ──── PROVE-STATUS-END ────";
const READY_START = "// ──── PR-READINESS-START ────";
const READY_END = "// ──── PR-READINESS-END ────";

/**
 * Module scope on purpose: a missing marker throws while this file is loading,
 * so every test below fails to run. Resolving it lazily and skipping when
 * absent turns "ship.js lost its draft logic" into a quiet green run.
 */
function sliceBlock(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`workflows/ship.js is missing the ${start} / ${end} markers`);
  }
  if (source.indexOf(start, a + 1) !== -1 || source.indexOf(end, b + 1) !== -1) {
    throw new Error(`${start} / ${end} appears more than once — the slice is ambiguous`);
  }
  return source.slice(a, b);
}

const BLOCK =
  sliceBlock(shipSource, STATUS_START, STATUS_END) +
  "\n" +
  sliceBlock(shipSource, READY_START, READY_END);

interface Readiness {
  action: string;
  number: number | null;
  reason: string | null;
}
type ReadinessFor = (status: unknown, pr: unknown) => Readiness;

/**
 * Compile one extracted block and hand back its `prReadiness`.
 *
 * `new Function` over this repository's own workflows/ship.js, read at test
 * time — the same trust boundary as importing it, which the Workflow sandbox
 * makes impossible (#69). Never give it a source from elsewhere.
 */
function loadReadiness(block: string): ReadinessFor {
  const fn = new Function(`${block}\nreturn prReadiness`)();
  if (typeof fn !== "function") {
    throw new Error("the PR-READINESS block does not define prReadiness");
  }
  return fn as ReadinessFor;
}

const readiness = loadReadiness(BLOCK);

/** What the `record-env-and-pr` step reports when it opened a PR. */
const OPENED = { ok: true, prNumber: 250, prUrl: "https://x/pull/250" };

/** The statuses the run can reach its terminal with, weakest first. */
const TERMINAL_STATUSES = [
  "SHIP_PASSED_SUITE_FAILED",
  "SHIP_PASSED_SUITE_UNMEASURED",
  "SHIP_PASSED_PROVE_FAILED",
  "SHIPPED_UNPROVEN",
  "SHIPPED_AND_PROVEN",
] as const;

/**
 * The line between "the harness stands behind this" and "it got this far".
 *
 * SHIPPED_UNPROVEN is above it, and that is a decision rather than an
 * oversight: for a LIGHT-ceremony issue with no UI criteria, prove is skipped
 * BY DESIGN, the verify gate having already run every evidence command. The
 * three below the line each name something that was measured and came back
 * short — a red suite, an unreadable suite, a prove step that ran and failed.
 */
const READY = ["SHIPPED_UNPROVEN", "SHIPPED_AND_PROVEN"];
const NOT_READY = ["SHIP_PASSED_SUITE_FAILED", "SHIP_PASSED_SUITE_UNMEASURED", "SHIP_PASSED_PROVE_FAILED"];

describe("#252: the PR is opened as a draft", () => {
  test("the pr-upsert command passes --draft", () => {
    // A source assertion, deliberately, and deliberately not the only one:
    // test/github-op.test.ts proves `--draft` produces `draft: true` in the
    // request GitHub receives. This one proves ship.js asks for it. Neither
    // alone is the property; the pair is.
    const upsert = shipSource.match(/github-op\.ts pr-upsert[\s\S]{0,400}?\n\n/);
    expect(upsert, "ship.js no longer contains a pr-upsert command").not.toBeNull();
    expect(upsert![0], "the ship PR is opened without --draft, so a refusal leaves it mergeable")
      .toContain("--draft");
  });

  test("the run has a way to take it out of draft", () => {
    expect(shipSource, "ship.js never calls pr-ready, so every PR it opens stays a draft forever")
      .toContain("github-op.ts pr-ready");
  });

  test("the undraft call is downstream of every refusal", () => {
    // Position is the whole mechanism. If the pr-ready call sat beside the
    // upsert, the draft would be decorative — this asserts the two are
    // separated by the gate that most often refuses.
    const upsertAt = shipSource.indexOf("github-op.ts pr-upsert");
    const readyAt = shipSource.indexOf("github-op.ts pr-ready");
    const shipGateAt = shipSource.indexOf("log('Running ship gate')");
    expect(upsertAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(shipGateAt).toBeGreaterThan(upsertAt);
    expect(readyAt, "pr-ready runs before the ship gate, so a ship-gate refusal still leaves a mergeable PR")
      .toBeGreaterThan(shipGateAt);
  });
});

describe("#252: which terminals earn a reviewable PR", () => {
  test.each(READY)("%s marks the PR ready", status => {
    const r = readiness(status, OPENED);
    expect(r.action).toBe("MARK_READY");
    expect(r.number).toBe(250);
  });

  test.each(NOT_READY)("%s leaves it a draft", status => {
    const r = readiness(status, OPENED);
    expect(r.action).toBe("LEAVE_DRAFT");
    // The reason is reported, not just the action: the criterion asks for
    // WHICH of the two outcomes happened to be recorded, and "LEAVE_DRAFT" with no cause is
    // the artefact that sent me reading run logs in the first place.
    expect(r.reason, `${status} left a draft with no recorded reason`).toBeTruthy();
    expect(r.reason).toContain(status);
  });

  test("every terminal status the run can report is ranked by this decision", () => {
    // A status nobody classified is the gap that makes a rule decorative. This
    // asserts the two lists above are the whole vocabulary, so adding a status
    // to ship.js without deciding what it means for the PR turns this red.
    expect([...READY, ...NOT_READY].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  test.each([
    ["an unranked status", "SHIPPED_SIDEWAYS"],
    ["the empty string", ""],
    ["a prototype key", "constructor"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 0],
    ["an object", {}],
  ])("%s leaves it a draft — unrecognised is not earned", (_label, status) => {
    expect(readiness(status, OPENED).action).toBe("LEAVE_DRAFT");
  });
});

describe("#252: no PR is not a PR to mark ready", () => {
  test.each([
    ["the step was never reached", null],
    ["the step reported failure", { ok: false, detail: "422" }],
    ["ok with no number", { ok: true }],
    ["a non-integer number", { ok: true, prNumber: 1.5 }],
    ["zero", { ok: true, prNumber: 0 }],
    ["a negative number", { ok: true, prNumber: -3 }],
    ["a string number", { ok: true, prNumber: "250" }],
    ["a number on a failed step", { ok: false, prNumber: 250 }],
  ])("%s reports NO_PR rather than marking something ready", (_label, pr) => {
    const r = readiness("SHIPPED_AND_PROVEN", pr);
    expect(r.action).toBe("NO_PR");
    expect(r.number).toBeNull();
  });
});

/**
 * The mutants. Each is built from the real block at run time, and each builder
 * throws if its substitution changed nothing — so a rename aborts this file
 * instead of quietly passing it.
 */
function mutate(find: string, replace: string): ReadinessFor {
  if (!BLOCK.includes(find)) {
    throw new Error(`could not build the mutant: ${JSON.stringify(find)} appears 0 times in the block`);
  }
  return loadReadiness(BLOCK.replace(find, replace));
}

describe("#252: the decision can fail", () => {
  test("dropping the threshold makes a red-suite run mark its PR ready", () => {
    // The real source leaves it a draft; the mutant does not. The second half
    // is the point — without it, a case that later passes for an unrelated
    // reason is indistinguishable from one that is genuinely caught.
    expect(readiness("SHIP_PASSED_SUITE_FAILED", OPENED).action).toBe("LEAVE_DRAFT");
    const mutant = mutate(
      "const SHIP_STATUS_READY_THRESHOLD = 'SHIPPED_UNPROVEN'",
      "const SHIP_STATUS_READY_THRESHOLD = 'SHIP_PASSED_SUITE_FAILED'",
    );
    expect(mutant("SHIP_PASSED_SUITE_FAILED", OPENED).action).toBe("MARK_READY");
  });

  test("a threshold the scale has never heard of leaves everything a draft", () => {
    // The fail-open this is here to rule out: `indexOf` returns -1 for an
    // unknown threshold, and `rank >= -1` is true for every status, so a
    // renamed constant would undraft a failed run. Fail-closed instead.
    const mutant = mutate(
      "const SHIP_STATUS_READY_THRESHOLD = 'SHIPPED_UNPROVEN'",
      "const SHIP_STATUS_READY_THRESHOLD = 'NOT_ON_THE_SCALE'",
    );
    for (const status of TERMINAL_STATUSES) {
      expect(mutant(status, OPENED).action, `${status} was undrafted by an unrankable threshold`)
        .toBe("LEAVE_DRAFT");
    }
  });

  test("ranking the status at all is load-bearing", () => {
    const mutant = mutate("const rank = ", "const rank = 99; const unusedRank = ");
    expect(mutant("SHIP_PASSED_SUITE_FAILED", OPENED).action).toBe("MARK_READY");
  });
});
