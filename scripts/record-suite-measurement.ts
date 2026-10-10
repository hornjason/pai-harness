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
 * Usage:
 *   bun scripts/record-suite-measurement.ts --state <workflow-state.json> \
 *     --sha <commit sha> --failures <n>
 */

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

const OPTIONS = new Set(["state", "sha", "failures"]);
const SHA = /^[0-9a-f]{7,40}$/i;

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
    if (!args.sha) throw new Refused("--sha is required");
    if (!SHA.test(args.sha.trim())) {
      throw new Refused(
        `--sha "${String(args.sha).slice(0, 80)}" is not a commit SHA (7-40 hex). ` +
          `A ref name is not accepted: "HEAD" means "whatever the checkout happens to be", ` +
          `which is the missing provenance this record exists to supply.`,
      );
    }
    const sha = args.sha.trim().toLowerCase();
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
