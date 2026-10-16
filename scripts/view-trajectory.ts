#!/usr/bin/env bun
/**
 * Print a run's trajectory as a readable timeline (#60 SC-3).
 *
 * Diagnosing a failed pipeline run means reading raw agent transcripts —
 * JSONL files, hundreds of lines each. The facts that actually answer "what
 * happened" are already recorded, and they are recorded in three places: agent
 * brackets in `agent-timings.jsonl`, gate results in `workflow-state.json`,
 * and the refusal ledger in `workflows/ship.js`'s memory, which exists only
 * until the run ends. This merges the two that survive.
 *
 * WHAT IT REFUSES TO PRETEND
 *
 * A timeline is the easiest report in the world to make look complete. Three
 * things here exist to stop it:
 *
 * - **A phase with no records does not appear as a phase that took no time.**
 *   `phaseSpans` derives spans from agents, so a phase nothing reported in is
 *   absent, and the footer says the timeline reports what RECORDED rather than
 *   what ran. `0` seconds is indistinguishable from "never measured"; a
 *   sentence saying so is not.
 * - **A missing artifact is not an empty run.** `UNMEASURED` and its path,
 *   with a non-zero exit, rather than a tidy empty timeline.
 * - **Malformed lines are printed, verbatim.** A reader that silently drops
 *   what it cannot parse reports a complete picture of a file it only partly
 *   understood.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  TRAJECTORY_FILENAME,
  phaseSpans,
  readTrajectory,
  timeline,
  type TrajectoryRead,
} from "../lib/trajectory";

/**
 * The one exit code every refusal goes through.
 *
 * Declared once, on one line, so no refusal can bypass it by inlining
 * `process.exit(2)` — `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export const VIEW_REFUSE_EXIT = 2;

export interface Rendered {
  lines: string[];
  /** True when the view is incomplete and says so. Drives the exit code. */
  unmeasured: boolean;
}

function clock(at: number, origin: number): string {
  const s = (at - origin) / 1000;
  return `${s >= 0 ? "+" : ""}${s.toFixed(3)}s`.padStart(10);
}

/**
 * The whole report, as lines, so a test can assert on it without a subprocess.
 */
export function render(read: TrajectoryRead, artifact: string): Rendered {
  if (read.missing) {
    return {
      unmeasured: true,
      lines: [
        `UNMEASURED: no trajectory artifact at ${artifact}`,
        "",
        "This is not an empty run. Either the run has not written a bracket yet, or",
        "the work directory is wrong. A run that executed and recorded nothing would",
        "leave an empty file, not no file.",
      ],
    };
  }

  const lines: string[] = [];
  const rows = timeline(read.records);
  const spans = phaseSpans(read.records);

  if (rows.length === 0) {
    lines.push(`UNMEASURED: ${artifact} exists and holds no readable records`);
  } else {
    const origin = rows[0]!.at;
    lines.push(`TIMELINE  ${rows.length} records from ${artifact}`);
    lines.push("");
    for (const row of rows) lines.push(`${clock(row.at, origin)}  ${row.text}`);
    lines.push("");

    if (spans.length === 0) {
      lines.push("PHASES    UNMEASURED — no agent bracket carried a phase.");
      lines.push("          Brackets written before #60 do not, so an older run reports this.");
    } else {
      lines.push("PHASES");
      for (const s of spans) {
        lines.push(
          `  ${s.phase.padEnd(12)} ${String(s.seconds).padStart(9)}s  ` +
            `${s.agents} agent${s.agents === 1 ? "" : "s"}`,
        );
      }
    }
    lines.push("");
    lines.push(
      "          Phases that recorded nothing are ABSENT from the list above, not",
      "          shown at zero. This is the timeline of what recorded, not of what ran.",
    );
  }

  if (read.malformed.length > 0) {
    lines.push("");
    lines.push(`MALFORMED ${read.malformed.length} line(s) could not be parsed, verbatim:`);
    for (const line of read.malformed) lines.push(`  ${line}`);
  }

  return { lines, unmeasured: rows.length === 0 || read.malformed.length > 0 };
}

/**
 * Gate results, merged in from `workflow-state.json`.
 *
 * Gates do not write to the trajectory — they write to the state file, which
 * they have always done, and adding a second write would make the two able to
 * disagree. So the viewer reads both and the state file is the gates' home.
 */
export function gateLines(workDir: string): string[] {
  const sf = join(workDir, "workflow-state.json");
  if (!existsSync(sf)) return ["GATES     UNMEASURED — no workflow-state.json beside the artifact"];
  let gates: Record<string, any>;
  try {
    gates = (JSON.parse(readFileSync(sf, "utf-8")).gates ?? {}) as Record<string, any>;
  } catch (err) {
    return [`GATES     UNMEASURED — workflow-state.json did not parse: ${err instanceof Error ? err.message : err}`];
  }
  const names = Object.keys(gates);
  if (names.length === 0) return ["GATES     none recorded"];
  const out = ["GATES"];
  for (const name of names) {
    const g = gates[name] ?? {};
    const failures: string[] = Array.isArray(g.failures) ? g.failures : [];
    // `result` absent is UNMEASURED, not PASS. A gate slot that exists with no
    // verdict is the exact shape #276 found reported as a pass.
    out.push(`  ${name.padEnd(12)} ${String(g.result ?? "UNMEASURED").padEnd(10)} ${failures.length} failure(s)`);
    for (const f of failures) out.push(`               ${f}`);
  }
  return out;
}

export function main(argv: string[]): number {
  const at = argv.indexOf("--work-dir");
  const workDir = at >= 0 && at < argv.length - 1 ? argv[at + 1]! : argv[0];
  if (!workDir || workDir.startsWith("--")) {
    process.stderr.write(
      "usage: view-trajectory.ts <workDir>\n" +
        "       view-trajectory.ts --work-dir <workDir>\n" +
        "\nPrints the merged timeline for one run: agent brackets and state mutations\n" +
        `from ${TRAJECTORY_FILENAME}, gate results from workflow-state.json.\n`,
    );
    return VIEW_REFUSE_EXIT;
  }

  const artifact = join(workDir, TRAJECTORY_FILENAME);
  const { lines, unmeasured } = render(readTrajectory(artifact), artifact);
  process.stdout.write(`${lines.join("\n")}\n\n${gateLines(workDir).join("\n")}\n`);
  return unmeasured ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
