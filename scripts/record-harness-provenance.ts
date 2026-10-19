#!/usr/bin/env bun
/**
 * Write which harness graded this run into `workflow-state.json` (#602).
 *
 * ## Why a script
 *
 * `workflows/ship.js` cannot do it: it makes zero subprocess calls and has
 * no filesystem (#69), so it cannot read a checkout's HEAD. It already
 * delegates the same way for the build commit and the suite measurement —
 * an agent runs a command, and the command writes the state.
 *
 * ## Why this is the thing worth recording
 *
 * On 2026-10-18 the primary checkout was 82 files and 10,527 insertions
 * behind `origin/main`, including 44 lines of `gates/schema.ts`. Three
 * runs that session were graded by a validator missing changes those very
 * runs merged, and nothing in any of their artefacts says so, because a
 * stale harness and a current one emit byte-identical output.
 *
 * The error runs in the permissive direction: every refusal added since
 * the checkout last moved is simply absent, so a stale harness PASSES
 * things a current one would stop.
 *
 * Usage:
 *   bun scripts/record-harness-provenance.ts --state <workflow-state.json> \
 *     --harness-root <dir>
 *
 * Prints one JSON receipt on stdout; diagnostics go to stderr. Exits
 * non-zero only when the STATE could not be written — a harness that is
 * dirty or behind is a finding to record, not a reason to refuse. #602
 * asks for a loud UNMEASURED rather than a refusal, and a gate that
 * stopped every run from a development checkout is one that gets switched
 * off.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP:
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once.
 *   2. It decides nothing itself. The reading and the warning both come
 *      from `lib/harness-provenance.ts`, so there is ONE binding to mutate
 *      rather than a script and a library that agree
 *      (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */

import { readFileSync, writeFileSync } from "fs";

import { harnessProvenance, harnessProvenanceWarning } from "../lib/harness-provenance";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["state", "harness-root"]);

class Refused extends Error {}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Refused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Refused(`--${m[1]} needs a value`);
    out[m[1]] = value;
  }
  for (const required of ["state", "harness-root"]) {
    if (!out[required]) throw new Refused(`--${required} is required`);
  }
  return out;
}

/**
 * The reading as the schema wants it.
 *
 * A total projection, so every field exists in both arms and a reader
 * never has to tell an absent key from a null one. `HarnessSchema`
 * refuses the contradictions — UNMEASURED with a SHA, MEASURED with a
 * reason — so this cannot quietly write a shape nothing can interpret.
 */
export function harnessRecord(reading: ReturnType<typeof harnessProvenance>) {
  if (reading.reading === "UNMEASURED") {
    return {
      reading: "UNMEASURED" as const,
      sha: null,
      branch: null,
      dirty: [],
      behind: null,
      behindReason: "the harness checkout could not be read at all, so its upstream was never consulted",
      reason: reading.reason,
    };
  }
  return {
    reading: "MEASURED" as const,
    sha: reading.sha,
    branch: reading.branch,
    dirty: reading.dirty,
    behind: reading.behind,
    behindReason: reading.behindReason,
    reason: null,
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const reading = harnessProvenance(args["harness-root"]);
    const record = harnessRecord(reading);

    // Read-modify-write, and a state that cannot be read is a refusal.
    // Writing a fresh object would discard every field the run has
    // accumulated, which is a far worse outcome than not recording this.
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(readFileSync(args.state, "utf-8"));
    } catch (e: any) {
      throw new Refused(`the run state at ${JSON.stringify(args.state)} could not be read: ${e?.message || e}`);
    }
    state.harness = record;
    writeFileSync(args.state, `${JSON.stringify(state, null, 2)}\n`);

    console.log(JSON.stringify({ ok: true, harness: record }, null, 2));

    // The whole point of the issue: say it where somebody reads it. A
    // divergence recorded in a JSON file nobody opens is the silence this
    // replaces, one layer further in.
    const warning = harnessProvenanceWarning(reading);
    if (warning) console.error(warning);
  } catch (e: any) {
    console.error(e instanceof Refused ? `REFUSED: ${e.message}` : `UNREADABLE: ${e?.message || e}`);
    process.exit(REFUSE_EXIT);
  }
}
