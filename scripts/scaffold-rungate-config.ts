#!/usr/bin/env bun
// scaffold-rungate-config.ts -- Generate starter .claude/rungate.json
// Usage: scaffold-rungate-config.ts /path/to/project

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("Usage: scaffold-rungate-config.ts /path/to/project");
  process.exit(1);
}

const target = join(projectRoot, ".claude", "rungate.json");

if (existsSync(target)) {
  console.log(`EXISTS: ${target} — not overwriting`);
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

mkdirSync(join(projectRoot, ".claude"), { recursive: true });

const config = {
  description: "Auto-generated project harness config",
  codeCommittedPaths: paths,
  issueRepo,
  dev: { command: devCmd },
  test: { command: testCmd },
  prod: { rebuild: rebuildCmd },
};

writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
console.log(`CREATED: ${target}`);
console.log(readFileSync(target, "utf-8"));
