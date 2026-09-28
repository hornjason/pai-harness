/**
 * scanner.ts — Project scanner for scaffold-project.ts decomposition.
 *
 * Extracts project scanning logic into a reusable module.
 * Returns a typed ProjectScan object containing tech stack, specs,
 * consumers, source directories, and project metadata.
 *
 * Design decision D-1 (SCAFFOLD-DECOMPOSITION-SPEC): Scanner is importable
 * by other scripts without pulling in generation logic.
 * Design decision D-5: Scan data passed as typed interface, not globals.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

// ── Types ──────────────────────────────────────────────────────

export type ProjectType = "code" | "content" | "infra";

export interface SpecMeta {
  filename: string;
  governs: string;
  testable: string;
}

export interface ProjectScan {
  /** Detected project type */
  projectType: ProjectType;
  /** Project name from package.json or directory name */
  projectName: string;
  /** Project description from package.json or README */
  projectDescription: string;
  /** Detected tech stack entries (e.g., Bun, TypeScript, ESM) */
  techStack: string[];
  /** Spec files found in specs/ with frontmatter metadata */
  specs: SpecMeta[];
  /** Consumer modules detected from src/ */
  consumers: string[];
  /** Source directories that exist (src, lib, gates, etc.) */
  sourceDirectories: string[];
  /** Git remote URL if available */
  repoUrl: string;
  /** Test directory name (test or tests) */
  testDir: string | null;
  /** Detected test command */
  testCommand: string;
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

// ── Tech stack detection ───────────────────────────────────────

export function detectTechStack(root: string): string[] {
  const techStack: string[] = [];
  const pkgPath = join(root, "package.json");

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
      if (existsSync(join(root, "tsconfig.json")) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("TypeScript");
      }
      // Detect module system
      if (pkg.type === "module") {
        techStack.push("ESM");
      }
    } catch {}
  }

  return techStack;
}

// ── Spec scanning ──────────────────────────────────────────────

export function scanSpecs(root: string): SpecMeta[] {
  const specsDir = join(root, "specs");
  const specs: SpecMeta[] = [];

  if (!existsSync(specsDir)) return specs;

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
    specs.push({ filename: f, governs, testable });
  }

  return specs;
}

// ── Consumer detection ─────────────────────────────────────────

export function scanConsumers(root: string): string[] {
  const srcDir = join(root, "src");
  const consumers: string[] = [];

  if (!existsSync(srcDir)) return consumers;

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

export function scanSourceDirectories(root: string): string[] {
  const candidates = ["src", "lib", "gates", "workflows", "hooks"];
  return candidates.filter(dir => existsSync(join(root, dir)));
}

// ── Project metadata ───────────────────────────────────────────

function readProjectMeta(root: string): { name: string; description: string } {
  const pkgPath = join(root, "package.json");
  const dirName = basename(root);

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return {
        name: pkg.name || dirName,
        description: pkg.description || "",
      };
    } catch {}
  }

  return { name: dirName, description: "" };
}

function detectRepoUrl(root: string): string {
  try {
    const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"]);
    return result.stdout.toString().trim().replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
  } catch {
    return "";
  }
}

function detectTestDir(root: string): string | null {
  if (existsSync(join(root, "test"))) return "test";
  if (existsSync(join(root, "tests"))) return "tests";
  return null;
}

function detectTestCommand(root: string): string {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) return pkg.scripts.test;
    } catch {}
  }
  return "bun test";
}

// ── Main scanner function ──────────────────────────────────────

/**
 * Scan a project directory and return structured metadata.
 * Pure scanning — no file generation, no side effects.
 */
export function scanProject(root: string): ProjectScan {
  const meta = readProjectMeta(root);

  return {
    projectType: detectProjectType(root),
    projectName: meta.name,
    projectDescription: meta.description,
    techStack: detectTechStack(root),
    specs: scanSpecs(root),
    consumers: scanConsumers(root),
    sourceDirectories: scanSourceDirectories(root),
    repoUrl: detectRepoUrl(root),
    testDir: detectTestDir(root),
    testCommand: detectTestCommand(root),
  };
}
