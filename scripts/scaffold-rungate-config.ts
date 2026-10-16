#!/usr/bin/env bun
// scaffold-rungate-config.ts -- Generate starter .claude/rungate.json
// Usage: scaffold-rungate-config.ts /path/to/project

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { buildDefaultRoles, buildDefaultHooks } from "../lib/scaffold/defaults";
import { resolveConfig, writeScaffoldedConfig } from "../lib/config-loader";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("Usage: scaffold-rungate-config.ts /path/to/project");
  process.exit(1);
}

// This script builds no config paths of its own (#415), so the two sites it
// used to carry in the config-access ratchet are gone rather than banked at a
// number no migration could lower. It does not decide whether a config is
// already there either — `writeScaffoldedConfig` does, and reports back. A
// copy of that decision here would make the library's copy unreachable, and
// an unreachable guard measures as load-bearing while nothing depends on it.

// Infer codeCommittedPaths
const paths: string[] = [];
for (const d of ["src", "lib", "app", "config", "test", "tests", "spec"]) {
  if (existsSync(join(projectRoot, d))) paths.push(`${d}/`);
}
for (const f of ["package.json", "Makefile", "docker-compose.yml", "tsconfig.json"]) {
  if (existsSync(join(projectRoot, f))) paths.push(f);
}
if (paths.length === 0) paths.push("./");

// Infer dev command
let devCmd: string | null = null;
const pkgPath = join(projectRoot, "package.json");
const makefilePath = join(projectRoot, "Makefile");
const hasPkg = existsSync(pkgPath);
const hasMakefile = existsSync(makefilePath);

if (hasPkg) {
  const pkg = readFileSync(pkgPath, "utf-8");
  if (pkg.includes('"dev"')) devCmd = "npm run dev";
  else if (pkg.includes('"start"')) devCmd = "npm start";
} else if (hasMakefile) {
  const mf = readFileSync(makefilePath, "utf-8");
  if (/^dev/m.test(mf)) devCmd = "make dev";
}

// Infer test command
let testCmd: string | null = null;
if (hasPkg) {
  const pkg = readFileSync(pkgPath, "utf-8");
  if (pkg.includes('"test"')) testCmd = "bun test --timeout 30000";
}

// Infer rebuild command
let rebuildCmd: string | null = null;
if (hasMakefile) {
  const mf = readFileSync(makefilePath, "utf-8");
  if (/^rebuild/m.test(mf)) rebuildCmd = "make rebuild";
}

// Infer issueRepo from git remote
let issueRepo = "";
if (existsSync(join(projectRoot, ".git"))) {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    if (remote) {
      issueRepo = remote.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
    }
  } catch {
    // no remote configured
  }
}

// An uninferred command is OMITTED, not written as `null` (#415). Three of
// these keys are declared `z.string().optional()`, so a `null` does not read
// as "not detected" — it fails validation, and every later `resolveConfig`
// over this project THREW. Nothing noticed because this script never asked
// the loader to read what it had just written; the second run of it, added in
// this change, is what surfaced it.
//
// `dev.start` rather than `dev.command` for the same reason from the other
// side: `command` is not a key of DevSchema, so the loader stripped it and
// the detected dev command reached nobody. A key the validator deletes is
// Silent Default Substitution — see `.claude/rules/config-access.md`.
const config = {
  description: "Auto-generated project harness config",
  codeCommittedPaths: paths,
  ...(issueRepo ? { issueRepo } : {}),
  ...(devCmd ? { dev: { start: devCmd } } : {}),
  ...(testCmd ? { test: { command: testCmd } } : {}),
  ...(rebuildCmd ? { prod: { rebuild: rebuildCmd } } : {}),
};

// Write split directory structure instead of monolith.
// roles/hooks come from the SAME source the main scaffold uses — two entry
// points writing different role sets means whichever ran last decides what the
// project is, which is the bug in #70 one layer up.
const roles = buildDefaultRoles();
const hooks = buildDefaultHooks();
const written = writeScaffoldedConfig(projectRoot, {
  config,
  roles,
  hooks,
  compliance: {
    rules: {},
    defaults: { consecutiveFailThreshold: 3, tierPromotionThreshold: 5 },
    organize: { fileTypes: [".md"], artifactClassification: {}, externalSources: [] },
  },
});

if (written.status === "exists") {
  console.log(`EXISTS: ${written.path} — not overwriting`);
  process.exit(0);
}

console.log(`CREATED: ${written.path}/`);
for (const f of ["config.json", "roles.json", "hooks.json", "compliance.json"]) {
  console.log(`  ${f}`);
}
console.log(readFileSync(join(written.path, "config.json"), "utf-8"));
