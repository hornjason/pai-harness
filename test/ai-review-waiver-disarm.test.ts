/**
 * ai-review-waiver-disarm.test.ts — the override waiver clears the red and
 * stops carrying the landing with it (#1242).
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 (#1242).
 * Covers AC-7 (#1428) — the step does not resolve its own tool out of an
 * environment the reviewed content can write.
 *
 * ## AC-7 and what it is about (#1428)
 *
 * This step is LAST in the job and the step before it is the REVIEWER, which
 * executes model-directed work. Anything a step writes to `GITHUB_PATH` or
 * `GITHUB_ENV` is inherited by every later step, so until #1428 the `gh` this
 * step resolved — and the `GH_HOST`/`GH_CONFIG_DIR` it resolved it under —
 * were values the reviewed content had an opportunity to set, in the step
 * whose entire job is disarming auto-merge on a waived review.
 *
 * Two changes, both executed here rather than grepped. The CLI is resolved by
 * `AI_REVIEW_PREPARE_STEP_ID`, which runs BEFORE the reviewer, and carried
 * forward as an absolute path — `GITHUB_PATH` cannot reach backwards. And the
 * inherited `gh` configuration is destroyed before the token is exported.
 *
 * Three readings of the carried value, three outcomes, because an EMPTY value
 * and a reading of ABSENCE are different facts: empty is a broken wire, the
 * `AI_REVIEW_CLI_ABSENT_TOKEN` is a runner with no CLI, and a recorded path
 * that is no longer executable is a third.
 *
 * ## What was broken to prove it
 *
 * Run over this file alone. `lib/scaffold/ai-review-step.ts` restored from a
 * `cp` backup after every row — never `git checkout --` — and confirmed
 * byte-identical by sha256 (`56ead6ea…`) afterwards, with the baseline
 * re-measured. Every count was predicted before the battery ran, and the
 * baseline row was read first.
 *
 * | Row | Mutation | Predicted | Measured |
 * |---|---|---|---|
 * | **baseline** | unmutated | 39 pass, 0 fail | **39 pass, 0 fail** |
 * | **M1** | the two call sites reverted to a bare `gh` — the pre-#1428 PATH lookup | 2 | **3 of 39** — AC-7a, AC-7b, AC-7d |
 * | **M2** | the `unset` of the inherited configuration removed | 4 | **4 of 39** — AC-7b, AC-7c, AC-7d, AC-7e |
 * | **M3** | the empty-reading refusal removed, so empty falls through to the not-executable arm | 1 | **1 of 39** — AC-7f |
 * | **M4** | the prepare step records `""` instead of the absent token | 1 | **1 of 39** — AC-7i |
 * | **M5** | the prepare step stops writing the output at all | 2 | **2 of 39** — AC-7h, AC-7i |
 *
 * **Before believing any row, the input on which mutant and original differ,
 * named and run rather than assumed.** For M1 and M2 it is the AC-7a/AC-7c
 * fixture: a `gh` planted first on PATH and a `GH_HOST` planted in the
 * environment. The real script never executes the plant and the stub records
 * no `GH_HOST`; M1 executes the plant and asks the pre-resolved stub nothing,
 * M2 forwards `GH_HOST=ghe.attacker.example` into the CLI's environment. For
 * M3 it is an empty `AI_REVIEW_DISARM_CLI_PATH_VAR`: the real script names the
 * wire, the mutant emits the not-executable sentence about an empty path. For
 * M4 and M5 it is a runner with no `gh`: the real prepare step records
 * `AI_REVIEW_CLI_ABSENT_TOKEN`, M4 records the empty string and M5 records
 * nothing.
 *
 * **M1 came back HIGH by one, and the extra red is the builder refusing.**
 * The prediction named AC-7b as the aborting case and forgot that AC-7d calls
 * the same builder: with no `"${cli}"` call site left, `prePathHardeningMutant`
 * throws *"the CLI call site appears 0 times"* rather than measuring nothing,
 * which is the loud-abort property a mutant builder is supposed to have. Not
 * a crashing mutant — 36 cases still pass and both reds are squarely about the
 * mutated behaviour.
 *
 * **The cheapest wrong fixes, named, and whether AC-7a survives them.**
 * *Keep `command -v` and add only the `unset`* — AC-7a survives
 * NON-vacuously: the plant is still first on PATH and is still what resolves.
 * *Hardcode `PATH=/usr/local/bin:/usr/bin:/bin` at the top of the step* —
 * AC-7a survives too, and this is why it asserts BOTH halves: the plant not
 * running is also what a hardcoded PATH produces, so the case additionally
 * requires that the PRE-RESOLVED stub took all three calls, which a hardcoded
 * PATH would not satisfy.
 *
 * ## What AC-7 does NOT establish, said as a gap rather than implied
 *
 * A reviewer that can WRITE the resolved path replaces the binary without
 * changing which path resolves. On a GitHub-hosted runner `gh` is root-owned
 * under `/usr/bin`; on a self-hosted runner whose CLI sits in a user-writable
 * directory this is UNMEASURED, and nothing here can tell the two apart.
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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_AUTO_MERGE_FIELD,
  AI_REVIEW_CLI_ABSENT_TOKEN,
  AI_REVIEW_DISARM_CLI,
  AI_REVIEW_DISARM_CLI_OUTPUT,
  AI_REVIEW_DISARM_CLI_PATH_VAR,
  AI_REVIEW_DISARM_FAILED_TITLE,
  AI_REVIEW_DISARM_PR_VAR,
  AI_REVIEW_DISARM_REPO_VAR,
  AI_REVIEW_DISARM_STEP_ID,
  AI_REVIEW_DISARM_TITLE,
  AI_REVIEW_DISARM_TOKEN_VAR,
  AI_REVIEW_DISARM_WAIVED_VAR,
  AI_REVIEW_DISARM_NEUTRALISED_VARS,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_PREPARE_STEP_ID,
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
  buildPrepareScript,
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
  /**
   * The ABSOLUTE path of this `gh` — what the prepare step would have
   * recorded, and what the disarm step executes since #1428. PATH is no
   * longer how the disarm step finds its CLI, so `path` above is only the
   * ambient environment the step happens to run under.
   */
  bin: string;
  /** Every argv the script handed it, one call per line. */
  calls(): string[];
  /** Every `GH_`/`GITHUB_` variable the stub saw, one `NAME=value` per line. */
  env(): string[];
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
  // #1428: the stub records the `GH_*`/`GITHUB_*` environment it was handed.
  // Neutralising a variable is a claim about what the CLI SEES, and the only
  // place that can be read is inside the process that was launched.
  const seen = join(dir, "env");
  writeFileSync(seen, "");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
env | grep -E '^(GH_|GITHUB_)' >> ${JSON.stringify(seen)} || true
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
    bin,
    calls: () => readFileSync(log, "utf-8").split("\n").filter(l => l !== ""),
    env: () => readFileSync(seen, "utf-8").split("\n").filter(l => l !== ""),
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
function pathWithoutGh(tools: string[] = []): string {
  const dir = scratchDir();
  symlinkSync("/bin/bash", join(dir, "bash"));
  // #1428's AC-7i runs the PREPARE script on such a PATH, and that script
  // needs real tools. Each is resolved rather than hardcoded: `/usr/bin` and
  // `/bin` differ by platform, and a hardcoded path that is wrong here fails
  // as "the tool is missing", which is the state the case is varying.
  for (const t of tools) {
    const at = Bun.which(t);
    if (at === null) throw new Error(`the fixture needs ${t} and it is not on this machine's PATH`);
    symlinkSync(at, join(dir, t));
  }
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

/**
 * Drive the disarm step the way the runner would, given the report step's
 * outputs.
 *
 * Since #1428 the CLI arrives as `AI_REVIEW_DISARM_CLI_PATH_VAR`, which the
 * PREPARE step resolved before the reviewer ran, and PATH is not how this
 * step finds `gh` any more. `gh.bin` is that recording; `extra` is how a
 * case plants something else in the environment.
 */
function runDisarm(
  reportOutputs: Record<string, string>,
  gh: { path: string; bin?: string },
  script = buildDisarmScript(),
  extra: Record<string, string> = {},
): Run {
  return runScript(script, {
    PATH: gh.path,
    [AI_REVIEW_DISARM_WAIVED_VAR]: reportOutputs[AI_REVIEW_WAIVED_OUTPUT] ?? "",
    [AI_REVIEW_DISARM_PR_VAR]: "1242",
    [AI_REVIEW_DISARM_REPO_VAR]: "hornjason/pai-harness",
    [AI_REVIEW_DISARM_TOKEN_VAR]: "ghs_fixture",
    [AI_REVIEW_DISARM_CLI_PATH_VAR]: gh.bin ?? AI_REVIEW_CLI_ABSENT_TOKEN,
    ...extra,
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
      [AI_REVIEW_DISARM_CLI_PATH_VAR]: gh.bin,
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
    // Since #1428 the reading comes from the PREPARE step, which records the
    // absent token rather than an empty string — see AC-7c for why an empty
    // value is a DIFFERENT refusal.
    const r = runDisarm(waived, { path: pathWithoutGh(), bin: AI_REVIEW_CLI_ABSENT_TOKEN });
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
      [AI_REVIEW_DISARM_CLI_PATH_VAR]: gh.bin,
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
      [AI_REVIEW_DISARM_CLI_PATH_VAR]: gh.bin,
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
      [AI_REVIEW_DISARM_CLI_PATH_VAR]: "",
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

// ── AC-7: the step does not resolve its tool out of the reviewer's env ───

/**
 * A `gh` that is NOT the stub: it records that it ran and reports a
 * successful disarm having done nothing.
 *
 * This is the binary a reviewer would plant. The reviewer step runs
 * model-directed work and the runner carries whatever it writes to
 * `GITHUB_PATH` into every LATER step's PATH — and the disarm step is the
 * last step in the job, so "later" is all of it.
 *
 * It reports SUCCESS rather than failing, because a planted tool that
 * crashes is caught by the refusals that already exist. The interesting
 * state is the one where every assertion in this file passes and no pull
 * request was disarmed.
 */
function hostileGh(): { dir: string; ran(): boolean } {
  const dir = scratchDir();
  const marker = join(dir, "ran");
  const bin = join(dir, AI_REVIEW_DISARM_CLI);
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(marker)}
# The always-emitting filter's absent token, so a step that runs this one
# concludes "nothing was armed" and exits 0 having disarmed nothing.
printf 'null\\n'
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { dir, ran: () => existsSync(marker) };
}

/**
 * The pre-#1428 disarm script, rebuilt from the shipped one.
 *
 * Three removals, and all three are what the file held before this change:
 * the `unset` of the inherited `gh` configuration, the three readings of
 * `AI_REVIEW_DISARM_CLI_PATH_VAR`, and the quoted `"${cli}"` at each call
 * site, which was a bare `gh` resolved from PATH.
 *
 * Every anchor is located exactly once or this throws. A mutant builder
 * that silently finds nothing measures that the file still parses
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
function prePathHardeningMutant(): string {
  const real = buildDisarmScript();
  const unsetLine = `unset ${AI_REVIEW_DISARM_NEUTRALISED_VARS.join(" ")}`;
  const end = `export GH_TOKEN="`;
  const callSite = '"${cli}"';

  const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
  if (occurrences(real, unsetLine) !== 1) {
    throw new Error(
      `could not build the mutant: the neutralise line appears ${occurrences(real, unsetLine)} times`,
    );
  }
  if (occurrences(real, end) !== 1) {
    throw new Error(
      `could not build the mutant: the token export appears ${occurrences(real, end)} times`,
    );
  }
  const from = real.indexOf(unsetLine);
  // Back up over the block comment that introduces the `unset`, so the
  // mutant does not carry prose describing a mechanism it no longer has.
  const blockStart = real.lastIndexOf("\n# #1428.", from);
  if (blockStart < 0) throw new Error("could not build the mutant: no #1428 block comment");
  const to = real.indexOf(end);
  const stripped = real.slice(0, blockStart + 1) + real.slice(to);

  // Counted AFTER the resolution block is gone, so the number is the CALL
  // SITES and not those plus the three readings of the same variable. Three
  // is `pr view`, `pr merge`, `pr view` again.
  const calls = occurrences(stripped, callSite);
  if (calls !== 3) {
    throw new Error(`could not build the mutant: the CLI call site appears ${calls} times, want 3`);
  }
  return stripped.split(callSite).join(AI_REVIEW_DISARM_CLI);
}

describe("AC-7 (#1428): the disarm does not resolve its tool from the reviewer's environment", () => {
  const waived = { [AI_REVIEW_WAIVED_OUTPUT]: AI_REVIEW_WAIVED_OUTPUT_VALUE };

  test("AC-7a: a `gh` planted ahead on PATH is not the binary that runs", () => {
    const hostile = hostileGh();
    const gh = stubGh("armed");
    const r = runDisarm(waived, { path: `${hostile.dir}:${gh.path}`, bin: gh.bin });

    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(
      hostile.ran(),
      "the step executed a `gh` the reviewed content put on PATH",
    ).toBe(false);
    // BOTH halves. "The plant did not run" is also what a step that found no
    // CLI at all would leave behind, and a repair that hardcodes PATH would
    // satisfy it while running some third binary. The pre-resolved stub
    // having taken all three calls is the positive half.
    expect(gh.calls().length, "the pre-resolved CLI was not the one driven").toBe(3);
  });

  test("AC-7b: the control — the pre-#1428 script DOES run the plant", () => {
    // Without this, AC-7a cannot tell a fix from a fixture whose poison never
    // worked. Same inputs, the only difference being the three removals.
    const hostile = hostileGh();
    const gh = stubGh("armed");
    const r = runDisarm(
      waived,
      { path: `${hostile.dir}:${gh.path}`, bin: gh.bin },
      prePathHardeningMutant(),
    );

    expect(hostile.ran(), "the plant was never reached — AC-7a witnessed nothing").toBe(true);
    expect(gh.calls(), "the pre-#1428 script somehow used the pre-resolved path").toEqual([]);
    // And it exits GREEN having disarmed nothing, which is the whole defect:
    // a waived pull request left armed under a successful required check.
    expect(r.code, "the pre-#1428 script refused, so the defect is not what AC-7a is about").toBe(0);
  });

  test("AC-7c: a `GH_HOST` the reviewer planted does not reach the CLI", () => {
    const gh = stubGh("armed");
    const r = runDisarm(waived, gh, undefined, {
      GH_HOST: "ghe.attacker.example",
      GH_CONFIG_DIR: "/tmp/planted-gh-config",
    });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    const seen = gh.env();
    expect(seen.length, "the stub recorded no environment at all").toBeGreaterThan(0);
    expect(seen.filter(l => l.startsWith("GH_HOST="))).toEqual([]);
    expect(seen.filter(l => l.startsWith("GH_CONFIG_DIR="))).toEqual([]);
    // The positive control: the variables this step DOES mean to pass are
    // still there, so the assertion above is a neutralisation and not a stub
    // that reads its environment through a hole.
    expect(seen.some(l => l.startsWith("GH_TOKEN="))).toBe(true);
  });

  test("AC-7d: the control — the pre-#1428 script forwards both", () => {
    const gh = stubGh("armed");
    runDisarm(waived, gh, prePathHardeningMutant(), {
      GH_HOST: "ghe.attacker.example",
      GH_CONFIG_DIR: "/tmp/planted-gh-config",
    });
    const seen = gh.env();
    expect(seen.some(l => l === "GH_HOST=ghe.attacker.example"), "AC-7c witnessed nothing").toBe(
      true,
    );
    expect(seen.some(l => l === "GH_CONFIG_DIR=/tmp/planted-gh-config")).toBe(true);
  });

  test("AC-7e: every name in the neutralised set is actually destroyed", () => {
    // The set is data, so a name added to it with no `unset` behind it would
    // read as covered. This drives the real script with every one of them
    // planted and asserts the CLI saw none.
    const gh = stubGh("armed");
    const planted: Record<string, string> = {};
    for (const v of AI_REVIEW_DISARM_NEUTRALISED_VARS) planted[v] = `planted-${v}`;
    const r = runDisarm(waived, gh, undefined, planted);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    const seen = gh.env();
    expect(seen.length).toBeGreaterThan(0);
    const survivors = AI_REVIEW_DISARM_NEUTRALISED_VARS.filter(v =>
      seen.includes(`${v}=planted-${v}`),
    );
    expect(
      survivors,
      "a name in AI_REVIEW_DISARM_NEUTRALISED_VARS reaches the CLI anyway",
    ).toEqual([]);
  });

  test("AC-7f: an EMPTY reading is its own refusal, not the absent one", () => {
    // The two states this file exists to keep apart, one layer out: the
    // producing step recorded nothing (the wire is broken) versus the
    // producing step recorded that there is no CLI.
    const gh = stubGh("armed");
    const empty = runDisarm(waived, { path: gh.path, bin: "" });
    const absent = runDisarm(waived, { path: gh.path, bin: AI_REVIEW_CLI_ABSENT_TOKEN });

    expect(empty.code, "an empty reading passed a waived pull request").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(absent.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      empty.err,
      "the empty reading and the absent reading produce the same annotation",
    ).not.toBe(absent.err);
    // Each names the state it is about. The empty one names the WIRE — that
    // is the actionable fact when no reading arrived — and the absent one
    // does not, because on that branch the wire worked.
    expect(empty.err).toContain(AI_REVIEW_DISARM_CLI_PATH_VAR);
    expect(empty.err).toContain(AI_REVIEW_CLI_ABSENT_TOKEN);
    expect(absent.err).not.toContain(AI_REVIEW_DISARM_CLI_PATH_VAR);
    // Both are the post-#1428 messages and not one old sentence reaching
    // both branches, which is what `not.toBe` alone would also accept.
    expect(absent.err).toContain(AI_REVIEW_PREPARE_STEP_ID);
    expect(empty.err).toContain(AI_REVIEW_PREPARE_STEP_ID);
    // Neither reached the API. "It refused" and "it refused before acting"
    // are different claims and only the second is true here.
    expect(gh.calls()).toEqual([]);
  });

  test("AC-7g: a recorded path that is no longer executable is a third refusal", () => {
    const gh = stubGh("armed");
    const dir = scratchDir();
    const dud = join(dir, AI_REVIEW_DISARM_CLI);
    writeFileSync(dud, "#!/bin/sh\nexit 0\n");
    chmodSync(dud, 0o644);

    const r = runDisarm(waived, { path: gh.path, bin: dud });
    expect(r.code, `a non-executable recorded CLI passed:\n${r.out}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err).toContain(dud);
    expect(
      gh.calls(),
      "the step fell back to PATH after the recorded path failed — that is #1428 reinstated",
    ).toEqual([]);
  });

  test("AC-7h: the prepare step RESOLVES the CLI, and records an absolute path", () => {
    // Executed, not grepped. The producing half of the wire has to be a real
    // reading or the consuming half above is asserting about nothing.
    const gh = stubGh("armed");
    const temp = scratchDir();
    const r = runScript(buildPrepareScript(), {
      PATH: gh.path,
      RUNNER_TEMP: temp,
      GITHUB_RUN_ID: "1428",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(outputs(r.output)[AI_REVIEW_DISARM_CLI_OUTPUT]).toBe(gh.bin);
  });

  test("AC-7i: a runner with no CLI records the token, never an empty value", () => {
    const temp = scratchDir();
    const r = runScript(buildPrepareScript(), {
      PATH: pathWithoutGh(["mkdir", "chmod", "stat", "rm"]),
      RUNNER_TEMP: temp,
      GITHUB_RUN_ID: "1428",
      GITHUB_RUN_ATTEMPT: "2",
    });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(outputs(r.output)[AI_REVIEW_DISARM_CLI_OUTPUT]).toBe(AI_REVIEW_CLI_ABSENT_TOKEN);
  });

  test("AC-7j: the committed workflow wires the two steps, and the disarm resolves nothing", () => {
    const doc = Bun.YAML.parse(readFileSync(COMMITTED, "utf-8")) as any;
    const steps: any[] = doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? [];
    expect(steps.length, "the committed job has no steps").toBeGreaterThan(0);

    const prepare = steps.find(s => s?.id === AI_REVIEW_PREPARE_STEP_ID);
    const disarm = steps.find(s => s?.id === AI_REVIEW_DISARM_STEP_ID);
    expect(prepare, `no '${AI_REVIEW_PREPARE_STEP_ID}' step`).toBeDefined();
    expect(disarm, `no '${AI_REVIEW_DISARM_STEP_ID}' step`).toBeDefined();

    // The producing step runs BEFORE the reviewer, which is the entire
    // property. An ordering that put it after would resolve the CLI from the
    // same poisoned PATH and every other case here would stay green.
    const review = steps.findIndex(s => s?.id === AI_REVIEW_RUN_STEP_ID);
    expect(review, `no '${AI_REVIEW_RUN_STEP_ID}' step`).toBeGreaterThan(-1);
    expect(steps.indexOf(prepare)).toBeLessThan(review);

    expect(disarm.env?.[AI_REVIEW_DISARM_CLI_PATH_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.${AI_REVIEW_DISARM_CLI_OUTPUT} }}`,
    );
    expect(String(prepare.run)).toContain(`${AI_REVIEW_DISARM_CLI_OUTPUT}=`);
    expect(
      String(disarm.run),
      "the disarm step resolves the CLI from PATH again — #1428 reinstated",
    ).not.toContain(`command -v ${AI_REVIEW_DISARM_CLI}`);
  });
});
