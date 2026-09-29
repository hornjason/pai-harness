/**
 * scanner.ts — Project scanner extracted from scaffold-project.ts (SC-358, SC-359)
 *
 * Scans a project root and returns a typed ProjectScan object containing
 * tech stack, specs, consumers, source directories, and other project metadata.
 *
 * This module imports ONLY from fs, path, and generators/types — no generation
 * logic (agents-md, agent-briefs, code-map) is imported here (SC-365, AC-3).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type {
  ProjectScan,
  ProjectType,
  KeyFile,
  SpecEntry,
  TestFile,
  RefFile,
  DocRoute,
  Category,
  DirEntry,
  ModuleEntry,
  RouteEntry,
} from "./generators/types";

// Re-export ProjectType for callers that need it
export type { ProjectType } from "./generators/types";

// ── Project type detection ─────────────────────────────────────

export function detectProjectType(root: string): ProjectType {
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

  if (hasSrc || hasLib || hasTsConfig || (hasPackageJson && (hasSrc || hasLib))) {
    return "code";
  }

  if (hasManifests || (hasScriptsDir && !hasPackageJson)) {
    return "infra";
  }

  if (hasPackageJson && hasMakefile) {
    return "code";
  }

  if (hasPackageJson) {
    return "code";
  }

  if (hasScriptsDir) {
    return "infra";
  }

  return "content";
}

// ── Tech stack detection ───────────────────────────────────────

function detectTechStack(root: string): string[] {
  const pkgPath = join(root, "package.json");
  const techStack: string[] = [];

  if (!existsSync(pkgPath)) return techStack;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    // Detect runtime
    if (pkg.scripts?.test?.includes("bun") || pkg.scripts?.dev?.includes("bun") || pkg.scripts?.start?.includes("bun")) {
      techStack.push("Bun");
    } else if (pkg.scripts?.test?.includes("node") || pkg.scripts?.dev?.includes("node") || pkg.scripts?.start?.includes("node")) {
      techStack.push("Node.js");
    }

    // Detect TypeScript
    if (existsSync(join(root, "tsconfig.json")) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      techStack.push("TypeScript");
    }

    // Detect module system
    if (pkg.type === "module") {
      techStack.push("ESM");
    }
  } catch {}

  return techStack;
}

// ── Spec scanning ──────────────────────────────────────────────

function scanSpecs(root: string): SpecEntry[] {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) return [];

  const specs: SpecEntry[] = [];
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

    specs.push({ file: f, governs, testable });
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
        specs.push({ file: `${sub}/ (${subFiles.length} specs)`, governs: groupGoverns, testable: "yes" });
      }
    }
  } catch {}

  return specs;
}

// ── Consumer detection ─────────────────────────────────────────

function detectConsumers(root: string): string[] {
  // First check rungate.json
  const harnessPath = join(root, ".claude", "rungate.json");
  if (existsSync(harnessPath)) {
    try {
      const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
      if (harness.consumers && Array.isArray(harness.consumers) && harness.consumers.length > 0) {
        return harness.consumers;
      }
    } catch {}
  }

  // Scan src/ for consumer modules
  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) return [];

  const consumers: string[] = [];
  const consumerPatterns = ["-routes.ts", "-generator.ts", "-plan.ts", "-intel.ts"];

  for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
    try {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const isConsumer = consumerPatterns.some(p => f.includes(p)) ||
        content.includes("app.get(") || content.includes("app.post(") ||
        content.includes("router.") || content.includes("export default");
      if (isConsumer) {
        consumers.push(f.replace(/\.ts$/, "").replace(/-routes|-generator/, ""));
      }
    } catch {}
  }

  return [...new Set(consumers)].sort();
}

// ── Source directory detection ──────────────────────────────────

function detectSourceDirectories(root: string): string[] {
  const candidates = ["src", "lib", "gates", "workflows", "hooks", "dashboard/src"];
  return candidates.filter(dir => existsSync(join(root, dir)));
}

// ── Key file scanning ──────────────────────────────────────────

function scanKeyFiles(root: string): KeyFile[] {
  // Always include scaffold-generated files for idempotency (SC-364)
  const keyFiles: KeyFile[] = [
    { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
    { file: "PROJECT-STATE.md", what: "Live status + handoff (generated from project-state.json — don't edit directly)", when: "Session start, always first after AGENTS.md" },
    { file: "project-state.json", what: "Source of truth for project status", when: "When editing state" },
  ];

  // Conditionally included files (only if they exist)
  const conditionalPatterns: Array<{ pattern: string; what: string; when: string }> = [
    { pattern: "package.json", what: "Dependencies and scripts", when: "Adding deps or scripts" },
    { pattern: "Makefile", what: "Build/deploy commands", when: "Building or deploying" },
    { pattern: "tsconfig.json", what: "TypeScript configuration", when: "Changing TS settings" },
    { pattern: "Containerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: "Dockerfile", what: "Container build definition", when: "Modifying container" },
  ];

  // Always include .claude/rungate.json for idempotency (scaffold generates it)
  keyFiles.push({ file: ".claude/rungate.json", what: "Harness project config", when: "Shipping through harness" });

  for (const kf of conditionalPatterns) {
    if (existsSync(join(root, kf.pattern))) {
      keyFiles.push({ file: kf.pattern, what: kf.what, when: kf.when });
    }
  }

  // Scan for main source directories
  for (const srcDir of ["src", "lib", "gates", "workflows", "hooks"]) {
    if (existsSync(join(root, srcDir))) {
      keyFiles.push({
        file: `${srcDir}/`,
        what: `${srcDir.charAt(0).toUpperCase() + srcDir.slice(1)} directory`,
        when: `Working on ${srcDir}`,
      });
    }
  }

  return keyFiles;
}

// ── Test file scanning ─────────────────────────────────────────

function scanTestFiles(root: string): TestFile[] {
  const testDir = existsSync(join(root, "test")) ? "test"
    : existsSync(join(root, "tests")) ? "tests"
    : null;

  if (!testDir) return [];

  try {
    return readdirSync(join(root, testDir))
      .filter(f => f.endsWith(".test.ts"))
      .map(f => ({
        label: f.replace(".test.ts", "").replace(/-/g, " "),
        file: f,
      }));
  } catch {
    return [];
  }
}

// ── Reference file scanning ───────────────────────────────────

function scanRefFiles(root: string): RefFile[] {
  const refDir = join(root, "reference");
  if (!existsSync(refDir)) return [];

  try {
    return readdirSync(refDir).map(f => ({
      file: f,
      what: "Historical reference",
    }));
  } catch {
    return [];
  }
}

// ── Doc routing scanning ───────────────────────────────────────

function scanDocRouting(root: string, categories: Category[]): DocRoute[] {
  const docRouting: DocRoute[] = [];

  // Always include scaffold-generated files for idempotency (SC-364)
  docRouting.push({ need: "Codebase structure (routes, components, modules, health)", file: "CODE-MAP.md" });
  docRouting.push({ need: "Current project state, priorities, and session history", file: "PROJECT-STATE.md" });

  // Root-level docs with intent descriptions (conditionally included)
  const rootDocIntents: Record<string, string> = {
    "ARCHITECTURE.md": "System architecture and design principles",
    "PRINCIPLES.md": "Core engineering principles and standards",
    "CONTRIBUTING.md": "How to contribute — workflow, conventions, review process",
    "MODEL.md": "Domain model and data relationships",
  };

  for (const [f, intent] of Object.entries(rootDocIntents)) {
    if (existsSync(join(root, f))) {
      docRouting.push({ need: intent, file: f });
    }
  }

  // Categories
  for (const cat of categories) {
    const catPath = join(root, cat.dir);
    if (existsSync(catPath)) {
      try {
        const files = readdirSync(catPath).filter(f => f.endsWith(".md"));
        docRouting.push({ need: `${cat.label} (${files.length} files)`, file: `${cat.dir}/` });
      } catch {
        docRouting.push({ need: cat.label, file: `${cat.dir}/` });
      }
    } else {
      docRouting.push({ need: cat.label, file: `${cat.dir}/` });
    }
  }

  // Docs top-level files
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    try {
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
    } catch {}
  }

  // Filter to non-obvious mappings
  return docRouting.filter(d => {
    const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "").toLowerCase().replace(/-/g, " ");
    const needLower = d.need.toLowerCase();
    return !needLower.startsWith(slug) || d.need.includes("—") || d.need.includes("(");
  });
}

// ── Identity detection ─────────────────────────────────────────

function detectIdentity(root: string, pkgDesc: string, type: ProjectType): string {
  // Read README.md first paragraph
  const readmePath = join(root, "README.md");
  if (existsSync(readmePath)) {
    try {
      let readme = readFileSync(readmePath, "utf-8");
      // Normalize CRLF to LF for consistent parsing
      readme = readme.replace(/\r\n/g, "\n");
      // Strip YAML frontmatter
      while (readme.startsWith("---\n")) {
        const endFm = readme.indexOf("\n---\n", 4);
        if (endFm > 0) { readme = readme.slice(endFm + 5); } else { break; }
      }
      readme = readme.replace(/<!--[\s\S]*?-->/g, "");
      const paragraphs = readme.split(/\n\n+/).filter(p => {
        const trimmed = p.trim();
        if (!trimmed || trimmed.length <= 20) return false;
        if (trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith("<")) return false;
        // Skip badge lines (shield.io badges, linked images)
        if (/^\[!\[.*\]\(.*\)\]\(.*\)/.test(trimmed)) return false;
        // Skip image-only paragraphs (![alt](url) lines with nothing else)
        const lines = trimmed.split("\n");
        if (lines.every(l => /^\s*!\[.*\]\(.*\)\s*$/.test(l) || /^\s*$/.test(l))) return false;
        return true;
      });
      if (paragraphs.length > 0) return paragraphs[0].replace(/\n/g, " ").trim();
    } catch {}
  }

  if (pkgDesc) return pkgDesc;

  const typeLabel = type === "code" ? "Code" : type === "content" ? "Content" : "Infrastructure";
  return `${typeLabel} project. <!-- TODO: Describe what this project is -->`;
}

// ── Repo URL detection ─────────────────────────────────────────

function detectRepoUrl(root: string): string {
  try {
    const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { timeout: 5_000 });
    return result.stdout.toString().trim()
      .replace(/\.git$/, "")
      .replace("git@github.com:", "https://github.com/");
  } catch {
    return "";
  }
}

// ── Makefile targets ───────────────────────────────────────────

function scanMakeTargets(root: string): string {
  const makefile = join(root, "Makefile");
  if (!existsSync(makefile)) return "";

  try {
    const content = readFileSync(makefile, "utf-8");
    const targets = content.match(/^[\w-]+(?=:)/gm)?.filter(t => !t.startsWith(".") && !t.startsWith("_")).slice(0, 8);
    if (targets?.length) return `\n- **Key commands:** \`make ${targets.join("`, `make ")}\``;
  } catch {}

  return "";
}

// ── Harness config loading ─────────────────────────────────────

function loadHarnessConfig(root: string): Record<string, any> | null {
  const p = join(root, ".claude", "rungate.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ── Code structure scanning (dirs, modules, routes) ────────────

function scanDirs(root: string): DirEntry[] {
  const skip = new Set(["node_modules", ".git", "reference", "dist", "build", ".next", ".fallow"]);
  const dirs: DirEntry[] = [];

  try {
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
  } catch {}

  dirs.sort((a, b) => b.fileCount - a.fileCount);
  return dirs;
}

function scanModules(root: string): ModuleEntry[] {
  const srcDir = join(root, "src");
  const modules: ModuleEntry[] = [];

  if (!existsSync(srcDir)) return modules;

  try {
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const exports: string[] = [];
      const exportPattern = /export\s+(?:function|const|class|type|interface)\s+(\w+)/g;
      let m;
      while ((m = exportPattern.exec(content)) !== null) exports.push(m[1]);
      if (exports.length > 0) modules.push({ file: `src/${f}`, exports });
    }
  } catch {}

  return modules;
}

function scanRoutes(root: string): RouteEntry[] {
  const srcDir = join(root, "src");
  const routes: RouteEntry[] = [];

  if (!existsSync(srcDir)) return routes;

  try {
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
  } catch {}

  return routes;
}

// ── Dependency counting ────────────────────────────────────────

function countDeps(root: string): { deps: number; devDeps: number } {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { deps: 0, devDeps: 0 };

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return {
      deps: Object.keys(pkg.dependencies || {}).length,
      devDeps: Object.keys(pkg.devDependencies || {}).length,
    };
  } catch {
    return { deps: 0, devDeps: 0 };
  }
}

// ── Prompt routing scanning ────────────────────────────────────

function scanPromptRouting(root: string, harness: Record<string, any> | null): Record<string, Array<{ file: string; when: string }>> {
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
    marcus: [], quinn: [], rook: [], serena: [], aditi: [], discovery: [],
  };

  const promptsDir = join(root, "prompts");
  if (!existsSync(promptsDir)) return promptsByAgent;

  try {
    const promptFiles = readdirSync(promptsDir).filter(f => f.endsWith(".md"));
    for (const f of promptFiles) {
      const content = readFileSync(join(promptsDir, f), "utf-8");
      const lower = f.toLowerCase();

      let whenToRead = f.replace(/\.md$/, "").replace(/-/g, " ");
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const headingMatch = content.match(/^#\s+(.+)$/m);
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
  } catch {}

  return promptsByAgent;
}

// ── Agent meta scanning ────────────────────────────────────────

function scanAgentMeta(harness: Record<string, any> | null): Record<string, { description: string; tools: string; model: string; tiers?: Record<string, string[]> }> {
  const agentMeta: Record<string, { description: string; tools: string; model: string; tiers?: Record<string, string[]> }> = {};

  if (!harness?.roles) return agentMeta;

  for (const [roleName, roleConfig] of Object.entries(harness.roles as Record<string, any>)) {
    if (roleConfig.description || roleConfig.tools || roleConfig.model) {
      agentMeta[roleName] = {
        description: roleConfig.description || `${roleName} agent`,
        tools: roleConfig.tools || "[Bash, Read]",
        model: roleConfig.model || "sonnet",
        ...(roleConfig.tiers ? { tiers: roleConfig.tiers } : {}),
      };
    }
  }

  return agentMeta;
}

// ── Test command detection ─────────────────────────────────────

function detectTestCmd(root: string): string {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return "bun test";

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.test) return pkg.scripts.test;
  } catch {}

  return "bun test";
}

// ── Categories ─────────────────────────────────────────────────

function buildCategories(): Category[] {
  return [
    { dir: "specs", label: "Specs — success criteria, constraints, requirements", frontmatter: "`doc-type: spec`, `testable`, `governs`", notes: "SCs auto-generate tests" },
    { dir: "docs/adr", label: "ADRs — architecture decisions", frontmatter: "`doc-type: adr`, `status`, `created`", notes: "Architecture decisions" },
    { dir: "docs/research", label: "Research — findings, evaluations, competitive analysis", frontmatter: "`doc-type: research`, `governs`", notes: "Tool evaluations, competitive analysis, findings" },
    { dir: "docs/council", label: "Council — synthesis, design debates", frontmatter: "`doc-type: council`", notes: "Council synthesis, design debates" },
    { dir: "docs/guides", label: "Guides — setup, onboarding, reference", frontmatter: "`doc-type: guide`", notes: "Setup, onboarding, reference" },
    { dir: "reference", label: "Reference — historical and inactive docs", frontmatter: "—", notes: "Historical reference" },
  ];
}

// ── Prompt prefix detection ────────────────────────────────────

function detectPromptPrefix(root: string): string {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return "node_modules/rungate/prompts";

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.name === "rungate") return "prompts";
  } catch {}

  return "node_modules/rungate/prompts";
}

// ── Main scanner ───────────────────────────────────────────────

export function scanProject(root: string): ProjectScan {
  const type = detectProjectType(root);
  const pkgPath = join(root, "package.json");
  let pkgName = basename(root);
  let pkgDesc = "";

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgName = pkg.name || pkgName;
      pkgDesc = pkg.description || "";
    } catch {}
  }

  const harness = loadHarnessConfig(root);
  const categories = buildCategories();
  const { deps, devDeps } = countDeps(root);

  const harnessTemplatesDir = (() => {
    // Find templates relative to scanner location
    const localTemplates = join(__dirname, "..", "templates", "agent-briefs");
    if (existsSync(localTemplates)) return localTemplates;
    // Fallback: node_modules/rungate/templates/agent-briefs
    const nmTemplates = join(root, "node_modules", "rungate", "templates", "agent-briefs");
    if (existsSync(nmTemplates)) return nmTemplates;
    return "";
  })();

  return {
    name: pkgName,
    type,
    root,
    identity: detectIdentity(root, pkgDesc, type),
    techStack: detectTechStack(root),
    repoUrl: detectRepoUrl(root),
    testCmd: detectTestCmd(root),
    keyFiles: scanKeyFiles(root),
    specs: scanSpecs(root),
    testFiles: scanTestFiles(root),
    refFiles: scanRefFiles(root),
    docRouting: scanDocRouting(root, categories),
    categories,
    consumers: detectConsumers(root),
    hasCodeMap: true, // Always true for idempotency — scaffold generates CODE-MAP.md (SC-364)
    makeTargets: scanMakeTargets(root),
    sourceDirs: detectSourceDirectories(root),
    promptRouting: scanPromptRouting(root, harness),
    harnessConfig: harness,
    agentMeta: scanAgentMeta(harness),
    dirs: scanDirs(root),
    deps,
    devDeps,
    modules: scanModules(root),
    routes: scanRoutes(root),
    harnessTemplatesDir,
    promptPrefix: detectPromptPrefix(root),
  };
}
