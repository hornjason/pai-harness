#!/usr/bin/env bun
/**
 * Replay the recorded compliance history through the hill-climb loop and say
 * where every detected action would land (#704).
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The store is outside this repository
 * and grows on every ship run, so a case pinning its counts would be red
 * tomorrow for a reason that has nothing to do with the code
 * (`test/unit/zero-reinforcement-baseline.test.ts` says the same thing about
 * the same numbers). What a number needs instead is the command that produced
 * it, re-runnable by a later reader against whatever the store holds then —
 * `.claude/rules/checks-must-be-able-to-fail.md`, *record the command beside
 * the count*.
 *
 * It replays rather than re-runs: each entry is graded against the entries
 * before it, exactly as `scripts/persist-compliance.ts` did on the day it was
 * written, and the resulting actions are resolved against the role briefs in
 * the tree this is invoked from. Nothing is written — the hill-climb runs at
 * `DISCARD`.
 *
 * Usage:
 *   bun scripts/replay-hill-climb-history.ts [--history <path>] [--project <root>]
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  applyHillClimb,
  detectHillClimbNeeds,
  generateComplianceReport,
  loadComplianceHistory,
  resolveHillClimbSection,
  setComplianceProjectRoot,
} from "../lib/compliance-report";
import { loadRoleBriefPaths } from "./grade-deterministic";

const COMPLIANCE_THRESHOLD = 70;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const historyPath = arg("history", join(homedir(), ".rungate", "compliance-history.jsonl"));
const projectRoot = arg("project", process.cwd());

const entries = loadComplianceHistory(historyPath);
if (entries.length === 0) {
  // An empty store is UNMEASURED, not "nothing to report" — the two read the
  // same and only one of them is a result.
  console.error(`UNMEASURED: no entries read from ${historyPath}`);
  process.exit(1);
}

setComplianceProjectRoot(projectRoot);
const briefPaths = loadRoleBriefPaths(projectRoot);

let runsWithActions = 0;
let actions = 0;
let applied = 0;
const skipKinds: Record<string, number> = {};
const perComp: Record<string, { applied: number; skipped: Record<string, number> }> = {};
const perRole: Record<string, number> = {};
/**
 * The SELECTOR asked about every detected action, including the ones the
 * tier-promotion branch stops one statement earlier.
 *
 * This is the question #645's table answered and `applyHillClimb` does not:
 * its tier check runs BEFORE the section is resolved, so 129 of the 193 never
 * reach the selector at all on a live run. Both readings are real and they
 * are different questions — reporting one of them as the other is how 136
 * came to be written beside `NO_SECTION`.
 */
const selectorOnly: Record<string, number> = {};

for (let i = 0; i < entries.length; i++) {
  const current = entries[i]!;
  const report = generateComplianceReport(current, entries.slice(0, i), COMPLIANCE_THRESHOLD);

  // The grader-accuracy gate, in the spelling persist-compliance.ts uses.
  const dropped = new Set<string>();
  for (const ct of report.compTrends) {
    const na = ct.lastN.filter((v) => v === "N/A").length;
    const ignored = ct.lastN.filter((v) => v === "IGNORED").length;
    if (na > 0 && ignored > 0 && na / (na + ignored) > 0.5) dropped.add(ct.compId);
  }

  const detected = detectHillClimbNeeds(report).filter((a) => !dropped.has(a.compId));
  if (detected.length === 0) continue;
  runsWithActions++;
  actions += detected.length;
  perRole[current.role] = (perRole[current.role] ?? 0) + detected.length;

  const briefPath = briefPaths[current.role];
  if (!briefPath || !existsSync(briefPath)) {
    skipKinds.NO_BRIEF_REGISTERED = (skipKinds.NO_BRIEF_REGISTERED ?? 0) + detected.length;
    for (const a of detected) {
      perComp[a.compId] ??= { applied: 0, skipped: {} };
      perComp[a.compId]!.skipped.NO_BRIEF_REGISTERED =
        (perComp[a.compId]!.skipped.NO_BRIEF_REGISTERED ?? 0) + 1;
    }
    continue;
  }

  const briefContent = readFileSync(briefPath, "utf-8");
  for (const a of detected) {
    const k = resolveHillClimbSection(a.compId, briefContent).kind;
    selectorOnly[k] = (selectorOnly[k] ?? 0) + 1;
  }

  const r = applyHillClimb(briefPath, detected, { destination: "DISCARD" });
  applied += r.applied.length;
  for (const a of r.applied) {
    const id = a.split(":")[0]!;
    perComp[id] ??= { applied: 0, skipped: {} };
    perComp[id]!.applied++;
  }
  for (const o of r.skipOutcomes) {
    skipKinds[o.kind] = (skipKinds[o.kind] ?? 0) + 1;
    perComp[o.compId] ??= { applied: 0, skipped: {} };
    perComp[o.compId]!.skipped[o.kind] = (perComp[o.compId]!.skipped[o.kind] ?? 0) + 1;
  }
}

console.log(`history:            ${historyPath}`);
console.log(`project:            ${projectRoot}`);
console.log(`entries:            ${entries.length}`);
console.log(`runs with actions:  ${runsWithActions}`);
console.log(`actions detected:   ${actions}`);
console.log(`applied:            ${applied}`);
for (const [kind, n] of Object.entries(skipKinds).sort()) console.log(`skipped ${kind}: ${n}`);
console.log("");
console.log("the selector asked about every detected action (tier branch ignored):");
for (const [k, n] of Object.entries(selectorOnly).sort()) console.log(`  ${k}: ${n}`);
console.log("");
console.log("actions per role:");
for (const [role, n] of Object.entries(perRole).sort()) console.log(`  ${role}: ${n}`);
console.log("");
console.log("per COMP id (applied / skip kinds):");
for (const [id, v] of Object.entries(perComp).sort()) {
  const skips = Object.entries(v.skipped)
    .sort()
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  console.log(`  ${id}: applied=${v.applied} ${skips}`);
}
