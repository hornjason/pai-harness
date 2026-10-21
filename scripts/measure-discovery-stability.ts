#!/usr/bin/env bun
/**
 * Report whether DISCOVERY's model output repeats, over the runs already on
 * disk (#523).
 *
 * WHY A SCRIPT AND NOT A GATE. #523 is explicit: a rerun next week measures a
 * different model-day, so a red row cannot be distinguished from drift, and a
 * check that cannot fail for the reason it claims to is the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` forbids. The output here is a
 * DATED MEASUREMENT. It exits 0 on a finding and 0 on no finding; the only
 * non-zero exits are usage errors, so nothing can mistake this for a gate.
 *
 * WHY IT READS RECORDED RUNS RATHER THAN DISPATCHING NEW ONES. The issue
 * priced the harness at five real pipeline runs with real agents and real
 * model calls, and declined to spend that unilaterally. Every run this harness
 * has ever completed already wrote its `workflow-state.json` under the run
 * work directory, so the series can be assembled from runs that were paid for
 * once, for their own reasons. That makes the instrument DISPATCHABLE today
 * instead of landing unwired — which is #530's shape, and an unwired control
 * is byte-identical to no control.
 *
 * WHAT IT REFUSES. Everything in `lib/discovery-stability.ts`'s refusal list,
 * plus the one that matters most here: a series whose runs do not share an
 * input. Reruns in this harness are normally re-dispatched with NEW
 * instructions after a failure, so the runs of one issue on disk are usually
 * one run each of several different prompts. Reporting their differences as
 * model variance would be a measurement of the prompt wearing a model's name.
 *
 * Usage:
 *   bun scripts/measure-discovery-stability.ts [--dir <path>] [--issue <n>] [--date <iso>]
 *
 * `--dir` defaults to RUNGATE_WORK_DIR, then $HOME/.rungate — the same
 * resolution `lib/gap-scanner.ts` uses. With no `--issue`, every issue with
 * two or more recorded runs is reported.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { localCalendarDay } from "../lib/local-calendar-day";
import {
  compareDiscoveryRuns,
  formatStabilityReport,
  type RunState,
} from "../lib/discovery-stability";

/** Usage errors only. A finding is not an error. */
const USAGE_EXIT = 2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const workDir =
  arg("dir") || process.env.RUNGATE_WORK_DIR || join(process.env.HOME ?? "", ".rungate");
const onlyIssue = arg("issue") ? Number(arg("issue")) : undefined;
// `localCalendarDay`, not `toISOString().slice(0,10)` (#600): a UTC slice
// stamps the wrong day for anyone west of Greenwich in the evening, and this
// output is a DATED measurement whose date is the whole point.
const measuredOn = arg("date") ?? localCalendarDay();

/**
 * An absent work directory is UNMEASURED, not "no variance found".
 *
 * This is the case a CI runner hits: a fresh `HOME` has no `~/.rungate`, so
 * the input this script measures is simply not present there. A script that
 * printed its usual "0 varied" line would be read as evidence, and the green
 * would mean nothing — the same failure `.github/workflows/ai-review.yml`
 * guards with its "UNMEASURED, not a passing review" warning.
 */
if (!existsSync(workDir)) {
  console.log(`Discovery-output stability (#523) — measured ${measuredOn}`);
  console.log("");
  console.log(
    `UNMEASURED — no run work directory at ${workDir}. There are no recorded runs here to ` +
      `compare, so nothing was measured. This is not a clean result.`,
  );
  process.exit(0);
}

const states: { slug: string; issue: number; state: Record<string, unknown> }[] = [];
let unreadable = 0;

for (const entry of readdirSync(workDir).sort()) {
  const file = join(workDir, entry, "workflow-state.json");
  if (!existsSync(file) || !statSync(join(workDir, entry)).isDirectory()) continue;
  try {
    const state = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const issue = Number(state.issue);
    if (!Number.isFinite(issue)) {
      unreadable++;
      continue;
    }
    states.push({ slug: entry, issue, state });
  } catch {
    unreadable++;
  }
}

const byIssue = new Map<number, typeof states>();
for (const s of states) {
  if (onlyIssue !== undefined && s.issue !== onlyIssue) continue;
  if (!byIssue.has(s.issue)) byIssue.set(s.issue, []);
  byIssue.get(s.issue)!.push(s);
}

if (onlyIssue !== undefined && !byIssue.has(onlyIssue)) {
  console.error(`No recorded run for issue ${onlyIssue} under ${workDir}`);
  process.exit(USAGE_EXIT);
}

const series = [...byIssue.entries()].filter(([, v]) => v.length >= 2);

console.log(`Discovery-output stability (#523) — measured ${measuredOn}`);
console.log(`corpus: ${workDir}`);
console.log(
  `${states.length} recorded run state(s)` +
    (unreadable ? `, ${unreadable} unreadable (reported, not skipped silently)` : "") +
    `; ${byIssue.size} distinct issue(s); ${series.length} with k >= 2.`,
);
console.log("");

if (series.length === 0) {
  console.log(
    `UNMEASURED — no issue in this corpus was run more than once, so there is no series to ` +
      `compare. Determinism is a property of repeated runs of ONE input; k = 1 everywhere ` +
      `cannot show it either way.`,
  );
  process.exit(0);
}

for (const [issue, group] of series) {
  const runs: RunState[] = group.map(g => ({ label: g.slug, state: g.state }));
  console.log(`── issue ${issue} ${"─".repeat(Math.max(0, 60 - String(issue).length))}`);
  console.log(formatStabilityReport(compareDiscoveryRuns(runs), measuredOn));
  console.log("");
}

process.exit(0);
