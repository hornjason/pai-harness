/**
 * scaffold/steps.ts — All scaffold step functions extracted from scaffold-project.ts.
 *
 * Each function takes a project root path and an actions array for reporting.
 * Pure side-effect functions: read from disk, write to disk, push to actions.
 *
 * Extracted per SCAFFOLD-DECOMPOSITION-SPEC to keep scaffold-project.ts
 * as orchestrator-only (under 200 lines).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { auditSpecs } from "../../scripts/audit-specs";
import { generateAgentsMd as buildAgentsMdContent, generateScopedRules } from "../generators/agents-md";
import { generateAgentBriefs as buildAgentBriefsContent } from "../generators/agent-briefs";
import { generateCodeMap as buildCodeMapContent } from "../generators/code-map";
import { buildAgentMeta, DEFAULT_AGENT_META } from "../create-brief";
import { buildDefaultRoles, buildDefaultHooks } from "./defaults";
import { tryLoadRungateConfig } from "../config-loader";
import { planManagedWrite } from "./managed-workflow";
import type { ProjectScan, ProjectType, SpecEntry, TestFile, RefFile, DocRoute, Category } from "../generators/types";
import { tier1Ere } from "../secret-patterns";

// ── Helpers ────────────────────────────────────────────────────

export function safeWrite(filePath: string, content: string, label: string, actions: string[]): void {
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

export function safeDir(dirPath: string, label: string, actions: string[]): void {
  if (existsSync(dirPath)) {
    actions.push(`SKIP: ${label}/ (already exists)`);
    return;
  }
  mkdirSync(dirPath, { recursive: true });
  actions.push(`CREATED: ${label}/`);
}

function loadHarnessConfig(root: string): any {
  const dirConfig = join(root, ".claude", "rungate", "config.json");
  if (existsSync(dirConfig)) {
    try {
      const config = JSON.parse(readFileSync(dirConfig, "utf-8"));
      // The split moved roles out of config.json into roles.json. Callers
      // (buildAgentMeta) still read `.roles` off one object, so re-attach it
      // here — otherwise every project on the directory layout silently falls
      // back to DEFAULT_AGENT_META and its role config is ignored.
      const rolesPath = join(root, ".claude", "rungate", "roles.json");
      if (existsSync(rolesPath)) {
        try {
          const roles = JSON.parse(readFileSync(rolesPath, "utf-8"));
          if (roles && typeof roles === "object" && !Array.isArray(roles)) {
            config.roles = { ...(config.roles || {}), ...roles };
          }
        } catch {}
      }
      return config;
    } catch {}
  }
  const p = join(root, ".claude", "rungate.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ── AGENTS.md generation and updates ───────────────────────────

export function updateSpecsTable(agentsMdPath: string, actions: string[]): void {
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

export function injectEnvironmentSection(root: string, actions: string[]): void {
  const agentsMdPath = join(root, "AGENTS.md");
  if (!existsSync(agentsMdPath)) return;

  let harness: any;
  const dirConfig = join(root, ".claude", "rungate", "config.json");
  const harnessPath = join(root, ".claude", "rungate.json");
  if (existsSync(dirConfig)) {
    try { harness = JSON.parse(readFileSync(dirConfig, "utf-8")); } catch { return; }
  } else if (existsSync(harnessPath)) {
    try { harness = JSON.parse(readFileSync(harnessPath, "utf-8")); } catch { return; }
  } else {
    return;
  }

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

export function generateAgentsMdContent(projectPath: string, type: ProjectType, actions: string[]): string {
  const pkgPath = join(projectPath, "package.json");
  let pkgDesc = "";
  let pkgName = basename(projectPath);
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgDesc = pkg.description || "";
      pkgName = pkg.name || pkgName;
    } catch {}
  }

  // Read README.md first paragraph for identity
  let readmeDesc = "";
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    try {
      let readme = readFileSync(readmePath, "utf-8");
      while (readme.startsWith("---\n")) {
        const endFm = readme.indexOf("\n---\n", 4);
        if (endFm > 0) { readme = readme.slice(endFm + 5); } else { break; }
      }
      readme = readme.replace(/<!--[\s\S]*?-->/g, "");
      const paragraphs = readme.split(/\n\n+/).filter(p =>
        !p.startsWith("#") && !p.startsWith("---") && !p.startsWith("<") &&
        !/^[\s]*$/.test(p) && p.trim().length > 20
      );
      if (paragraphs.length > 0) readmeDesc = paragraphs[0].replace(/\n/g, " ").trim();
    } catch {}
  }

  const typeLabel = type === "code" ? "Code" : type === "content" ? "Content" : "Infrastructure";
  const identity = readmeDesc || pkgDesc || `${typeLabel} project. <!-- TODO: Describe what this project is -->`;

  // Detect tech stack
  const techStack: string[] = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test?.includes("bun") || pkg.scripts?.dev?.includes("bun") || pkg.scripts?.start?.includes("bun")) {
        techStack.push("Bun");
      } else if (pkg.scripts?.test?.includes("node") || pkg.scripts?.dev?.includes("node")) {
        techStack.push("Node.js");
      }
      if (existsSync(join(projectPath, "tsconfig.json")) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("TypeScript");
      }
      if (pkg.type === "module") {
        techStack.push("ESM");
      }
    } catch {}
  }

  // Detect git remote
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
  const conditionalPatterns: Array<{ pattern: string; what: string; when: string }> = [
    { pattern: "package.json", what: "Dependencies and scripts", when: "Adding deps or scripts" },
    { pattern: "Makefile", what: "Build/deploy commands", when: "Building or deploying" },
    { pattern: "tsconfig.json", what: "TypeScript configuration", when: "Changing TS settings" },
    { pattern: "Containerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: "Dockerfile", what: "Container build definition", when: "Modifying container" },
  ];
  // Include rungate config reference — check directory first, fall back to monolith
  if (existsSync(join(projectPath, ".claude", "rungate", "config.json"))) {
    keyFiles.push({ file: ".claude/rungate/", what: "Harness project config (directory)", when: "Shipping through harness" });
  } else {
    keyFiles.push({ file: ".claude/rungate.json", what: "Harness project config", when: "Shipping through harness" });
  }
  for (const kf of conditionalPatterns) {
    if (existsSync(join(projectPath, kf.pattern))) {
      keyFiles.push({ file: kf.pattern, what: kf.what, when: kf.when });
    }
  }
  for (const srcDir of ["src", "lib", "gates", "workflows", "hooks"]) {
    if (existsSync(join(projectPath, srcDir))) {
      keyFiles.push({ file: `${srcDir}/`, what: `${srcDir.charAt(0).toUpperCase() + srcDir.slice(1)} directory`, when: `Working on ${srcDir}` });
    }
  }

  // Scan specs
  const specsDir = join(projectPath, "specs");
  const specEntries: SpecEntry[] = [];
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
      specEntries.push({ file: f, governs, testable });
    }

    // Also scan specs subdirectories
    try {
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
          specEntries.push({ file: `${sub}/ (${subFiles.length} specs)`, governs: groupGoverns, testable: "yes" });
        }
      }
    } catch {}
  }

  // Scan tests
  const testDir = existsSync(join(projectPath, "test")) ? "test" : existsSync(join(projectPath, "tests")) ? "tests" : null;
  const testEntries: TestFile[] = [];
  if (testDir) {
    for (const f of readdirSync(join(projectPath, testDir)).filter(f => f.endsWith(".test.ts"))) {
      const label = f.replace(".test.ts", "").replace(/-/g, " ");
      testEntries.push({ label, file: f });
    }
  }

  // Detect test command
  let testCmd = "bun test";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) testCmd = pkg.scripts.test;
    } catch {}
  }

  // Scan reference files
  const refDir = join(projectPath, "reference");
  const refEntries: RefFile[] = [];
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
      refEntries.push({ file: f, what: "Historical reference" });
    }
  }

  // Detect workflow info
  let makeTargets = "";
  if (existsSync(join(projectPath, "Makefile"))) {
    try {
      const makefile = readFileSync(join(projectPath, "Makefile"), "utf-8");
      const targets = makefile.match(/^[\w-]+(?=:)/gm)?.filter(t => !t.startsWith(".") && !t.startsWith("_")).slice(0, 8);
      if (targets?.length) makeTargets = `\n- **Key commands:** \`make ${targets.join("`, `make ")}\``;
    } catch {}
  }

  // Load harness config
  const harness = loadHarnessConfig(projectPath);

  // Scan docs/ for routing
  const docsDir = join(projectPath, "docs");
  const categories = [
    { dir: "specs", label: "Specs — success criteria, constraints, requirements", frontmatter: "`doc-type: spec`, `testable`, `governs`", notes: "SCs auto-generate tests" },
    { dir: "docs/adr", label: "ADRs — architecture decisions", frontmatter: "`doc-type: adr`, `status`, `created`", notes: "Architecture decisions" },
    { dir: "docs/research", label: "Research — findings, evaluations, competitive analysis", frontmatter: "`doc-type: research`, `governs`", notes: "Tool evaluations, competitive analysis, findings" },
    { dir: "docs/council", label: "Council — synthesis, design debates", frontmatter: "`doc-type: council`", notes: "Council synthesis, design debates" },
    { dir: "docs/guides", label: "Guides — setup, onboarding, reference", frontmatter: "`doc-type: guide`", notes: "Setup, onboarding, reference" },
    { dir: "reference", label: "Reference — historical and inactive docs", frontmatter: "—", notes: "Historical reference" },
  ];

  const rootDocIntents: Record<string, string> = {
    "ARCHITECTURE.md": "System architecture and design principles",
    "PRINCIPLES.md": "Core engineering principles and standards",
    "CONTRIBUTING.md": "How to contribute — workflow, conventions, review process",
    "MODEL.md": "Domain model and data relationships",
    "PROJECT-STATE.md": "Current project state, priorities, and session history",
  };

  const docRouting: Array<{ need: string; file: string }> = [];
  // Always include scaffold-generated files for idempotency (SC-364)
  docRouting.push({ need: "Codebase structure (routes, components, modules, health)", file: "CODE-MAP.md" });
  docRouting.push({ need: "Current project state, priorities, and session history", file: "PROJECT-STATE.md" });
  // Conditionally include other root docs
  for (const [f, intent] of Object.entries(rootDocIntents)) {
    if (f !== "PROJECT-STATE.md" && existsSync(join(projectPath, f))) {
      docRouting.push({ need: intent, file: f });
    }
  }
  for (const cat of categories) {
    const catPath = join(projectPath, cat.dir);
    if (existsSync(catPath)) {
      // Recursive — see the same fix in scanner.ts. This is a second copy of
      // scanDocRouting and it is the one the scaffold actually calls, so the
      // scanner fix alone changed no generated output at all (#91).
      const files = readdirSync(catPath, { recursive: true }).map(String).filter(f => f.endsWith(".md"));
      docRouting.push({ need: `${cat.label} (${files.length} files)`, file: `${cat.dir}/` });
    } else {
      docRouting.push({ need: cat.label, file: `${cat.dir}/` });
      actions.push(`WARN: ${cat.dir}/ listed in routing but directory does not exist`);
    }
  }
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
  const filteredRouting = docRouting.filter(d => {
    const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "").toLowerCase().replace(/-/g, " ");
    const needLower = d.need.toLowerCase();
    return !needLower.startsWith(slug) || d.need.includes("—") || d.need.includes("(");
  });

  const consumers = harness?.consumers || [];

  const scan: ProjectScan = {
    name: pkgName,
    type,
    root: projectPath,
    identity,
    techStack,
    repoUrl,
    testCmd,
    keyFiles,
    specs: specEntries,
    testFiles: testEntries,
    refFiles: refEntries,
    docRouting: filteredRouting as DocRoute[],
    categories: categories as Category[],
    consumers,
    hasCodeMap: true, // Always true for idempotency — scaffold generates CODE-MAP.md (SC-364)
    makeTargets,
    sourceDirs: [],
    promptRouting: {},
    harnessConfig: harness,
    agentMeta: {},
    dirs: [],
    deps: 0,
    devDeps: 0,
    modules: [],
    routes: [],
    harnessTemplatesDir: "",
    promptPrefix: "",
  };

  // Write scoped rules to .claude/rules/
  const rulesDir = join(projectPath, ".claude", "rules");
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  const scopedRules = generateScopedRules(scan);
  for (const rule of scopedRules) {
    writeFileSync(join(rulesDir, rule.filename), rule.content);
    actions.push(`GENERATED: .claude/rules/${rule.filename}`);
  }

  return buildAgentsMdContent(scan);
}

/**
 * Rewrite `.claude/rules/` from a scan of the tree the run actually left (#123).
 *
 * The first pass happens in Phase 0.5, before `generateOrAuditProjectHarness`
 * creates `.claude/rungate/` and before `copySpecTemplateIfEmpty` creates
 * `specs/`. So a freshly scaffolded project shipped rules describing a tree that
 * no longer existed:
 *
 *   docs-routing.md  "Specs — ... (0 files)"   in a project with a spec
 *   key-files.md     `.claude/rungate.json`    the LEGACY monolith path, in a
 *                                              project using the directory layout
 *
 * The second one is the damaging one: it sends every agent in a new project to a
 * config file that is not there, and key-files.md is the table agents are told
 * to read first.
 *
 * Re-running the generator is safe and cheap: `generateAgentsMdContent` writes
 * only the rules, and returns AGENTS.md content for its caller to write. The
 * return value is discarded here on purpose — AGENTS.md has already been
 * through `updateSpecsTable` and `injectEnvironmentSection` by this point, and
 * rewriting it would undo both.
 */
export function refreshScopedRulesStep(root: string, type: ProjectType, actions: string[]): void {
  const sink: string[] = [];
  generateAgentsMdContent(root, type, sink);
  // Forward everything except the per-rule GENERATED lines already reported by
  // the Phase 0.5 pass. Swallowing the rest would hide a warning raised only on
  // the second scan — the fail-open shape .claude/rules/checks-must-be-able-to-fail.md
  // exists to prevent.
  for (const a of sink) {
    if (!a.startsWith("GENERATED: .claude/rules/")) actions.push(a);
  }
  actions.push(`REFRESHED: .claude/rules/ (rescanned after harness config and specs/ existed)`);
}

export function refreshAgentsMd(root: string, type: ProjectType, actions: string[]): void {
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

  // Check staleness
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

  // Check specs table
  const specsDir = join(root, "specs");
  if (existsSync(specsDir)) {
    const actualSpecs = readdirSync(specsDir).filter(f => f.endsWith(".md"));
    const unlisted = actualSpecs.filter(f => !content.includes(f));
    if (unlisted.length > 0) {
      issues.push(`UNLISTED specs: ${unlisted.join(", ")} (in specs/ but not in AGENTS.md)`);
    }
  }

  // Check CODE-MAP.md reference
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

// ── Conformity test generation ─────────────────────────────────

export function generateConformityTest(): string {
  return `import { resolve } from "path";
import { afterAll } from "bun:test";
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runPackageValidation, runTsconfigValidation, writeFindingsReport } from "rungate/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
const findings: any[] = [];

runScaffoldConformity(ROOT, findings);
runSpecDiscovery(ROOT, findings);
runSpecDrift(ROOT, findings);
runDocHygiene(ROOT, findings);
runFallowCheck(ROOT, findings);
runAgentFileValidation(ROOT, findings);
runPackageValidation(ROOT, findings);
runTsconfigValidation(ROOT, findings);

afterAll(() => writeFindingsReport(ROOT, findings));
`;
}

// ── Agent briefs generation ────────────────────────────────────

export function generateAgentBriefsStep(root: string, actions: string[]): void {
  const agentsDir = join(root, ".claude", "agents");
  safeDir(agentsDir, ".claude/agents", actions);

  const pkgPath = join(root, "package.json");
  const isSelf = existsSync(pkgPath) && JSON.parse(readFileSync(pkgPath, "utf-8")).name === "rungate";
  const promptPrefix = isSelf ? "prompts" : "node_modules/rungate/prompts";

  const harness = loadHarnessConfig(root);

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

  // Prompt routing
  const promptsDir = join(root, "prompts");
  const defaultKeywords: Record<string, string[]> = {
    marcus: ["coding", "code", "standard", "implementation", "engineering", "convention", "principle"],
    quinn: ["testing", "test", "qa", "quality", "coverage"],
    rook: ["security", "auth", "secret", "vulnerability", "access"],
    serena: ["architecture", "design-pattern", "system", "module", "structure"],
    aditi: ["design", "ui", "ux", "component", "visual", "accessibility"],
    discovery: ["discovery", "ac-format", "evidence", "scope", "sizing"],
  };
  const agentKeywords: Record<string, string[]> = { ...defaultKeywords, ...harness?.promptKeywords };
  const promptsByAgent: Record<string, Array<{ file: string; when: string }>> = {
    marcus: [], quinn: [], rook: [], serena: [], aditi: [], discovery: []
  };
  if (existsSync(promptsDir)) {
    const promptFiles = readdirSync(promptsDir).filter(f => f.endsWith(".md"));
    for (const f of promptFiles) {
      const content = readFileSync(join(promptsDir, f), "utf-8");
      const lower = f.toLowerCase();

      let whenToRead = f.replace(/\.md$/, "").replace(/-/g, " ");
      const headingMatch = content.match(/^#\s+(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        whenToRead = descMatch[1].trim();
      } else if (headingMatch) {
        whenToRead = headingMatch[1].trim();
      }

      const stem = lower.replace(/\.md$/, "");
      const segments = stem.split(/[-_]/);
      for (const [agent, keywords] of Object.entries(agentKeywords)) {
        const matches = stem === agent || keywords.some(kw =>
          kw.includes("-") ? stem.includes(kw) : segments.includes(kw)
        );
        if (matches) {
          promptsByAgent[agent].push({ file: `prompts/${f}`, when: whenToRead });
        }
      }
    }
  }

  const srcDirs = ["src", "dashboard/src", "lib", "gates", "hooks"].filter(d => existsSync(join(root, d)));
  const consumers = harness?.consumers || [];

  // Resolve templates directory relative to this module
  const harnessTemplatesDir = join(dirname(dirname(__dirname)), "templates", "agent-briefs");

  // buildAgentMeta takes the whole harness config and reads .roles itself.
  // Passing harness?.roles made it look for roles.roles, so every consumer's
  // role config was silently dropped and DEFAULT_AGENT_META always won.
  const configMeta = buildAgentMeta(harness ?? null);
  const agentMeta: Record<string, any> = {};
  for (const name of Object.keys({ ...DEFAULT_AGENT_META, ...configMeta })) {
    agentMeta[name] = { ...DEFAULT_AGENT_META[name], ...configMeta[name] };
  }

  // Detect project type for accurate briefs
  let detectedType: ProjectType = "code";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name === "rungate" || pkg.keywords?.includes("harness")) detectedType = "infra";
    } catch {}
  } else if (!existsSync(join(root, "src")) && !existsSync(join(root, "lib"))) {
    detectedType = "infra";
  }

  const briefScan: ProjectScan = {
    name: basename(root),
    type: detectedType,
    root,
    identity: projectIdentity,
    techStack: [],
    repoUrl: "",
    testCmd: harness?.dev?.testCmd || "bun test",
    keyFiles: [],
    specs: [],
    testFiles: [],
    refFiles: [],
    docRouting: [],
    categories: [],
    consumers,
    hasCodeMap: false,
    makeTargets: "",
    sourceDirs: srcDirs,
    promptRouting: promptsByAgent,
    harnessConfig: harness,
    agentMeta,
    dirs: [],
    deps: 0,
    devDeps: 0,
    modules: [],
    routes: [],
    harnessTemplatesDir,
    promptPrefix,
  };

  const briefs = buildAgentBriefsContent(briefScan);

  for (const [agentName, content] of Object.entries(briefs)) {
    const p = join(agentsDir, `${agentName}.md`);
    writeFileSync(p, content);
    actions.push(existsSync(p) ? `UPDATED: .claude/agents/${agentName}.md` : `CREATED: .claude/agents/${agentName}.md`);
  }
}

// ── Harness config generation/audit ────────────────────────────

export function generateOrAuditProjectHarness(root: string, actions: string[]): void {
  const harnessPath = join(root, ".claude", "rungate.json");

  // Scan pages from route files
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

  // Scan pages from dashboard/src/pages/*.tsx (file-based routing)
  const dashboardPagesDir = join(root, "dashboard", "src", "pages");
  if (existsSync(dashboardPagesDir)) {
    const pageFiles = readdirSync(dashboardPagesDir).filter(f => f.endsWith(".tsx") || f.endsWith(".jsx"));
    for (const f of pageFiles) {
      const componentName = f.replace(/\.(tsx|jsx)$/, "");
      // Convert CamelCase to kebab-case route path
      const routePath = "/" + componentName
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
      scannedPages[routePath] = componentName;
    }
  }

  // Scan test commands
  const pkgPath = join(root, "package.json");
  let testCmd = "bun test";
  let typeCheckCmd = "bunx tsc --noEmit";
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.test) testCmd = pkg.scripts.test;
    if (pkg.scripts?.typecheck) typeCheckCmd = pkg.scripts.typecheck;
  }

  // Scan port from Makefile, docker-compose.yml, or .env.example
  const makefile = join(root, "Makefile");
  const detectedPort = (() => {
    if (existsSync(makefile)) {
      const content = readFileSync(makefile, "utf-8");
      const portMatch = content.match(/(?:--port\s+|PORT=|-p\s+|:)(\d{4,5})/);
      if (portMatch) return parseInt(portMatch[1]);
    }
    // Scan docker-compose.yml for port mappings
    const dockerComposePaths = ["docker-compose.yml", "docker-compose.yaml"]
      .map(f => join(root, f));
    for (const dcPath of dockerComposePaths) {
      if (existsSync(dcPath)) {
        const content = readFileSync(dcPath, "utf-8");
        // Match port mappings like "3001:3001" or "- 8080:8080"
        const portMatch = content.match(/["']?(\d{4,5}):\d{4,5}["']?/);
        if (portMatch) return parseInt(portMatch[1]);
      }
    }
    const envExample = join(root, ".env.example");
    if (existsSync(envExample)) {
      const content = readFileSync(envExample, "utf-8");
      const portMatch = content.match(/^PORT=(\d{4,5})/m);
      if (portMatch) return parseInt(portMatch[1]);
    }
    return null;
  })();

  // Scan envVars
  const envVars = (() => {
    const envPath = join(root, ".env.example");
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, "utf-8");
    return content.split("\n")
      .filter(line => line.trim() && !line.startsWith("#"))
      .map(line => line.split("=")[0].trim())
      .filter(Boolean);
  })();

  // Detect git remote
  let repo = "";
  try {
    const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { timeout: 5_000 });
    repo = result.stdout.toString().trim()
      .replace(/\.git$/, "")
      .replace("git@github.com:", "")
      .replace("https://github.com/", "");
  } catch {}

  // Scan consumers
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

  const rungateDir = join(root, ".claude", "rungate");
  const hasDirectory = existsSync(join(rungateDir, "config.json"));

  if (hasDirectory) {
    // Directory structure already exists — audit it
    const existing = JSON.parse(readFileSync(join(rungateDir, "config.json"), "utf-8"));
    auditExistingConfig(existing, scannedPages, scannedConsumers, actions);
  } else if (existsSync(harnessPath)) {
    // Monolith exists — split into directory structure
    const existing = JSON.parse(readFileSync(harnessPath, "utf-8"));

    // Check if monolith has roles/hooks/compliance to split
    if (existing.roles || existing.hooks || existing.compliance) {
      splitMonolithToDirectory(root, existing, actions);
    } else {
      // Simple monolith without split-worthy content — audit only
      auditExistingConfig(existing, scannedPages, scannedConsumers, actions);
    }
  } else {
    // No config exists — create directory structure
    let harnessVersion = "unknown";
    try {
      const harnessPkg = JSON.parse(readFileSync(join(dirname(dirname(__dirname)), "package.json"), "utf-8"));
      harnessVersion = harnessPkg.version || "unknown";
    } catch {}

    // Prefer package.json name, fall back to directory basename
    let projectName = basename(root);
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name) projectName = pkg.name;
      } catch {}
    }

    const config = {
      "$schema": "rungate",
      harnessVersion,
      scaffoldedAt: new Date().toISOString(),
      project: projectName,
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
      test: {
        command: testCmd,
        timeout: 300000,
      },
    };

    // Greenfield gets the DEFAULT roles and hooks, not `{}` and `[]`. An empty
    // roles.json reads as a configured project with nothing to dispatch (#70).
    // The split path below is deliberately NOT routed through these defaults.
    const roles = buildDefaultRoles();
    const hooks = buildDefaultHooks();
    writeDirectoryStructure(root, config, roles, hooks, undefined, actions);
    actions.push(
      `CREATED: .claude/rungate/ (${Object.keys(scannedPages).length} pages, ${scannedConsumers.length} consumers, ` +
      `${Object.keys(roles).length} roles, ${hooks.length} hooks)`
    );
  }
}

function auditExistingConfig(
  existing: any,
  scannedPages: Record<string, string>,
  scannedConsumers: string[],
  actions: string[]
): void {
  const issues: string[] = [];

  const declaredPages = Object.keys(existing.pages || {});
  const scannedPaths = Object.keys(scannedPages);
  const missingPages = scannedPaths.filter(p => !declaredPages.some(d => existing.pages[d] === p || d === p));
  if (missingPages.length > 0) {
    issues.push(`PAGES: ${missingPages.length} routes in code not in rungate.json: ${missingPages.slice(0, 5).join(", ")}`);
  }

  // Audit consumers: flag declared consumers not found in source code as stale
  const declaredConsumers = existing.consumers || [];
  if (declaredConsumers.length > 0) {
    const staleConsumers = declaredConsumers.filter((c: string) => !scannedConsumers.includes(c));
    if (staleConsumers.length > 0) {
      issues.push(`CONSUMERS: ${staleConsumers.length} stale consumers in rungate.json not found in source: ${staleConsumers.slice(0, 5).join(", ")}`);
      actions.push(`AUDIT: CONSUMERS — ${staleConsumers.length} stale consumers not in source: ${staleConsumers.slice(0, 5).join(", ")}`);
    }
  }

  if (issues.length > 0) {
    console.log("\n  rungate.json audit:");
    for (const issue of issues) console.log(`    ⚠ ${issue}`);
    actions.push(`AUDITED: rungate.json (${issues.length} gaps)`);
  } else {
    actions.push("AUDITED: rungate.json (aligned with code)");
  }
}

function splitMonolithToDirectory(
  root: string,
  monolith: any,
  actions: string[]
): void {
  // Extract split-worthy fields
  const { roles, hooks, compliance, ...configFields } = monolith;

  writeDirectoryStructure(
    root,
    configFields,
    roles || {},
    hooks || [],
    compliance,
    actions
  );
  actions.push(`SPLIT: .claude/rungate.json → .claude/rungate/ (config.json, roles.json, hooks.json, compliance.json)`);
}

function writeDirectoryStructure(
  root: string,
  config: any,
  roles: any,
  hooks: any[],
  compliance: any | undefined,
  actions: string[]
): void {
  const rungateDir = join(root, ".claude", "rungate");
  if (!existsSync(rungateDir)) mkdirSync(rungateDir, { recursive: true });

  writeFileSync(join(rungateDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(rungateDir, "roles.json"), JSON.stringify(roles, null, 2) + "\n");
  writeFileSync(join(rungateDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");

  const defaultCompliance = compliance || {
    rules: {},
    defaults: { consecutiveFailThreshold: 3, tierPromotionThreshold: 5 },
    organize: { fileTypes: [".md"], artifactClassification: {}, externalSources: [] },
  };
  writeFileSync(join(rungateDir, "compliance.json"), JSON.stringify(defaultCompliance, null, 2) + "\n");
}

// ── Code map generation ────────────────────────────────────────

/**
 * Generate CODE-MAP.md. Must run LAST in the scaffold (#123).
 *
 * This used to be invoked in Phase 1, before `generateAgentBriefsStep` wrote
 * `.claude/agents/`, before `copySpecTemplateIfEmpty` wrote `specs/`, and
 * before `addPaiHarnessDevDep` added a devDependency — so a fresh project's
 * CODE-MAP.md described a tree that stopped existing moments later in the same
 * run, reporting `specs/ 0 files` and no agents directory in a project with
 * both.
 *
 * The lag was permanent rather than one-run-behind, because of the staleness
 * skip below: while the file is under 14 days old it is not regenerated at all,
 * so no later scaffold ever corrected it. Running this step last is what makes
 * that skip safe — the content it preserves is now right from run 1.
 */
export function generateCodeMapStep(root: string, actions: string[], opts?: { fix?: boolean; dryRun?: boolean }): void {
  const fixMode = opts?.fix ?? !opts?.dryRun;
  const codeMapPath = join(root, "CODE-MAP.md");

  // In dry-run/non-fix mode, only report gaps
  if (!fixMode) {
    if (!existsSync(codeMapPath)) {
      actions.push("GAP: CODE-MAP.md missing — run with --fix to generate");
    }
    return;
  }

  // Check staleness
  if (existsSync(codeMapPath)) {
    const content = readFileSync(codeMapPath, "utf-8");
    const updatedMatch = content.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
    if (updatedMatch) {
      const lastScan = new Date(updatedMatch[1]);
      const daysSince = (Date.now() - lastScan.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 14) {
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

  // Run generate-code-map.ts if available
  const scriptPath = join(dirname(dirname(__dirname)), "scripts", "generate-code-map.ts");
  if (existsSync(scriptPath)) {
    const result = Bun.spawnSync(["bun", scriptPath, root], { timeout: 60_000 });
    if (result.exitCode === 0) {
      actions.push(existsSync(codeMapPath) ? "UPDATED: CODE-MAP.md" : "CREATED: CODE-MAP.md");
    } else {
      actions.push("WARN: CODE-MAP.md generation failed via script — trying inline");
      generateCodeMapInline(root, codeMapPath, actions);
    }
  } else {
    generateCodeMapInline(root, codeMapPath, actions);
  }
}

function generateCodeMapInline(root: string, outPath: string, actions: string[]): void {
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
      const exts = new Set(files.map(f => f.split(".").pop()).filter((e): e is string => Boolean(e)));
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

  const mapScan: ProjectScan = {
    name,
    type: "code",
    root,
    identity: "",
    techStack: [],
    repoUrl: "",
    testCmd: "",
    keyFiles: [],
    specs: [],
    testFiles: [],
    refFiles: [],
    docRouting: [],
    categories: [],
    consumers: [],
    hasCodeMap: false,
    makeTargets: "",
    sourceDirs: [],
    promptRouting: {},
    harnessConfig: null,
    agentMeta: {},
    dirs,
    deps,
    devDeps,
    modules,
    routes,
    harnessTemplatesDir: "",
    promptPrefix: "",
  };

  const md = buildCodeMapContent(mapScan);
  writeFileSync(outPath, md);
  actions.push("CREATED: CODE-MAP.md (inline)");
}

// ── Misc scaffold steps ────────────────────────────────────────

export function copySpecTemplateIfEmpty(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;

  // Skip if specs/ already has .md files (besides SPEC-TEMPLATE.md itself)
  const existingSpecs = readdirSync(specsDir).filter(
    f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md"
  );
  if (existingSpecs.length > 0) {
    actions.push("SKIP: spec template (specs/ already has .md files)");
    return;
  }

  const templatePath = join(dirname(dirname(__dirname)), "specs", "SPEC-TEMPLATE.md");
  if (!existsSync(templatePath)) {
    actions.push("SKIP: spec template (SPEC-TEMPLATE.md not found in harness)");
    return;
  }

  const template = readFileSync(templatePath, "utf-8");
  writeFileSync(join(specsDir, "SPEC-TEMPLATE.md"), template);
  actions.push("CREATED: specs/SPEC-TEMPLATE.md (starter template)");
}

// ── tsconfig.json ──────────────────────────────────────────────

/**
 * Trees a generated tsconfig type-checks. Same list as the scanner's source
 * directories, plus `scripts/` — a consumer keeps real TypeScript there and
 * nothing else would check it.
 *
 * `test/` is deliberately absent. The conformity test rungate generates into
 * every consumer imports `bun:test` and `rungate/lib/conformity`, and neither
 * resolves for tsc without `@types/bun` and an installed `rungate` — so
 * including the test tree would hand a freshly scaffolded project a type check
 * that reports 4 errors it did not cause and cannot fix. That is the #65/#76
 * defect again in the other direction: a documented command whose result says
 * nothing about the project's code.
 */
const TS_SOURCE_DIRS = ["src", "lib", "scripts", "gates", "hooks", "workflows"] as const;

/** True when `dir` holds at least one hand-written .ts/.tsx file. */
function containsTypeScript(dir: string): boolean {
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Write a tsconfig.json for a TypeScript consumer that has none (#72, #65/#76).
 *
 * AGENTS.md has documented `bunx tsc --noEmit` as THE type check for every
 * scaffolded project since the scaffold existed, and `.github/workflows/ci.yml`
 * ran it — over a file rungate never created. With no tsconfig.json tsc prints
 * 147 lines of help text and exits 1, so the documented check had never checked
 * anything anywhere. `lib/generators/agents-md.ts` and `createCiWorkflows` were
 * taught to stop ADVERTISING the command without a tsconfig; this creates the
 * file so the command can be advertised again and mean something.
 *
 * Must run before AGENTS.md is generated and before createCiWorkflows: both
 * decide whether to emit the type check by looking for this file on disk.
 *
 * Never overwrites. A consumer's compiler settings are the consumer's, and
 * re-scaffold is routine.
 */
export function createTsconfig(root: string, actions: string[]): void {
  const tsconfigPath = join(root, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    actions.push("SKIP: tsconfig.json (already exists)");
    return;
  }

  // The include list and the "is this a TypeScript project" test are the same
  // question, answered once. Deriving them separately is how you get a
  // tsconfig whose include matches no files — tsc error TS18003, which reads
  // as a broken type check rather than as "nothing to check".
  const include = TS_SOURCE_DIRS
    .filter(dir => containsTypeScript(join(root, dir)))
    .map(dir => `${dir}/**/*.ts`);

  if (include.length === 0) {
    actions.push(`SKIP: tsconfig.json (no TypeScript source in ${TS_SOURCE_DIRS.join("/, ")}/)`);
    return;
  }

  const tsconfig = {
    "//": "Created by rungate. Edit freely — re-scaffold never overwrites an existing tsconfig.json.",
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
    include,
    exclude: ["node_modules"],
  };

  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
  actions.push("CREATED: tsconfig.json");
}

export function createGitignore(root: string, actions: string[]): void {
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

export function generateProjectState(root: string, actions: string[]): void {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) {
    actions.push("SKIP: PROJECT-STATE.md (no specs directory)");
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  interface SC { id: string; what: string; done: boolean; }
  const scs: SC[] = [];

  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: specsDir, absolute: true })) {
    if (file.endsWith("SPEC-TEMPLATE.md")) continue;
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const doneMatch = line.match(/^- \[x\] (SC-\d+):\s*(.+)/i);
      if (doneMatch) {
        scs.push({ id: doneMatch[1].toUpperCase(), what: doneMatch[2].trim(), done: true });
        continue;
      }
      const openMatch = line.match(/^- \[ \] (SC-\d+):\s*(.+)/i);
      if (openMatch) {
        scs.push({ id: openMatch[1].toUpperCase(), what: openMatch[2].trim(), done: false });
      }
    }
  }

  if (scs.length === 0) {
    actions.push("SKIP: PROJECT-STATE.md (no SCs found in specs)");
    return;
  }

  scs.sort((a, b) => {
    const aNum = parseInt(a.id.replace("SC-", ""));
    const bNum = parseInt(b.id.replace("SC-", ""));
    return aNum - bNum;
  });

  const state = {
    updated: today,
    priorities: ["Review and update priorities in project-state.json"],
    notes: `${scs.length} SCs discovered from specs. Organize into phases as project evolves.`,
    phases: [{ name: "Initial Implementation", scs }],
    sessions: []
  };

  const openCount = scs.filter(sc => !sc.done).length;
  const currentLabel = openCount > 0
    ? `Initial Implementation — ${openCount} SCs open`
    : "All SCs complete";

  const lines: string[] = [];
  lines.push("# Project State");
  lines.push("");
  lines.push(`**Current phase: ${currentLabel}**`);
  lines.push("");
  lines.push(state.notes);
  lines.push("");

  if (state.priorities.length > 0) {
    lines.push("**Next priorities:**");
    state.priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  lines.push(`## ${openCount === 0 ? "✅" : openCount < scs.length ? "🔄" : "⬜"} Initial Implementation (${openCount === 0 ? "COMPLETE" : openCount < scs.length ? "IN PROGRESS" : "NOT STARTED"})`);
  lines.push("");
  if (scs.length > 0) {
    lines.push("| Status | SC | What |");
    lines.push("|---|---|---|");
    for (const sc of scs) {
      lines.push(`| ${sc.done ? "✅" : "⬜"} | ${sc.id} | ${sc.what} |`);
    }
    lines.push("");
  }

  const stateJson = join(root, "project-state.json");
  const stateMd = join(root, "PROJECT-STATE.md");

  safeWrite(stateJson, JSON.stringify(state, null, 2) + "\n", "project-state.json", actions);
  safeWrite(stateMd, lines.join("\n") + "\n", "PROJECT-STATE.md", actions);
}

export function createClaudeMdBridge(root: string, actions: string[]): void {
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
    const content = `# Project Rules\n\n${bridgeLine}\n`;
    writeFileSync(claudeMdPath, content);
    actions.push("CREATED: CLAUDE.md (with @AGENTS.md bridge)");
  }
}

/**
 * The placeholder spec a `workflow` project is seeded with. Lived inline in
 * scripts/scaffold-project.ts; moved here so the orchestrator stays an
 * orchestrator (SCAFFOLD-DECOMPOSITION-SPEC D-3, SC-363).
 */
export function createWorkflowDefinitionSpec(root: string, actions: string[]): void {
  const workflowDef = `---
doc-type: spec
testable: no
governs: workflow-definition
---

# Workflow Definition

## Trigger

When should this workflow run?

## Inputs

What inputs does this workflow require?

## Process

What steps does this workflow perform?

## Output

What does this workflow produce?
`;
  safeWrite(join(root, "specs", "WORKFLOW-DEFINITION.md"), workflowDef, "specs/WORKFLOW-DEFINITION.md", actions);
}

export interface ManagedWriteOptions {
  /** Overwrite content the harness cannot prove it authored. Opt-in only. */
  force?: boolean;
}

/**
 * The single site through which every harness-managed workflow file is
 * written (#216).
 *
 * Both halves of this function matter and both are mutated by
 * test/scaffold-ci-preservation-mutation.test.ts: the decision (what, if
 * anything, to write) comes from `planManagedWrite`, and the REPORT comes from
 * the same measurement rather than from whether the path happened to exist.
 * The old code wrote unconditionally and pushed "CREATED" unconditionally, so
 * a run that deleted a consumer's deploy job reported having created a file.
 *
 * A refusal is pushed as an action rather than thrown: the rest of the
 * scaffold is still worth running, and `scripts/scaffold-project.ts` exits
 * non-zero when any action is a refusal, so the run is still loud.
 */
export function writeManagedWorkflow(filePath: string, generated: string, label: string, actions: string[], opts: ManagedWriteOptions = {}): void {
  const before = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const plan = planManagedWrite(before, generated, { force: opts.force === true });

  if (plan.verb === "REFUSED") {
    actions.push(`REFUSED: ${label} — ${plan.refusal}`);
    return;
  }
  if (plan.verb === "SKIP") {
    actions.push(`SKIP: ${label} (unchanged)`);
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, plan.content);
  actions.push(
    plan.verb === "CREATED"
      ? `CREATED: ${label} (harness-owned)`
      : plan.verb === "REPLACED"
        ? `REPLACED: ${label} (${plan.lineDelta} lines, --force)`
        : `UPDATED: ${label} (consumer content preserved)`,
  );
}

export function createCiWorkflows(root: string, actions: string[], opts: ManagedWriteOptions = {}): void {
  const workflowsDir = join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  const harness = loadHarnessConfig(root);
  const bunVersion = harness?.ci?.bunVersion || "latest";
  const runner = harness?.ci?.runner || "ubuntu-latest";
  const branches = harness?.ci?.branches || ["main"];
  // Branch patterns are globs: a bare `*` is a YAML alias indicator and `*-dev`
  // an unresolved alias, so emitting them unquoted produces a workflow file
  // GitHub Actions refuses to parse. JSON.stringify yields a YAML-compatible
  // double-quoted scalar with the right escaping.
  const branchList = branches.map((b: string) => `      - ${JSON.stringify(String(b))}`).join("\n");
  const runsOn = JSON.stringify(String(runner));

  // The typecheck step used to be emitted unconditionally as `bunx tsc --noEmit`.
  // Without a tsconfig.json tsc prints its help text and exits 1, so every
  // scaffolded consumer that is not already a TypeScript project got a CI step
  // that could only fail, over a file rungate never created for them (#65/#76).
  // Rungate itself was shielded from noticing because `bun test` failed first
  // and the step never ran.
  //
  // Emit it only when the project actually has a tsconfig, and prefer the
  // project's own ratchet script when it has one — consumers do not get
  // rungate's scripts/, so they must fall back to plain tsc.
  const hasTsconfig = existsSync(join(root, "tsconfig.json"));
  const hasRatchet = existsSync(join(root, "scripts", "typecheck.ts"));
  const typecheckStep = !hasTsconfig
    ? ""
    : hasRatchet
      ? `\n      - run: bun scripts/typecheck.ts`
      : `\n      - run: bunx tsc --noEmit`;

  const ciYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
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
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"
      - run: bun install
      - run: bun test${typecheckStep}
`;

  const gatesYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
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
    runs-on: ${runsOn}
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
          # CI has nothing staged, so the old --cached scan examined zero files
          # on every run — a green check that verified nothing.
          # git grep handles paths with spaces natively, skips binaries with -I,
          # and surfaces real errors instead of hiding them behind 2>/dev/null,
          # so this cannot fail open the way the xargs pipeline could.
          # git grep exits 1 when nothing matches, which is the pass case.
          # Tier 1 patterns come from lib/secret-patterns.ts, the single registry
          # shared with the generated pre-commit hook. This comment used to
          # CLAIM parity while CI carried 3 patterns and the hook carried 8 —
          # CI missed gho_, ghs_, github_pat_, sk-ant- and PEM private keys
          # entirely. Asserted now in test/unit/secret-patterns.test.ts.
          if git grep -I -lE '${tier1Ere()}' -- .; then
            echo "::error::Potential secrets detected in tracked files"
            exit 1
          fi
          # Capture first so a git failure fails CLOSED. Piping git straight
          # into the filters would turn an error into empty input, which reads
          # as "clean" — passing exactly when the scan could not run.
          # git grep exits 1 for "no match", which is not an error.
          # NOTE: do NOT append "|| true" to the assignment below. It makes the
          # assignment itself succeed, so $? is always 0 and the error branch
          # becomes dead code — the scan would fail open on a git error.
          set +e
          tier2=$(git grep -I -hoE '(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+=_.-]{12,}' -- .)
          rc=$?
          set -e
          # git grep: 0 = match, 1 = no match, >1 = real error.
          if [ "$rc" -gt 1 ]; then
            echo "::error::git grep failed (exit $rc) — refusing to report a clean scan"
            exit 1
          fi
          # Exclusion applies to the extracted VALUE, not the whole line.
          # Matching anywhere on the line let a trailing "# placeholder"
          # launder a real secret past the check.
          if printf '%s\\n' "$tier2" | grep -qvE '^$|[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)'; then
            echo "::error::Potential credential assignment in tracked files"
            exit 1
          fi
          echo "Secret scan clean"
`;

  writeManagedWorkflow(join(workflowsDir, "ci.yml"), ciYml, ".github/workflows/ci.yml", actions, opts);
  writeManagedWorkflow(join(workflowsDir, "gates.yml"), gatesYml, ".github/workflows/gates.yml", actions, opts);
}

// ── Consumer hook deployment ─────────────────────────────────

/**
 * Deploy hooks marked deployToConsumers:true to consumer projects'
 * .claude/settings.local.json with correct hookFor and command paths.
 * SC-472: scaffold deploys consumer-facing hooks
 *
 * Reads through the config loader, so the hooks come from
 * `.claude/rungate/hooks.json` under the directory layout and from
 * `.claude/rungate.json` under the monolith. Reading the monolith path
 * directly — as this did — meant a project on the directory layout deployed
 * nothing and said nothing, because the early return is indistinguishable
 * from "this project has no hooks" (#70).
 */
export function deployHooksToConsumers(root: string, actions: string[]): void {
  let harness: any;
  try {
    harness = tryLoadRungateConfig(root);
  } catch (err) {
    // A config that exists but cannot be read is not a config that is absent
    // (ADR-001 D2). Say so rather than returning as if there were no hooks.
    actions.push(`SKIP: hook deployment — unreadable rungate config: ${(err as Error).message}`);
    return;
  }
  if (!harness) return;

  if (!harness?.hooks || !Array.isArray(harness.hooks)) return;
  if (!harness?.consumers || !Array.isArray(harness.consumers) || harness.consumers.length === 0) return;

  const hooksDir = join(root, "hooks");

  for (const consumer of harness.consumers) {
    const consumerRoot = consumer.startsWith("/") ? consumer : join(root, consumer);
    if (!existsSync(consumerRoot)) {
      actions.push(`SKIP: Consumer ${consumer} — directory not found`);
      continue;
    }

    const claudeDir = join(consumerRoot, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const settingsPath = join(consumerRoot, ".claude", "settings.local.json");
    let settings: any = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    }

    if (!settings.hooks) settings.hooks = {};

    let deployed = 0;
    for (const hook of harness.hooks) {
      if (!hook.enabled || !hook.hookFor || !hook.command) continue;
      if (hook.deployToConsumers !== true) continue;

      const resolvedCommand = hook.command.replace("${RUNGATE_HOOKS_DIR}", hooksDir);
      const hookType = hook.hookFor as string;

      if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

      // Check if this hook is already deployed
      const existing = settings.hooks[hookType].find(
        (h: any) => h.command === resolvedCommand || (h.command && h.command.includes(hook.name))
      );
      if (existing) continue;

      const hookEntry: any = { command: resolvedCommand };
      if (hook.matcher) hookEntry.matcher = hook.matcher;

      settings.hooks[hookType].push(hookEntry);
      deployed++;
    }

    if (deployed > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      actions.push(`DEPLOYED: ${deployed} hooks to ${consumer}/.claude/settings.local.json`);
    } else {
      actions.push(`SKIP: All hooks already deployed to ${consumer}`);
    }
  }
}

export function createGitHooks(root: string, actions: string[]): void {
  const hooksDir = join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return;

  const { chmodSync } = require("fs");

  const preCommit = join(hooksDir, "pre-commit");
  if (!existsSync(preCommit)) {
    writeFileSync(preCommit, `#!/bin/sh
# Managed by rungate — secret scan + PROJECT-STATE update
#
# Scans the staged DIFF, not files on disk. This is deliberate and fixes four
# failure modes the file-list approach had:
#   - nothing staged: the list was empty, xargs ran grep with no operands,
#     grep read stdin and exited 0, so every --amend was rejected
#   - paths with spaces: split into nonexistent fragments, grep errored,
#     2>/dev/null hid it, and the file was silently never scanned
#   - 2>/dev/null masked every real error, so the scan failed open
#   - grep read the WORKING TREE, so a secret staged and then edited out of
#     the file on disk was committed unseen
# Matching only added lines (^+) also means pre-existing matches elsewhere in
# a touched file do not block unrelated commits.
#
# Capturing the diff first makes a git failure fail CLOSED. Piping git
# straight into grep would swallow a git error as empty input, which grep
# reads as "no secrets" — the scan would pass precisely when it could not run.
staged_diff=$(git diff --cached --diff-filter=ACM -U0) || {
  echo "ERROR: could not read staged diff — refusing to commit unscanned"
  exit 1
}
# Tier 1 — anchored key formats. Unambiguous, so no exceptions.
if printf '%s\\n' "$staged_diff" | grep -qE '^\\+.*${tier1Ere()}'; then
  echo "ERROR: Potential secrets detected in staged changes"
  exit 1
fi

# Tier 2 — credential assignments. Restores the coverage the old
# password="..." pattern was meant to provide, in a form with no quote
# characters (quotes could not survive JS-template -> shell escaping).
#
# grep -o extracts just the assignment, so the exclusion below is applied to
# the VALUE and not to the whole line. Matching the exclusion anywhere on the
# line was an allowlist escape: appending "# placeholder" to a line holding a
# real secret was enough to launder it past the check.
#
# Exclusions are env lookups and explicit non-values. password =
# process.env.DB_PASSWORD is a reference, not a secret, and flagging it would
# only train people to reach for --no-verify.
if printf '%s\\n' "$staged_diff" \\
  | grep '^+' \\
  | grep -oE '(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+=_.-]{12,}' \\
  | grep -qvE '[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)'; then
  echo "ERROR: Potential credential assignment in staged changes"
  exit 1
fi

# Update PROJECT-STATE if it exists
if [ -f "project-state.json" ]; then
  bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true
  git add PROJECT-STATE.md project-state.json 2>/dev/null || true
fi

# A script's exit status is its last command's. Without this, the [ -f ] test
# failing (no project-state.json) or git add failing (no PROJECT-STATE.md yet)
# made the hook exit non-zero and reject a perfectly good commit. Everything
# that should block has already exited 1 above.
exit 0
`);
    chmodSync(preCommit, 0o755);
    actions.push("CREATED: .git/hooks/pre-commit (secret scan + PROJECT-STATE update)");
  }

  const prePush = join(hooksDir, "pre-push");
  const MANAGED_MARKER = "# Managed by rungate — conformity check before push";

  // `2>/dev/null` threw away the only output that said WHY conformity failed,
  // leaving the developer a bare "fix before pushing" and no diagnosis. And the
  // old guard was `if (!existsSync(prePush))`, so once a hook existed it was
  // never updated again — every fix to this hook, including this one, would
  // have reached nobody. Overwrite only our own managed hook; a hook a human
  // wrote is left alone.
  const existing = existsSync(prePush) ? readFileSync(prePush, "utf-8") : null;
  if (existing !== null && !existing.includes(MANAGED_MARKER)) {
    actions.push("SKIP: .git/hooks/pre-push (hand-written, not overwriting)");
    return;
  }

  // Checks the COMMITS BEING PUSHED, not the working tree (#85).
  //
  // The old hook ran the conformity suite in the working tree, which is not
  // what is being pushed. On 2026-10-05 that let a regression reach main:
  // HYGIENE-3's reference index recursed into .claude/worktrees/, 39 full repo
  // copies that exist locally and not in a clean checkout, so every file
  // looked referenced. It passed before push and Gates went red on main. A
  // gate that inspects something other than what it is gating is not a weaker
  // gate; it is a different gate wearing the name of the one you wanted.
  //
  // On node_modules, which #85 left open: symlinking the working tree's is
  // fast, and it is honest exactly while the pushed commit's lockfile matches
  // the one those modules were installed from. Installing unconditionally is
  // correct and slow enough that people disable the hook, which is worse than
  // either. So compare the lockfiles and only pay for an install when they
  // actually differ — the common push changes no dependencies and keeps the
  // fast path, and the push that does change them cannot quietly test against
  // the wrong ones.
  writeFileSync(prePush, `#!/bin/sh
${MANAGED_MARKER}
ZERO=0000000000000000000000000000000000000000
TOPLEVEL=$(git rev-parse --show-toplevel) || exit 1
status=0

while read -r _lref lsha _rref _rsha; do
  # Branch deletion: there is no commit to check out.
  [ "$lsha" = "$ZERO" ] && continue

  tmp=$(mktemp -d) || exit 1
  if ! git worktree add --detach --quiet "$tmp" "$lsha"; then
    echo "ERROR: could not check out $lsha to verify the push" >&2
    rm -rf "$tmp"
    exit 1
  fi

  # Reuse the installed modules only when the pushed commit expects the same
  # ones; otherwise install from the pushed lockfile.
  if [ -f "$TOPLEVEL/bun.lock" ] && [ -f "$tmp/bun.lock" ] && cmp -s "$TOPLEVEL/bun.lock" "$tmp/bun.lock"; then
    ln -s "$TOPLEVEL/node_modules" "$tmp/node_modules" 2>/dev/null
  else
    echo "pre-push: dependencies differ from the working tree — installing from the pushed lockfile" >&2
    ( cd "$tmp" && bun install --frozen-lockfile ) >&2 || status=1
  fi

  if [ "$status" -eq 0 ]; then
    ( cd "$tmp" && bun test test/scaffold-conformity.test.ts ) || status=1
  fi

  # Always clean up. An early exit here would leak a worktree on every failed
  # push, which is how #68 reached 39 stale worktrees and 243 MB.
  git worktree remove --force "$tmp" 2>/dev/null
  rm -rf "$tmp"

  [ "$status" -ne 0 ] && break
done

if [ "$status" -ne 0 ]; then
  echo "ERROR: Conformity tests failed against the commits being pushed — fix before pushing" >&2
  exit 1
fi
exit 0
`);
  chmodSync(prePush, 0o755);
  actions.push(existing === null
    ? "CREATED: .git/hooks/pre-push (conformity check)"
    : "UPDATED: .git/hooks/pre-push (conformity check)");
}

export function addPaiHarnessDevDep(root: string, actions: string[]): void {
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

  const harnessRelative = require("path").relative(root, dirname(dirname(__dirname)));
  pkg.devDependencies["rungate"] = `file:${harnessRelative}`;

  if (!pkg.scripts) {
    pkg.scripts = {};
  }
  if (!pkg.scripts.test) {
    pkg.scripts.test = "bun test";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  actions.push("UPDATED: package.json (rungate devDep)");
}

export function runAuditSpecsFix(root: string, actions: string[]): void {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) {
    actions.push("SKIP: audit-specs (no specs/ directory)");
    return;
  }
  const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md"));
  if (specFiles.length === 0) {
    actions.push("SKIP: audit-specs (no spec files)");
    return;
  }
  const result = auditSpecs(root, { fix: true });
  const rewriteCount = result.rewrites?.length ?? 0;
  if (rewriteCount > 0) {
    // One action per FILE, naming the file. The old single line said "rewrote
    // 2 SCs" and named no path, so postScaffoldCommit could not stage the
    // specs this step had just edited — they were left behind by every commit,
    // and the dirty-tree guard (#216) then read them as somebody else's work.
    // `specFile` is a bare filename off readdirSync(specs/); the report is
    // repo-relative, because that is what `git add` and `git status` speak.
    for (const file of [...new Set((result.rewrites ?? []).map(r => r.specFile))]) {
      actions.push(`UPDATED: ${file.includes("/") ? file : `specs/${file}`} (audit-specs --fix)`);
    }
    actions.push(`AUDITED: audit-specs --fix rewrote ${rewriteCount} SCs`);
  } else {
    actions.push("SKIP: audit-specs (all SCs already matchable)");
  }
}

export interface PostScaffoldCommitOptions {
  /** Commit the generated files. Opt-in: `scaffold-project.ts --commit`. */
  commit?: boolean;
}

/**
 * Commit the scaffold's output — but only when asked, and only into a tree
 * where nothing else is in flight (#216).
 *
 * This used to be unconditional. Running `scaffold-project.ts --fix` on a
 * consumer repo therefore wrote a commit into someone else's history as a side
 * effect of what reads like an audit, and a consumer cannot undo a commit they
 * did not know was coming. Two separate guards, because they fail differently:
 *
 *  - no `--commit`: the caller never asked, so nothing is committed at all.
 *  - dirty tree: the caller asked, but there is unrelated work in the tree.
 *    Staging only generated paths (the earlier fix) keeps that work OUT of the
 *    commit, but it still leaves a commit landing underneath someone mid-edit.
 *    Refuse and say which paths stopped it.
 */
export function postScaffoldCommit(root: string, actions: string[], opts: PostScaffoldCommitOptions = {}): void {
  try {
    if (opts.commit !== true) {
      actions.push("SKIP: post-scaffold commit (not requested — pass --commit)");
      return;
    }
    // Stage ONLY what this scaffold run generated, never `git add -A`.
    //
    // The blanket add swept up whatever else was in the working tree and
    // committed it under "scaffold: initialize rungate harness". Running
    // scaffold mid-session therefore hijacked unrelated in-progress work into
    // a commit with a message describing none of it — and, because the commit
    // already existed, the real commit then had to be an amend.
    const generated = [...new Set(
      actions
        // Verbs that mean "scaffold wrote this path". Deliberately excludes
        // SKIP / GAP / WARN / AUDIT (no write happened) — and all of them,
        // because missing one silently leaves generated files uncommitted.
        .map(a => a.trim().match(/^(?:CREATED|UPDATED|REPLACED|REGENERATED|REFRESHED|GENERATED|DEPLOYED|SPLIT): ([^\s(]+)/)?.[1])
        .filter((p): p is string => Boolean(p))
        // .git/ contents are not tracked; hooks live there.
        // .git/ contents are never tracked. Directories are kept — scaffold
        // reports some output as a created directory (.claude/rules/) rather
        // than per-file, and git add stages a directory's contents.
        .map(p => p.replace(/\/+$/, ""))
        .filter(p => p && !p.startsWith(".git/") && p !== ".git")
        .filter(p => existsSync(join(root, p)))
    )];

    if (generated.length === 0) {
      actions.push("SKIP: post-scaffold commit (nothing generated)");
      return;
    }

    // Dirty means "dirty with work this scaffold run did not produce".
    // The scaffold's own output makes the tree dirty by definition, so the
    // generated set is subtracted first — otherwise the guard would refuse on
    // every run and be removed within a week.
    //
    // -uall, not the default: porcelain collapses an untracked directory to
    // `.claude/`, which matches no generated path and would make every run
    // that created a new directory refuse itself.
    const unrelated = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "-uall"])
      .stdout.toString().split("\n")
      .map(l => l.slice(3).trim().replace(/^.* -> /, "").replace(/^"|"$/g, ""))
      .filter(Boolean)
      .filter(p => !generated.some(g => p === g || p.startsWith(`${g}/`)));
    if (unrelated.length > 0) {
      actions.push(
        `REFUSED: post-scaffold commit (dirty working tree: ${unrelated.slice(0, 5).join(", ")}` +
        `${unrelated.length > 5 ? `, +${unrelated.length - 5} more` : ""}) — commit or stash first`,
      );
      return;
    }

    Bun.spawnSync(["git", "-C", root, "add", "--", ...generated]);

    // Only commit if staging actually produced a change — re-scaffolding an
    // up-to-date project regenerates identical files and must stay a no-op.
    const staged = Bun.spawnSync(["git", "-C", root, "diff", "--cached", "--name-only"])
      .stdout.toString().trim();
    if (!staged) {
      actions.push("SKIP: post-scaffold commit (no changes)");
      return;
    }

    Bun.spawnSync(["git", "-C", root, "commit", "-m", "scaffold: regenerate harness files"]);
    actions.push("CREATED: post-scaffold commit");
  } catch {
    actions.push("SKIP: post-scaffold commit (git error)");
  }
}
