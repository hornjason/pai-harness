#!/usr/bin/env bun
// scaffold-rungate-config.ts -- Generate starter .claude/rungate/ directory
// Usage: scaffold-rungate-config.ts /path/to/project

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("Usage: scaffold-rungate-config.ts /path/to/project");
  process.exit(1);
}

const rungateDir = join(projectRoot, ".claude", "rungate");
const monolithPath = join(projectRoot, ".claude", "rungate.json");

// Skip if directory already exists
if (existsSync(join(rungateDir, "config.json"))) {
  console.log(`EXISTS: ${rungateDir}/config.json — not overwriting`);
  process.exit(0);
}

// Skip if monolith exists (use splitMonolithToDirectory from steps.ts instead)
if (existsSync(monolithPath)) {
  console.log(`EXISTS: ${monolithPath} — not overwriting (use re-scaffold to split)`);
  process.exit(0);
}

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

mkdirSync(rungateDir, { recursive: true });

const config = {
  description: "Auto-generated project harness config",
  codeCommittedPaths: paths,
  issueRepo,
  dev: { command: devCmd },
  test: { command: testCmd },
  prod: { rebuild: rebuildCmd },
};

// Write split directory structure
writeFileSync(join(rungateDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
writeFileSync(join(rungateDir, "roles.json"), JSON.stringify({}, null, 2) + "\n");
writeFileSync(join(rungateDir, "hooks.json"), JSON.stringify([], null, 2) + "\n");
writeFileSync(join(rungateDir, "compliance.json"), JSON.stringify({
  rules: {},
  defaults: { consecutiveFailThreshold: 3, tierPromotionThreshold: 5 },
  organize: { fileTypes: [".md"], artifactClassification: {}, externalSources: [] },
}, null, 2) + "\n");

console.log(`CREATED: ${rungateDir}/`);
console.log("  config.json, roles.json, hooks.json, compliance.json");
console.log(readFileSync(join(rungateDir, "config.json"), "utf-8"));
