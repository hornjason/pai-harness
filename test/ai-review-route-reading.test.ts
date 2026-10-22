/**
 * ai-review-route-reading.test.ts — the report step reads what it talks about
 * (#826).
 *
 * ## The reading that was never taken
 *
 * `buildReviewRunScript` branches on `[ -s "${AI_REVIEW_FINDINGS_PATH:-}" ]`
 * and #816 built a whole file of cases proving that branch behaves. Every one
 * of those cases SETS `AI_REVIEW_FINDINGS_PATH` in the environment it hands
 * the script. **The generated step does not.** Measured on run `39518336224`,
 * from the runner's own echo of the step's environment:
 *
 *     env:
 *       AI_REVIEW_MODE: vertex
 *       AI_REVIEW_ACTION_OUTCOME: success
 *       RUNGATE_REQUIRE_AI_REVIEW:
 *
 * Three variables. The findings path is set on the ACTION step, and a GitHub
 * step's `env:` does not carry to a later step, so in the report step the
 * variable is unset, `[ -s "" ]` is false, and the no-payload branch is taken
 * on **every** run that has ever executed — whether or not a payload exists.
 * The `unadjudicated` branch has never been reachable.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s opening sentence
 * arriving through #530's door: the test supplied the input the artifact does
 * not, so the store answered with what the test put in it. A suite can prove
 * a script correct and say nothing about whether anything calls it that way.
 *
 * ## The two routes, and the third
 *
 * #826 asks for the annotation to distinguish an action that declined to run
 * from a reviewer that ran and wrote nothing, because they need different
 * actions and the message named only the first. On run `39518336224` the
 * reviewer ran 44 turns and spent $2.04, and the annotation sent the reader to
 * the workflow file.
 *
 * The discriminator is the action's own `execution_file` output, and it needs
 * no parsing: `setExecutionFileOutputIfPresent` in the pinned action sets the
 * output only when the file exists, so an empty value IS "the action never got
 * far enough to write one". Verified against
 * `base-action/src/execution-file.ts` at `5eb090f3`, not assumed.
 *
 * There is a third route this repository has already produced and #826 does
 * not name: run `39461944884` ended `"subtype": "error_max_turns"` with 26
 * turns and no payload. An exhausted reviewer and a blocked one both execute
 * and both leave a file, so the file's presence separates two of the three and
 * `subtype` separates the remaining pair.
 *
 * ## Why this is not the second decider the module argues against
 *
 * `buildReviewRunScript`'s own comment declines to read `num_turns`, on the
 * grounds that it would answer the same question the payload answers and two
 * deciders that agree are behaviourally one. That is right about the VERDICT
 * and does not reach the DIAGNOSTIC. The payload decides whether the check is
 * UNMEASURED and what the exit code is; the execution file decides only which
 * sentence explains it. `AC-B5` asserts that separation rather than intending
 * it: the exit code must be identical across both routes, in both directions
 * of the require switch, so a future edit that lets the route decide anything
 * goes red.
 *
 * ## The cheapest wrong fix, named before the repair was written
 *
 * What an operator sees is an annotation naming a cause that was not the
 * cause. **The 5pm repair is to delete the validation-guard sentence.** It
 * works: the wrong assertion stops being made, and the job still cannot say
 * which of three things happened, so the next reader gets no cause at all
 * instead of a wrong one. M3 below is that repair applied — 2 red, and
 * AC-B1 is one of them, because the sentence is TRUE on the declined route
 * and measuring the route is what makes it accurate rather than removable.
 *
 * That matters beyond this file. #824's AC-5 proposes removing the same
 * sentence, and it was right to when the sentence printed on every route.
 * With the route measured it should be scoped, not deleted — and M3's second
 * red is `test/ai-review-payload-reading.test.ts`'s own case saying the same
 * thing from #816.
 *
 * ## What was broken to prove it
 *
 * Over this file plus `test/ai-review-payload-reading.test.ts` (22 tests).
 * Every count predicted before the battery ran, in
 * `/tmp/826-battery/predictions.md`, and **the baseline row was read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 22 pass, 0 fail | **22 pass, 0 fail** | — |
 * | M1 the genuinely pre-#826 step: both new `env:` lines removed, the workflow regenerated | 3 | **3 of 22** | the committed step's env map — three keys against five |
 * | M2 the whole route block deleted, `skipped` printed directly again | 4 | **4 of 22** | an execution file with no payload: original says the reviewer executed, mutant names the guard |
 * | M3 **the cheapest wrong fix**: the guard sentence deleted from `skipped` | 1 | **2 of 22** | no execution file: original names the guard, mutant names no cause at all |
 * | M4 the route decides the exit code — `exit 0` in the executed branch | 1 | **1 of 22** | an execution file with the require switch on: original refuses, mutant exits 0 |
 * | M5 the payload reading short-circuited to `if false` | 5 | **5 of 22** | a payload on disk: original takes the unadjudicated branch, mutant reports none |
 * | M6 the execution-file `-s` test widened to `-n` | 1 | **1 of 22** | `AI_REVIEW_EXECUTION_FILE` naming a path that does not exist |
 *
 * **M3 came back 2 against a predicted 1, and the extra red is the real
 * kind.** It is `ai-review-payload-reading.test.ts`'s *"it names the cause a
 * consumer will actually hit"* — #816's own case over the same sentence,
 * which the prediction simply forgot was there. 20 cases still pass and both
 * reds are about the deleted text. The fact it records is that the sentence
 * has two independent holders in two files, so the delete-it repair is
 * costlier to make silently than it looks.
 *
 * **M6 is 1 because AC-B7 was strengthened before the battery, not after.**
 * As first written that case only forbade the guard sentence — and the `-n`
 * mutant sends a missing file down the EXECUTED branch, whose text does not
 * contain the guard either, so the case passed over the mutation it exists
 * for. Writing the predictions is what surfaced it. It now asserts the
 * unreadable sentence positively and compares it to the executed one.
 *
 * None of the mutations is left in the tree; all were run and restored from a
 * `cp` backup, and `lib/scaffold/ai-review-step.ts`, this file,
 * `test/ai-review-payload-reading.test.ts` and
 * `.github/workflows/ai-review.yml` were confirmed byte-identical to the
 * measured source afterwards by SHA-256, never by `git checkout --`.
 *
 * ## What this does NOT do
 *
 * It does not set `RUNGATE_REQUIRE_AI_REVIEW` on this repository, which is
 * #826's first bullet and is explicitly gated on #824 landing. Flipping it
 * now turns every pull request red for a cause #824 is mid-flight fixing,
 * which is the pressure that gets a check disabled rather than fixed.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import { actionRef } from "../lib/workflow-actions";
import { declaredBunVersion, setupBunWith } from "../lib/bun-version";
import type { VertexCiDecision } from "../lib/scaffold/ai-review-step";
import {
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_PREPARE_STEP_ID,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_WORKFLOW_FILE,
  buildReviewRunScript,
  buildReviewRunStep,
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

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-route-"));
  scratch.push(dir);
  return dir;
}

/**
 * The committed workflow, parsed.
 *
 * Read from the repository rather than from a scaffolded scratch project. A
 * scratch project is written by the generator under test, so comparing it to
 * the generator is the question restated (#530) — and the defect this file is
 * about is precisely a step that the generator writes one way and the suite
 * reads another.
 */
function committedStep(id: string): any {
  const path = join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
  const doc = Bun.YAML.parse(readFileSync(path, "utf-8")) as any;
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? [];
  expect(steps.length, "the committed ai-review job has no steps — this read is vacuous").toBeGreaterThan(
    3,
  );
  const found = steps.find((s: any) => s?.id === id);
  expect(found, `the committed workflow has no step with id ${id}`).toBeDefined();
  return found;
}

const VERTEX: VertexCiDecision = {
  config: {
    project: "fixture-project",
    region: "global",
    workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/g",
  },
  reason: "fixture",
} as VertexCiDecision;

/** The same step as the GENERATOR emits it, so a fix cannot land in only one. */
function generatedStep(id: string): any {
  const steps = buildReviewRunStep(
    VERTEX,
    {
      checkout: actionRef("actions/checkout"),
      auth: actionRef(GOOGLE_AUTH_ACTION),
      review: actionRef(CLAUDE_CODE_ACTION),
      setupBun: actionRef("oven-sh/setup-bun"),
      setupBunWith: setupBunWith(declaredBunVersion(join(import.meta.dir, "..")), "    "),
    },
    FIXTURE_VERSION,
  );
  const yaml = `jobs:\n  ${AI_REVIEW_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  const doc = Bun.YAML.parse(yaml) as any;
  const found = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find((s: any) => s?.id === id);
  expect(found, `the generator emits no step with id ${id}`).toBeDefined();
  return found;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * Drive the real report script.
 *
 * `payload` is the content to write at the findings path, or `null` for a path
 * that does not exist. `execution` is the content of the action's execution
 * file, or `null` for an output the action never set — which is what a
 * declined action leaves behind.
 */
function runReport(opts: {
  payload: string | null;
  execution: string | null;
  require?: boolean;
  script?: string;
}): Run {
  const dir = scratchDir();
  const scriptPath = join(dir, "report.sh");
  writeFileSync(scriptPath, opts.script ?? buildReviewRunScript(FIXTURE_VERSION));

  const findings = join(dir, "findings.json");
  if (opts.payload !== null) writeFileSync(findings, opts.payload);

  const env: Record<string, string> = {
    PATH: stubBunxAbsent(),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "success",
    [AI_REVIEW_FINDINGS_PATH_VAR]: findings,
  };
  if (opts.execution !== null) {
    const exec = join(dir, "claude-execution-output.json");
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

/** Run 39518336224's result object, which is the shape the file really holds. */
const EXECUTED = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    {
      type: "result",
      subtype: "success",
      num_turns: 44,
      total_cost_usd: 2.0388728,
      permission_denials_count: 3,
    },
  ],
  null,
  2,
);

/**
 * Run 39707821002's, which is the shape #1087 is about: the reviewer ran for
 * 22 turns, was refused nothing, and wrote no payload. Four more runs on this
 * repository reported the same zero — 39708155573 (40 turns), 39707657746
 * (43), 39707621271 (47), 39708162846 (51).
 */
const EXECUTED_NO_DENIALS = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    {
      type: "result",
      subtype: "success",
      num_turns: 22,
      total_cost_usd: 0.3704491,
      permission_denials_count: 0,
    },
  ],
  null,
  2,
);

/** The same run with the counter absent, which is not the same as zero. */
const EXECUTED_NO_COUNTER = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    { type: "result", subtype: "success", num_turns: 22, total_cost_usd: 0.3704491 },
  ],
  null,
  2,
);

/** Run 39461944884's, which exhausted the turn budget instead. */
const EXHAUSTED = JSON.stringify(
  [
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    { type: "result", subtype: "error_max_turns", num_turns: 26, total_cost_usd: 1.2685924 },
  ],
  null,
  2,
);

// ── AC-A: the step receives the thing it branches on ─────────────────────

describe("AC-A (#826): the report step is handed the findings path", () => {
  test("AC-A1: the COMMITTED workflow's report step carries the findings path", () => {
    const env = committedStep(AI_REVIEW_RUN_STEP_ID).env ?? {};
    expect(
      env[AI_REVIEW_FINDINGS_PATH_VAR],
      "the report step branches on a variable the runner never sets it — measured unset on run 39518336224",
    ).toBe(`\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.path }}`);
  });

  test("AC-A2: the GENERATOR emits it, so the fix is not only in the artifact", () => {
    const env = generatedStep(AI_REVIEW_RUN_STEP_ID).env ?? {};
    expect(env[AI_REVIEW_FINDINGS_PATH_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.path }}`,
    );
  });

  test("AC-A3: the action step still has it too — this adds a binding, it does not move one", () => {
    // The cheapest wrong fix for a failing AC-A1 is to move the line rather
    // than add one, and the action is the step that must write the payload.
    const env = committedStep(AI_REVIEW_ACTION_STEP_ID).env ?? {};
    expect(env[AI_REVIEW_FINDINGS_PATH_VAR], "the action lost the path it writes to").toBe(
      `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.path }}`,
    );
  });

  test("AC-A4: with the path wired, a payload reaches the unadjudicated branch", () => {
    // Unreachable before this change: the branch exists, #816 tested it with
    // an env the workflow never produced, and no run has ever taken it.
    const r = runReport({ payload: PAYLOAD, execution: EXECUTED });
    // An `::error` on stderr since #1013's review, not a `::warning`: a
    // payload nothing adjudicated now FAILS rather than warning, because a
    // review WAS attempted and its result is on disk unread. The branch
    // being reachable is what this case is about, and the title is the
    // thing that says which branch it is.
    expect(r.err, `stdout:\n${r.out}`).toContain(`::error title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(
      `${r.out}${r.err}`,
      "a payload still reads as an action that wrote nothing",
    ).not.toContain("WITHOUT writing a findings payload");
  });
});

// ── AC-B: which of the three routes, said rather than guessed ────────────

describe("AC-B (#826): the annotation names the route it measured", () => {
  test("AC-B1: no execution file — the action declined, and the guard is named", () => {
    const r = runReport({ payload: null, execution: null });
    expect(r.out).toContain("WITHOUT writing a findings payload");
    expect(
      r.out,
      "with no execution file the validation guard IS the usual cause, so it should still be named",
    ).toContain("workflow-validation guard");
  });

  test("AC-B2: an execution file — the reviewer ran, and the guard is NOT named", () => {
    const r = runReport({ payload: null, execution: EXECUTED });
    expect(r.out).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(
      r.out,
      "the reviewer executed and the reader is still being sent at the workflow file",
    ).not.toContain("workflow-validation guard");
    expect(r.out, "the route that was measured is not stated").toContain("execution");
  });

  test("AC-B3: the PAIR — one input varies, and the two annotations differ", () => {
    // #585's discipline. Everything else is held: same payload state, same
    // outcome, same mode, same require switch. The only difference between
    // these two runs is whether the action set its execution_file output.
    const declined = runReport({ payload: null, execution: null });
    const executed = runReport({ payload: null, execution: EXECUTED });
    const line = (r: Run) => r.out.split("\n").find(l => l.includes("::warning")) ?? "";
    expect(line(declined), "the declined run printed no annotation").not.toBe("");
    expect(line(executed), "the executed run printed no annotation").not.toBe("");
    expect(
      line(declined) === line(executed),
      "both routes print the same sentence, so the reading is not being used",
    ).toBe(false);
  });

  test("AC-B4: an exhausted reviewer is its own route, not the blocked one", () => {
    const exhausted = runReport({ payload: null, execution: EXHAUSTED });
    const blocked = runReport({ payload: null, execution: EXECUTED });
    const line = (r: Run) => r.out.split("\n").find(l => l.includes("::warning")) ?? "";
    expect(line(exhausted)).not.toBe("");
    expect(
      line(exhausted) === line(blocked),
      "a reviewer that ran out of turns and one that wrote nothing get the same advice",
    ).toBe(false);
  });

  test("AC-B5: the route decides the SENTENCE and never the exit code", () => {
    // The separation that keeps this from being the second decider
    // `buildReviewRunScript`'s comment argues against. Asserted, not intended.
    for (const require of [false, true]) {
      const declined = runReport({ payload: null, execution: null, require });
      const executed = runReport({ payload: null, execution: EXECUTED, require });
      const exhausted = runReport({ payload: null, execution: EXHAUSTED, require });
      expect(
        [declined.code, executed.code, exhausted.code],
        `the route moved the exit code with ${AI_REVIEW_REQUIRE_VAR}=${require}`,
      ).toEqual([declined.code, declined.code, declined.code]);
    }
    // And the control: the switch still does what it is for, or the equality
    // above is satisfied by a script that never refuses at all.
    expect(runReport({ payload: null, execution: null, require: false }).code).toBe(0);
    expect(
      runReport({ payload: null, execution: null, require: true }).code,
      "the require switch stopped refusing, so AC-B5's equality means nothing",
    ).not.toBe(0);
  });

  test("AC-B6: the COMMITTED workflow hands the report step the action's execution file", () => {
    const env = committedStep(AI_REVIEW_RUN_STEP_ID).env ?? {};
    expect(env[AI_REVIEW_EXECUTION_FILE_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_ACTION_STEP_ID}.outputs.execution_file }}`,
    );
    expect(generatedStep(AI_REVIEW_RUN_STEP_ID).env?.[AI_REVIEW_EXECUTION_FILE_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_ACTION_STEP_ID}.outputs.execution_file }}`,
    );
  });

  test("AC-B7: an execution file that is present but unreadable is UNMEASURED about the route", () => {
    // A path that does not resolve is not "the action declined". Reporting it
    // as the declined route would be a default substituted for a reading, in
    // the step whose whole subject is not doing that.
    const dir = scratchDir();
    const scriptPath = join(dir, "report.sh");
    writeFileSync(scriptPath, buildReviewRunScript(FIXTURE_VERSION));
    const r = Bun.spawnSync(["bash", scriptPath], {
      cwd: dir,
      env: {
        PATH: stubBunxAbsent(),
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_ACTION_OUTCOME: "success",
        [AI_REVIEW_FINDINGS_PATH_VAR]: join(dir, "findings.json"),
        [AI_REVIEW_EXECUTION_FILE_VAR]: join(dir, "gone.json"),
      },
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(out).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(
      out,
      "a named-but-missing execution file is being reported as the declined route",
    ).not.toContain("workflow-validation guard");
    // And not as the EXECUTED route either, which `not.toContain` above is
    // equally satisfied by. The cheapest wrong fix for a failing version of
    // this case is to widen the `-s` test to `-n`, which sends a missing file
    // down the executed branch — and that passes a case that only forbids the
    // guard. So the sentence is asserted positively.
    expect(
      out,
      "a file that could not be read is being reported as a reviewer that ran",
    ).toContain("could not read");
    expect(out).toContain("UNMEASURED");
    const line = out.split("\n").find(l => l.includes("::warning")) ?? "";
    const executedLine =
      runReport({ payload: null, execution: EXECUTED }).out.split("\n").find(l => l.includes("::warning")) ??
      "";
    expect(line === executedLine, "the unreadable route and the executed route say the same thing").toBe(
      false,
    );
  });
});

// ── AC-C: the denial count, read rather than guessed (#1087) ─────────────

/**
 * The sentence this block replaces asserted a cause: *"a reviewer that ran
 * and wrote nothing is usually one that could not write to the findings
 * path"*. The execution files refute it at `permission_denials_count: 0` on
 * every run sampled, and the guess cost two readers of #1087 a dead end each
 * before anyone read the number it was guessing about.
 *
 * Three states, because a file with no counter is not a file reporting zero.
 * The pair case is what makes that a split rather than three spellings of one
 * sentence; AC-C5 is the separation this file's AC-B5 asserts for the route
 * as a whole, re-asserted for the branch added inside it.
 */
describe("AC-C (#1087): the annotation reads the denial count", () => {
  const line = (out: string) => out.split("\n").find(l => l.includes("::warning")) ?? "";

  test("AC-C1: zero denials — the findings path is named as NOT the cause", () => {
    const r = runReport({ payload: null, execution: EXECUTED_NO_DENIALS });
    expect(r.out, `stderr:\n${r.err}`).toContain("permission_denials_count 0");
    expect(
      r.out,
      "a run that was refused nothing is still being sent at the findings path",
    ).toContain("dead end");
  });

  test("AC-C2: a non-zero count sends the reader at the denials", () => {
    const r = runReport({ payload: null, execution: EXECUTED });
    expect(r.out, `stderr:\n${r.err}`).toContain("NON-ZERO");
    expect(r.out, "the denied route does not say the path is worth checking").toContain(
      "worth checking",
    );
  });

  test("AC-C3: no counter at all is UNMEASURED about the denials, not zero", () => {
    const r = runReport({ payload: null, execution: EXECUTED_NO_COUNTER });
    expect(r.out, `stderr:\n${r.err}`).toContain("carries no permission_denials_count");
    expect(
      r.out,
      "an absent counter is being reported as a measured zero",
    ).not.toContain("permission_denials_count 0");
  });

  test("AC-C4: the THREE sentences are three — one input varies and none repeats", () => {
    // #585's discipline. Payload state, outcome, mode and require switch are
    // all held; the only thing that moves is the denial field in the
    // execution file. Three readings that collapsed to one sentence would
    // leave AC-C1..C3 green on substrings while measuring nothing.
    const zero = line(runReport({ payload: null, execution: EXECUTED_NO_DENIALS }).out);
    const denied = line(runReport({ payload: null, execution: EXECUTED }).out);
    const absent = line(runReport({ payload: null, execution: EXECUTED_NO_COUNTER }).out);
    for (const [a, b] of [
      [zero, denied],
      [zero, absent],
      [denied, absent],
    ]) {
      expect(a, "a route printed no annotation at all").not.toBe("");
      expect(a === b, `two denial routes printed the same sentence:\n${a}`).toBe(false);
    }
  });

  test("AC-C5: the denial reading decides the SENTENCE and never the exit code", () => {
    for (const require of [false, true]) {
      const codes = [EXECUTED_NO_DENIALS, EXECUTED, EXECUTED_NO_COUNTER].map(
        execution => runReport({ payload: null, execution, require }).code,
      );
      expect(
        codes,
        `the denial count moved the exit code with require=${require}`,
      ).toEqual([codes[0], codes[0], codes[0]]);
    }
    // And the switch is doing something, or the equality above is vacuous —
    // the same trap AC-B5 names.
    expect(
      runReport({ payload: null, execution: EXECUTED_NO_DENIALS, require: true }).code,
      "the require switch stopped refusing, so AC-C5's equality means nothing",
    ).not.toBe(0);
  });

  test("AC-C6: a count that merely STARTS with the matched digits is not read as zero", () => {
    // The other direction of the end-anchor, and the cheap half: `30` was
    // never going to match a pattern whose first value character is `0`. The
    // anchor's real work is the `$`, which AC-C4 above measured — see the
    // generator's comment for the draft it caught.
    const thirty = EXECUTED.replace('"permission_denials_count": 3', '"permission_denials_count": 30');
    expect(thirty, "the fixture rewrite did not take").toContain('"permission_denials_count": 30');
    const r = runReport({ payload: null, execution: thirty });
    expect(r.out, "a count of 30 was read as a zero").not.toContain("permission_denials_count 0");
    expect(r.out).toContain("NON-ZERO");
  });
});
