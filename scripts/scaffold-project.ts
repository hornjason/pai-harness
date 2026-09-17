#!/usr/bin/env bun
/**
 * scaffold-project.ts — Bootstrap any project to scaffold conformity.
 *
 * Usage: bun ~/Projects/pai-harness/scripts/scaffold-project.ts /path/to/project
 *
 * Detects project type (code/content/infra), creates missing directories,
 * generates AGENTS.md stub, creates thin conformity test, adds frontmatter
 * to bare specs. NEVER overwrites existing files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

// ── CLI argument parsing ───────────────────────────────────────

const projectPath = process.argv[2];

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project");
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

// ── Project type detection ─────────────────────────────────────

type ProjectType = "code" | "content" | "infra";

function detectProjectType(root: string): ProjectType {
  const hasPackageJson = existsSync(join(root, "package.json"));
  const hasSrc = existsSync(join(root, "src"));
  const hasLib = existsSync(join(root, "lib"));
  const hasMakefile = existsSync(join(root, "Makefile"));
  const hasTsConfig = existsSync(join(root, "tsconfig.json"));
  const hasDockerCompose = existsSync(join(root, "docker-compose.yml")) || existsSync(join(root, "docker-compose.yaml"));
  const hasDockerfile = existsSync(join(root, "Dockerfile"));
  const hasScriptsDir = existsSync(join(root, "scripts"));
  const hasManifests = hasDockerCompose || hasDockerfile ||
    existsSync(join(root, "k8s")) || existsSync(join(root, "terraform"));

  // Code project: has source directories or package.json with source
  if (hasSrc || hasLib || hasTsConfig || (hasPackageJson && (hasSrc || hasLib))) {
    return "code";
  }

  // Infra project: has deployment/config files
  if (hasManifests || (hasScriptsDir && !hasPackageJson)) {
    return "infra";
  }

  // Code project: has package.json (even without src/)
  if (hasPackageJson && hasMakefile) {
    return "code";
  }

  // Content project: predominantly markdown/media files
  if (hasPackageJson) {
    return "code";
  }

  // Infra: has scripts dir
  if (hasScriptsDir) {
    return "infra";
  }

  return "content";
}

// ── Helpers ────────────────────────────────────────────────────

const actions: string[] = [];

function safeWrite(filePath: string, content: string, label: string): void {
  if (existsSync(filePath)) {
    actions.push(`SKIP: ${label} (already exists)`);
    return;
  }
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content);
  actions.push(`CREATED: ${label}`);
}

function safeDir(dirPath: string, label: string): void {
  if (existsSync(dirPath)) {
    actions.push(`SKIP: ${label}/ (already exists)`);
    return;
  }
  mkdirSync(dirPath, { recursive: true });
  actions.push(`CREATED: ${label}/`);
}

// ── Main ───────────────────────────────────────────────────────

const projectType = detectProjectType(projectPath);
const projectName = basename(projectPath);

console.log(`Detected project type: ${projectType}`);
console.log(`Project: ${projectName}`);
console.log(`Path: ${projectPath}`);
console.log("---");

// 1. Create missing directories
safeDir(join(projectPath, "specs"), "specs");
safeDir(join(projectPath, "reference"), "reference");
safeDir(join(projectPath, ".github"), ".github");

// tests/ or test/ — respect existing convention
const existingTestDir = existsSync(join(projectPath, "test")) ? "test" : null;
const testDirName = existingTestDir || "tests";
safeDir(join(projectPath, testDirName), testDirName);

// 2. Generate AGENTS.md stub
const agentsMd = generateAgentsMd(projectName, projectType);
safeWrite(join(projectPath, "AGENTS.md"), agentsMd, "AGENTS.md");

// 3. Create .github/copilot-instructions.md
const copilotInstructions = `# Copilot Instructions

Read [AGENTS.md](../AGENTS.md) for project context, key files, specs, and workflow.

All project knowledge lives in AGENTS.md. Start there.
`;
safeWrite(join(projectPath, ".github", "copilot-instructions.md"), copilotInstructions, ".github/copilot-instructions.md");

// 4. Create thin conformity test file
const conformityTest = generateConformityTest();
safeWrite(
  join(projectPath, testDirName, "scaffold-conformity.test.ts"),
  conformityTest,
  `${testDirName}/scaffold-conformity.test.ts`
);

// 5. Add frontmatter to bare spec files
addFrontmatterToSpecs(join(projectPath, "specs"));

// 6. Add pai-harness to package.json devDeps (only if package.json exists)
addPaiHarnessDevDep(projectPath);

// ── Report ─────────────────────────────────────────────────────

console.log("\n=== Scaffold Report ===");
for (const action of actions) {
  console.log(`  ${action}`);
}
console.log(`\nTotal: ${actions.filter(a => a.startsWith("CREATED")).length} created, ${actions.filter(a => a.startsWith("SKIP")).length} skipped`);

// ── Generators ─────────────────────────────────────────────────

function generateAgentsMd(name: string, type: ProjectType): string {
  const typeLabel = type === "code" ? "Code" : type === "content" ? "Content" : "Infrastructure";

  return `# ${name}

## Project Identity

${typeLabel} project. <!-- TODO: Describe what this project is and who uses it. One paragraph. -->

## Key Files

| File | What | When to Read |
|------|------|--------------|
| AGENTS.md | Project entry point | Always first |
<!-- TODO: Add key files for this project -->

## Specs

All specs live in \`specs/\` with YAML frontmatter declaring \`testable: true/false\`.

| Spec | Testable | Governs |
|------|----------|---------|
<!-- TODO: Add specs as they are created -->

## Tests

\`\`\`bash
bun test
\`\`\`

| Category | File | What |
|----------|------|------|
| Scaffold conformity | scaffold-conformity.test.ts | Structure validation |
<!-- TODO: Add test files as they are created -->

## Workflow

<!-- TODO: Describe how work gets done in this project -->

## Quick Reference

<!-- TODO: Add critical rules condensed -->

## Reference Files

Historical and inactive docs live in \`reference/\`.

| File | What |
|------|------|
<!-- TODO: Add reference files -->
`;
}

function generateConformityTest(): string {
  return `import { resolve } from "path";
import { runScaffoldConformity, runSpecDiscovery } from "pai-harness/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
`;
}

function addFrontmatterToSpecs(specsDir: string): void {
  if (!existsSync(specsDir)) return;

  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(specsDir, file);
    const content = readFileSync(filePath, "utf-8");

    // Skip files that already have frontmatter
    if (content.startsWith("---\n")) {
      continue;
    }

    const today = new Date().toISOString().split("T")[0];
    const frontmatter = `---
doc-type: spec
status: draft
owner: TODO
created: ${today}
updated: ${today}
governs: TODO — describe what this spec governs
testable: false
---

`;
    writeFileSync(filePath, frontmatter + content);
    actions.push(`UPDATED: specs/${file} (added frontmatter)`);
  }
}

function addPaiHarnessDevDep(root: string): void {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (!pkg.devDependencies) {
    pkg.devDependencies = {};
  }

  if (pkg.devDependencies["pai-harness"]) {
    actions.push("SKIP: pai-harness devDep (already present)");
    return;
  }

  pkg.devDependencies["pai-harness"] = "file:~/Projects/pai-harness";

  // Add test script if missing
  if (!pkg.scripts) {
    pkg.scripts = {};
  }
  if (!pkg.scripts.test) {
    pkg.scripts.test = "bun test";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  actions.push("CREATED: pai-harness devDep in package.json");
}
