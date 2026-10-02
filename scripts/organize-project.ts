#!/usr/bin/env bun
/**
 * organize-project.ts — Scan, classify, and organize scattered markdown files
 *
 * Usage:
 *   bun scripts/organize-project.ts /path/to/project [--dry-run] [--apply]
 *
 * Default mode is --dry-run (shows proposals as JSON without moving files).
 * Use --apply to execute the proposed moves.
 */
import { existsSync, statSync } from "fs";
import { organizeProject } from "../lib/organize";

const args = process.argv.slice(2);
const projectPath = args.find((arg) => !arg.startsWith("--"));
const applyMode = args.includes("--apply");
const dryRun = !applyMode; // default to dry-run
const harnessRootIdx = args.indexOf("--harness-root");
const harnessRoot = harnessRootIdx >= 0 ? args[harnessRootIdx + 1] : import.meta.dir.replace("/scripts", "");

if (!projectPath) {
  console.error("Usage: organize-project.ts /path/to/project [--dry-run] [--apply]");
  process.exit(1);
}

if (!existsSync(projectPath)) {
  console.error(`ERROR: Path does not exist: ${projectPath}`);
  process.exit(1);
}

if (!statSync(projectPath).isDirectory()) {
  console.error(`ERROR: Not a directory: ${projectPath}`);
  process.exit(1);
}

const proposals = organizeProject(projectPath, { apply: applyMode, dryRun, harnessRoot });

if (proposals.length === 0) {
  console.log("No unorganized files found.");
  process.exit(0);
}

// Output structured JSON
console.log(JSON.stringify(proposals, null, 2));

console.log(`\n--- Summary ---`);
console.log(`Total proposals: ${proposals.length}`);
console.log(`Mode: ${applyMode ? "APPLY (files moved)" : "DRY-RUN (no changes)"}`);

for (const p of proposals) {
  console.log(`  ${p.source} → ${p.target} [${p.classification}] (confidence: ${p.confidence})`);
}
