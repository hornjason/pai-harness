/**
 * ai-review-waiver-disarm.test.ts — the override waiver clears the red and
 * stops carrying the landing with it (#1242).
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 (#1242).
 *
 * ## The configuration this removes
 *
 * `ai-review` refuses any pull request that edits `ai-review.yml` — the
 * action's own workflow-validation guard declines to review against a copy
 * that differs from the default branch — and since #1166/#1180 that refusal is
 * a hard red on a REQUIRED context. The only route to green is
 * `ai-review-override`; the label is standing; auto-merge survives it. So a
 * change to the merge gate itself could merge on a waiver with nobody reading
 * it, automatically. #1236 did, and its defects became #1241.
 *
 * ## Everything here is EXECUTED
 *
 * Both subjects are shell scripts, so every case runs one as
 * `bash -e <script>` — the shell GitHub supplies, which
 * `test/ai-review-runner-shell-parity.test.ts` AC-1 requires of every runner
 * in this family. The two steps are two processes on a real runner, so the
 * acceptance rows below chain them through a real `GITHUB_OUTPUT` file rather
 * than asserting that one builder's string contains what the other builder's
 * string contains (#530).
 *
 * ## The control, and the mutant it catches
 *
 * The cheapest wrong fix is to disarm whenever the LABEL is present — one
 * `contains(github.event.pull_request.labels.*.name, …)` in the disarm step's
 * `env:`, no report-step output, no plumbing. It satisfies the first
 * acceptance row exactly. AC-2 is the row it fails: the label is standing, so
 * it sits on pull requests whose review ran perfectly well, and the blanket
 * fix disarms those too. AC-2c BUILDS that mutant — the real script with its
 * waived reading rewritten to the label variable — hands it the row-2 state,
 * and requires it to disarm. A control that only described the wrong fix in
 * prose would prove nothing.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_AUTO_MERGE_FIELD,
  AI_REVIEW_DISARM_CLI,
  AI_REVIEW_DISARM_FAILED_TITLE,
  AI_REVIEW_DISARM_PR_VAR,
  AI_REVIEW_DISARM_REPO_VAR,
  AI_REVIEW_DISARM_STEP_ID,
  AI_REVIEW_DISARM_TITLE,
  AI_REVIEW_DISARM_TOKEN_VAR,
  AI_REVIEW_DISARM_WAIVED_VAR,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_OVERRIDE_LABEL,
  AI_REVIEW_OVERRIDE_VALUE,
  AI_REVIEW_OVERRIDE_VAR,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WAIVED_OUTPUT,
  AI_REVIEW_WAIVED_OUTPUT_VALUE,
  AI_REVIEW_WAIVED_TITLE,
  AI_REVIEW_WORKFLOW_FILE,
  buildDisarmScript,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunx, stubBunxAbsent } from "./helpers/stub-bunx";

/** The shell GitHub supplies for a `run:` step, declared so the parity scan can see it. */
const RUNNER_SHELL_FLAGS = ["-e"];

/**
 * A fixture version for the adjudicator's `bunx` pin, never the real one —
 * passing `harnessVersion()` would make the assertions agree with the
 * generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";

const ROOT = join(import.meta.dir, "..");
const COMMITTED = join(ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-waiver-disarm-"));
  scratch.push(dir);
  return dir;
}

interface Run {
  code: number;
  out: string;
  err: string;
  /** Whatever the script appended to `GITHUB_OUTPUT`. */
  output: string;
}

/**
 * The arming state a stubbed `gh` reports, and how it behaves when asked to
 * disarm.
 *
 * `view-empty` and `verify-empty` are the two states the push review on
 * #1418 named: a `gh` that exits ZERO and prints nothing. Both are distinct
 * from `not-armed` — silence is a client that did not answer, and reading it
 * as "nothing is armed" is a default substituted for a reading.
 *
 * That distinction only EXISTS if the step asks for a reading that cannot
 * come back empty, which is what `AI_REVIEW_AUTO_MERGE_ABSENT_TOKEN`
 * documents and what `stubGh` now emulates rather than assumes.
 */
type GhMode =
  | "armed"
  | "not-armed"
  | "stubborn"
  | "merge-fails"
  | "view-fails"
  | "view-empty"
  | "verify-empty";

/** The JSON object `gh pr view` prints for an ARMED pull request. */
const ARMED = `{"enabledAt":"2026-10-23T00:00:00Z"}`;

interface StubGh {
  /** PATH with this `gh` first. */
  path: string;
  /** Every argv the script handed it, one call per line. */
  calls(): string[];
}

/**
 * A `gh` on PATH that answers `pr view` from a state file and `pr merge
 * --disable-auto` by rewriting it.
 *
 * Stubbing the binary rather than handing the generated script an override
 * keeps the seam out of the artefact GitHub runs — the same argument
 * `test/helpers/stub-gh.ts` records. An override variable in a step whose job
 * is to refuse a self-merging waiver would be a switch for turning the refusal
 * off.
 *
 * It LOGS every call, because the row-2 assertion is that nothing was asked of
 * the API at all, and "the pull request is still armed" is also what a stub
 * that was never invoked would leave behind.
 */
function stubGh(mode: GhMode): StubGh {
  const dir = scratchDir();
  const state = join(dir, "state");
  const log = join(dir, "calls");
  writeFileSync(state, mode === "not-armed" ? "null\n" : `${ARMED}\n`);
  writeFileSync(log, "");

  // The state file holds the FIELD VALUE — `null`, or the object. What `gh`
  // prints for that value depends on the `-q` it was handed, and emulating
  // that dependence is the whole point of this branch (#1418).
  //
  // Measured, 2026-10-23: `-q .autoMergeRequest` on an unarmed pull request
  // prints a BARE NEWLINE. `gh` suppresses a null result; `jq` would have
  // printed the literal `null`. The previous stub printed `null` for the
  // not-armed mode whatever it was asked, so it reported a value the real
  // client does not produce, and the `= "null"` arm it certified was
  // unreachable in CI. A fixture must not assert its own premise.
  const onView = mode === "view-fails"
    ? `echo "stub-gh: view refused" >&2\n  exit 1`
    : mode === "view-empty"
      ? `exit 0`
      : `value=$(cat ${JSON.stringify(state)})
  case "$*" in
    *tostring*)
      # The always-emitting filter: a token for absent, the object for armed.
      printf '%s\\n' "$value" ;;
    *)
      # The bare field. This is the regression arm, and it is what makes the
      # not-armed row a witness: read this way, an absent auto-merge is
      # indistinguishable from a client that said nothing.
      if [ "$value" = "null" ]; then printf '\\n'; else printf '%s\\n' "$value"; fi ;;
  esac
  exit 0`;
  const onMerge = mode === "merge-fails"
    ? `echo "stub-gh: merge refused" >&2\n  exit 1`
    : mode === "stubborn"
      ? `exit 0`
      // `verify-empty`: the disarm is accepted and the READ-BACK goes silent,
      // so the step has acted and cannot confirm the action.
      : mode === "verify-empty"
        ? `printf '' > ${JSON.stringify(state)}\n  exit 0`
        : `printf 'null\\n' > ${JSON.stringify(state)}\n  exit 0`;

  const bin = join(dir, AI_REVIEW_DISARM_CLI);
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  ${onView}
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  ${onMerge}
fi
echo "stub-gh: unstubbed command: $*" >&2
exit 1
`,
  );
  chmodSync(bin, 0o755);

  return {
    path: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    calls: () => readFileSync(log, "utf-8").split("\n").filter(l => l !== ""),
  };
}

/**
 * A PATH with `bash` on it and no `gh`, for AC-6.
 *
 * Built by symlinking the shell into an otherwise empty directory rather than
 * by naming a system directory that happens to lack `gh` today: on a
 * GitHub-hosted runner the CLI lives in `/usr/bin`, so `/usr/bin:/bin` is a
 * no-`gh` PATH on this laptop and a with-`gh` PATH in CI, and the case would
 * pass locally for a reason that does not hold where it matters.
 */
function pathWithoutGh(): string {
  const dir = scratchDir();
  symlinkSync("/bin/bash", join(dir, "bash"));
  return dir;
}

/** Run a script as the runner does, and return what it wrote to `GITHUB_OUTPUT`. */
function runScript(script: string, env: Record<string, string>): Run {
  const dir = scratchDir();
  const sh = join(dir, "step.sh");
  writeFileSync(sh, script);
  const outputs = join(dir, "github_output");
  writeFileSync(outputs, "");

  const r = Bun.spawnSync(["bash", ...RUNNER_SHELL_FLAGS, sh], {
    cwd: dir,
    env: { GITHUB_OUTPUT: outputs, ...env },
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
    output: readFileSync(outputs, "utf-8"),
  };
}

// ── the two states the acceptance rows are about ─────────────────────────

/**
 * Row 1's state: the action DECLINED on its workflow-validation guard.
 *
 * That is `AI_REVIEW_ACTION_OUTCOME: success` with no payload on disk, which
 * is what run 39465155816 and #1236 both looked like. The label is on.
 */
function rowOneEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: stubBunxAbsent(),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "success",
    [AI_REVIEW_FINDINGS_PATH_VAR]: join(scratchDir(), "absent.json"),
    [AI_REVIEW_OVERRIDE_VAR]: AI_REVIEW_OVERRIDE_VALUE,
    ...extra,
  };
}

/**
 * Row 2's state: a pull request that edits no workflow, carrying the label.
 *
 * The reviewer ran and wrote a payload, and the adjudicator reports CLEAN — so
 * the report step passes on the MEASURED route and never reaches a waiver. The
 * label is on, because that is the whole of what row 2 tests.
 */
function rowTwoEnv(extra: Record<string, string> = {}): Record<string, string> {
  const payload = join(scratchDir(), "findings.json");
  writeFileSync(payload, JSON.stringify({ findings: [], verdict: "PASS" }));
  return {
    PATH: stubBunx(`echo "${AI_REVIEW_OUTCOME_LINE} CLEAN"\nexit 0`),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "success",
    [AI_REVIEW_FINDINGS_PATH_VAR]: payload,
    [AI_REVIEW_OVERRIDE_VAR]: AI_REVIEW_OVERRIDE_VALUE,
    ...extra,
  };
}

/** Parse `key=value` lines out of a `GITHUB_OUTPUT` file. */
function outputs(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) map[line.slice(0, at)] = line.slice(at + 1);
  }
  return map;
}

/** Drive the disarm step the way the runner would, given the report step's outputs. */
function runDisarm(
  reportOutputs: Record<string, string>,
  gh: { path: string },
  script = buildDisarmScript(),
): Run {
  return runScript(script, {
    PATH: gh.path,
    [AI_REVIEW_DISARM_WAIVED_VAR]: reportOutputs[AI_REVIEW_WAIVED_OUTPUT] ?? "",
    [AI_REVIEW_DISARM_PR_VAR]: "1242",
    [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
    [AI_REVIEW_DISARM_TOKEN_VAR]: "ghs_fixture",
  });
}

// ── AC-1: row 1 — waived, green, and no longer self-merging ──────────────

describe("AC-1 (#1242): a waived review passes AND leaves auto-merge disarmed", () => {
  test("AC-1a: the report step waives, exits 0, and records that it did", () => {
    const r = runScript(buildReviewRunScript(FIXTURE_VERSION), rowOneEnv());
    expect(r.code, `the waiver stopped passing:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain(`::warning title=${AI_REVIEW_WAIVED_TITLE}`);
    expect(outputs(r.output)[AI_REVIEW_WAIVED_OUTPUT]).toBe(AI_REVIEW_WAIVED_OUTPUT_VALUE);
  });

  test("AC-1b: the two steps chained — green check, and the field reads null", () => {
    const report = runScript(buildReviewRunScript(FIXTURE_VERSION), rowOneEnv());
    const gh = stubGh("armed");
    const disarm = runDisarm(outputs(report.output), gh);

    // The row, said in the issue's own terms.
    expect(report.code, "`ai-review` was not green").toBe(0);
    expect(disarm.code, `the disarm refused:\n${disarm.out}${disarm.err}`).toBe(0);
    expect(disarm.out).toContain(`::notice title=${AI_REVIEW_DISARM_TITLE}`);

    const merges = gh.calls().filter(c => c.startsWith("pr merge"));
    expect(merges.length, `gh calls: ${JSON.stringify(gh.calls())}`).toBe(1);
    expect(merges[0]).toContain("--disable-auto");
  });

  test("AC-1c: the mutant — a report step that records nothing leaves it armed", () => {
    // The regression this issue is about, performed. Removing the one call is
    // the whole of what the fix adds on the report side, so a case that cannot
    // tell this apart from the real script is not covering it.
    const mutant = buildReviewRunScript(FIXTURE_VERSION).replace(/^(\s*)record_waiver$/m, "$1:");
    expect(mutant, "no `record_waiver` call to remove — the mutant is the real script").not.toBe(
      buildReviewRunScript(FIXTURE_VERSION),
    );

    const report = runScript(mutant, rowOneEnv());
    expect(report.code, "the mutant did not waive, so it witnessed nothing").toBe(0);

    const gh = stubGh("armed");
    const disarm = runDisarm(outputs(report.output), gh);
    expect(disarm.code).toBe(0);
    expect(
      gh.calls(),
      "the mutant still disarmed — AC-1b would pass without the marker it is about",
    ).toEqual([]);
  });

  test("AC-1d: the failure route waives and records too", () => {
    // Same waiver, reached when the ACTION failed with nothing to adjudicate.
    // Both halves record, or the disarm depends on how the action died.
    const r = runScript(
      buildReviewRunScript(FIXTURE_VERSION),
      rowOneEnv({ AI_REVIEW_ACTION_OUTCOME: "failure" }),
    );
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain(`::warning title=${AI_REVIEW_WAIVED_TITLE}`);
    expect(outputs(r.output)[AI_REVIEW_WAIVED_OUTPUT]).toBe(AI_REVIEW_WAIVED_OUTPUT_VALUE);
  });
});

// ── AC-2: row 2 — the control the blanket fix fails ──────────────────────

describe("AC-2 (#1242): a labelled pull request that was really reviewed is untouched", () => {
  test("AC-2a: the report step adjudicates and records no waiver", () => {
    const r = runScript(buildReviewRunScript(FIXTURE_VERSION), rowTwoEnv());
    expect(r.code, `the clean adjudication did not pass:\n${r.out}${r.err}`).toBe(0);
    expect(r.out, "this route must not claim a waiver").not.toContain(
      `::warning title=${AI_REVIEW_WAIVED_TITLE}`,
    );
    expect(outputs(r.output)[AI_REVIEW_WAIVED_OUTPUT]).toBeUndefined();
  });

  test("AC-2b: chained, nothing is asked of the API and nothing is disarmed", () => {
    const report = runScript(buildReviewRunScript(FIXTURE_VERSION), rowTwoEnv());
    const gh = stubGh("armed");
    const disarm = runDisarm(outputs(report.output), gh);

    expect(report.code).toBe(0);
    expect(disarm.code, `${disarm.out}${disarm.err}`).toBe(0);
    expect(
      gh.calls(),
      "an ordinary labelled pull request had its auto-merge touched",
    ).toEqual([]);
  });

  test("AC-2c: the control — the blanket fix disarms this row, and is caught", () => {
    // THE CHEAPEST WRONG FIX, BUILT AND RUN. The disarm step reads the report
    // step's output; the wrong fix reads the label, which is available in the
    // same position and is one expression shorter. Both satisfy row 1. This is
    // the row that separates them, and naming it in prose would not.
    const mutant = buildDisarmScript().replace(
      AI_REVIEW_DISARM_WAIVED_VAR,
      AI_REVIEW_OVERRIDE_VAR,
    );
    expect(mutant, "the waived variable is not in the script — nothing was mutated").not.toBe(
      buildDisarmScript(),
    );

    const report = runScript(buildReviewRunScript(FIXTURE_VERSION), rowTwoEnv());
    const gh = stubGh("armed");
    const r = runScript(mutant, {
      PATH: gh.path,
      // The row-2 state exactly: no waiver marker, and the label IS on.
      [AI_REVIEW_DISARM_WAIVED_VAR]: outputs(report.output)[AI_REVIEW_WAIVED_OUTPUT] ?? "",
      [AI_REVIEW_OVERRIDE_VAR]: AI_REVIEW_OVERRIDE_VALUE,
      [AI_REVIEW_DISARM_PR_VAR]: "1242",
      [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
      [AI_REVIEW_DISARM_TOKEN_VAR]: "ghs_fixture",
    });

    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(
      gh.calls().filter(c => c.startsWith("pr merge")).length,
      "the label-reading mutant did NOT disarm an ordinary labelled pull request, so " +
        "AC-2b is not distinguishing the two fixes",
    ).toBe(1);
  });
});

// ── AC-3: a waiver that cannot be recorded does not pass ─────────────────

describe("AC-3 (#1242): the report step refuses a waiver it cannot record", () => {
  test("AC-3a: no GITHUB_OUTPUT is a refusal, not a quiet pass", () => {
    const dir = scratchDir();
    const sh = join(dir, "step.sh");
    writeFileSync(sh, buildReviewRunScript(FIXTURE_VERSION));
    const r = Bun.spawnSync(["bash", ...RUNNER_SHELL_FLAGS, sh], { cwd: dir, env: rowOneEnv() });
    const err = new TextDecoder().decode(r.stderr);
    expect(
      r.exitCode,
      `a waiver nobody could record still passed:\n${new TextDecoder().decode(r.stdout)}${err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(err).toContain(`::error title=${AI_REVIEW_DISARM_FAILED_TITLE}`);
  });

  test("AC-3b: a marker that does not read back is a refusal", () => {
    // The read-back, performed: the mutant writes to a path nothing reads, so
    // the `grep -qF` comes back empty exactly as a lost write would. Without
    // the read-back this is a green waived check with an armed auto-merge.
    const sink = join(scratchDir(), "elsewhere");
    writeFileSync(sink, "");
    const mutant = buildReviewRunScript(FIXTURE_VERSION).replace(
      `>> "\${GITHUB_OUTPUT}"`,
      `>> ${JSON.stringify(sink)}`,
    );
    expect(mutant).not.toBe(buildReviewRunScript(FIXTURE_VERSION));

    const r = runScript(mutant, rowOneEnv());
    expect(r.code, `a lost marker passed:\n${r.out}${r.err}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err).toContain(`::error title=${AI_REVIEW_DISARM_FAILED_TITLE}`);
  });

  test("AC-3c: the pair — the unmutated script writes the marker and passes", () => {
    // So AC-3b's red is the lost write, not something the mutation broke in
    // passing. Same input, one substitution apart.
    const r = runScript(buildReviewRunScript(FIXTURE_VERSION), rowOneEnv());
    expect(r.code).toBe(0);
    expect(r.output).toContain(`${AI_REVIEW_WAIVED_OUTPUT}=${AI_REVIEW_WAIVED_OUTPUT_VALUE}`);
  });
});

// ── AC-4: the committed workflow, not the builder ────────────────────────

describe("AC-4 (#1242): the committed workflow carries the step the runner executes", () => {
  const doc = Bun.YAML.parse(readFileSync(COMMITTED, "utf-8")) as any;
  const steps = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []) as any[];

  test("AC-4a: the population this reads is the committed job's steps", () => {
    // Stated rather than assumed: every case below is vacuous on an empty
    // list, and an empty list is also what a renamed job would produce.
    expect(steps.length, `no steps under jobs.${AI_REVIEW_JOB} in ${COMMITTED}`).toBeGreaterThan(7);
    expect(steps.map(s => s?.id)).toContain(AI_REVIEW_DISARM_STEP_ID);
  });

  test("AC-4b: it is last, after the drift reading", () => {
    const ids = steps.map(s => s?.id);
    expect(ids.indexOf(AI_REVIEW_DISARM_STEP_ID)).toBeGreaterThan(
      ids.indexOf(AI_REVIEW_DRIFT_STEP_ID),
    );
    expect(ids[ids.length - 1]).toBe(AI_REVIEW_DISARM_STEP_ID);
  });

  test("AC-4c: it carries no `if:` — a skipped step reports skipped", () => {
    const step = steps.find(s => s?.id === AI_REVIEW_DISARM_STEP_ID);
    expect(Object.keys(step)).not.toContain("if");
  });

  test("AC-4d: it reads the report step's output, and the label nowhere", () => {
    const step = steps.find(s => s?.id === AI_REVIEW_DISARM_STEP_ID);
    expect(step.env?.[AI_REVIEW_DISARM_WAIVED_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_RUN_STEP_ID}.outputs.${AI_REVIEW_WAIVED_OUTPUT} }}`,
    );
    // The EXPRESSION, not the label's name — the annotations this step prints
    // quote the label, which is prose and is the point of them. What must not
    // be here is a second resolution of the label by the runner, which is the
    // only form the wrong fix can take in an `env:` block.
    expect(
      JSON.stringify(step.env ?? {}),
      "the disarm step resolves the label itself — see AC-2c for why that is the wrong fix",
    ).not.toContain("github.event.pull_request.labels");
  });

  test("AC-4e: the control — that expression IS in the committed file, once", () => {
    // Without this, AC-4d passes on a workflow where the label is resolved
    // nowhere at all, including one where the waiver has been deleted. The
    // count is the population: one resolution, in the report step, which is
    // the single reading `AI_REVIEW_OVERRIDE_LABEL` is documented to have.
    const report = steps.find(s => s?.id === AI_REVIEW_RUN_STEP_ID);
    expect(String(report.env?.[AI_REVIEW_OVERRIDE_VAR] ?? "")).toContain(
      AI_REVIEW_OVERRIDE_LABEL,
    );
    const resolvers = steps.filter(s =>
      JSON.stringify(s?.env ?? {}).includes("github.event.pull_request.labels"),
    );
    expect(resolvers.map(s => s?.id)).toEqual([AI_REVIEW_RUN_STEP_ID]);
  });
});

// ── AC-5: the disarm reads the field back ────────────────────────────────

describe("AC-5 (#1242): the disarm verifies, rather than trusting an exit code", () => {
  const waived = { [AI_REVIEW_WAIVED_OUTPUT]: AI_REVIEW_WAIVED_OUTPUT_VALUE };

  test("AC-5a: a disarm that reports success and changed nothing is refused", () => {
    const gh = stubGh("stubborn");
    const r = runDisarm(waived, gh);
    expect(r.code, `a pull request left armed still passed:\n${r.out}${r.err}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(r.err).toContain(`::error title=${AI_REVIEW_DISARM_FAILED_TITLE}`);
    expect(gh.calls().filter(c => c.startsWith("pr view")).length, "it read once, not twice").toBe(
      2,
    );
  });

  test("AC-5b: the mutant — without the read-back the stubborn case goes green", () => {
    // `stubborn` exits 0 from `pr merge` and leaves the field armed, which is
    // the real state where a pull request merged between the two calls. The
    // exit code cannot tell it from a disarm that worked.
    // Both post-merge guards go — the emptiness one and the still-armed one —
    // so what is removed is the whole reading and not half of a conjunction
    // the other half would hold up.
    const mutant = buildDisarmScript()
      .replace(/if \[ -z "\$\{after\}" \]; then\n(?:.*\n)*?fi\n\n/, "")
      .replace(/if \[ "\$\{after\}" != "null" \]; then\n(?:.*\n)*?fi\n/, "");
    expect(mutant, "no read-back check to remove").not.toBe(buildDisarmScript());
    expect(mutant, "a post-merge guard survived the mutation").not.toContain(`"\${after}" !=`);
    const r = runDisarm(waived, stubGh("stubborn"), mutant);
    expect(r.code, "the mutant refused anyway, so AC-5a witnessed something else").toBe(0);
  });

  test("AC-5c: a `gh pr merge` that fails is refused", () => {
    const r = runDisarm(waived, stubGh("merge-fails"));
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err).toContain(`::error title=${AI_REVIEW_DISARM_FAILED_TITLE}`);
  });

  test("AC-5d: a `gh pr view` that fails is UNMEASURED, not nothing-to-do", () => {
    const r = runDisarm(waived, stubGh("view-fails"));
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err).toContain(AI_REVIEW_AUTO_MERGE_FIELD);
  });

  test("AC-5f: a SILENT pre-reading is UNMEASURED, not nothing-to-do (#1418 review)", () => {
    // `null` and `` are different facts. `jq` prints the literal `null` for an
    // absent `autoMergeRequest`, so an EMPTY reading is a client that exited
    // zero without answering — and reading it as "nothing is armed" is the
    // Silent Default Substitution this module's own header is about, in the
    // one branch where the substituted default lets an armed pull request
    // through.
    const gh = stubGh("view-empty");
    const r = runDisarm(waived, gh);
    expect(r.code, `a silent reading was taken as unarmed:\n${r.out}${r.err}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(r.err).toContain(`::error title=${AI_REVIEW_DISARM_FAILED_TITLE}`);
    expect(
      gh.calls().filter(c => c.startsWith("pr merge")),
      "it tried to disarm on a reading it did not have",
    ).toEqual([]);
  });

  test("AC-5g: a SILENT read-back is UNMEASURED, and the step HAS acted by then", () => {
    // Worse than AC-5f: the disarm request was accepted, so this is the one
    // state where the step cannot say whether the thing it just did took
    // effect. `-n` on the after-reading had made this green.
    const gh = stubGh("verify-empty");
    const r = runDisarm(waived, gh);
    expect(r.code, `a silent read-back passed:\n${r.out}${r.err}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(gh.calls().filter(c => c.startsWith("pr merge")).length, "it never disarmed").toBe(1);
  });

  test("AC-5h: the mutant — an emptiness-tolerant reading passes both", () => {
    // The shape this PR shipped with and the push review caught: `[ -z ]`
    // folded into the not-armed arm, and `&& [ -n "${after}" ]` guarding the
    // read-back. Rebuilt here, so AC-5f and AC-5g cannot both be true of a
    // script that tolerates silence.
    const tolerant = buildDisarmScript()
      .replace(/if \[ -z "\$\{armed\}" \]; then\n(?:.*\n)*?fi\n\n/, "")
      .replace(
        `if [ "\${armed}" = "null" ]; then`,
        `if [ "\${armed}" = "null" ] || [ -z "\${armed}" ]; then`,
      )
      .replace(/if \[ -z "\$\{after\}" \]; then\n(?:.*\n)*?fi\n\n/, "")
      .replace(
        `if [ "\${after}" != "null" ]; then`,
        `if [ "\${after}" != "null" ] && [ -n "\${after}" ]; then`,
      );
    // The mutation is SPELLED, so assert it landed in full rather than
    // trusting that four substitutions all matched: a mutant that failed to
    // apply reads exactly like a guard that was never needed.
    //
    // Counted by the REFUSAL TEXT, not by the test expression: the
    // reconstructed conditions legitimately contain `[ -z "${armed}" ]` as
    // one arm of a disjunction, so a substring check on the expression
    // reports a survivor that is not one. The message is emitted by the
    // refusal and by nothing else.
    const emptyRefusals = (s: string) => s.split("came back EMPTY").length - 1;
    expect(emptyRefusals(buildDisarmScript()), "the population being removed").toBe(2);
    expect(tolerant, "nothing was mutated").not.toBe(buildDisarmScript());
    expect(emptyRefusals(tolerant), "an emptiness refusal survived").toBe(0);
    expect(tolerant).toContain(`|| [ -z "\${armed}" ]`);
    expect(tolerant).toContain(`&& [ -n "\${after}" ]`);
    expect(runDisarm(waived, stubGh("view-empty"), tolerant).code, "AC-5f witnessed nothing").toBe(
      0,
    );
    expect(
      runDisarm(waived, stubGh("verify-empty"), tolerant).code,
      "AC-5g witnessed nothing",
    ).toBe(0);
  });

  test("AC-5e: nothing armed is nothing to do, and says so", () => {
    const gh = stubGh("not-armed");
    const r = runDisarm(waived, gh);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain(`::notice title=${AI_REVIEW_DISARM_TITLE}`);
    expect(gh.calls().filter(c => c.startsWith("pr merge")), "it merged on an unarmed PR").toEqual(
      [],
    );
  });
});

// ── AC-6: the states where the disarm cannot act at all ──────────────────

describe("AC-6 (#1242): a waiver it cannot decouple is red, never green", () => {
  const waived = { [AI_REVIEW_WAIVED_OUTPUT]: AI_REVIEW_WAIVED_OUTPUT_VALUE };

  test("AC-6a: no `gh` on the runner is a refusal", () => {
    const r = runDisarm(waived, { path: pathWithoutGh() });
    expect(r.code, `a runner with no CLI passed a waived pull request:\n${r.out}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(r.err).toContain(AI_REVIEW_DISARM_CLI);
  });

  test("AC-6b: no pull request number alongside a waiver is a contradiction, so red", () => {
    const gh = stubGh("armed");
    const r = runScript(buildDisarmScript(), {
      PATH: gh.path,
      [AI_REVIEW_DISARM_WAIVED_VAR]: AI_REVIEW_WAIVED_OUTPUT_VALUE,
      [AI_REVIEW_DISARM_PR_VAR]: "",
      [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
      [AI_REVIEW_DISARM_TOKEN_VAR]: "ghs_fixture",
    });
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-6c: no token is a refusal", () => {
    const gh = stubGh("armed");
    const r = runScript(buildDisarmScript(), {
      PATH: gh.path,
      [AI_REVIEW_DISARM_WAIVED_VAR]: AI_REVIEW_WAIVED_OUTPUT_VALUE,
      [AI_REVIEW_DISARM_PR_VAR]: "1242",
      [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
      [AI_REVIEW_DISARM_TOKEN_VAR]: "",
    });
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-6d: the pair — an unwaived run on a runner with no `gh` is untouched", () => {
    // So AC-6a is the waiver reaching the CLI check, not the CLI check firing
    // on every run. A merge_group entry and an ordinary pull request both
    // reach this step with no marker and must exit 0 having done nothing.
    const r = runScript(buildDisarmScript(), {
      PATH: pathWithoutGh(),
      [AI_REVIEW_DISARM_WAIVED_VAR]: "",
      [AI_REVIEW_DISARM_PR_VAR]: "",
      [AI_REVIEW_DISARM_REPO_VAR]: "",
      [AI_REVIEW_DISARM_TOKEN_VAR]: "",
    });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
  });

  test("AC-6f: the notices claim a point in time, not standing protection (#1418 review)", () => {
    // A TEXT assertion, and it is load-bearing for the same reason the
    // UNMEASURED annotations are: the notice is the only thing a maintainer
    // reads, and this step's protection genuinely ends when the step does.
    // Nothing here stops auto-merge being re-armed after this run, and if no
    // further push or label event follows there is no next run to disarm it.
    // A notice promising otherwise is a check that cannot fail, written in
    // prose.
    const script = buildDisarmScript();
    expect(
      script,
      "the notice promises a protection that outlives the run that printed it",
    ).not.toContain("will not merge itself");
    // And the honest sentence is asserted positively, because `not.toContain`
    // alone is equally satisfied by a notice that says nothing at all.
    expect(script).toContain("as it stood when this step read it");
    expect(script).toContain("re-armed after this run");
  });

  test("AC-6e: the waived reading is an exact compare, not a prefix", () => {
    // The producer is `record_waiver`, which writes the literal this reads,
    // so a looser compare would buy nothing and would widen what can switch
    // the step on. `True` is not that literal and must be read as "no waiver".
    const gh = stubGh("armed");
    const r = runScript(buildDisarmScript(), {
      PATH: gh.path,
      [AI_REVIEW_DISARM_WAIVED_VAR]: "True",
      [AI_REVIEW_DISARM_PR_VAR]: "1242",
      [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
      [AI_REVIEW_DISARM_TOKEN_VAR]: "ghs_fixture",
    });
    expect(r.code).toBe(0);
    expect(gh.calls(), "a case-insensitive reading disarmed on `True`").toEqual([]);
  });
});
