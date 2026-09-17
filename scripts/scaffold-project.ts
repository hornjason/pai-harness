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

  // Read package.json for description
  const pkgPath = join(projectPath, "package.json");
  let pkgDesc = "";
  let pkgName = name;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgDesc = pkg.description || "";
      pkgName = pkg.name || name;
    } catch {}
  }

  // Read README.md first paragraph for identity
  let readmeDesc = "";
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    try {
      const readme = readFileSync(readmePath, "utf-8");
      const paragraphs = readme.split(/\n\n+/).filter(p => !p.startsWith("#") && p.trim().length > 20);
      if (paragraphs.length > 0) readmeDesc = paragraphs[0].replace(/\n/g, " ").trim();
    } catch {}
  }

  const identity = readmeDesc || pkgDesc || `${typeLabel} project. <!-- TODO: Describe what this project is -->`;

  // Detect git remote for repo URL
  let repoUrl = "";
  try {
    const result = Bun.spawnSync(["git", "-C", projectPath, "remote", "get-url", "origin"]);
    repoUrl = result.stdout.toString().trim().replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
  } catch {}

  // Scan key files
  const keyFiles: Array<{ file: string; what: string; when: string }> = [
    { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
  ];
  const keyFilePatterns: Array<{ pattern: string; what: string; when: string }> = [
    { pattern: "package.json", what: "Dependencies and scripts", when: "Adding deps or scripts" },
    { pattern: "Makefile", what: "Build/deploy commands", when: "Building or deploying" },
    { pattern: "tsconfig.json", what: "TypeScript configuration", when: "Changing TS settings" },
    { pattern: "Containerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: "Dockerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: ".claude/project-harness.json", what: "Harness project config", when: "Shipping through harness" },
  ];
  for (const kf of keyFilePatterns) {
    if (existsSync(join(projectPath, kf.pattern))) {
      keyFiles.push({ file: kf.pattern, what: kf.what, when: kf.when });
    }
  }
  // Scan for main source files
  for (const srcDir of ["src", "lib", "gates", "workflows", "hooks"]) {
    if (existsSync(join(projectPath, srcDir))) {
      keyFiles.push({ file: `${srcDir}/`, what: `${srcDir.charAt(0).toUpperCase() + srcDir.slice(1)} directory`, when: `Working on ${srcDir}` });
    }
  }

  const keyFilesTable = keyFiles.map(kf => `| ${kf.file} | ${kf.what} | ${kf.when} |`).join("\n");

  // Scan specs
  const specsDir = join(projectPath, "specs");
  const specRows: string[] = [];
  if (existsSync(specsDir)) {
    for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let testable = "false";
      let governs = f.replace(/\.md$/, "");
      if (fmMatch) {
        const tMatch = fmMatch[1].match(/testable:\s*(true|false)/);
        if (tMatch) testable = tMatch[1];
        const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
        if (gMatch) governs = gMatch[1].trim();
      }
      specRows.push(`| ${f} | ${testable} | ${governs} |`);
    }
  }
  const specsTable = specRows.length > 0
    ? specRows.join("\n")
    : "| (none yet — copy SPEC-TEMPLATE.md from pai-harness) | | |";

  // Scan test files
  const testDir = existsSync(join(projectPath, "test")) ? "test" : existsSync(join(projectPath, "tests")) ? "tests" : null;
  const testRows: string[] = [];
  if (testDir) {
    for (const f of readdirSync(join(projectPath, testDir)).filter(f => f.endsWith(".test.ts"))) {
      const label = f.replace(".test.ts", "").replace(/-/g, " ");
      testRows.push(`| ${label} | ${f} | Auto-detected |`);
    }
  }
  const testsTable = testRows.length > 0
    ? testRows.join("\n")
    : "| scaffold conformity | scaffold-conformity.test.ts | Structure validation |";

  // Detect test command
  let testCmd = "bun test";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) testCmd = pkg.scripts.test;
    } catch {}
  }

  // Scan reference/ files
  const refDir = join(projectPath, "reference");
  const refRows: string[] = [];
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
      refRows.push(`| ${f} | Historical reference |`);
    }
  }
  const refTable = refRows.length > 0
    ? refRows.join("\n")
    : "| (empty) | |";

  // Detect workflow info
  const repoLine = repoUrl ? `- **Repo:** ${repoUrl}` : "<!-- TODO: Add repo URL -->";

  // Makefile targets for workflow section
  let makeTargets = "";
  if (existsSync(join(projectPath, "Makefile"))) {
    try {
      const makefile = readFileSync(join(projectPath, "Makefile"), "utf-8");
      const targets = makefile.match(/^[\w-]+(?=:)/gm)?.filter(t => !t.startsWith(".") && !t.startsWith("_")).slice(0, 8);
      if (targets?.length) makeTargets = `\n- **Key commands:** \`make ${targets.join("`, `make ")}\``;
    } catch {}
  }

  return `# ${pkgName}

## Project Identity

${identity}
${repoLine}

## Key Files

| File | What | When to Read |
|------|------|--------------|
${keyFilesTable}

## Specs

All specs live in \`specs/\` with YAML frontmatter declaring \`testable: true/false\`.

| Spec | Testable | Governs |
|------|----------|---------|
${specsTable}

## Tests

\`\`\`bash
${testCmd}
\`\`\`

| Category | File | What |
|----------|------|------|
${testsTable}

## Workflow
${repoLine}${makeTargets}
- **Test:** \`${testCmd}\`
- **Conformity:** Imported from pai-harness. \`bun update pai-harness && bun test\` to sync.

## Quick Reference

1. AGENTS.md is the single entry point — everything routes from here
2. Specs in specs/ are source of truth — testable: true specs auto-generate tests
3. \`bun test\` runs conformity + domain tests

## Reference Files

Historical and inactive docs live in \`reference/\`.

| File | What |
|------|------|
${refTable}
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

  if (pkg.devDependencies["pai-harness"] || pkg.name === "pai-harness") {
    actions.push("SKIP: pai-harness devDep (already present or self-reference)");
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
