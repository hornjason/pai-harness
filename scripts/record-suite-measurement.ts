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
 * Usage:
 *   bun scripts/record-suite-measurement.ts --state <workflow-state.json> \
 *     --project <project root> --failures <n>
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { writeWorkflowState } from "../gates/orchestrator";

/**
 * The one exit code every refusal goes through.
 *
 * Declared once and used once, so `test/suite-verdict-binding.test.ts` can
 * build a copy of this file with it set to 0 and prove each refusal is this
 * script saying no rather than something else failing by coincidence
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["state", "project", "failures"]);
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
  verdict: "--verdict is not a flag — the verdict is derived from --failures and has no " +
    "other source.",
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
 * The failing-test count, as a count.
 *
 * `parseInt` is deliberately not used: `parseInt("none")` is NaN and
 * `parseInt(x) || 0` turns an unreadable input into "nothing failed" — the
 * budget-counter fail-open named in .claude/rules/checks-must-be-able-to-fail.md,
 * pointed at the one number this script exists to carry.
 */
export function failureCount(raw: string | undefined): number {
  if (raw === undefined) throw new Refused("--failures is required — a measurement with no count is not a measurement");
  if (!/^\d+$/.test(raw.trim())) {
    throw new Refused(
      `--failures "${String(raw).slice(0, 40)}" is not a count of failing tests (expected a non-negative integer)`,
    );
  }
  return Number(raw.trim());
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

/** The record to persist. PASS means zero failures; it cannot mean anything else. */
export function buildMeasurement(sha: string, failures: number): Record<string, unknown> {
  return {
    verdict: failures === 0 ? "PASS" : "FAIL",
    measuredSha: sha,
    failures,
    measuredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) throw new Refused("--state is required");
    const sha = measuredSha(args.project);
    const failures = failureCount(args.failures);

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    const measurement = buildMeasurement(sha, failures);
    state.suiteMeasurement = measurement;
    state.changelog = state.changelog || [];
    state.changelog.push({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      event: "suite-measurement",
      detail: `${measurement.verdict}: ${failures} failing test(s) at ${sha}`,
      actor: "gate-runner",
    });

    writeWorkflowState(args.state, state);
    console.log(JSON.stringify({ ok: true, verdict: measurement.verdict, measuredSha: sha, failures }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`record-suite-measurement: ${msg}`);
    console.log(JSON.stringify({ ok: false, error: msg }));
    process.exit(REFUSE_EXIT);
  }
}
