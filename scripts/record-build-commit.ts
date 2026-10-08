#!/usr/bin/env bun
/**
 * Record the build commit in workflow-state.json (#166).
 *
 * `workflows/ship.js` used to carry this as step 3 of a three-step commit
 * prompt — a `bun -e` one-liner the agent was told to run — while the schema
 * it answered with asked only for `{branch, commitSha, pushed}`. An agent
 * could commit, push, answer correctly, and never run step 3, and the
 * workflow read that as a fully successful commit. On `wf_b5f65252-24f` it
 * did, and the ship gate refused the run six agents later with "neither
 * buildCommit nor agents.marcus.branch present". Two earlier runs had the
 * fields, so the failure was intermittent rather than absent.
 *
 * Same shape as #155 and #157 one step up: a step whose schema does not
 * mention its most important effect cannot report that the effect happened.
 * So this is a script with a receipt, and ship.js requires the receipt.
 *
 * WHY A SCRIPT AT ALL. The sandbox has no module loading (#69), so ship.js
 * cannot call writeWorkflowState itself, and gates/SCHEMA-GUIDE.md forbids
 * writing the file with Write or `cat >` — Zod validates at write time and an
 * invalid value must fail here rather than as an opaque gate failure later.
 *
 * WHY IT MERGES. The one-liner it replaces did `s.agents = {marcus, quinn}`,
 * an assignment. That was safe only because it ran before rook; since #161
 * `agents.rook` is the record of whether the security review ran, so anything
 * re-running that write after the Verify phase erased it and the run reached
 * the PR step with no security record.
 *
 * WHAT IT WILL NOT WRITE (#173). This script records a commit. It did not run
 * the test suite, so it does not get to say the suite passed —
 * `environments.local.tests` used to be the literal string `PASS` here, and
 * the `tests-pass` check in gates/workflow.test.ts reads exactly that field.
 * It did not run Quinn either, so a FAIL already recorded against Quinn is a
 * measurement this script leaves alone. `environments.local` was an
 * assignment for the same reason `agents` was, and #169 adds call sites that
 * run after Quinn, which turns both overwrites from latent into live.
 *
 * #176 finishes that: `api` and `ui` were assigned unconditionally too, from
 * `--api PASS` / `--ui PASS` that ship.js derived from whether rungate.json
 * named a URL. The gate checks that read those two fields therefore saw PASS
 * on every configured project and nothing at all on every unconfigured one —
 * two branches, neither of them red. An omitted flag now writes nothing, and
 * a verdict already in the file is left where it is.
 *
 * Every argument is refused rather than sanitised when it is not the shape it
 * must be. A SHA that needs quoting is not a SHA, and three consecutive
 * security reviews of this repo's shell surfaces each found a new hole in a
 * filter that tried to clean its input instead of rejecting it.
 *
 * Usage:
 *   bun scripts/record-build-commit.ts --state <workflow-state.json> \
 *     --sha <commit sha> --branch <branch> --quinn PASS|FAIL|SKIP \
 *     [--api PASS|FAIL|SKIP] [--ui PASS|FAIL|SKIP] [--ui-skip-reason <text>]
 *
 * --api and --ui are for a caller that MEASURED the environment. Omit them
 * otherwise; they have no default (#176).
 */

import { readFileSync } from "fs";
import { writeWorkflowState } from "../gates/orchestrator";

/**
 * The one exit code every refusal goes through.
 *
 * Declared once and used once, so `test/record-build-commit.test.ts` can build
 * a copy of this file with it set to 0 and prove each refusal is this script
 * saying no rather than something else failing by coincidence
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["state", "sha", "branch", "quinn", "api", "ui", "ui-skip-reason"]);
const SHA = /^[0-9a-f]{7,40}$/;
/** git's own rules, narrowed: no spaces, no shell metacharacters, no leading dash. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const VERDICTS = new Set(["PASS", "FAIL", "SKIP"]);

/**
 * Verdicts this script will not overwrite once they are in the file (#173).
 *
 * A FAIL is the one verdict nobody records by accident, and this script never
 * measured anything — so when the file already says an agent failed, the
 * commit record is not the thing that gets to change its mind. Declared as a
 * named constant on one line so test/record-build-commit.test.ts can build a
 * copy of this file with it emptied and watch the overwrite come back
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export const PRESERVED_VERDICTS = new Set(["FAIL"]);

class Refused extends Error {}

/** The value at `key` if it is a plain object, otherwise an empty one. */
function record(from: unknown, key: string): Record<string, unknown> {
  const v = (from as Record<string, unknown> | null | undefined)?.[key];
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(argv[i]);
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

function verdict(name: string, value: string | undefined, fallback?: string): string {
  const v = value ?? fallback;
  if (v === undefined) throw new Refused(`--${name} is required`);
  if (!VERDICTS.has(v)) {
    throw new Refused(`--${name} must be PASS, FAIL or SKIP (got "${String(v).slice(0, 40)}")`);
  }
  return v;
}

/**
 * The new `agents` map: marcus and quinn updated, everything else carried over.
 *
 * Returns a new object rather than mutating the input, so a caller holding the
 * old map does not see it change underneath them. Each agent's own record is
 * merged too (#173) — quinn arrives here carrying a port, screenshots and
 * findings that this script knows nothing about, and replacing the record
 * throws them away along with the verdict.
 */
export function buildMarcusRecord(
  existing: Record<string, unknown> | null | undefined,
  sha: string,
  branch: string,
  quinnVerdict: string,
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const quinn = record(base, "quinn");
  return {
    ...base,
    marcus: { ...record(base, "marcus"), branch, commitSha: sha, spawned: true, verdict: "PASS" },
    quinn: PRESERVED_VERDICTS.has(String(quinn.verdict))
      ? quinn
      : { ...quinn, spawned: quinnVerdict !== "SKIP", verdict: quinnVerdict },
  };
}

/**
 * Whether a verdict already in the file wins over the one this script is
 * handed (#176).
 *
 * Declared as a one-line constant so test/record-build-commit.test.ts can
 * build a copy of this file with it set to `false` and watch the overwrite
 * come back. Without that second run, "the measured value survived" is also
 * satisfied by a script that stopped writing the field at all
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export const PRESERVE_MEASURED_ENVIRONMENTS = true;

/** A verdict somebody recorded, as opposed to a field nobody has touched. */
function measured(v: unknown): boolean {
  return typeof v === "string" && VERDICTS.has(v);
}

/**
 * The new `environments.local`: whatever was measured stays measured (#176).
 *
 * Same shape as `tests` just below, and for the same reason. This script
 * records a commit; it did not curl an API and it did not open a browser. The
 * api and ui fields were assigned unconditionally from values `workflows/ship.js`
 * derived from `rungate.json` — `--api PASS` whenever `projectConfig.apiUrl`
 * was merely truthy — so the commit step overwrote Quinn's measurement from
 * the Validate phase with a restatement of the config file. The
 * `local-api-validated` and `local-ui-validated` checks read exactly these two
 * fields, which made a configured project pass them unconditionally and an
 * unconfigured one pass them by early return. There was no third branch.
 *
 * So: a value already in the file is left alone, and a value this script was
 * not given is not invented. `uiSkipReason` travels with the ui verdict it
 * explains rather than being written next to one it does not.
 */
export function buildLocalEnvironment(
  existing: Record<string, unknown> | null | undefined,
  given: { api?: string; ui?: string; uiSkipReason?: string },
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const keep = (field: "api" | "ui") => PRESERVE_MEASURED_ENVIRONMENTS && measured(base[field]);

  if (given.api !== undefined && !keep("api")) base.api = given.api;
  if (given.ui !== undefined && !keep("ui")) {
    base.ui = given.ui;
    if (given.uiSkipReason) base.uiSkipReason = given.uiSkipReason;
  }
  return base;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) throw new Refused("--state is required");
    if (!args.sha) throw new Refused("--sha is required");
    if (!SHA.test(args.sha)) {
      throw new Refused(
        `--sha "${String(args.sha).slice(0, 80)}" is not a commit SHA (7-40 lowercase hex). ` +
          `A ref name is not accepted: "HEAD" means "whatever the checkout happens to be".`,
      );
    }
    if (!args.branch) throw new Refused("--branch is required");
    if (!BRANCH.test(args.branch)) {
      throw new Refused(`--branch "${String(args.branch).slice(0, 80)}" is not a usable branch name`);
    }
    const quinnVerdict = verdict("quinn", args.quinn);
    // #176: no "SKIP" fallback. An omitted --api is "this run has nothing to
    // say about the API", which is not the same fact as "the API check was
    // skipped" and must not be written as one.
    const api = args.api === undefined ? undefined : verdict("api", args.api);
    const ui = args.ui === undefined ? undefined : verdict("ui", args.ui);

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    state.buildCommit = args.sha;
    state.agents = buildMarcusRecord(state.agents, args.sha, args.branch, quinnVerdict);
    state.environments = {
      ...(state.environments || {}),
      local: {
        ...buildLocalEnvironment(record(state.environments, "local"), {
          api,
          ui,
          uiSkipReason: args["ui-skip-reason"],
        }),
        // #173-NO-TESTS-VERDICT
        // `tests` is deliberately absent. This script ran no tests, and the
        // line that used to sit here said `PASS` unconditionally — over the
        // top of whatever the Verify phase had measured. Absent is a state
        // the `tests-pass` check reports ("local.tests not set"); PASS is a
        // state it believes. #176 extends the same rule to api and ui, in
        // buildLocalEnvironment above.
      },
    };
    state.changelog = state.changelog || [];
    state.changelog.push({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      event: "build-commit",
      detail: `${args.sha} on ${args.branch}`,
      phase: "BUILD",
      actor: "marcus",
    });

    writeWorkflowState(args.state, state);
    console.log(JSON.stringify({ ok: true, buildCommit: args.sha, branch: args.branch }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`record-build-commit: ${msg}`);
    console.log(JSON.stringify({ ok: false, error: msg }));
    process.exit(REFUSE_EXIT);
  }
}
