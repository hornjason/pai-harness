/**
 * ai-review-failure-route.test.ts — the report step's FAILURE branch names a
 * route it measured, instead of asserting one it did not (#826).
 *
 * ## What #849 fixed, and the branch it did not reach
 *
 * #826 has two halves. Its second is *"the message asserts a cause it did not
 * measure"*, and `ba69a7af` (#849) answered it with four measured routes —
 * **all four inside `if [ "${AI_REVIEW_ACTION_OUTCOME}" = success ]`**
 * (`buildReviewRunScript`). The `else` fall-through below it was untouched and
 * still carries the original shape: one sentence, printed unconditionally,
 * naming the Claude Code GitHub App as *"the usual cause"*.
 *
 * `continue-on-error: true` on the action step is why nobody noticed. The
 * step's CONCLUSION is `success` while its OUTCOME is `failure`, so the job
 * is green and the run list says `success` on a run where no review happened.
 * The outcome is only visible in the report step's own env dump.
 *
 * ## Measured, seven consecutive runs
 *
 * | run | outcome | the action's own error | what the step said |
 * |---|---|---|---|
 * | `39683654861` | **failure** | successful result after **54** turns, max 50 | GitHub App not installed |
 * | `39683370868` | success | — | declined: validation guard (correct) |
 * | `39681656175` | **failure** | successful result after **51** turns, max 50 | GitHub App not installed |
 * | `39678706315` | success | — | — |
 * | `39675295321` | success | — | — |
 * | `39680851322` | success | — | payload written, #675 (correct) |
 * | `39682051799` | **failure** | successful result after **52** turns, max 50 | GitHub App not installed |
 *
 * Three of three failures get the wrong cause. The app is demonstrably
 * installed on all three — the reviewer ran for four minutes and fifty-odd
 * turns. A reader who trusts the sentence goes and installs an app that is
 * already there.
 *
 * ## Two defects, and the second is worse than the sentence
 *
 * 1. **An asserted cause where a reading is available.**
 *    `AI_REVIEW_EXECUTION_FILE` is bound into the step and was a real,
 *    readable path on all three failures — `"num_turns": 54` is in it. Its
 *    mere presence refutes the app-install cause: the agent cannot run
 *    without the token exchange that cause is about.
 * 2. **An assertion about a file nobody opened.** The branch states *"no
 *    findings payload was written"* and is reached BEFORE the
 *    `[ -s "$AI_REVIEW_FINDINGS_PATH" ]` test, so the path is never stat'd on
 *    this route. On these runs the CLI reported a *successful result* and was
 *    rejected afterwards by the action's own turn accounting, so a payload
 *    may well be on disk. Claiming its absence without looking is the Silent
 *    Default Substitution this file's own header refuses.
 *
 * ## The discriminator, read from the pinned action rather than guessed
 *
 * `base-action/src/run-claude-sdk.ts` at `5eb090f3`:
 *
 *     const executionFile = await writeExecutionFile(messages);   // :222
 *     …
 *     if (resultMessage.subtype === "success" && !resultMessage.is_error &&
 *         sdkOptions.maxTurns !== undefined &&
 *         resultMessage.num_turns > sdkOptions.maxTurns) {
 *       const message = `Claude reported a successful result after …`;
 *       throw new Error(message);                                 // :249
 *     }
 *
 * The execution file is written at `:222`, BEFORE the throw at `:249`. So on
 * an overshoot the file exists, the output is set, and its result message
 * carries `"subtype":"success"` — the CLI finished and the action rejected the
 * run after the fact. That is a different thing from a reviewer that crashed,
 * and it is a reading, not an inference.
 *
 * ## Why this is not a second decider
 *
 * `buildReviewRunScript`'s success branch already states the rule and AC-B5 of
 * `ai-review-route-reading.test.ts` enforces it: **the route decides the
 * sentence and never the exit code.** This change obeys it on the other
 * branch — `AC-F6` asserts the exit code is identical across all four routes
 * in both directions of the require switch, so an edit that lets the route
 * decide anything goes red.
 *
 * ## The cheapest wrong fix, named
 *
 * **Delete the GitHub-App sentence.** It works: the wrong assertion stops
 * being made. It also throws away the one route where the sentence is TRUE —
 * no execution file means the action never got far enough to write one, which
 * is exactly the 401 state #803 measured on run `39456331887`, where it was
 * the cause on all three consumer repositories and was named nowhere else.
 * `AC-F1` is the case that survives that repair: it asserts the sentence is
 * still there on the declined route, so deleting it goes red rather than
 * green. `M3` below is that repair applied.
 *
 * ## What was broken to prove it
 *
 * Counts predicted before the battery ran, with the assertion each row should
 * redden named. Baseline read first. Mutations applied by hand to
 * `lib/scaffold/ai-review-step.ts`, reverted, and the file confirmed
 * byte-identical by SHA-256 — never by `git checkout --`. Over this file plus
 * `ai-review-route-reading.test.ts` and `ai-review-payload-reading.test.ts`.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 34 pass, 0 fail | **34 pass, 0 fail** | — |
 * | M1 the whole route block deleted, `pending` printed directly again | 6, and they are F1b, F2, F3, F4, F5, F6c | **6 of 34** | an execution file on a failed action: original names the reviewer, mutant names the app |
 * | M2 **the cheapest wrong fix**: the app-install cause deleted from `pending` | 2, and they are F1 and F1b | **2 of 34** | no execution file: original names the 401, mutant names no cause at all |
 * | M3 the `subtype` grep widened to match any `"subtype"` | 1, and it is F3b's verdict | **2 of 34** | a crashed reviewer: original says executed, mutant says the action rejected a success |
 * | M4a the route decides the exit code — `exit 0` after the rejected route | 1 | **3 of 34, CONFOUNDED** | the early exit suppressed the ANNOTATION as well, so F3 and F4b red for a second reason. Not evidence about the exit code; re-run as M4b |
 * | M4b the failure branch's refusal changed to `exit 0` | 1, and it is F6b's verdict | **1 of 34** | any failure route with the require switch on: original exits 1, mutant exits 0 |
 * | M5 the failure-branch payload reading short-circuited to `if false` | 3 | **2 of 34** | a payload on disk: original says it IS present, mutant reports the rejection route |
 * | M6 the execution-file `-s` widened to `-n` | 1, and it is F5's verdict | **2 of 34** | `AI_REVIEW_EXECUTION_FILE` naming a path that does not exist |
 *
 * **Three rows came back higher than predicted and every excess is AC-F6c.**
 * That is the case working rather than noise: F6c asserts the five routes
 * produce five distinct messages, so it reds on any mutation that COLLAPSES
 * two of them — M3 folds `executed` into `rejected`, M6 folds `unreadable`
 * into `executed`, M1 folds all five into one. It is the non-vacuity control
 * for F6a and F6b, which would otherwise hold over one state wearing five
 * names, and the prediction simply forgot it is cross-cutting.
 *
 * **M5 came back 2 against a predicted 3, and the prediction was wrong rather
 * than the case.** I counted AC-F4's two new assertions as two rows; they are
 * one `test()` and bun reports a case, not an expectation. No decider is
 * missing — AC-F4 is the row that reds, on the input it names.
 *
 * **M4a is recorded rather than dropped.** A mutation that changes two things
 * produces a count that is about neither, and `3 of 34` would have read as a
 * stronger result than the clean `1 of 34` that replaced it.
 *
 * ## What this does NOT do
 *
 * It does not set `RUNGATE_REQUIRE_AI_REVIEW` on this repository, which is
 * #826's FIRST bullet. That bullet is gated on #675, not on #824 as the issue
 * body says: with #675 open, a review that ran and wrote a payload refuses at
 * the `unadjudicated` branch, so the flag fails every pull request including
 * the ones with a perfect review. Run `39680851322` is the example.
 *
 * It does not raise the turn budget. Three runs overshot by 1 to 4 turns and
 * had a completed review discarded; that is #812's subject and a budget
 * question, not a diagnostics one.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_APP_INSTALL_CAUSE,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_UNMEASURED_TITLE,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunxAbsent } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin (#1013), never the
 * real one. `buildReviewRunScript` takes the generating version as an
 * argument; passing `harnessVersion()` here would make every assertion
 * below agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";


const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * Drive the real report script with the action OUTCOME under our control.
 *
 * `ai-review-route-reading.test.ts`'s own harness pins
 * `AI_REVIEW_ACTION_OUTCOME` to `success`, which is why every case in it is
 * about the other branch. This one defaults to `failure`, which is the branch
 * three of seven measured runs actually took.
 *
 * `execution: "unreadable"` names a path that does not exist, which is the
 * state the action leaves when it sets the output and the file is then gone —
 * distinct from `null`, where the output was never set at all.
 */
function runReport(opts: {
  payload: string | null;
  execution: string | null | "unreadable";
  outcome?: string;
  require?: boolean;
  script?: string;
}): Run {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-failroute-"));
  scratch.push(dir);
  const scriptPath = join(dir, "report.sh");
  writeFileSync(scriptPath, opts.script ?? buildReviewRunScript(FIXTURE_VERSION));

  const findings = join(dir, "findings.json");
  if (opts.payload !== null) writeFileSync(findings, opts.payload);

  const env: Record<string, string> = {
    PATH: stubBunxAbsent(),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: opts.outcome ?? "failure",
    [AI_REVIEW_FINDINGS_PATH_VAR]: findings,
  };
  const exec = join(dir, "claude-execution-output.json");
  if (opts.execution === "unreadable") {
    env[AI_REVIEW_EXECUTION_FILE_VAR] = exec;
  } else if (opts.execution !== null) {
    writeFileSync(exec, opts.execution);
    env[AI_REVIEW_EXECUTION_FILE_VAR] = exec;
  }
  if (opts.require) env[AI_REVIEW_REQUIRE_VAR] = AI_REVIEW_REQUIRE_VALUE;

  const r = Bun.spawnSync(["bash", scriptPath], { cwd: dir, env });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

const PAYLOAD = JSON.stringify({ findings: [], verdict: "PASS" });

/**
 * Run `39683654861`'s shape: the CLI reported success, the action rejected it
 * for 54 turns against a maximum of 50. `subtype: "success"` with the action
 * having failed is the whole discriminator.
 */
const REJECTED = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 54,
      total_cost_usd: 2.11,
    },
  ],
  null,
  2,
);

/** A reviewer that executed and did NOT report a successful result. */
const CRASHED = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    { type: "result", subtype: "error_during_execution", num_turns: 12, total_cost_usd: 0.4 },
  ],
  null,
  2,
);

// ── AC-F1: the declined route keeps the cause that is TRUE there ─────────

describe("AC-F1 (#826): with no execution file the app-install cause is still named", () => {
  test("AC-F1: no execution file — the action never started, and the cause is named", () => {
    // This is the case the cheapest wrong fix kills. #803 measured the
    // 401 state on run 39456331887 and it was the cause on all three
    // consumer repositories; deleting the sentence outright loses it.
    const r = runReport({ payload: null, execution: null });
    expect(r.out, `stderr:\n${r.err}`).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(
      r.out,
      "with no execution file the app-install 401 IS the usual cause, so it must still be named",
    ).toContain("Claude Code GitHub App is not installed");
  });

  test("AC-F1b: the cause constant is reachable only from the declined route", () => {
    // Non-vacuity for AC-F2/F3: if the constant were still printed on every
    // route, those cases would be asserting the absence of text that is
    // present and would be measuring nothing.
    const declined = runReport({ payload: null, execution: null });
    const executed = runReport({ payload: null, execution: CRASHED });
    expect(declined.out).toContain(AI_REVIEW_APP_INSTALL_CAUSE);
    expect(
      executed.out,
      "the app-install cause is printed on a route where an agent demonstrably ran",
    ).not.toContain(AI_REVIEW_APP_INSTALL_CAUSE);
  });
});

// ── AC-F2: an execution file refutes the app-install cause ───────────────

describe("AC-F2 (#826): a reviewer that executed is not reported as an uninstalled app", () => {
  test("AC-F2: an execution file is present — the guard names the reviewer, not the app", () => {
    const r = runReport({ payload: null, execution: CRASHED });
    expect(r.out, `stderr:\n${r.err}`).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(
      r.out,
      "the agent cannot run at all without the token exchange the app-install cause is about",
    ).not.toContain("Claude Code GitHub App is not installed");
    expect(r.out, "the route that WAS measured is not named").toContain("execution file");
  });
});

// ── AC-F3: the measured overshoot route ──────────────────────────────────

describe("AC-F3 (#826): the CLI finished and the action rejected it afterwards", () => {
  test("AC-F3: a successful result on a failed action is named as the action's own rejection", () => {
    // Run 39683654861, 39681656175, 39682051799 — 54, 51 and 52 turns against
    // a configured maximum of 50. `writeExecutionFile` runs at
    // run-claude-sdk.ts:222, before the throw at :249, so the file is there.
    const r = runReport({ payload: null, execution: REJECTED });
    expect(r.out, `stderr:\n${r.err}`).toContain("reported a SUCCESSFUL result");
    expect(
      r.out,
      "the turn budget is the lever on this route and the message does not say so",
    ).toContain("turn");
  });

  test("AC-F3b: a crashed reviewer is NOT reported as a rejected successful run", () => {
    // The input on which this route and AC-F2's differ: `subtype`. Without
    // this case, widening the grep to anything that matches both leaves both
    // cases green.
    const r = runReport({ payload: null, execution: CRASHED });
    expect(
      r.out,
      "a reviewer that errored during execution reads as one the action rejected for overshooting",
    ).not.toContain("reported a SUCCESSFUL result");
  });
});

// ── AC-F4: the payload is read rather than asserted absent ───────────────

describe("AC-F4 (#826): the failure branch stops asserting a file it never opened", () => {
  test("AC-F4: a payload on disk is reported, not denied", () => {
    const withPayload = runReport({ payload: PAYLOAD, execution: REJECTED });
    const without = runReport({ payload: null, execution: REJECTED });

    expect(
      withPayload.out,
      "the step states no payload was written on a run where one is on disk, without stat'ing it",
    ).not.toContain("no findings payload was written");

    // The `not.toContain` above is satisfied by any sentence that happens not
    // to use that phrase — including the one printed when the payload reading
    // is removed entirely. These two are what make the case about the
    // READING: the same execution file with and without a payload must reach
    // different messages, and the one with it must say so.
    expect(
      withPayload.out,
      "a payload on disk and no payload on disk produce the same message — nothing stat'd the path",
    ).not.toBe(without.out);
    expect(withPayload.out, "the payload that IS there goes unmentioned").toContain("IS present");
  });

  test("AC-F4b: with no payload the branch may still say so — it looked", () => {
    // The direction that keeps AC-F4 from being satisfied by deleting the
    // sentence everywhere: an absent payload is a reading and is allowed to
    // be stated.
    const r = runReport({ payload: null, execution: REJECTED });
    expect(r.out).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
  });
});

// ── AC-F5: named but unreadable is UNMEASURED, not declined ──────────────

describe("AC-F5 (#826): an execution file named and not readable is its own state", () => {
  test("AC-F5: a named-but-missing execution file is not reported as a declined action", () => {
    const r = runReport({ payload: null, execution: "unreadable" });
    expect(
      r.out,
      "an output that was SET names an action that got far enough to set it",
    ).not.toContain("Claude Code GitHub App is not installed");
    expect(r.out, "the unmeasured route does not say it is unmeasured").toContain("cannot say");
  });
});

// ── AC-F6: the route decides the sentence and NEVER the exit code ────────

describe("AC-F6 (#826): every failure route exits the same way", () => {
  const routes: Array<[string, { payload: string | null; execution: string | null | "unreadable" }]> =
    [
      ["declined", { payload: null, execution: null }],
      ["executed", { payload: null, execution: CRASHED }],
      ["rejected", { payload: null, execution: REJECTED }],
      ["unreadable", { payload: null, execution: "unreadable" }],
      ["payload present", { payload: PAYLOAD, execution: REJECTED }],
    ];

  test("AC-F6a: without the require switch, every route exits 0", () => {
    for (const [name, opts] of routes) {
      const r = runReport(opts);
      expect(r.code, `route ${name} changed the exit code\nstdout:\n${r.out}\nstderr:\n${r.err}`).toBe(
        0,
      );
    }
  });

  test("AC-F6b: with the require switch, every route refuses", () => {
    for (const [name, opts] of routes) {
      const r = runReport({ ...opts, require: true });
      expect(r.code, `route ${name} did not refuse\nstdout:\n${r.out}\nstderr:\n${r.err}`).toBe(
        AI_REVIEW_REQUIRED_EXIT,
      );
      expect(r.err, `route ${name} refused without an error annotation`).toContain(
        `::error title=${AI_REVIEW_UNMEASURED_TITLE}`,
      );
    }
  });

  test("AC-F6c: the routes genuinely differ — otherwise AC-F6a/b are vacuous", () => {
    // Two deciders that agree are behaviourally one. If every route printed
    // the same sentence, F6a and F6b would hold over one state wearing five
    // names and would be measuring nothing.
    const seen = new Set(routes.map(([, o]) => runReport(o).out));
    expect(seen.size, "the five failure routes do not produce five distinct messages").toBe(
      routes.length,
    );
  });
});

// ── AC-F7: the success branch is untouched ───────────────────────────────

describe("AC-F7 (#826): #849's four routes on the success branch still hold", () => {
  test("AC-F7: a declined action on the SUCCESS branch still names the validation guard", () => {
    const r = runReport({ payload: null, execution: null, outcome: "success" });
    expect(
      r.out,
      "the success branch lost #849's declined route — this change is additive, not a rewrite",
    ).toContain("workflow-validation guard");
    expect(
      r.out,
      "the app-install cause leaked onto the success branch, where the action exited zero",
    ).not.toContain("Claude Code GitHub App is not installed");
  });
});
