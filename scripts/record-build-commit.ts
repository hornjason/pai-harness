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
 * Every argument is refused rather than sanitised when it is not the shape it
 * must be. A SHA that needs quoting is not a SHA, and three consecutive
 * security reviews of this repo's shell surfaces each found a new hole in a
 * filter that tried to clean its input instead of rejecting it.
 *
 * Usage:
 *   bun scripts/record-build-commit.ts --state <workflow-state.json> \
 *     --sha <commit sha> --branch <branch> --quinn PASS|FAIL|SKIP \
 *     [--api PASS|FAIL|SKIP] [--ui PASS|FAIL|SKIP] [--ui-skip-reason <text>]
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

class Refused extends Error {}

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
 * The new `agents` map: marcus and quinn set, everything else carried over.
 *
 * Returns a new object rather than mutating the input, so a caller holding the
 * old map does not see it change underneath them.
 */
export function buildMarcusRecord(
  existing: Record<string, unknown> | null | undefined,
  sha: string,
  branch: string,
  quinnVerdict: string,
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return {
    ...base,
    marcus: { branch, commitSha: sha, spawned: true, verdict: "PASS" },
    quinn: { spawned: quinnVerdict !== "SKIP", verdict: quinnVerdict },
  };
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
    const api = verdict("api", args.api, "SKIP");
    const ui = verdict("ui", args.ui, "SKIP");

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    state.buildCommit = args.sha;
    state.agents = buildMarcusRecord(state.agents, args.sha, args.branch, quinnVerdict);
    state.environments = {
      ...(state.environments || {}),
      local: {
        api,
        ui,
        uiSkipReason: args["ui-skip-reason"] || (ui === "SKIP" ? "No UI configured" : ""),
        tests: "PASS",
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
