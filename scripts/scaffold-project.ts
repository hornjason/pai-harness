#!/usr/bin/env bun
/**
 * scaffold-project.ts — Bootstrap any project to scaffold conformity.
 *
 * Usage: bun ~/Projects/rungate/scripts/scaffold-project.ts /path/to/project
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

// 2. Generate or refresh AGENTS.md
if (existsSync(join(projectPath, "AGENTS.md"))) {
  refreshAgentsMd(projectPath, projectType);
} else {
  const agentsMd = generateAgentsMd(projectName, projectType);
  safeWrite(join(projectPath, "AGENTS.md"), agentsMd, "AGENTS.md");
}

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

// 6. Generate .claude/agents/ briefing files (code projects only)
if (projectType === "code") {
  generateAgentBriefs(projectPath);
}

// 7. Generate or refresh CODE-MAP.md (code projects only)
if (projectType === "code") {
  generateCodeMap(projectPath);
}

// 8. Generate or audit project-harness.json (code projects only)
if (projectType === "code") {
  generateOrAuditProjectHarness(projectPath);
}

// 9. Copy spec template if specs/ is empty (#529)
copySpecTemplateIfEmpty(join(projectPath, "specs"));

// 10. Add rungate to package.json devDeps (only if package.json exists)
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

  // Read README.md first paragraph for identity (skip ALL YAML frontmatter blocks, HTML, and comments)
  let readmeDesc = "";
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    try {
      let readme = readFileSync(readmePath, "utf-8");
      // Strip all YAML frontmatter blocks (some files have multiple from templates)
      while (readme.startsWith("---\n")) {
        const endFm = readme.indexOf("\n---\n", 4);
        if (endFm > 0) { readme = readme.slice(endFm + 5); } else { break; }
      }
      // Strip HTML comments
      readme = readme.replace(/<!--[\s\S]*?-->/g, "");
      const paragraphs = readme.split(/\n\n+/).filter(p =>
        !p.startsWith("#") && !p.startsWith("---") && !p.startsWith("<") &&
        !/^[\s]*$/.test(p) && p.trim().length > 20
      );
      if (paragraphs.length > 0) readmeDesc = paragraphs[0].replace(/\n/g, " ").trim();
    } catch {}
  }

  // Preserve existing Hard Constraints section if AGENTS.md already exists
  let existingHardConstraints = "";
  const existingAgentsPath = join(projectPath, "AGENTS.md");
  if (existsSync(existingAgentsPath)) {
    try {
      const existing = readFileSync(existingAgentsPath, "utf-8");
      const hcMatch = existing.match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
      if (hcMatch) {
        const hcContent = hcMatch[1].trim();
        // Only preserve if it has actual content (not just the placeholder comment)
        if (hcContent && !hcContent.startsWith("<!-- Add project-specific")) {
          existingHardConstraints = hcContent;
        }
      }
    } catch (e: unknown) { console.error('Hard Constraints preservation failed:', (e as Error).message); throw e; }
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
    : "| (none yet — copy SPEC-TEMPLATE.md from rungate) | | |";

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

  // Load project-harness.json for environment info
  const harness = (() => {
    const p = join(projectPath, ".claude", "project-harness.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  })();

  // Scan docs/ directory for documentation routing
  const docsDir = join(projectPath, "docs");
  const docRouting: Array<{ need: string; file: string }> = [];
  // CODE-MAP first (auto-generated, always fresh)
  if (existsSync(join(projectPath, "CODE-MAP.md"))) {
    docRouting.push({ need: "Codebase structure (routes, components, modules, health)", file: "CODE-MAP.md" });
  }
  // Root-level docs (highest priority)
  for (const f of ["ARCHITECTURE.md", "PRINCIPLES.md", "CONTRIBUTING.md", "MODEL.md", "PROJECT-STATE.md"]) {
    if (existsSync(join(projectPath, f))) {
      docRouting.push({ need: f.replace(/\.md$/, "").replace(/-/g, " "), file: f });
    }
  }
  // docs/ directory — cap at 10 most relevant (prioritize by name patterns)
  if (existsSync(docsDir)) {
    const priority = ["ARCHITECTURE", "DOMAIN", "TESTING", "SECURITY", "DATA", "SETUP", "INSTALL"];
    const allDocs = readdirSync(docsDir).filter(f => f.endsWith(".md"))
      .map(f => ({ name: f, label: f.replace(/\.md$/, "").replace(/-/g, " "), score: priority.findIndex(p => f.toUpperCase().includes(p)) }))
      .sort((a, b) => (a.score === -1 ? 999 : a.score) - (b.score === -1 ? 999 : b.score));
    const topDocs = allDocs.slice(0, 10);
    for (const d of topDocs) {
      docRouting.push({ need: d.label, file: `docs/${d.name}` });
    }
    if (allDocs.length > 10) {
      docRouting.push({ need: `... and ${allDocs.length - 10} more`, file: "docs/" });
    }
  }
  const docRoutingTable = docRouting.length > 0
    ? docRouting.map(d => `| ${d.need} | \`${d.file}\` |`).join("\n")
    : "| (no docs found) | |";

  // Environment section from project-harness.json
  let envSection = "";
  if (harness) {
    const lines: string[] = ["## Environment\n"];
    if (harness.dev) {
      lines.push("**Dev:**");
      if (harness.dev.start) lines.push(`- Start: \`${harness.dev.start}\``);
      if (harness.dev.uiBase) lines.push(`- UI: ${harness.dev.uiBase}`);
      if (harness.dev.apiBase) lines.push(`- API: ${harness.dev.apiBase}`);
      if (harness.dev.testCmd) lines.push(`- Test: \`${harness.dev.testCmd}\``);
    }
    if (harness.prod) {
      lines.push("\n**Prod:**");
      if (harness.prod.rebuild) lines.push(`- Deploy: \`${harness.prod.rebuild}\``);
      if (harness.prod.apiBase) lines.push(`- API: ${harness.prod.apiBase}`);
      if (harness.prod.smokeTest) lines.push(`- Smoke: \`${harness.prod.smokeTest}\``);
    }
    if (harness.pages && Object.keys(harness.pages).length > 0) {
      lines.push("\n**Pages:**\n");
      lines.push("| Page | Path |");
      lines.push("|------|------|");
      for (const [path, label] of Object.entries(harness.pages)) {
        lines.push(`| ${label} | ${path} |`);
      }
    }
    envSection = lines.join("\n");
  }

  // Consumers from project-harness.json
  const consumers = harness?.consumers || [];
  const consumerSection = consumers.length > 0
    ? `## Consumers (${consumers.length})\n\n${consumers.map((c: string) => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.`
    : "";

  // CODE-MAP reference
  const codeMapRef = existsSync(join(projectPath, "CODE-MAP.md"))
    ? "| `CODE-MAP.md` | Auto-generated codebase map (routes, components, modules, health) | Understanding codebase structure |"
    : "";

  return `# ${pkgName}

## Project Identity

${identity}
${repoLine}

## Hard Constraints (non-inferrable — agents cannot discover these from code)

${existingHardConstraints || `<!-- Add project-specific rules that agents can't figure out from reading code.
     Examples: intentional anti-patterns, safety boundaries, deploy restrictions.
     Delete this comment after filling in. -->`}

## Key Files

| File | What | When to Read |
|------|------|--------------|
${keyFilesTable}
${codeMapRef}

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
${docRoutingTable}

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

${envSection}

${consumerSection}

## Workflow
${repoLine}${makeTargets}
- **Test:** \`${testCmd}\`
- **Conformity:** Imported from rungate. \`bun update rungate && bun test\` to sync.

## Quick Reference

1. AGENTS.md is the single entry point — everything routes from here
2. CODE-MAP.md has the auto-generated codebase map — routes, components, modules, health
3. Specs in specs/ are source of truth — testable: true specs auto-generate tests
4. \`bun test\` runs conformity + domain tests
5. Agent briefings in .claude/agents/ are auto-generated — run bootstrap to refresh

## Reference Files

Historical and inactive docs live in \`reference/\`.

| File | What |
|------|------|
${refTable}
`;
}


function generateConformityTest(): string {
  return `import { resolve } from "path";
import { runScaffoldConformity, runSpecDiscovery, runDocHygiene, runFallowCheck, runAgentFileValidation } from "rungate/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT, { warnOnly: true });
runAgentFileValidation(ROOT);
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

  if (pkg.devDependencies["rungate"] || pkg.name === "rungate") {
    actions.push("SKIP: rungate devDep (already present or self-reference)");
    return;
  }

  const harnessRelative = require("path").relative(root, join(__dirname, ".."));
  pkg.devDependencies["rungate"] = `file:${harnessRelative}`;

  // Add test script if missing
  if (!pkg.scripts) {
    pkg.scripts = {};
  }
  if (!pkg.scripts.test) {
    pkg.scripts.test = "bun test";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  actions.push("CREATED: rungate devDep in package.json");
}

function generateAgentBriefs(root: string): void {
  const agentsDir = join(root, ".claude", "agents");
  safeDir(agentsDir, ".claude/agents");

  const harness = loadHarnessConfig(root);
  const devUi = harness?.dev?.uiBase || `http://localhost:5173`;
  const devApi = harness?.dev?.apiBase || `http://localhost:7778`;
  const testCmd = harness?.dev?.testCmd || "bun test";
  const typeCheck = harness?.dev?.typeCheck || "bunx tsc --noEmit";
  const pages = harness?.pages || {};
  const pagesTable = Object.keys(pages).length > 0
    ? "### Pages Map\n\n| Path | Page |\n|------|------|\n" +
      Object.entries(pages).map(([k, v]) => `| ${v} | ${k} |`).join("\n")
    : "";

  // Pull project identity from AGENTS.md or README
  let projectIdentity = "";
  const agentsMdPath = join(root, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, "utf-8");
    const identityMatch = content.match(/## Project Identity\n\n([\s\S]*?)(?=\n##|\n\|)/);
    if (identityMatch) projectIdentity = identityMatch[1].trim();
  }
  if (!projectIdentity) {
    const readmePath = join(root, "README.md");
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, "utf-8");
      const paragraphs = readme.split(/\n\n+/).filter(p => !p.startsWith("#") && p.trim().length > 20);
      if (paragraphs.length > 0) projectIdentity = paragraphs[0].replace(/\n/g, " ").trim();
    }
  }
  const identitySection = projectIdentity ? `## Project\n\n${projectIdentity}\n` : "";

  const architecturalTruths = "";

  // Pull directory structure for Marcus
  const srcDirs = ["src", "dashboard/src", "lib", "gates", "hooks"].filter(d => existsSync(join(root, d)));
  const dirList = srcDirs.length > 0 ? srcDirs.map(d => `- \`${d}/\``).join("\n") : "";

  // Pull consumers from harness config
  const consumers = harness?.consumers || [];
  const consumerNote = consumers.length > 0
    ? `\n## Consumers (${consumers.length})\n\n${consumers.map((c: string) => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.\n`
    : "";

  const quinnBrief = `---
name: quinn
description: QA engineer — tests as a brand-new user using Playwright MCP tools
tools: [Bash, Read, mcp__playwright__*]
model: sonnet
---

You are Quinn Torres, QA engineer. You test as a brand-new user who has never seen this app before.

${identitySection}## Context (MANDATORY — read before testing)

1. **AGENTS.md** — project identity, critical rules, documentation routing
2. **CODE-MAP.md § Page → Component Map** — which components are on each page (your test targets)
3. **CODE-MAP.md § API Routes** — endpoint inventory for API-level checks
4. **node_modules/rungate/prompts/quinn-ui-brief.md** — structured UI testing methodology

## Environment

- **Dev UI:** ${devUi}
- **Dev API:** ${devApi}
- **Viewport:** 1280x720 (set via browser_resize FIRST)
- **Never test on port 7777** — that's the live container

${pagesTable}

## Pre-conditions (GATE — stop if any fail)

1. Set viewport: browser_resize(1280, 720)
2. Navigate to target URL
3. browser_snapshot() — verify page loaded (no error banners, data present)
If pre-conditions fail → report FAIL immediately, do NOT proceed.

## Tools

- browser_snapshot() for ALL assertions (text, fast, cheap)
- browser_take_screenshot() ONLY for evidence after assertions pass
- Never guess URLs — read .claude/project-harness.json pages map

## Anti-checks (ALWAYS run)

- No "undefined" or "null" rendered as visible text
- No stuck loading spinners
- No error banners or toast messages
- Interactive elements respond to clicks

## Report

- PASS/FAIL per AC with snapshot/screenshot evidence
- Anti-check results
- Any new findings flagged as blocking or non-blocking
`;

  const marcusBrief = `---
name: marcus
description: Principal engineer — implements code changes with TDD, writes tests, commits
tools: [Bash, Read, Write, Edit]
model: opus
---

You are Marcus Webb, principal engineer. You implement code changes, write tests, and commit.

${identitySection}## Context (MANDATORY — read before coding)

1. **AGENTS.md** — project identity, critical rules, documentation routing
2. **CODE-MAP.md § Module Dependencies** — import chains for cascade impact analysis
3. **CODE-MAP.md § Code Health** — circular deps and unused files to avoid

${dirList ? `## Source Directories\n\n${dirList}\n` : ""}${consumerNote}## Before writing code
2. Read every file listed in the brief's **Files** section
3. Read the **Governing Spec** if one is cited
4. Run existing tests to establish baseline: \`${testCmd}\`

## While coding

- TDD: write the failing test first, then the implementation
- Deep modules, thin consumers: shared logic in lib/, consumers call one function
- No hardcoded values — use config or environment variables
- All thresholds configurable

## Before reporting done

1. Run \`${testCmd}\` — all tests pass
2. Run \`${typeCheck}\` — no type errors
3. Run \`npx fallow audit\` — no new dead code or circular deps introduced
4. Commit all changes referencing the issue number
5. Push branch with -u flag

## Rules

- Never run \`make rebuild\` — only the DA does that
- Dev server: \`make dev-all\` starts API (${devApi}) and UI (${devUi})
`;

  const rookBrief = `---
name: rook
description: Security engineer — scans changed files for vulnerabilities
tools: [Bash, Read]
model: sonnet
---

You are Rook Blackburn, security engineer. You scan changed files for vulnerabilities.

${identitySection}## Context (MANDATORY — read before scanning)

1. **AGENTS.md** — project identity, critical rules, security baseline routing
2. **CODE-MAP.md § Code Health** — circular deps and unused files (vulnerability surface)
3. **CODE-MAP.md § Module Dependencies** — data flow chains for injection analysis

## What you scan

1. All files changed in the current branch vs main
2. Pattern siblings — files that share imports or data flow with changed files
3. Configuration files touched by the change

## What you look for

- Injection vulnerabilities (XSS, SQL injection, command injection)
- Authentication/authorization bypasses
- Sensitive data exposure (credentials, tokens, PII in logs)
- Insecure defaults or missing input validation
- Path traversal in file operations
- Unsafe deserialization

## Report

- CLEAR or FINDINGS with severity (CRITICAL/HIGH/MEDIUM/LOW)
- Each finding: file, line, vulnerability type, remediation
- False positives noted as such with reasoning

## Rules

- Never modify source code — report only
- Never touch production config files
- Never run \`make rebuild\`
`;

  const serenaBrief = `---
name: serena
description: Software architect — structural decisions, ADRs, module boundary review
tools: [Bash, Read]
model: opus
---

You are Serena Blackwood, software architect. You make structural decisions and write ADRs.

${identitySection}## Context (MANDATORY — read before designing)

1. **AGENTS.md** — project identity, critical rules, documentation routing
2. **CODE-MAP.md § Module Dependencies** — import chains for boundary analysis
3. **CODE-MAP.md § Directory Structure** — module inventory for architecture review

## What you do

1. Evaluate proposed architectural changes against existing ADRs
2. Write new ADRs for decisions that don't have one
3. Review module boundaries and dependency direction
4. Assess scalability, maintainability, and complexity tradeoffs

## Architecture principles

- Deep modules, thin consumers
- Single chokepoint for mutations
- Config-driven over hardcoded
- Shared logic in lib/, never duplicated across consumers
- Schema validation at system boundaries

## Report

- ADR document for new decisions
- APPROVED or CONCERNS for reviews
- Specific module/file recommendations, not abstract guidance

## Rules

- Never write implementation code — provide specs for Marcus
- Never run builds, tests, or deployments
`;

  const aditiBrief = `---
name: aditi
description: UX/UI designer — component specs, visual review, accessibility
tools: [Bash, Read]
model: sonnet
---

You are Aditi Sharma, UX/UI designer. You design component specs and review UI implementations.

${identitySection}## Context (MANDATORY — read before designing)

1. **AGENTS.md** — project identity, critical rules, documentation routing
2. **CODE-MAP.md § Page → Component Map** — which components render on each page
3. **CODE-MAP.md § React Components** — full component inventory
4. Read any visual specs or mockups referenced in the brief

## What you do

1. Review proposed UI changes against design principles
2. Create component specs with layout, spacing, typography, color
3. Assess visual hierarchy and information density
4. Evaluate accessibility (contrast, focus order, screen reader labels)

## Design principles

- shadcn/ui component library as the base
- Consistent spacing scale (4px base)
- Clear visual hierarchy — primary action obvious
- Accessible: WCAG 2.1 AA minimum

## Report

- APPROVED or REVISION_NEEDED with specific changes
- Mockups as HTML when proposing new layouts
- Annotated screenshots when reviewing existing UI
- Specific CSS values, not vague directions

## Rules

- Never modify source code directly — provide specs for Marcus
- Never run builds or tests
`;

  // Agent briefs always regenerate — they're harness-owned templates, not user-customized
  for (const [name, content] of [
    ["quinn.md", quinnBrief], ["marcus.md", marcusBrief], ["rook.md", rookBrief],
    ["serena.md", serenaBrief], ["aditi.md", aditiBrief],
  ] as const) {
    const p = join(agentsDir, name);
    writeFileSync(p, content);
    actions.push(existsSync(p) ? `UPDATED: .claude/agents/${name}` : `CREATED: .claude/agents/${name}`);
  }
}

function refreshAgentsMd(root: string, type: ProjectType): void {
  const agentsPath = join(root, "AGENTS.md");
  const content = readFileSync(agentsPath, "utf-8");
  const issues: string[] = [];

  // Check all file references resolve
  const linkPattern = /`([^`]+\.(md|json|ts|js|tsx|yml|yaml))`/g;
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const ref = match[1];
    if (ref.startsWith("http") || ref.includes("*")) continue;
    if (!existsSync(join(root, ref))) {
      issues.push(`BROKEN: ${ref} (referenced in AGENTS.md but doesn't exist)`);
    }
  }

  // Check staleness of referenced files
  const staleFiles: string[] = [];
  const linkPattern2 = /`([^`]+\.md)`/g;
  while ((match = linkPattern2.exec(content)) !== null) {
    const ref = match[1];
    if (!existsSync(join(root, ref))) continue;
    try {
      const result = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%ci", "--", ref], { timeout: 5_000 });
      const dateStr = result.stdout.toString().trim().split(" ")[0];
      if (dateStr) {
        const daysSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
        const isAdr = ref.includes('docs/adr/') || /ADR/i.test(ref);
        if (isAdr) continue;
        const threshold = ref.startsWith('specs/') ? 90 : 180;
        if (daysSince > threshold) staleFiles.push(`${ref} (${Math.floor(daysSince)}d old)`);
      }
    } catch (e: unknown) { console.warn('Staleness check failed for', ref, (e as Error).message); }
  }

  // Check specs/ table matches actual specs
  const specsDir = join(root, "specs");
  if (existsSync(specsDir)) {
    const actualSpecs = readdirSync(specsDir).filter(f => f.endsWith(".md"));
    const listedInAgents = actualSpecs.filter(f => content.includes(f));
    const unlisted = actualSpecs.filter(f => !content.includes(f));
    if (unlisted.length > 0) {
      issues.push(`UNLISTED specs: ${unlisted.join(", ")} (in specs/ but not in AGENTS.md)`);
    }
  }

  // Check CODE-MAP.md is referenced
  if (existsSync(join(root, "CODE-MAP.md")) && !content.includes("CODE-MAP")) {
    issues.push("CODE-MAP.md exists but not referenced in AGENTS.md routing table");
  }

  if (issues.length > 0 || staleFiles.length > 0) {
    console.log("\n  AGENTS.md audit:");
    for (const issue of issues) console.log(`    ⚠ ${issue}`);
    if (staleFiles.length > 0) {
      console.log(`    ⚠ STALE (>90 days): ${staleFiles.join(", ")}`);
    }
    actions.push(`AUDITED: AGENTS.md (${issues.length} broken refs, ${staleFiles.length} stale docs)`);
  } else {
    actions.push("AUDITED: AGENTS.md (all references valid, no stale docs)");
  }
}

function generateOrAuditProjectHarness(root: string): void {
  const harnessPath = join(root, ".claude", "project-harness.json");

  // Scan pages from App.tsx or pages/ directory
  const scannedPages: Record<string, string> = {};
  const appTsx = join(root, "dashboard/src/App.tsx");
  if (existsSync(appTsx)) {
    const content = readFileSync(appTsx, "utf-8");
    const routePattern = /path="([^"]+)"/g;
    let m;
    while ((m = routePattern.exec(content)) !== null) {
      const path = m[1];
      if (path === "*" || path.includes(":")) continue;
      const label = path.split("/").pop() || "home";
      scannedPages[path] = label;
    }
  }

  // Scan test commands from package.json
  const pkgPath = join(root, "package.json");
  let testCmd = "bun test";
  let typeCheckCmd = "bunx tsc --noEmit";
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.test) testCmd = pkg.scripts.test;
    if (pkg.scripts?.typecheck) typeCheckCmd = pkg.scripts.typecheck;
  }

  // Scan ports from Makefile
  let devPort = 5173, apiPort = 7778, prodPort = 7777;
  const makefile = join(root, "Makefile");
  if (existsSync(makefile)) {
    const content = readFileSync(makefile, "utf-8");
    const portMatch = content.match(/(\d{4}):(\d{4})/g);
    if (portMatch) {
      for (const pm of portMatch) {
        const [host] = pm.split(":");
        const p = parseInt(host);
        if (p === 7777) prodPort = p;
        if (p === 7776 || p === 7778) apiPort = p;
      }
    }
  }

  // Detect git remote for repo
  let repo = "";
  try {
    const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { timeout: 5_000 });
    repo = result.stdout.toString().trim()
      .replace(/\.git$/, "")
      .replace("git@github.com:", "")
      .replace("https://github.com/", "");
  } catch {}

  // Scan for consumer modules (files in src/ that are route handlers or generators)
  const scannedConsumers: string[] = [];
  const srcDir = join(root, "src");
  if (existsSync(srcDir)) {
    const consumerPatterns = ["-routes.ts", "-generator.ts", "-plan.ts", "-intel.ts"];
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const isConsumer = consumerPatterns.some(p => f.includes(p)) ||
        content.includes("callGemini") || content.includes("buildTemplate");
      if (isConsumer) {
        scannedConsumers.push(f.replace(/\.ts$/, "").replace(/-routes|-generator/, ""));
      }
    }
  }

  if (existsSync(harnessPath)) {
    // Audit existing — compare scanned vs declared
    const existing = JSON.parse(readFileSync(harnessPath, "utf-8"));
    const issues: string[] = [];

    // Check pages drift
    const declaredPages = Object.keys(existing.pages || {});
    const scannedPaths = Object.keys(scannedPages);
    const missingPages = scannedPaths.filter(p => !declaredPages.some(d => existing.pages[d] === p || d === p));
    if (missingPages.length > 0) {
      issues.push(`PAGES: ${missingPages.length} routes in code not in project-harness.json: ${missingPages.slice(0, 5).join(", ")}`);
    }

    if (issues.length > 0) {
      console.log("\n  project-harness.json audit:");
      for (const issue of issues) console.log(`    ⚠ ${issue}`);
      actions.push(`AUDITED: project-harness.json (${issues.length} gaps)`);
    } else {
      actions.push("AUDITED: project-harness.json (aligned with code)");
    }
  } else {
    // Generate new project-harness.json
    const config = {
      project: basename(root),
      repo,
      issueRepo: repo,
      dev: {
        start: existsSync(makefile) ? "make dev-all" : "bun run dev",
        apiBase: `http://localhost:${apiPort}`,
        uiBase: `http://localhost:${devPort}`,
        testCmd,
        typeCheck: typeCheckCmd,
      },
      prod: {
        rebuild: existsSync(makefile) ? "make rebuild" : undefined,
        apiBase: `http://localhost:${prodPort}`,
      },
      pages: scannedPages,
      consumers: [...new Set(scannedConsumers)].sort(),
      contextDocs: {},
    };

    const dir = join(root, ".claude");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(harnessPath, JSON.stringify(config, null, 2) + "\n");
    actions.push(`CREATED: .claude/project-harness.json (${Object.keys(scannedPages).length} pages, ${scannedConsumers.length} consumers)`);
  }
}

function loadHarnessConfig(root: string): any {
  const p = join(root, ".claude", "project-harness.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function generateCodeMap(root: string): void {
  const codeMapPath = join(root, "CODE-MAP.md");

  // Check staleness: skip if <14 days old AND <50 commits since last scan
  if (existsSync(codeMapPath)) {
    const content = readFileSync(codeMapPath, "utf-8");
    const updatedMatch = content.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
    if (updatedMatch) {
      const lastScan = new Date(updatedMatch[1]);
      const daysSince = (Date.now() - lastScan.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 14) {
        // Check commit count since last scan
        const gitResult = Bun.spawnSync(
          ["git", "-C", root, "rev-list", "--count", `--since=${updatedMatch[1]}`, "HEAD"],
          { timeout: 5_000 }
        );
        const commits = parseInt(gitResult.stdout.toString().trim()) || 0;
        if (commits < 50) {
          actions.push(`SKIP: CODE-MAP.md (${daysSince.toFixed(0)}d old, ${commits} commits — still fresh)`);
          return;
        }
      }
    }
  }

  // Run generate-code-map.ts
  const scriptPath = join(__dirname, "generate-code-map.ts");
  if (!existsSync(scriptPath)) {
    actions.push("SKIP: CODE-MAP.md (generate-code-map.ts not found)");
    return;
  }

  const result = Bun.spawnSync(["bun", scriptPath, root], { timeout: 60_000 });
  if (result.exitCode === 0) {
    actions.push(existsSync(codeMapPath) ? "UPDATED: CODE-MAP.md" : "CREATED: CODE-MAP.md");
  } else {
    actions.push("WARN: CODE-MAP.md generation failed");
  }
}

function copySpecTemplateIfEmpty(specsDir: string): void {
  if (!existsSync(specsDir)) return;
  const specs = readdirSync(specsDir).filter(f => f.endsWith(".md"));
  if (specs.length > 0) return;

  const templatePath = join(__dirname, "..", "specs", "SPEC-TEMPLATE.md");
  if (!existsSync(templatePath)) {
    actions.push("SKIP: spec template (SPEC-TEMPLATE.md not found in harness)");
    return;
  }

  const template = readFileSync(templatePath, "utf-8");
  writeFileSync(join(specsDir, "SPEC-TEMPLATE.md"), template);
  actions.push("CREATED: specs/SPEC-TEMPLATE.md (starter template)");
}
