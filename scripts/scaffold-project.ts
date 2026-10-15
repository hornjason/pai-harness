#!/usr/bin/env bun
/**
 * scaffold-project.ts — Bootstrap any project to scaffold conformity.
 *
 * Usage: bun ~/Projects/rungate/scripts/scaffold-project.ts /path/to/project
 *
 * Orchestrator-only: calls scanner, passes data to generators, writes output.
 * All logic lives in lib/scaffold/steps.ts and lib/validators/spec-validators.ts.
 */
import { existsSync, statSync } from "fs";
import { basename } from "path";
import { detectProjectType } from "../lib/scanner";
import { reportScaffoldActions } from "../lib/scaffold/steps";
import { runScaffoldWriteSteps } from "../lib/scaffold/write-steps";
import { cloneForRehearsal, discardRehearsal, rehearsalNotice } from "../lib/scaffold/rehearsal";
import type { ProjectType } from "../lib/generators/types";

// ── CLI argument parsing ───────────────────────────────────────

const args = process.argv.slice(2);
const projectPath = args.find(arg => !arg.startsWith('--'));
const typeFlag = args.find(arg => arg.startsWith('--type='))?.split('=')[1] ||
                 (args.indexOf('--type') !== -1 ? args[args.indexOf('--type') + 1] : null);
const fix = args.includes('--fix');
// #216: both default false — re-scaffold is how a consumer takes an UPDATE.
const force = args.includes('--force'), commit = args.includes('--commit');

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project [--type code|workflow] [--fix] [--force] [--commit]");
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

if (typeFlag && !['code', 'content', 'infra', 'workflow'].includes(typeFlag)) {
  console.error(`ERROR: Invalid --type value: ${typeFlag}`);
  console.error(`Valid values: code, content, infra, workflow`);
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────

const actions: string[] = [];
const projectType: ProjectType = (typeFlag as ProjectType) || detectProjectType(projectPath);
const projectName = basename(projectPath);

console.log(`Detected project type: ${projectType}`);
console.log(`Project: ${projectName}`);
console.log(`Path: ${projectPath}`);
console.log("---");

if (fix) {
  runScaffoldWriteSteps(projectPath, projectType, actions, { force, commit });
} else {
  // Audit does not PREDICT what --fix would do; it does it, against a clone,
  // and reports what the real steps said (#398). The previous audit branch was
  // four existsSync checks against twenty-five write steps and reported 0
  // changes on a tree --fix rewrote in 28 places.
  const rehearsal = cloneForRehearsal(projectPath);
  try {
    console.log(rehearsalNotice(rehearsal));
    runScaffoldWriteSteps(rehearsal.dir, projectType, actions, { force, commit: false, rehearsing: true });
  } finally {
    discardRehearsal(rehearsal);
  }
}

// ── Report ─────────────────────────────────────────────────────

// A refusal that only prints is one nobody's CI notices (#216).
if (reportScaffoldActions(actions) > 0) process.exit(1);
