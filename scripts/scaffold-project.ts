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
import { join, basename, dirname } from "path";

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

// Phase 0.10: .gitignore with security template (BEFORE any other file creation)
createGitignore(projectPath);

// Phase 0.11-0.14: Create missing directories
safeDir(join(projectPath, "specs"), "specs");
safeDir(join(projectPath, "reference"), "reference");
safeDir(join(projectPath, ".github"), ".github");
safeDir(join(projectPath, ".github", "workflows"), ".github/workflows");
safeDir(join(projectPath, "scripts"), "scripts");
safeDir(join(projectPath, "docs"), "docs");
safeDir(join(projectPath, "docs", "adr"), "docs/adr");

// tests/ or test/ — respect existing convention
const existingTestDir = existsSync(join(projectPath, "test")) ? "test" : null;
const testDirName = existingTestDir || "tests";
safeDir(join(projectPath, testDirName), testDirName);

// 2. Always regenerate AGENTS.md (spec line 24: "Everything is regenerable")
// User rules go in CLAUDE.md, not AGENTS.md (harness-owned, always regenerated)
const agentsMd = generateAgentsMd(projectName, projectType);
writeFileSync(join(projectPath, "AGENTS.md"), agentsMd);
actions.push(existsSync(join(projectPath, "AGENTS.md")) ? "REGENERATED: AGENTS.md" : "CREATED: AGENTS.md");
refreshAgentsMd(projectPath, projectType);
updateSpecsTable(join(projectPath, "AGENTS.md"));

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

// 5. Add frontmatter to bare spec files and ADRs
addFrontmatterToSpecs(join(projectPath, "specs"));
addFrontmatterToAdrs(join(projectPath, "docs", "adr"));
// SC-278, SC-279: Detect oversized specs and governs misalignment
detectOversizedSpecs(join(projectPath, "specs"));
checkGovernsAlignment(join(projectPath, "specs"));

// Phase 1: Scan code and generate config (data flows DOWN — config before briefs)
// 6. Generate or refresh CODE-MAP.md (code projects only)
if (projectType === "code") {
  generateCodeMap(projectPath);
}

// 7. Generate or audit rungate.json (code projects only)
if (projectType === "code") {
  generateOrAuditProjectHarness(projectPath);
}

// 7.5. Inject environment section into AGENTS.md from rungate.json (SC-3)
if (projectType === "code") {
  injectEnvironmentSection(projectPath);
}

// Phase 2: Generate briefs AFTER config (briefs read from rungate.json)
// 8. Generate .claude/agents/ briefing files (code projects only)
if (projectType === "code") {
  generateAgentBriefs(projectPath);
}

// 9. Copy spec template if specs/ is empty (#529)
copySpecTemplateIfEmpty(join(projectPath, "specs"));

// 10. Add rungate to package.json devDeps (only if package.json exists)
addPaiHarnessDevDep(projectPath);

// 11. Create CLAUDE.md with @AGENTS.md bridge
createClaudeMdBridge(projectPath);

// 12. Create CI/CD workflows (harness-owned — always regenerated)
createCiWorkflows(projectPath);

// 13. Create git hooks (pre-commit + pre-push)
createGitHooks(projectPath);

// 14. Post-scaffold git commit
postScaffoldCommit(projectPath);

// ── Report ─────────────────────────────────────────────────────

console.log("\n=== Scaffold Report ===");
for (const action of actions) {
  console.log(`  ${action}`);
}
console.log(`\nTotal: ${actions.filter(a => a.startsWith("CREATED")).length} created, ${actions.filter(a => a.startsWith("SKIP")).length} skipped`);

// ── Generators ─────────────────────────────────────────────────

function updateSpecsTable(agentsMdPath: string): void {
  if (!existsSync(agentsMdPath)) return;
  const specsDir = join(dirname(agentsMdPath), "specs");
  if (!existsSync(specsDir)) return;

  const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
  if (specFiles.length === 0) return;

  const specRows: string[] = [];
  for (const f of specFiles) {
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
    specRows.push(`| ${f} | ${governs} | ${testable === "true" ? "yes" : "no"} |`);
  }

  const existing = readFileSync(agentsMdPath, "utf-8");
  const tablePattern = /(\|[^\n]*Spec[^\n]*\|\n\|[-| ]+\|\n)((?:\|[^\n]+\|\n)*)/;
  const match = existing.match(tablePattern);
  if (match) {
    const newTable = match[1] + specRows.join("\n") + "\n";
    const updated = existing.replace(tablePattern, newTable);
    writeFileSync(agentsMdPath, updated);
    actions.push("UPDATED: AGENTS.md specs table from frontmatter");
  }
}

function injectEnvironmentSection(root: string): void {
  const agentsMdPath = join(root, "AGENTS.md");
  const harnessPath = join(root, ".claude", "rungate.json");
  if (!existsSync(agentsMdPath) || !existsSync(harnessPath)) return;

  let harness: any;
  try { harness = JSON.parse(readFileSync(harnessPath, "utf-8")); } catch { return; }

  const lines: string[] = [];
  if (harness.dev) {
    lines.push("**Dev:**");
    if (harness.dev.start) lines.push(`- Start: \`${harness.dev.start}\``);
    if (harness.dev.apiBase) lines.push(`- API: ${harness.dev.apiBase}`);
    if (harness.dev.uiBase) lines.push(`- UI: ${harness.dev.uiBase}`);
    if (harness.dev.testCmd) lines.push(`- Test: \`${harness.dev.testCmd}\``);
  }
  if (harness.prod) {
    const prodLines: string[] = [];
    if (harness.prod.rebuild) prodLines.push(`- Deploy: \`${harness.prod.rebuild}\``);
    if (harness.prod.apiBase) prodLines.push(`- API: ${harness.prod.apiBase}`);
    if (prodLines.length > 0) {
      lines.push("\n**Prod:**");
      lines.push(...prodLines);
    }
  }
  if (lines.length === 0) return;

  const envSection = `## Environment\n\n${lines.join("\n")}`;
  const existing = readFileSync(agentsMdPath, "utf-8");

  // Insert before ## Workflow or append before last section
  if (existing.includes("## Workflow")) {
    const updated = existing.replace("## Workflow", `${envSection}\n\n## Workflow`);
    writeFileSync(agentsMdPath, updated);
  } else {
    writeFileSync(agentsMdPath, existing + "\n\n" + envSection + "\n");
  }
  actions.push("UPDATED: AGENTS.md environment section from rungate.json");
}

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

  // AGENTS.md is fully harness-owned — user rules go in CLAUDE.md

  const identity = readmeDesc || pkgDesc || `${typeLabel} project. <!-- TODO: Describe what this project is -->`;

  // Detect tech stack from package.json
  const techStack: string[] = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      // Detect runtime
      if (pkg.scripts?.test?.includes("bun") || pkg.scripts?.dev?.includes("bun") || pkg.scripts?.start?.includes("bun")) {
        techStack.push("Bun");
      } else if (pkg.scripts?.test?.includes("node") || pkg.scripts?.dev?.includes("node")) {
        techStack.push("Node.js");
      }
      // Detect TypeScript
      if (existsSync(join(projectPath, "tsconfig.json")) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("TypeScript");
      }
      // Detect module system
      if (pkg.type === "module") {
        techStack.push("ESM");
      }
    } catch {}
  }
  const techLine = techStack.length > 0 ? `\n**Tech:** ${techStack.join(", ")}` : "";

  // Detect git remote for repo URL
  let repoUrl = "";
  try {
    const result = Bun.spawnSync(["git", "-C", projectPath, "remote", "get-url", "origin"]);
    repoUrl = result.stdout.toString().trim().replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
  } catch {}

  // Scan key files
  const keyFiles: Array<{ file: string; what: string; when: string }> = [
    { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
    { file: "PROJECT-STATE.md", what: "Live status + handoff (generated from project-state.json — don't edit directly)", when: "Session start, always first after AGENTS.md" },
    { file: "project-state.json", what: "Source of truth for project status", when: "When editing state" },
  ];
  const keyFilePatterns: Array<{ pattern: string; what: string; when: string }> = [
    { pattern: "package.json", what: "Dependencies and scripts", when: "Adding deps or scripts" },
    { pattern: "Makefile", what: "Build/deploy commands", when: "Building or deploying" },
    { pattern: "tsconfig.json", what: "TypeScript configuration", when: "Changing TS settings" },
    { pattern: "Containerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: "Dockerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: ".claude/rungate.json", what: "Harness project config", when: "Shipping through harness" },
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
  const mergedSpecRows: string[] = [];
  if (existsSync(specsDir)) {
    const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
    for (const f of specFiles) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let governs = "";
      let testable = "TODO";
      if (fmMatch) {
        const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
        if (gMatch && gMatch[1].trim() !== "TODO" && gMatch[1].trim().length > 5) {
          governs = gMatch[1].trim().replace(/\|/g, "—").slice(0, 120);
        }
        const tMatch = fmMatch[1].match(/testable:\s*(.+)/);
        if (tMatch) testable = tMatch[1].trim();
      }
      mergedSpecRows.push(`| ${f} | ${governs} | ${testable} |`);
    }

    // Also scan specs subdirectories (e.g., specs/bootstrap/)
    const specSubDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const sub of specSubDirs) {
      const subPath = join(specsDir, sub);
      const subFiles = readdirSync(subPath).filter(f => f.endsWith(".md") && f !== "INDEX.md");
      if (subFiles.length > 0) {
        const indexPath = join(subPath, "INDEX.md");
        let groupGoverns = `${sub} (${subFiles.length} specs)`;
        if (existsSync(indexPath)) {
          const indexContent = readFileSync(indexPath, "utf-8");
          const fmMatch = indexContent.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
            if (gMatch && gMatch[1].trim().length > 5) {
              groupGoverns = gMatch[1].trim().replace(/\|/g, "—").slice(0, 120);
            }
          }
        }
        mergedSpecRows.push(`| ${sub}/ (${subFiles.length} specs) | ${groupGoverns} | yes |`);
      }
    }
  }
  // No artificial cap — 150-line AGENTS.md limit is the natural bound
  const mergedSpecsTable = mergedSpecRows.length > 0 ? mergedSpecRows.join("\n") : "| (no specs found) | | |";

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
  const refTable = refRows.join("\n");
  const refSection = refRows.length > 0
    ? `\n## Reference Files\n\nHistorical and inactive docs live in \`reference/\`.\n\n| File | What |\n|------|------|\n${refTable}\n`
    : "";

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

  // Load rungate.json for environment info
  const harness = (() => {
    const p = join(projectPath, ".claude", "rungate.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  })();

  // Scan docs/ directory for documentation routing
  const docsDir = join(projectPath, "docs");
  // SC-283: Unified category list — drives both routing table and "Where to Create"
  const categories = [
    { dir: "specs", label: "Specs — success criteria, constraints, requirements", frontmatter: "`doc-type: spec`, `testable`, `governs`", notes: "SCs auto-generate tests" },
    { dir: "docs/adr", label: "ADRs — architecture decisions", frontmatter: "`doc-type: adr`, `status`, `created`", notes: "Architecture decisions" },
    { dir: "docs/research", label: "Research — findings, evaluations, competitive analysis", frontmatter: "`doc-type: research`, `governs`", notes: "Tool evaluations, competitive analysis, findings" },
    { dir: "docs/council", label: "Council — synthesis, design debates", frontmatter: "`doc-type: council`", notes: "Council synthesis, design debates" },
    { dir: "docs/guides", label: "Guides — setup, onboarding, reference", frontmatter: "`doc-type: guide`", notes: "Setup, onboarding, reference" },
    { dir: "reference", label: "Reference — historical and inactive docs", frontmatter: "—", notes: "Historical reference" },
  ];

  // SC-271: Intent-based descriptions for root-level docs
  const rootDocIntents: Record<string, string> = {
    "ARCHITECTURE.md": "System architecture and design principles",
    "PRINCIPLES.md": "Core engineering principles and standards",
    "CONTRIBUTING.md": "How to contribute — workflow, conventions, review process",
    "MODEL.md": "Domain model and data relationships",
    "PROJECT-STATE.md": "Current project state, priorities, and session history",
  };

  const docRouting: Array<{ need: string; file: string }> = [];
  if (existsSync(join(projectPath, "CODE-MAP.md"))) {
    docRouting.push({ need: "Codebase structure (routes, components, modules, health)", file: "CODE-MAP.md" });
  }
  // SC-271: Root-level docs with intent descriptions
  for (const [f, intent] of Object.entries(rootDocIntents)) {
    if (existsSync(join(projectPath, f))) {
      docRouting.push({ need: intent, file: f });
    }
  }
  // SC-284: Permanent categories always present
  for (const cat of categories) {
    const catPath = join(projectPath, cat.dir);
    if (existsSync(catPath)) {
      const files = readdirSync(catPath).filter(f => f.endsWith(".md"));
      docRouting.push({ need: `${cat.label} (${files.length} files)`, file: `${cat.dir}/` });
    } else {
      docRouting.push({ need: cat.label, file: `${cat.dir}/` });
      // SC-285: WARN when category has no directory
      actions.push(`WARN: ${cat.dir}/ listed in routing but directory does not exist`);
    }
  }
  // SC-271: docs/ top-level files with intent from governs or descriptive name
  if (existsSync(docsDir)) {
    const allDocs = readdirSync(docsDir).filter(f => f.endsWith(".md"));
    for (const f of allDocs) {
      const docPath = join(docsDir, f);
      const content = readFileSync(docPath, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let need = f.replace(/\.md$/, "").replace(/-/g, " ");
      if (fmMatch) {
        const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
        if (gMatch && gMatch[1].trim() !== "TODO") need = gMatch[1].trim();
      }
      docRouting.push({ need, file: `docs/${f}` });
    }
    const subDirs = readdirSync(docsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !categories.some(c => c.dir === `docs/${d.name}`))
      .map(d => d.name);
    for (const sub of subDirs) {
      const subPath = join(docsDir, sub);
      const subFiles = readdirSync(subPath).filter(f => f.endsWith(".md"));
      if (subFiles.length > 0) {
        docRouting.push({ need: `${sub} (${subFiles.length} files)`, file: `docs/${sub}/` });
      }
    }
  }
  // SC-281: Filter routing to non-obvious mappings — exclude entries where filename matches intent
  const filteredRouting = docRouting.filter(d => {
    const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "").toLowerCase().replace(/-/g, " ");
    const needLower = d.need.toLowerCase();
    return !needLower.startsWith(slug) || d.need.includes("—") || d.need.includes("(");
  });
  const docRoutingTable = filteredRouting.length > 0
    ? filteredRouting.map(d => `| ${d.need} | \`${d.file}\` |`).join("\n")
    : "| (no docs found) | |";

  // SC-283: Generate "Where to Create" table from same category list
  const createRows = categories.map(c => `| ${c.label.split(" — ")[0]} | \`${c.dir}/\` | ${c.frontmatter} | ${c.notes} |`);
  createRows.push(`| Source code | \`src/\` | — | Follow existing module structure |`);
  createRows.push(`| Tests | \`test/\` | — | Mirror source structure |`);
  const createTable = createRows.join("\n");

  // Environment section injected post-creation by injectEnvironmentSection (SC-3)

  // Consumers from rungate.json
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

${identity}${techLine}
${repoLine}

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (\`${testCmd}\`) and show real output — no summaries, no skipped files
- Read docs before writing code — routing table shows where
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work

## Key Files

| File | What | When to Read |
|------|------|--------------|
${keyFilesTable}
${codeMapRef}

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
${docRoutingTable}

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
${createTable}

## Specs

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
${mergedSpecsTable}

## Tests

\`\`\`bash
${testCmd}
\`\`\`

| Category | File | What |
|----------|------|------|
${testsTable}

## Commands

| Action | Command |
|--------|---------|
| Install | \`bun install\` |
| Test | \`${testCmd}\` |
| Type check | \`bunx tsc --noEmit\` |
| Conformity | \`bun test test/scaffold-conformity.test.ts\` |
| Sync spec tests | \`bunx rungate sync-tests .\` |
| Create spec | \`bunx rungate create-spec "title"\` |
| Create ADR | \`bunx rungate create-adr "title"\` |
| Extract constraints | \`bunx rungate extract-constraints .\` |
| Check findings | \`cat .rungate/conformity-findings.json\` — structured findings with fix commands |
| Re-scaffold | \`bun ~/Projects/rungate/scripts/scaffold-project.ts .\` |

${consumerSection}

## Workflow
${repoLine}${makeTargets}
- **Test:** \`${testCmd}\`
- **Conformity:** Imported from rungate. \`bun update rungate && bun test\` to sync.

## Harness-Managed Files

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| \`.github/workflows/ci.yml\` | Set \`ci\` fields in \`.claude/rungate.json\` | Don't edit the YAML |
| \`.github/workflows/gates.yml\` | Settings from \`.claude/rungate.json\` | Don't edit the YAML |
| \`.claude/agents/*.md\` | Settings from \`.claude/rungate.json\` | Don't edit briefs |
| \`test/scaffold-conformity.test.ts\` | Runs automatically | Don't edit |
| \`CODE-MAP.md\` | Auto-generated from code scan | Don't edit |
${refSection}`;
}


function generateConformityTest(): string {
  return `import { resolve } from "path";
import { afterAll } from "bun:test";
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runPackageValidation, runTsconfigValidation, writeFindingsReport } from "rungate/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
runSpecDrift(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT, { warnOnly: true });
runAgentFileValidation(ROOT);
runPackageValidation(ROOT);
runTsconfigValidation(ROOT);

afterAll(() => {
  writeFindingsReport(ROOT);
});
`;
}

// SC-278: Detect spec files over 500 lines and WARN
function detectOversizedSpecs(specsDir: string): void {
  if (!existsSync(specsDir)) return;
  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: specsDir, absolute: false })) {
    const content = readFileSync(join(specsDir, file), "utf-8");
    const lineCount = content.split("\n").length;
    if (lineCount > 500) {
      actions.push(`WARN: specs/${file} is ${lineCount} lines (>500) — consider splitting with \`bun scripts/split-spec.ts specs/${file}\``);
    }
  }
}

// SC-279: Check that spec content aligns with its governs field
function checkGovernsAlignment(specsDir: string): void {
  if (!existsSync(specsDir)) return;
  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const content = readFileSync(join(specsDir, file), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
    if (!gMatch || gMatch[1].trim().startsWith("TODO")) continue;
    const governs = gMatch[1].trim().toLowerCase();
    // Check if the file has multiple unrelated H2 sections that don't match governs
    const h2s = content.match(/^## .+/gm) || [];
    if (h2s.length > 8) {
      actions.push(`WARN: specs/${file} has ${h2s.length} sections — may cover more than its governs ("${gMatch[1].trim().slice(0, 60)}"). Consider splitting.`);
    }
  }
}

function addFrontmatterToSpecs(specsDir: string): void {
  if (!existsSync(specsDir)) return;

  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(specsDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: spec\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\ngoverns: TODO — describe what this spec governs\ntestable: false\n---\n\n`;
      writeFileSync(filePath, frontmatter + content);
      actions.push(`UPDATED: specs/${file} (added frontmatter)`);
    } else {
      // Validate existing frontmatter has required fields
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("testable:")) missing.push(`testable: false`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);
      if (!fm.includes("governs:")) missing.push(`governs: TODO`);
      if (missing.length > 0) {
        const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
        writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
        actions.push(`UPDATED: specs/${file} (added missing frontmatter fields: ${missing.map(m => m.split(":")[0]).join(", ")})`);
      }
      // SC-269: WARN for specs with missing or TODO governs
      const governsMatch = fm.match(/governs:\s*(.+)/);
      if (!governsMatch || governsMatch[1].trim() === "TODO" || governsMatch[1].trim().startsWith("TODO")) {
        actions.push(`WARN: specs/${file} has no governs: field (or governs: TODO) — add a one-line description of what this spec governs`);
      }
    }
  }
}

function addFrontmatterToAdrs(adrDir: string): void {
  if (!existsSync(adrDir)) return;

  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(adrDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: adr\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\n---\n\n`;
      writeFileSync(filePath, frontmatter + content);
      actions.push(`UPDATED: docs/adr/${file} (added frontmatter)`);
    } else {
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("doc-type:")) missing.push(`doc-type: adr`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);
      if (missing.length > 0) {
        const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
        writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
        actions.push(`UPDATED: docs/adr/${file} (added missing: ${missing.map(m => m.split(":")[0]).join(", ")})`);
      }
    }
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

  // Self-scaffolding: prompts are at prompts/, not ${promptPrefix}/
  const pkgPath = join(root, "package.json");
  const isSelf = existsSync(pkgPath) && JSON.parse(readFileSync(pkgPath, "utf-8")).name === "rungate";
  const promptPrefix = isSelf ? "prompts" : "node_modules/rungate/prompts";

  const harness = loadHarnessConfig(root);
  const devUi = harness?.dev?.uiBase || null;
  const devApi = harness?.dev?.apiBase || null;
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

  // Read project prompts/*.md for content separation (SC-161)
  const promptsDir = join(root, "prompts");
  const agentKeywords: Record<string, string[]> = {
    marcus: ["coding", "code", "standard", "implementation", "engineering", "convention", "principle"],
    quinn: ["testing", "test", "qa", "quality", "coverage"],
    rook: ["security", "auth", "secret", "vulnerability", "access"],
    serena: ["architecture", "design-pattern", "system", "module", "structure"],
    aditi: ["design", "ui", "ux", "component", "visual", "accessibility"],
    discovery: ["discovery", "ac-format", "evidence", "scope", "sizing"],
  };
  const promptsByAgent: Record<string, Array<{ file: string; when: string }>> = {
    marcus: [], quinn: [], rook: [], serena: [], aditi: [], discovery: []
  };
  if (existsSync(promptsDir)) {
    const promptFiles = readdirSync(promptsDir).filter(f => f.endsWith(".md"));
    for (const f of promptFiles) {
      const content = readFileSync(join(promptsDir, f), "utf-8");
      const lower = f.toLowerCase();

      // Extract "when to read" from first heading or frontmatter description
      let whenToRead = f.replace(/\.md$/, "").replace(/-/g, " ");
      const headingMatch = content.match(/^#\s+(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        whenToRead = descMatch[1].trim();
      } else if (headingMatch) {
        whenToRead = headingMatch[1].trim();
      }

      let matched = false;
      for (const [agent, keywords] of Object.entries(agentKeywords)) {
        if (keywords.some(kw => lower.includes(kw))) {
          promptsByAgent[agent].push({ file: `prompts/${f}`, when: whenToRead });
          matched = true;
        }
      }
      if (!matched) {
        for (const agent of Object.keys(promptsByAgent)) {
          promptsByAgent[agent].push({ file: `prompts/${f}`, when: whenToRead });
        }
      }
    }
  }

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

${identitySection}## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run \`bun test\` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting

## Ask First
- Modifying files outside the brief's listed files
- Adding new dependencies
- Changing public interfaces

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run \`pwd\` or \`ls -la\` for orientation — worktree CWD is always the project root

## Methodology
- Read \`${promptPrefix}/quinn-decision-tree.md\` for journey decision tree and UI testing methodology

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, documentation routing
2. **CODE-MAP.md § Page → Component Map** — which components are on each page (your test targets)
3. **CODE-MAP.md § API Routes** — endpoint inventory for API-level checks
4. **${promptPrefix}/quinn-ui-brief.md** — structured UI testing methodology

## Environment

${devUi ? `- **Dev UI:** ${devUi}` : "- **Dev UI:** not configured — check .claude/rungate.json"}
${devApi ? `- **Dev API:** ${devApi}` : "- **Dev API:** not configured — check .claude/rungate.json"}
- **Viewport:** 1280x720 (set via browser_resize FIRST)

${pagesTable}

## Pre-conditions (GATE — stop if any fail)

1. Set viewport: browser_resize(1280, 720)
2. Navigate to target URL
3. browser_snapshot() — verify page loaded (no error banners, data present)
If pre-conditions fail → report FAIL immediately, do NOT proceed.

## Tools

- browser_snapshot() for ALL assertions (text, fast, cheap)
- browser_take_screenshot() ONLY for evidence after assertions pass
- Never guess URLs — read .claude/rungate.json pages map

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
model: sonnet
---

You are Marcus Webb, principal engineer. You implement code changes, write tests, and commit.

${identitySection}## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run \`bun test\` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting

## Ask First
- Modifying files outside the brief's listed files
- Adding new dependencies
- Changing public interfaces

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run \`pwd\` or \`ls -la\` for orientation — worktree CWD is always the project root

## Methodology
- Read \`${promptPrefix}/coding-principles.md\` for coding standards
- Read \`${promptPrefix}/testing-strategy.md\` for testing approach

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, documentation routing
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
- Dev server: \`make dev-all\`${devApi ? ` starts API (${devApi})` : ""}${devUi ? ` and UI (${devUi})` : ""}
`;

  const rookBrief = `---
name: rook
description: Security engineer — scans changed files for vulnerabilities
tools: [Bash, Read]
model: sonnet
---

You are Rook Blackburn, security engineer. You scan changed files for vulnerabilities.

${identitySection}## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run \`bun test\` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting

## Ask First
- Modifying files outside the brief's listed files
- Adding new dependencies
- Changing public interfaces

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run \`pwd\` or \`ls -la\` for orientation — worktree CWD is always the project root

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, security baseline routing
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
model: sonnet
---

You are Serena Blackwood, software architect. You make structural decisions and write ADRs.

${identitySection}## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run \`bun test\` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting

## Ask First
- Modifying files outside the brief's listed files
- Adding new dependencies
- Changing public interfaces

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run \`pwd\` or \`ls -la\` for orientation — worktree CWD is always the project root

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, documentation routing
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

${identitySection}## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run \`bun test\` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools

## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting

## Ask First
- Modifying files outside the brief's listed files
- Adding new dependencies
- Changing public interfaces

## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
- Run \`pwd\` or \`ls -la\` for orientation — worktree CWD is always the project root

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, documentation routing
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

  // Load shared rules partial for template variable substitution
  const harnessTemplatesDir = join(__dirname, "..", "templates", "agent-briefs");
  const sharedRulesPath = join(harnessTemplatesDir, "_shared.md");
  let sharedRules = existsSync(sharedRulesPath) ? readFileSync(sharedRulesPath, "utf-8").trim() : "";
  // Strip frontmatter from partials (hooks may auto-add it)
  sharedRules = sharedRules.replace(/^---[\s\S]*?---\n*/, "");

  // Agent metadata for frontmatter generation (hooks may overwrite template frontmatter)
  const agentMeta: Record<string, { description: string; tools: string; model: string }> = {
    discovery: { description: "Discovery agent — reads issue, sizes work, writes ACs with evidence methods", tools: "[Bash, Read]", model: "sonnet" },
    marcus: { description: "Principal engineer — implements code changes with TDD, writes tests, commits", tools: "[Bash, Read, Write, Edit]", model: "sonnet" },
    quinn: { description: "QA engineer — tests as a brand-new user using Playwright MCP tools", tools: "[Bash, Read, mcp__playwright__*]", model: "sonnet" },
    rook: { description: "Security reviewer — scans for vulnerabilities, credentials, injection", tools: "[Bash, Read]", model: "sonnet" },
    serena: { description: "Architect — system design, module boundaries, dependency analysis", tools: "[Bash, Read]", model: "sonnet" },
    aditi: { description: "UX/UI designer — component specs, visual review, accessibility", tools: "[Bash, Read]", model: "sonnet" },
  };

  // Load template-based briefs from templates/agent-briefs/
  function loadBriefTemplate(name: string): string | null {
    const templatePath = join(harnessTemplatesDir, name);
    if (!existsSync(templatePath)) return null;
    let content = readFileSync(templatePath, "utf-8");
    // Strip any hook-injected frontmatter
    content = content.replace(/^---[\s\S]*?---\n*/, "");
    // Apply variable substitution
    content = content.replace(/\$\{PROJECT_IDENTITY\}/g, identitySection);
    content = content.replace(/\$\{SHARED_RULES\}/g, sharedRules);
    content = content.replace(/\$\{SOURCE_DIRS\}/g, dirList);
    content = content.replace(/\$\{CONSUMERS\}/g, consumerNote);
    // Prepend correct agent frontmatter
    const agentName = name.replace(".md", "");
    const meta = agentMeta[agentName];
    if (meta) {
      content = `---\nname: ${agentName}\ndescription: ${meta.description}\ntools: ${meta.tools}\nmodel: ${meta.model}\n---\n\n${content}`;
    }
    return content;
  }

  // Build brief list: template file wins over hardcoded, hardcoded is fallback
  const hardcodedBriefs: Record<string, string> = {
    "quinn.md": quinnBrief,
    "marcus.md": marcusBrief,
    "rook.md": rookBrief,
    "serena.md": serenaBrief,
    "aditi.md": aditiBrief,
  };

  // Discover all template files (includes any new agents added via templates/)
  const templateFiles = existsSync(harnessTemplatesDir)
    ? readdirSync(harnessTemplatesDir).filter(f => f.endsWith(".md") && !f.startsWith("_"))
    : [];
  const allBriefNames = new Set([...Object.keys(hardcodedBriefs), ...templateFiles]);

  // Agent briefs always regenerate — they're harness-owned templates, not user-customized
  for (const name of allBriefNames) {
    const agentName = name.replace(".md", "");
    const briefContent = loadBriefTemplate(name) || hardcodedBriefs[name] || null;
    if (!briefContent) continue;
    const prompts = promptsByAgent[agentName] || [];
    const promptSection = prompts.length > 0
      ? `\n## Reference (read when needed)\n\n| Prompt | When to Read |\n|--------|-------------|\n` +
        prompts.map(p => `| ${p.file} | ${p.when} |`).join("\n") + "\n"
      : "";
    const p = join(agentsDir, name);
    writeFileSync(p, briefContent + promptSection);
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
  const harnessPath = join(root, ".claude", "rungate.json");

  // Scan pages from route files (App.tsx, routes.ts, etc.) in src/
  const scannedPages: Record<string, string> = {};
  const routeFiles = ["src/App.tsx", "src/routes.tsx", "src/index.tsx", "src/app.tsx"]
    .map(f => join(root, f))
    .filter(f => existsSync(f));
  for (const routeFile of routeFiles) {
    const content = readFileSync(routeFile, "utf-8");
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

  // Scan port from Makefile
  const makefile = join(root, "Makefile");
  const detectedPort = (() => {
    if (existsSync(makefile)) {
      const content = readFileSync(makefile, "utf-8");
      const portMatch = content.match(/(?:--port\s+|PORT=|-p\s+|:)(\d{4,5})/);
      if (portMatch) return parseInt(portMatch[1]);
    }
    const envExample = join(root, ".env.example");
    if (existsSync(envExample)) {
      const content = readFileSync(envExample, "utf-8");
      const portMatch = content.match(/^PORT=(\d{4,5})/m);
      if (portMatch) return parseInt(portMatch[1]);
    }
    return null;
  })();

  // Scan envVars from .env.example
  const envVars = (() => {
    const envPath = join(root, ".env.example");
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, "utf-8");
    return content.split("\n")
      .filter(line => line.trim() && !line.startsWith("#"))
      .map(line => line.split("=")[0].trim())
      .filter(Boolean);
  })();

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
        content.includes("app.get(") || content.includes("app.post(") ||
        content.includes("router.") || content.includes("export default");
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
      issues.push(`PAGES: ${missingPages.length} routes in code not in rungate.json: ${missingPages.slice(0, 5).join(", ")}`);
    }

    if (issues.length > 0) {
      console.log("\n  rungate.json audit:");
      for (const issue of issues) console.log(`    ⚠ ${issue}`);
      actions.push(`AUDITED: rungate.json (${issues.length} gaps)`);
    } else {
      actions.push("AUDITED: rungate.json (aligned with code)");
    }
  } else {
    // Read harness version from own package.json
    let harnessVersion = "unknown";
    try {
      const harnessPkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
      harnessVersion = harnessPkg.version || "unknown";
    } catch {}

    // Generate new rungate.json
    const config = {
      "$schema": "rungate",
      harnessVersion,
      scaffoldedAt: new Date().toISOString(),
      project: basename(root),
      repo,
      issueRepo: repo,
      dev: {
        start: existsSync(makefile) ? "make dev-all" : "bun run dev",
        apiBase: detectedPort ? `http://localhost:${detectedPort}` : null,
        uiBase: null as string | null,
        testCmd,
        typeCheck: typeCheckCmd,
      },
      prod: {
        rebuild: existsSync(makefile) ? "make rebuild" : undefined,
        apiBase: null as string | null,
      },
      pages: scannedPages,
      consumers: [...new Set(scannedConsumers)].sort(),
      envVars: envVars || [],
      ci: {
        runner: "ubuntu-latest",
        bunVersion: "latest",
        branches: ["main"],
      },
      contextDocs: {},
    };

    const dir = join(root, ".claude");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const targetPath = join(root, ".claude", "rungate.json");
    writeFileSync(targetPath, JSON.stringify(config, null, 2) + "\n");
    actions.push(`CREATED: .claude/rungate.json (${Object.keys(scannedPages).length} pages, ${scannedConsumers.length} consumers)`);
  }
}

function loadHarnessConfig(root: string): any {
  const p = join(root, ".claude", "rungate.json");
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

  // Run generate-code-map.ts if available, otherwise generate inline
  const scriptPath = join(__dirname, "generate-code-map.ts");
  if (existsSync(scriptPath)) {
    const result = Bun.spawnSync(["bun", scriptPath, root], { timeout: 60_000 });
    if (result.exitCode === 0) {
      actions.push(existsSync(codeMapPath) ? "UPDATED: CODE-MAP.md" : "CREATED: CODE-MAP.md");
    } else {
      actions.push("WARN: CODE-MAP.md generation failed via script — trying inline");
      generateCodeMapInline(root, codeMapPath);
    }
  } else {
    generateCodeMapInline(root, codeMapPath);
  }
}

function generateCodeMapInline(root: string, outPath: string): void {
  const today = new Date().toISOString().split("T")[0];
  const name = basename(root);
  const skip = new Set(["node_modules", ".git", "reference", "dist", "build", ".next", ".fallow"]);
  const dirs: Array<{ name: string; fileCount: number; types: string[] }> = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".") && entry !== ".claude") continue;
    if (skip.has(entry)) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      const files = readdirSync(full, { recursive: true }).map(String);
      const exts = new Set(files.map(f => f.split(".").pop()).filter(Boolean));
      dirs.push({ name: entry, fileCount: files.length, types: [...exts].slice(0, 5) });
    } catch {}
  }
  dirs.sort((a, b) => b.fileCount - a.fileCount);

  let deps = 0, devDeps = 0;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      deps = Object.keys(pkg.dependencies || {}).length;
      devDeps = Object.keys(pkg.devDependencies || {}).length;
    } catch {}
  }

  const srcDir = join(root, "src");
  const modules: Array<{ file: string; exports: string[] }> = [];
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const exports: string[] = [];
      const exportPattern = /export\s+(?:function|const|class|type|interface)\s+(\w+)/g;
      let m;
      while ((m = exportPattern.exec(content)) !== null) exports.push(m[1]);
      if (exports.length > 0) modules.push({ file: `src/${f}`, exports });
    }
  }

  // Detect API routes
  const routes: Array<{ method: string; path: string; file: string }> = [];
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const routePatterns = [
        /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
        /router\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
        /["'`]((?:GET|POST|PUT|DELETE|PATCH)\s+\/[^"'`]+)["'`]/g,
      ];
      for (const pattern of routePatterns) {
        let rm;
        while ((rm = pattern.exec(content)) !== null) {
          if (rm[2]) routes.push({ method: rm[1].toUpperCase(), path: rm[2], file: `src/${f}` });
          else if (rm[1]) {
            const parts = rm[1].split(/\s+/);
            if (parts.length === 2) routes.push({ method: parts[0], path: parts[1], file: `src/${f}` });
          }
        }
      }
    }
  }

  let md = `---\ndoc-type: code-map\nstatus: generated\nupdated: ${today}\ngenerator: scaffold-project.ts\n---\n\n# Code Map — ${name}\n\nAuto-generated architecture snapshot.\n\n## Summary\n\n| Metric | Count |\n|--------|-------|\n| Source directories | ${dirs.length} |\n| Dependencies | ${deps} |\n| Dev dependencies | ${devDeps} |\n\n## Directory Structure\n\n| Directory | Files | Types |\n|-----------|-------|-------|\n${dirs.map(d => `| ${d.name}/ | ${d.fileCount} | ${d.types.join(", ")} |`).join("\n")}\n`;
  if (routes.length > 0) {
    md += `\n## API Routes\n\n| Method | Path | File |\n|--------|------|------|\n`;
    for (const r of routes) md += `| ${r.method} | ${r.path} | ${r.file} |\n`;
  }
  if (modules.length > 0) {
    md += `\n## Source Modules\n\n| File | Exports |\n|------|---------|\n`;
    for (const mod of modules) md += `| ${mod.file} | ${mod.exports.join(", ")} |\n`;
  }
  md += "\n";
  writeFileSync(outPath, md);
  actions.push("CREATED: CODE-MAP.md (inline)");
}

function copySpecTemplateIfEmpty(specsDir: string): void {
  if (!existsSync(specsDir)) return;
  const specs = readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
  // Always copy/update the template
  const templatePath = join(__dirname, "..", "specs", "SPEC-TEMPLATE.md");
  if (!existsSync(templatePath)) {
    actions.push("SKIP: spec template (SPEC-TEMPLATE.md not found in harness)");
    return;
  }

  const template = readFileSync(templatePath, "utf-8");
  writeFileSync(join(specsDir, "SPEC-TEMPLATE.md"), template);
  actions.push("CREATED: specs/SPEC-TEMPLATE.md (starter template)");
}

function createGitignore(root: string): void {
  const gitignorePath = join(root, ".gitignore");
  const securityTemplate = `# Dependencies
node_modules/
.bun/

# Build output
dist/
build/
*.tsbuildinfo

# Environment and secrets
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
credentials.json
service-account*
.secret*

# Harness working directory
.rungate/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Test artifacts
coverage/
`;

  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    const required = [
      "node_modules", "dist", ".env", ".rungate",
      "*.pem", "*.key", "credentials.json", "service-account",
    ];
    const missing = required.filter(entry => !existing.includes(entry));
    if (missing.length > 0) {
      const additions = "\n# Added by rungate scaffold\n" +
        missing.map(e => {
          if (e === ".env") return ".env\n.env.*\n!.env.example";
          return e.includes("*") ? e : `${e}/`;
        }).join("\n") + "\n";
      writeFileSync(gitignorePath, existing.trimEnd() + "\n" + additions);
      actions.push(`UPDATED: .gitignore (added ${missing.length} missing entries)`);
    } else {
      actions.push("SKIP: .gitignore (all required entries present)");
    }
  } else {
    writeFileSync(gitignorePath, securityTemplate);
    actions.push("CREATED: .gitignore (security template)");
  }
}

function createClaudeMdBridge(root: string): void {
  const claudeMdPath = join(root, "CLAUDE.md");
  const bridgeLine = "@AGENTS.md";

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    if (!existing.includes(bridgeLine)) {
      writeFileSync(claudeMdPath, existing.trimEnd() + "\n\n" + bridgeLine + "\n");
      actions.push("UPDATED: CLAUDE.md (added @AGENTS.md bridge)");
    } else {
      actions.push("SKIP: CLAUDE.md (@AGENTS.md bridge already present)");
    }
  } else {
    const content = `# Project Rules

${bridgeLine}
`;
    writeFileSync(claudeMdPath, content);
    actions.push("CREATED: CLAUDE.md (with @AGENTS.md bridge)");
  }
}

function createCiWorkflows(root: string): void {
  const workflowsDir = join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  const harness = loadHarnessConfig(root);
  const bunVersion = harness?.ci?.bunVersion || "latest";
  const runner = harness?.ci?.runner || "ubuntu-latest";
  const branches = harness?.ci?.branches || ["main"];
  const branchList = branches.map((b: string) => `      - ${b}`).join("\n");

  const ciYml = `# Managed by rungate — do not edit. Customize via .claude/rungate.json ci section.
name: CI

on:
  push:
    branches:
${branchList}
  pull_request:
    branches:
${branchList}

jobs:
  test:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"
      - run: bun install
      - run: bun test
      - run: bunx tsc --noEmit
`;

  const gatesYml = `# Managed by rungate — do not edit. Customize via .claude/rungate.json ci section.
name: Gates

on:
  push:
    branches:
${branchList}
  pull_request:
    branches:
${branchList}

jobs:
  gates:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"
      - run: bun install
      - name: Conformity + spec drift
        run: bun test test/scaffold-conformity.test.ts
      - name: Secret scan
        run: |
          if git diff --cached --name-only | xargs grep -l -E '(AKIA|sk-|ghp_|password\s*=)' 2>/dev/null; then
            echo "::error::Potential secrets detected in staged files"
            exit 1
          fi
`;

  // CI and gates workflows are harness-owned — always regenerated
  writeFileSync(join(workflowsDir, "ci.yml"), ciYml);
  actions.push("CREATED: .github/workflows/ci.yml (harness-owned)");

  writeFileSync(join(workflowsDir, "gates.yml"), gatesYml);
  actions.push("CREATED: .github/workflows/gates.yml (harness-owned)");
}

function createGitHooks(root: string): void {
  const hooksDir = join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return;

  const { chmodSync } = require("fs");

  const preCommit = join(hooksDir, "pre-commit");
  if (!existsSync(preCommit)) {
    writeFileSync(preCommit, `#!/bin/sh
# Managed by rungate — secret scan on staged files
if git diff --cached --name-only | xargs grep -l -E '(AKIA[A-Z0-9]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|password\\s*=\\s*["\\''][^\\"\\'']+["\\''])' 2>/dev/null; then
  echo "ERROR: Potential secrets detected in staged files"
  exit 1
fi
`);
    chmodSync(preCommit, 0o755);
    actions.push("CREATED: .git/hooks/pre-commit (secret scan)");
  }

  const prePush = join(hooksDir, "pre-push");
  if (!existsSync(prePush)) {
    writeFileSync(prePush, `#!/bin/sh
# Managed by rungate — conformity check before push
bun test test/scaffold-conformity.test.ts 2>/dev/null
if [ $? -ne 0 ]; then
  echo "ERROR: Conformity tests failed — fix before pushing"
  exit 1
fi
`);
    chmodSync(prePush, 0o755);
    actions.push("CREATED: .git/hooks/pre-push (conformity check)");
  }
}

function postScaffoldCommit(root: string): void {
  try {
    const result = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"]);
    const status = result.stdout.toString().trim();
    if (!status) {
      actions.push("SKIP: post-scaffold commit (no changes)");
      return;
    }

    Bun.spawnSync(["git", "-C", root, "add", "-A"]);
    Bun.spawnSync(["git", "-C", root, "commit", "-m", "scaffold: initialize rungate harness"]);
    actions.push("CREATED: post-scaffold commit");
  } catch {
    actions.push("SKIP: post-scaffold commit (git error)");
  }
}
