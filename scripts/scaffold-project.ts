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
import { parseProfile, STEPS_NOT_MINIMAL, type ScaffoldProfile } from "../lib/scaffold/profiles";

// ── CLI argument parsing ───────────────────────────────────────

const args = process.argv.slice(2);
const projectPath = args.find(arg => !arg.startsWith('--'));
const typeFlag = args.find(arg => arg.startsWith('--type='))?.split('=')[1] ||
                 (args.indexOf('--type') !== -1 ? args[args.indexOf('--type') + 1] : null);
const fix = args.includes('--fix');
// #216: both default false — re-scaffold is how a consumer takes an UPDATE.
const force = args.includes('--force'), commit = args.includes('--commit');
// #42. Auto-fix is opt-OUT: a re-scaffold that reports a gap it could have
// closed is a worse onboarding than one that closes it. Pruning consumers is
// opt-IN and separate — see `pruneStaleConsumers` for why deleting a config
// entry is not in the same risk class as adding a frontmatter line.
const autoFix = !args.includes('--no-auto-fix');
const pruneConsumers = args.includes('--prune-consumers');
// #449. Orthogonal to --type: that selects WHICH generators run, this selects
// whether the harness-only ones run at all.
const profileFlag = args.find(arg => arg.startsWith('--profile='))?.split('=')[1] ||
                 (args.indexOf('--profile') !== -1 ? args[args.indexOf('--profile') + 1] : null);

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project [--type code|content|infra|workflow] [--profile full|minimal] [--fix] [--force] [--commit] [--no-auto-fix] [--prune-consumers]");
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

// parseProfile throws rather than defaulting: a typo'd --profile=minimial that
// silently scaffolded the full harness would look like the flag was honoured.
let profile: ScaffoldProfile;
try {
  profile = parseProfile(profileFlag);
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────

const actions: string[] = [];
const projectType: ProjectType = (typeFlag as ProjectType) || detectProjectType(projectPath);
const projectName = basename(projectPath);

console.log(`Detected project type: ${projectType}`);
console.log(`Project: ${projectName}`);
console.log(`Path: ${projectPath}`);
console.log(`Profile: ${profile}${profile === "minimal" ? ` — not written: ${[...STEPS_NOT_MINIMAL.keys()].join(", ")}` : ""}`);
console.log("---");

if (fix) {
  runScaffoldWriteSteps(projectPath, projectType, actions, { force, commit, profile, autoFix, pruneConsumers });
} else {
  // Audit does not PREDICT what --fix would do; it does it, against a clone,
  // and reports what the real steps said (#398). The previous audit branch was
  // four existsSync checks against twenty-five write steps and reported 0
  // changes on a tree --fix rewrote in 28 places.
  //
  // A rehearsal that cannot be set up safely REFUSES rather than falling
  // back to the old guesswork. An audit that reports nothing because it
  // could not look is indistinguishable from an audit that found nothing,
  // and that is the defect, not a lesser version of it.
  let rehearsal;
  try {
    rehearsal = cloneForRehearsal(projectPath);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
  try {
    console.log(rehearsalNotice(rehearsal));
    // The rehearsal gets the same flags, so an audit reports what --fix would
    // actually do rather than what it would do with different settings (#398).
    runScaffoldWriteSteps(rehearsal.dir, projectType, actions, { force, commit: false, rehearsing: true, profile, autoFix, pruneConsumers });
  } finally {
    discardRehearsal(rehearsal);
  }
}

// ── Report ─────────────────────────────────────────────────────

// A refusal that only prints is one nobody's CI notices (#216).
if (reportScaffoldActions(actions) > 0) process.exit(1);
