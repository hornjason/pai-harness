#!/usr/bin/env bun
/**
 * Record a suite run, bound to the commit it ran against (#224).
 *
 * Run `wf_7ac5f614-d21` reported `regressions: 0` over a branch whose suite
 * had one failing test. The count and the tree being shipped were never
 * connected, so nothing could notice. This is the write half of connecting
 * them: a failure count is persisted only alongside the SHA it was measured
 * at, and anything that cannot supply both is refused rather than recorded.
 *
 * WHY A SCRIPT. `workflows/ship.js` runs in a sandbox with no module loading
 * (#69), so it cannot call writeWorkflowState itself, and gates/SCHEMA-GUIDE.md
 * forbids writing the file with Write or `cat >` — Zod validates at write time
 * and an invalid value must fail here, loudly, rather than as an opaque gate
 * failure later.
 *
 * WHY THERE IS NO --verdict. The verdict is derived from the failure count and
 * nothing else. A flag would let a caller hand this script the word PASS over
 * a suite that failed, which is #224 restated as an argument. PASS means the
 * count was zero; it has no other meaning here.
 *
 * Every argument is refused rather than sanitised when it is not the shape it
 * must be. A SHA that needs quoting is not a SHA, and three consecutive
 * security reviews of this repo's shell surfaces each found a new hole in a
 * filter that tried to clean its input instead of rejecting it.
 *
 * WHY THERE IS NO --sha. The measured commit is read from the project tree
 * (#312 SC-A12). A SHA a caller types can agree with HEAD by construction,
 * which is the comparison quietly answering itself — the same defect as a
 * caller-supplied verdict, one field over. `--sha` is refused by name rather
 * than falling through to "unexpected argument", because the flag was in the
 * documented usage for its whole life and a caller still passing it deserves
 * to be told what replaced it.
 *
 * WHY THERE IS NO --failures, since #469/#490. That was the last value a
 * caller still chose, and it is the one the defect arrives through: an agent
 * read `0 fail` off a summary and typed it. A run whose test files had all
 * vanished printed no summary at all and exited 0, and a run whose only test
 * file declares no tests prints `0 pass / 0 fail / Ran 0 tests across 1 file.`
 * and also exits 0. Both are a count of zero that an agent can honestly read
 * and that means nothing. The output itself is the argument now, and
 * `lib/suite-run-reading.ts` decides whether there is a result in it.
 *
 * WHAT --output IS NOT. It is not provenance. The file is written by the
 * step above it in the same prompt, into a directory the agent can write, so
 * an agent determined to record a clean suite can still author one. Flagged
 * by the commit security review, and it is a real limit — but it is not a
 * regression and not the thing this flag is for. `--failures 0` was the same
 * hole needing one token instead of a crafted summary, and #224 answered the
 * forgery question in a different place on purpose: the provenance is the
 * COMMIT, read from the tree by `measuredSha` and compared against the
 * branch tip at ship time by `suiteCurrency`. What `--output` buys is that
 * the honest path can no longer produce a wrong answer by accident, which is
 * how every instance of this has actually arrived.
 *
 * WHY AN UNMEASURED RUN IS REFUSED RATHER THAN RECORDED. `lib/suite-measurement.ts`
 * says it: UNMEASURED is not a result, it is the statement that this run has
 * no suite evidence, and it is deliberately not writable — a recorded
 * UNMEASURED would be a way to park an unmeasured run in the field that
 * proves the suite ran. So this script refuses, nothing is written, and the
 * absent record reads UNMEASURED, which is what absence already means.
 *
 * Usage:
 *   bun scripts/record-suite-measurement.ts --state <workflow-state.json> \
 *     --project <project root> --output <file holding the suite's output>
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { writeWorkflowState } from "../gates/orchestrator";
import { readSuiteRun, type MeasuredRun } from "../lib/suite-run-reading";

/**
 * The one exit code every refusal goes through.
 *
 * Declared once and used once, so `test/suite-verdict-binding.test.ts` can
 * build a copy of this file with it set to 0 and prove each refusal is this
 * script saying no rather than something else failing by coincidence
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["state", "project", "output"]);
const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Flags this script used to take, refused by name.
 *
 * "unexpected argument --sha" is true and useless: it reads like a typo for
 * a caller following the usage line that shipped with every previous version
 * of this file. Both of these were in a live prompt on main.
 */
const RETIRED: Record<string, string> = {
  sha: "--sha is no longer accepted — the measured commit is read from --project. " +
    "A SHA the caller chose can agree with HEAD by construction, which is the " +
    "provenance check answering itself.",
  result: "--result is not a flag — the verdict is derived from --failures and has no " +
    "other source. PASS means the count was zero; it cannot mean anything else.",
  verdict: "--verdict is not a flag — the verdict is derived from the runner's output and has no " +
    "other source.",
  failures: "--failures is no longer accepted — pass --output <file holding the suite's output> and " +
    "the count is read from it. A number typed after reading a summary is a number, and the runs " +
    "this guards against printed no summary (#469) or a summary of nothing (#490).",
};

class Refused extends Error {}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(argv[i]);
    if (m && RETIRED[m[1]]) throw new Refused(RETIRED[m[1]]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Refused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Refused(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * What the suite run reported, read out of its captured output.
 *
 * The count is no longer an argument (#469, #490). `parseInt(x) || 0` is the
 * fail-open .claude/rules/checks-must-be-able-to-fail.md names, and
 * `--failures 0` typed by an agent who read a run that printed no summary is
 * the same fail-open with a person in the middle of it.
 *
 * Refuses on UNMEASURED rather than recording it, and the reason the reader
 * produced is carried through verbatim — an operator who gets this back needs
 * to know whether their runner printed nothing, printed half a summary, or
 * printed a clean summary over zero tests, because those are three different
 * things to go and fix.
 */
export function measuredRun(outputPath: string | undefined): MeasuredRun {
  if (outputPath === undefined) {
    throw new Refused(
      "--output is required — it is the file holding what the test runner printed, and the " +
        "failure count is read from it rather than supplied",
    );
  }
  let output: string;
  try {
    output = readFileSync(outputPath, "utf-8");
  } catch (e: any) {
    throw new Refused(
      `could not read the suite output from ${outputPath}: ${String(e?.message || e).trim().slice(0, 200)}`,
    );
  }
  const run = readSuiteRun(output);
  if (run.status !== "MEASURED") throw new Refused(run.reason);
  return run;
}

/**
 * The commit the suite ran against, read from the tree rather than told.
 *
 * Refuses rather than falling back. `git rev-parse` prints `HEAD` back at you
 * for a repo with no commits, and a non-repo exits non-zero — both would
 * otherwise become a measurement with no provenance, which is the thing this
 * script exists to make impossible.
 */
export function measuredSha(projectRoot: string | undefined): string {
  if (!projectRoot) {
    throw new Refused("--project is required — the measured commit is read from the project tree");
  }
  let out: string;
  try {
    out = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    throw new Refused(
      `could not read a commit from ${projectRoot}: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`,
    );
  }
  return shaFromGitOutput(projectRoot, out);
}

/**
 * The validation half of `measuredSha`, split out so it can be driven.
 *
 * It is a separate function because the case it guards is **not reachable
 * through git on this machine**: `git rev-parse HEAD` in a repository with no
 * commits exits non-zero here, so the exec above throws and the caller never
 * gets a string. Older gits print the literal `HEAD` on stdout and exit
 * non-zero, and there is no promise about which future versions do what.
 *
 * Leaving the guard inline would have made it a branch no test could enter —
 * the thing `.claude/rules/checks-must-be-able-to-fail.md` is about — and
 * deleting it would make the recorder's provenance depend on a git exit code
 * staying what it is today. Splitting it is the third option: the branch is
 * exercised directly, and the comment says which half the repo cannot see.
 */
export function shaFromGitOutput(projectRoot: string, out: string): string {
  const trimmed = out.trim();
  if (!SHA.test(trimmed)) {
    throw new Refused(
      `${projectRoot} has no commit to measure against (git answered "${trimmed.slice(0, 80)}")`,
    );
  }
  return trimmed.toLowerCase();
}

/**
 * The record to persist. PASS means zero failures; it cannot mean anything else.
 *
 * `tests` and `files` ride along as the run's own coverage (#490): a verdict
 * with no coverage beside it cannot tell `0 fail` over three hundred files
 * from `0 fail` over one empty one. They are written as `null` rather than
 * omitted when the runner did not report them, because absent would mean
 * "recorded by a harness older than this field".
 */
export function buildMeasurement(sha: string, run: MeasuredRun): Record<string, unknown> {
  return {
    verdict: run.fail === 0 ? "PASS" : "FAIL",
    measuredSha: sha,
    failures: run.fail,
    tests: run.tests,
    files: run.files,
    measuredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) throw new Refused("--state is required");
    const sha = measuredSha(args.project);
    const run = measuredRun(args.output);

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    const measurement = buildMeasurement(sha, run);
    state.suiteMeasurement = measurement;
    state.changelog = state.changelog || [];
    const coverage = run.files === null
      ? `${run.pass + run.fail} test(s), file count not reported`
      : `${run.pass + run.fail} test(s) across ${run.files} file(s)`;
    state.changelog.push({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      event: "suite-measurement",
      detail: `${measurement.verdict}: ${run.fail} failing test(s) of ${coverage} at ${sha}`,
      actor: "gate-runner",
    });

    writeWorkflowState(args.state, state);
    console.log(JSON.stringify({
      ok: true,
      verdict: measurement.verdict,
      measuredSha: sha,
      failures: run.fail,
      tests: run.tests,
      files: run.files,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`record-suite-measurement: ${msg}`);
    console.log(JSON.stringify({ ok: false, error: msg }));
    process.exit(REFUSE_EXIT);
  }
}
