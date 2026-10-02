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
import type { ProjectScan, ProjectType, SpecEntry, TestFile, RefFile, DocRoute, Category } from "../generators/types";

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
    try { return JSON.parse(readFileSync(dirConfig, "utf-8")); } catch {}
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
      const files = readdirSync(catPath).filter(f => f.endsWith(".md"));
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

  const configMeta = buildAgentMeta(harness?.roles);
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

    writeDirectoryStructure(root, config, {}, [], undefined, actions);
    actions.push(`CREATED: .claude/rungate/ (${Object.keys(scannedPages).length} pages, ${scannedConsumers.length} consumers)`);
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

export function generateCodeMapStep(root: string, actions: string[]): void {
  const codeMapPath = join(root, "CODE-MAP.md");

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

export function createCiWorkflows(root: string, actions: string[]): void {
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
          if git diff --cached --name-only | xargs grep -l -E '(AKIA|sk-|ghp_|password\\s*=)' 2>/dev/null; then
            echo "::error::Potential secrets detected in staged files"
            exit 1
          fi
`;

  writeFileSync(join(workflowsDir, "ci.yml"), ciYml);
  actions.push("CREATED: .github/workflows/ci.yml (harness-owned)");

  writeFileSync(join(workflowsDir, "gates.yml"), gatesYml);
  actions.push("CREATED: .github/workflows/gates.yml (harness-owned)");
}

// ── Consumer hook deployment ─────────────────────────────────

/**
 * Deploy hooks marked deployToConsumers:true from rungate.json to consumer
 * projects' .claude/settings.local.json with correct hookFor and command paths.
 * SC-472: scaffold deploys consumer-facing hooks
 */
export function deployHooksToConsumers(root: string, actions: string[]): void {
  const harnessPath = join(root, ".claude", "rungate.json");
  if (!existsSync(harnessPath)) return;

  let harness: any;
  try { harness = JSON.parse(readFileSync(harnessPath, "utf-8")); } catch { return; }

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
if git diff --cached --name-only | xargs grep -l -E '(AKIA[A-Z0-9]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|password\\s*=\\s*["\\''][^\\"\\'']+["\\''])' 2>/dev/null; then
  echo "ERROR: Potential secrets detected in staged files"
  exit 1
fi

# Update PROJECT-STATE if it exists
if [ -f "project-state.json" ]; then
  bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null
  git add PROJECT-STATE.md project-state.json 2>/dev/null
fi
`);
    chmodSync(preCommit, 0o755);
    actions.push("CREATED: .git/hooks/pre-commit (secret scan + PROJECT-STATE update)");
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
  actions.push("CREATED: rungate devDep in package.json");
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
    actions.push(`CREATED: audit-specs --fix rewrote ${rewriteCount} SCs`);
  } else {
    actions.push("SKIP: audit-specs (all SCs already matchable)");
  }
}

export function postScaffoldCommit(root: string, actions: string[]): void {
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
