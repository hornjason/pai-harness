/**
 * scanner.ts — Project scanner extracted from scaffold-project.ts (SC-358, SC-359)
 *
 * Scans a project root and returns a typed ProjectScan object containing
 * tech stack, specs, consumers, source directories, and other project metadata.
 *
 * This module is intentionally free of generation logic so it can be
 * imported independently without pulling in AGENTS.md or CODE-MAP
 * generators (SC-365).
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

// ── Types ──────────────────────────────────────────────────────

export type ProjectType = "code" | "content" | "infra";

export interface SpecInfo {
  file: string;
  governs: string;
  testable: string;
}

export interface ProjectScan {
  projectName: string;
  projectType: ProjectType;
  techStack: string[];
  specs: SpecInfo[];
  consumers: string[];
  sourceDirectories: string[];
  packageJson: {
    name: string;
    description: string;
    type?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  repoUrl: string;
  testDir: string | null;
  testFiles: string[];
  keyFiles: string[];
}

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

function scanSpecs(root: string): SpecInfo[] {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) return [];

  const specs: SpecInfo[] = [];
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
    const content = readFileSync(join(srcDir, f), "utf-8");
    const isConsumer = consumerPatterns.some(p => f.includes(p)) ||
      content.includes("app.get(") || content.includes("app.post(") ||
      content.includes("router.") || content.includes("export default");
    if (isConsumer) {
      consumers.push(f.replace(/\.ts$/, "").replace(/-routes|-generator/, ""));
    }
  }

  return [...new Set(consumers)].sort();
}

// ── Source directory detection ──────────────────────────────────

function detectSourceDirectories(root: string): string[] {
  const candidates = ["src", "lib", "gates", "workflows", "hooks"];
  return candidates.filter(dir => existsSync(join(root, dir)));
}

// ── Package.json reading ───────────────────────────────────────

function readPackageJson(root: string): ProjectScan["packageJson"] {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return {
      name: pkg.name || basename(root),
      description: pkg.description || "",
      type: pkg.type,
      scripts: pkg.scripts,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
    };
  } catch {
    return null;
  }
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

// ── Test file scanning ─────────────────────────────────────────

function scanTestFiles(root: string): { testDir: string | null; testFiles: string[] } {
  const testDir = existsSync(join(root, "test")) ? "test"
    : existsSync(join(root, "tests")) ? "tests"
    : null;

  if (!testDir) return { testDir: null, testFiles: [] };

  const testFiles = readdirSync(join(root, testDir))
    .filter(f => f.endsWith(".test.ts"));

  return { testDir, testFiles };
}

// ── Key file detection ─────────────────────────────────────────

function detectKeyFiles(root: string): string[] {
  const candidates = [
    "package.json", "Makefile", "tsconfig.json",
    "Containerfile", "Dockerfile", ".claude/rungate.json",
  ];
  return candidates.filter(f => existsSync(join(root, f)));
}

// ── Main scanner ───────────────────────────────────────────────

export function scanProject(root: string): ProjectScan {
  const projectType = detectProjectType(root);
  const pkg = readPackageJson(root);
  const { testDir, testFiles } = scanTestFiles(root);

  return {
    projectName: pkg?.name || basename(root),
    projectType,
    techStack: detectTechStack(root),
    specs: scanSpecs(root),
    consumers: detectConsumers(root),
    sourceDirectories: detectSourceDirectories(root),
    packageJson: pkg,
    repoUrl: detectRepoUrl(root),
    testDir,
    testFiles,
    keyFiles: detectKeyFiles(root),
  };
}
