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
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import { actionRef } from "../lib/workflow-actions";
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
  const steps = buildReviewRunStep(VERTEX, {
    checkout: actionRef("actions/checkout"),
    auth: actionRef(GOOGLE_AUTH_ACTION),
    review: actionRef(CLAUDE_CODE_ACTION),
  });
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
  writeFileSync(scriptPath, opts.script ?? buildReviewRunScript());

  const findings = join(dir, "findings.json");
  if (opts.payload !== null) writeFileSync(findings, opts.payload);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
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
    expect(r.out, `stderr:\n${r.err}`).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(r.out, "a payload still reads as an action that wrote nothing").not.toContain(
      "WITHOUT writing a findings payload",
    );
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
    writeFileSync(scriptPath, buildReviewRunScript());
    const r = Bun.spawnSync(["bash", scriptPath], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
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
