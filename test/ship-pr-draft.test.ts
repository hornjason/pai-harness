/**
 * A run that does not ship leaves no mergeable PR behind (#252, criterion 3)
 *
 * Run `wf_e105dd33-220` returned `SHIP_FAILED` and left PR #250 open, not a
 * draft, `mergeable: MERGEABLE`, carrying the `resolveManagedWrite` defect that
 * destroyed a consumer's CI. Nothing had gone wrong with the refusal — the
 * refusal was correct. The problem is WHERE the PR is opened: `ship.js` opens
 * it in the `open-pr` step, and the ship gate, the blocking-grade
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
type ReadinessFor = (status: unknown, pr: unknown, ci?: unknown) => Readiness;

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

/** What the `open-pr` step reports when it opened a PR. */
const OPENED = { ok: true, prNumber: 250, prUrl: "https://x/pull/250" };

/**
 * What the `ci-verify` step reports when CI was green (#46).
 *
 * Passed explicitly by every case below rather than defaulted inside
 * `prReadiness`, and that is the whole design: an absent reading means nobody
 * looked, and the decision treats it as a reason to leave the draft. A default
 * would make "CI passed" and "CI was never read" the same input.
 */
const CI_PASS = { verdict: "PASS", workflowCount: 2, reason: "all 2 checks passed" };

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
    const r = readiness(status, OPENED, CI_PASS);
    expect(r.action).toBe("MARK_READY");
    expect(r.number).toBe(250);
  });

  test.each(NOT_READY)("%s leaves it a draft", status => {
    const r = readiness(status, OPENED, CI_PASS);
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
    expect(readiness(status, OPENED, CI_PASS).action).toBe("LEAVE_DRAFT");
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
    const r = readiness("SHIPPED_AND_PROVEN", pr, CI_PASS);
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
    expect(readiness("SHIP_PASSED_SUITE_FAILED", OPENED, CI_PASS).action).toBe("LEAVE_DRAFT");
    const mutant = mutate(
      "const SHIP_STATUS_READY_THRESHOLD = 'SHIPPED_UNPROVEN'",
      "const SHIP_STATUS_READY_THRESHOLD = 'SHIP_PASSED_SUITE_FAILED'",
    );
    expect(mutant("SHIP_PASSED_SUITE_FAILED", OPENED, CI_PASS).action).toBe("MARK_READY");
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
      expect(mutant(status, OPENED, CI_PASS).action, `${status} was undrafted by an unrankable threshold`)
        .toBe("LEAVE_DRAFT");
    }
  });

  test("ranking the status at all is load-bearing", () => {
    const mutant = mutate("const rank = ", "const rank = 99; const unusedRank = ");
    expect(mutant("SHIP_PASSED_SUITE_FAILED", OPENED, CI_PASS).action).toBe("MARK_READY");
  });
});

/**
 * #46 — CI gates the undrafting, and nothing else.
 *
 * Covers SC-1771..SC-1774 (HARNESS-STANDARD.md).
 *
 * These live beside #252's cases rather than in `test/ci-verification.test.ts`
 * because `prReadiness` has one owner and extracting the same marked block
 * twice would be two places to drift. The verdict-building half is over there;
 * this is what the harness DOES with a verdict.
 *
 * The lever is the draft, not the run. `workflows/ship.js` does not merge
 * anything — it opens a draft PR and marks it ready once nothing is left that
 * can refuse. So "FAIL the ship gate if CI fails" lands here: a run whose CI
 * is red has not earned a mergeable PR, and a draft is the state it actually
 * earned (#252). Failing the whole run instead would throw away the prove
 * evidence and the PR body for a condition a re-run of CI might clear.
 */
describe("#46: CI's verdict decides whether the PR stops being a draft", () => {
  test("SC-1771: a red CI leaves the PR a draft and names the failure", () => {
    const r = readiness("SHIPPED_AND_PROVEN", OPENED, {
      verdict: "FAIL",
      workflowCount: 2,
      reason: "CI failed on abc1234: test",
    });
    expect(r.action).toBe("LEAVE_DRAFT");
    expect(r.number).toBe(250);
    expect(r.reason).toContain("CI failed");
    expect(r.reason).toContain("test");

    // The control, without which the row above is satisfied by anything that
    // leaves a draft for any reason at all.
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, CI_PASS).action).toBe("MARK_READY");
  });

  test("SC-1772: a CI reading that is not a pass is not a pass - however it is malformed", () => {
    // UNMEASURED is the one worth being careful about: the code may well be
    // fine and nobody has looked. That is still not a pass, and the PR being
    // reviewable rather than mergeable costs a click.
    for (const ci of [
      { verdict: "UNMEASURED", workflowCount: 2, reason: "still running: gates" },
      { verdict: "UNMEASURED", workflowCount: 2 },
      { verdict: "SHIPPED", workflowCount: 2 },
      { verdict: "pass", workflowCount: 2 },
      { verdict: "", workflowCount: 2 },
      { verdict: null, workflowCount: 2 },
      { workflowCount: 2 },
      { verdict: "PASS", workflowCount: "2" },
      { verdict: "PASS" },
      {},
    ]) {
      const r = readiness("SHIPPED_AND_PROVEN", OPENED, ci);
      expect(r.action, `${JSON.stringify(ci)} earned a mergeable PR`).toBe("LEAVE_DRAFT");
      expect(r.reason, `${JSON.stringify(ci)} left a draft with no recorded reason`).toBeTruthy();
    }

    // A lowercase "pass" is in that list deliberately. `verdict === 'PASS'` is
    // the only accepting comparison, so every other spelling falls through to
    // the refusal rather than to a looser match somebody adds later.
  });

  test("SC-1773: no reading at all is not a pass - an unread CI is the default state", () => {
    // The fail-open this whole issue exists to prevent, in its most likely
    // form: the step was never reached, errored, or was removed, and the run
    // undrafts because nothing said no. Every absent shape lands on the same
    // refusal.
    for (const ci of [undefined, null, 0, "", "PASS", [], false]) {
      const r = readiness("SHIPPED_AND_PROVEN", OPENED, ci);
      expect(r.action, `${JSON.stringify(ci ?? null)} earned a mergeable PR`).toBe("LEAVE_DRAFT");
      expect(r.reason).toContain("not");
    }
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, undefined).reason).toContain("CI was not read");
  });

  test("SC-1774: a project with no workflows has no CI to wait for and is not blocked", () => {
    // Without this the gate would leave every PR a draft forever for any
    // consumer who has no GitHub Actions — which is how a correct check gets
    // switched off within a week.
    const r = readiness("SHIPPED_AND_PROVEN", OPENED, { verdict: "UNMEASURED", workflowCount: 0, reason: "no check has been recorded" });
    expect(r.action).toBe("MARK_READY");

    // And the exemption is keyed on a COUNT the shell produced, not on the
    // verdict. "No workflows" and "workflows that have not reported" are
    // different facts, and a reading that cannot tell them apart is refused
    // rather than given the benefit of the doubt.
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, { verdict: "UNMEASURED", reason: "x" }).action).toBe("LEAVE_DRAFT");
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, { verdict: "UNMEASURED", workflowCount: null }).action).toBe("LEAVE_DRAFT");

    // A count of zero does not rescue a status that was never earned, either
    // — the two conditions are independent and CI is checked last.
    expect(readiness("SHIP_PASSED_SUITE_FAILED", OPENED, { verdict: "UNMEASURED", workflowCount: 0 }).action).toBe("LEAVE_DRAFT");
  });

  test("SC-1775: removing the CI condition undrafts a run CI called red", () => {
    // The mutation, built from the real block so a rename aborts the file.
    const mutant = mutate("const ciReason = ciBlocksReadiness(ci)", "const ciReason = null");
    const red = { verdict: "FAIL", workflowCount: 2, reason: "CI failed on abc1234: test" };
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, red).action).toBe("LEAVE_DRAFT");
    expect(mutant("SHIPPED_AND_PROVEN", OPENED, red).action).toBe("MARK_READY");

    // And the weaker mutation that the cheapest repair reaches for: treating
    // an absent reading as acceptable. It leaves the FAIL case working, so a
    // battery that only planted a red CI would call this fixed.
    const lenient = mutate(
      "return 'CI was not read for this run, and an unread CI is not a passing one'",
      "return null",
    );
    expect(lenient("SHIPPED_AND_PROVEN", OPENED, red).action, "the lenient mutant still catches a red CI")
      .toBe("LEAVE_DRAFT");
    expect(lenient("SHIPPED_AND_PROVEN", OPENED, undefined).action).toBe("MARK_READY");
    expect(readiness("SHIPPED_AND_PROVEN", OPENED, undefined).action).toBe("LEAVE_DRAFT");
  });
});

/**
 * #46 — the undraft is enforced by the shell, not by a reply.
 *
 * Covers SC-1776, SC-1777 (HARNESS-STANDARD.md).
 *
 * `prReadiness` above decides on a CI reading that reached the workflow as
 * text an agent typed. A step that answered `{verdict:"PASS"}` without running
 * anything gets past every branch of it, and nothing downstream could tell —
 * which would make the CI gate exactly the kind of check #46 was filed to
 * replace, one layer up.
 *
 * `workflows/ship.js` cannot close that itself: no filesystem, no subprocess
 * (#69). What it can do is make the undraft require a live pass, by chaining
 * `pr-ready` behind `ci-status` in one shell command. The `&&` is the
 * enforcement; `prReadiness` is the record.
 */
describe("#46: the undraft cannot happen without a live CI pass", () => {
  const PROVE_TAIL = shipSource.slice(shipSource.indexOf("label: 'ci-verify'"));

  test("SC-1776: pr-ready is chained behind ci-status and never issued alone", () => {
    const chain = /ci-status[^\n]*\\\s*\n\s*&&\s*bun [^\n]*pr-ready/;
    expect(PROVE_TAIL, "the ci-status && pr-ready chain is gone").toMatch(chain);

    // Every `pr-ready` invocation in the undraft step is either the chained
    // one or the no-workflows branch. A third, unchained one would be the
    // bypass — it reads as a harmless duplicate and undoes the whole thing.
    const invocations = [
      ...PROVE_TAIL.matchAll(/bun --cwd \$\{shellQuote\(HARNESS_ROOT\)\} scripts\/github-op\.ts pr-ready/g),
    ];
    expect(invocations).toHaveLength(2);

    // And the exemption branch is guarded by the workflow count rather than
    // standing on its own, so "no CI configured" is the only way to reach an
    // unchained undraft.
    const exempt = PROVE_TAIL.slice(0, invocations[0]!.index);
    expect(exempt).toMatch(/if \[ "\$workflows" -eq 0 \]; then\s*\n\s*$/);
  });

  test("SC-1777: the SHA and the workflow count come from the shell - not from the agent", () => {
    // Both facts the chain turns on are computed in the command itself. An
    // agent that supplies either one is supplying the answer to the question
    // being asked — and `--sha` is the field that decides WHICH commit's CI
    // is consulted, so a typed value is a stale-reading primitive.
    const undraft = PROVE_TAIL.slice(PROVE_TAIL.indexOf("Take the PR out of draft"));
    // Both name their directory on the command since #1056 — the block no
    // longer reaches `${commitDir}` by moving the session into it.
    expect(undraft).toContain("sha=$(git -C ${shellQuote(commitDir)} rev-parse HEAD)");
    expect(undraft).toMatch(
      /workflows=\$\(find \$\{shellQuote\(commitDir\)\}\/\.github\/workflows[^\n]*wc -l/,
    );
    expect(undraft).toContain('--sha "$sha"');

    // …and a count of 0 is a READING, not the shape a broken probe also
    // produces. `ls <dir>/*.yml <dir>/*.yaml` returned 0 under zsh for a
    // repository holding `ci.yml`, because an unmatched second glob aborts
    // the command — and 0 is the branch that undrafts WITHOUT reading CI.
    expect(
      undraft,
      "the probe no longer distinguishes 'no CI configured' from 'could not look', " +
        "and the two reach the same undraft-without-checking branch",
    ).toContain("WORKFLOW_PROBE_FAILED");

    // The interpolated values that ARE allowed are the ones ship.js knows
    // first-hand: the repo slug and the PR number it opened. Neither is a
    // measurement.
    expect(undraft).not.toMatch(/--sha \$\{/);

    // The instruction says why, because a step that does not know why the
    // commands are joined will helpfully split them when one fails.
    expect(undraft).toContain("is not yours to split");
  });
});
