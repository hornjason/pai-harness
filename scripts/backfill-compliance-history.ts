#!/usr/bin/env bun
/**
 * Move the compliance grades that every ship run produced into the history file
 * that every trend line reads.
 *
 * `~/.rungate/compliance-history.jsonl` held four entries, all synthetic, all
 * named `#compliance-test-N`, while 149 real role-records sat unread in
 * `~/.rungate/<slug>/compliance-grade.json`. Every "declining" verdict and
 * every hill-climb decision has been computed over the fixture.
 *
 * Usage:
 *   bun scripts/backfill-compliance-history.ts              # dry run, prints the plan
 *   bun scripts/backfill-compliance-history.ts --write      # rewrites the history
 *   bun scripts/backfill-compliance-history.ts --root DIR   # non-default ~/.rungate
 *
 * Dry run is the default because applying this REWRITES the history file rather
 * than appending to it — backfilled records have to be interleaved by time, or
 * `generateComplianceReport`'s "last five entries" window would treat September
 * runs as the most recent thing that ever happened. A `.bak` is written first.
 *
 * Safe to run twice: identity is source-file + role, so a second pass adds
 * nothing. The logic lives in lib/compliance-backfill.ts and is tested in
 * test/unit/compliance-backfill.test.ts; this file is argument handling and I/O.
 */

import { copyFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { loadComplianceHistory } from "../lib/compliance-report";
import { planComplianceBackfill, mergeHistory } from "../lib/compliance-backfill";

const args = process.argv.slice(2);
const write = args.includes("--write");
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? args[rootFlag + 1] : join(homedir(), ".rungate");

if (!existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exit(1);
}

const historyPath = join(root, "compliance-history.jsonl");
const existing = loadComplianceHistory(historyPath);
const plan = planComplianceBackfill(root, existing);

console.log(`root:            ${root}`);
console.log(`history before:  ${existing.length} entries`);
console.log(`grade files:     ${plan.scanned} scanned`);
console.log(`  usable:        ${new Set(plan.added.map(e => e.source)).size} files -> ${plan.added.length} role-records`);
console.log(`  already in:    ${plan.alreadyPresent} role-records`);
console.log(`  no grades:     ${plan.emptyGrades.length}${plan.emptyGrades.length ? ` (${plan.emptyGrades.join(", ")})` : ""}`);
console.log(`  unparseable:   ${plan.unparseable.length}${plan.unparseable.length ? ` (${plan.unparseable.join(", ")})` : ""}`);

const byRole: Record<string, number> = {};
for (const e of plan.added) byRole[e.role] = (byRole[e.role] ?? 0) + 1;
console.log(`  by role:       ${Object.entries(byRole).map(([r, n]) => `${r} ${n}`).join(", ") || "none"}`);

if (plan.added.length > 0) {
  const times = plan.added.map(e => e.timestamp).sort();
  console.log(`  date range:    ${times[0]} .. ${times[times.length - 1]}`);
  const unknown = plan.added.filter(e => e.issue === "#unknown").length;
  if (unknown) console.log(`  issue unknown: ${unknown} record(s) — slug carried no number`);
}

const merged = mergeHistory(existing, plan.added);

if (!write) {
  console.log(`\nDRY RUN — nothing written. History would go ${existing.length} -> ${merged.length} entries.`);
  console.log(`Re-run with --write to apply.`);
  process.exit(0);
}

if (plan.added.length === 0) {
  console.log(`\nNothing to add. History left untouched.`);
  process.exit(0);
}

if (existsSync(historyPath)) {
  const backup = `${historyPath}.bak`;
  copyFileSync(historyPath, backup);
  console.log(`\nbacked up existing history to ${backup}`);
}

writeFileSync(historyPath, merged.map(e => JSON.stringify(e)).join("\n") + "\n");
console.log(`wrote ${merged.length} entries to ${historyPath}`);
