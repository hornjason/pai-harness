#!/usr/bin/env bun
/**
 * generate-code-map.ts — Scan a codebase and produce CODE-MAP.md
 *
 * Usage: bun ~/Projects/rungate/scripts/generate-code-map.ts /path/to/project
 *
 * Combines fallow analysis + route scanning + directory structure into a
 * machine-generated architecture snapshot. Agents read this to understand
 * the codebase without exploring manually.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join, basename } from "path";
import { localCalendarDay } from "../lib/local-calendar-day";
import { FRESHNESS_NOTICE, directoryTable } from "../lib/generators/code-map";
import { fileExtensions } from "../lib/file-extensions";
import {
  fallowAvailable,
  fallowUnmeasuredNotice,
  runFallowJson,
  type FallowUnavailable,
} from "../lib/fallow-availability";

const projectPath = process.argv[2];
if (!projectPath || !existsSync(projectPath)) {
  console.error("Usage: generate-code-map.ts /path/to/project");
  process.exit(1);
}

const projectName = basename(projectPath);
const today = localCalendarDay();

// ── Fallow analysis ──────────────────────────────────────────

interface FallowData {
  entryPoints: number;
  unusedFiles: string[];
  unusedExports: Array<{ path: string; export_name: string; line: number }>;
  circularDeps: Array<{ files: string[] }>;
  elapsed: number;
}

/**
 * Three outcomes, not two (#581).
 *
 * This returned `null` for "not installed", "the spawn failed", "the output
 * did not parse" and — through `||` in the summary table below — "it ran and
 * found zero". A CODE-MAP written from any of them was byte-identical, so a
 * reader could not tell a project with no dead code from a project nobody
 * looked at.
 */
type FallowOutcome = { data: FallowData } | { unavailable: FallowUnavailable };

function runFallow(): FallowOutcome {
  // Resolved locally, with no network path. A bare `npx fallow` for a tool
  // that is not a declared dependency is a registry fetch on the SCAFFOLD
  // path — once per consumer, forever, including behind a proxy and in an
  // air-gapped CI. `lib/conformity.ts` fixed this for itself in #510 and
  // this caller never got it.
  //
  // The spawn, the budget and the classification are no longer here: they
  // were a second copy of `lib/conformity.ts`'s, with a second `30_000`
  // literal, and the two disagreed about what to do with a killed run. One
  // binding now, in `lib/fallow-availability.ts` (#935). What stays here is
  // the SHAPING of fallow's JSON into the fields CODE-MAP.md needs, which is
  // this script's own business and nobody else's.
  const root = fallowAvailable(projectPath) ? projectPath : process.cwd();
  const reading = runFallowJson<any>(root, ["dead-code"]);
  if ("unavailable" in reading) return { unavailable: reading.unavailable };
  const d = reading.data;
  return { data: {
    entryPoints: d.entry_points?.total || 0,
    unusedFiles: (d.unused_files || []).map((f: any) => f.path),
    unusedExports: (d.unused_exports || []).map((e: any) => ({
      path: e.path, export_name: e.export_name, line: e.line
    })),
    circularDeps: (d.circular_dependencies || []).map((c: any) => ({
      files: c.files || [c.path]
    })),
    elapsed: d.elapsed_ms || 0,
  } };
}

// ── Route scanning ───────────────────────────────────────────

interface Route { method: string; path: string; file: string; line: number }

function scanRoutes(): Route[] {
  const routes: Route[] = [];
  const srcDir = join(projectPath, "src");
  if (!existsSync(srcDir)) return routes;

  const routePattern = /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;

  for (const file of readdirSync(srcDir, { recursive: true }).map(String)) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
    const fullPath = join(srcDir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let match;
        const lineRoutePattern = /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
        while ((match = lineRoutePattern.exec(lines[i])) !== null) {
          routes.push({
            method: match[1].toUpperCase(),
            path: match[2],
            file: `src/${file}`,
            line: i + 1,
          });
        }
      }
    } catch {}
  }
  return routes;
}

// ── Directory structure ──────────────────────────────────────

interface DirSummary { name: string; types: string[] }

function scanDirectories(): DirSummary[] {
  const dirs: DirSummary[] = [];
  const skip = new Set(["node_modules", ".git", "reference", "dist", "build", ".next", ".fallow"]);

  for (const entry of readdirSync(projectPath)) {
    if (entry.startsWith(".") && entry !== ".claude") continue;
    if (skip.has(entry)) continue;
    const full = join(projectPath, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      // One binding for what a "type" is, shared with `lib/scanner.ts` and
      // `generateCodeMapInline` (#1200). The copy that used to be here
      // reported directory names — this script produced the shipped
      // `| evals/ | marcus-tdd-order, … |` row.
      dirs.push({ name: entry, types: fileExtensions(full) });
    } catch {}
  }
  // Unsorted. Row order is `directoryTable`'s single decision (#1163) —
  // this used to sort by `fileCount`, which is how the census survived one
  // indirection past being printed.
  return dirs;
}

// ── Component scanning (React) ───────────────────────────────

function scanComponents(): string[] {
  const componentDirs = [
    join(projectPath, "dashboard/src/components"),
    join(projectPath, "src/components"),
  ];
  const components: string[] = [];
  for (const dir of componentDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".tsx") || f.endsWith(".jsx")) {
        components.push(f.replace(/\.(tsx|jsx)$/, ""));
      }
    }
  }
  return components.sort();
}

// ── Consumer-module mapping (for Marcus) ─────────────────────

interface ConsumerMapping { consumer: string; imports: string[] }

function scanConsumerModules(): ConsumerMapping[] {
  const srcDir = join(projectPath, "src");
  if (!existsSync(srcDir)) return [];
  const mappings: ConsumerMapping[] = [];

  for (const file of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
    const content = readFileSync(join(srcDir, file), "utf-8");
    const imports: string[] = [];
    const importPattern = /from\s+["']\.\/([^"']+)["']/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      imports.push(m[1]);
    }
    if (imports.length > 0) {
      mappings.push({ consumer: file, imports: imports.slice(0, 8) });
    }
  }
  return mappings.sort((a, b) => b.imports.length - a.imports.length).slice(0, 15);
}

// ── Page-component mapping (for Quinn) ───────────────────────

function scanPageComponents(): Array<{ page: string; components: string[] }> {
  const pagesDir = join(projectPath, "dashboard/src/pages");
  if (!existsSync(pagesDir)) return [];
  const pages: Array<{ page: string; components: string[] }> = [];

  for (const file of readdirSync(pagesDir).filter(f => f.endsWith(".tsx"))) {
    const content = readFileSync(join(pagesDir, file), "utf-8");
    const components: string[] = [];
    const importPattern = /from\s+["'].*?\/components\/([^"']+)["']/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      components.push(m[1].replace(/["']$/, ""));
    }
    if (components.length > 0) {
      pages.push({ page: file.replace(/\.tsx$/, ""), components });
    }
  }
  return pages;
}

// ── Package info ─────────────────────────────────────────────

function readPackageInfo(): { name: string; deps: number; devDeps: number; scripts: string[] } {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return { name: projectName, deps: 0, devDeps: 0, scripts: [] };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return {
    name: pkg.name || projectName,
    deps: Object.keys(pkg.dependencies || {}).length,
    devDeps: Object.keys(pkg.devDependencies || {}).length,
    scripts: Object.keys(pkg.scripts || {}),
  };
}

// ── Generate ─────────────────────────────────────────────────

console.log(`Scanning ${projectName}...`);

const fallowOutcome = runFallow();
const fallow = "data" in fallowOutcome ? fallowOutcome.data : null;
const fallowMissing = "unavailable" in fallowOutcome ? fallowOutcome.unavailable : null;
const routes = scanRoutes();
const dirs = scanDirectories();
const components = scanComponents();
const pkg = readPackageInfo();
const consumerMappings = scanConsumerModules();
const pageMappings = scanPageComponents();

console.log(
  `  Fallow: ${fallow ? `${fallow.entryPoints} entry points, ${fallow.elapsed}ms` : `UNMEASURED — ${fallowMissing?.reason}`}`,
);
console.log(`  Routes: ${routes.length}`);
console.log(`  Directories: ${dirs.length}`);
console.log(`  Components: ${components.length}`);
console.log(`  Module mappings: ${consumerMappings.length}`);
console.log(`  Page mappings: ${pageMappings.length}`);

// ── Build CODE-MAP.md ────────────────────────────────────────

let headSha = "unknown";
try {
  const result = Bun.spawnSync(["git", "-C", projectPath, "rev-parse", "HEAD"]);
  headSha = result.stdout.toString().trim().substring(0, 8);
} catch {}

const sections: string[] = [];

sections.push(`---
doc-type: code-map
status: generated
updated: ${today}
scanned-at-sha: ${headSha}
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — ${pkg.name}

Auto-generated architecture snapshot. Re-run \`bun generate-code-map.ts ${projectPath}\` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

${FRESHNESS_NOTICE}`);

// Summary
sections.push(`## Summary

| Metric | Count |
|--------|-------|
| Source directories | ${dirs.length} |
| Dependencies | ${pkg.deps} |
| Dev dependencies | ${pkg.devDeps} |
| API routes | ${routes.length} |
| React components | ${components.length} |
| Entry points (fallow) | ${fallow ? fallow.entryPoints : "UNMEASURED"} |
| Unused files | ${fallow ? fallow.unusedFiles.length : "UNMEASURED"} |
| Unused exports | ${fallow ? fallow.unusedExports.length : "UNMEASURED"} |
| Circular dependencies | ${fallow ? fallow.circularDeps.length : "UNMEASURED"} |
| Module import mappings | ${consumerMappings.length} |
| Page-component mappings | ${pageMappings.length} |`);

// Directory structure. No `Files` column, and the order is `directoryTable`'s
// rather than the scanner's — see `FRESHNESS_NOTICE` and #1163.
sections.push(`## Directory Structure

${directoryTable(dirs)}`);

// Routes
if (routes.length > 0) {
  const byMethod: Record<string, Route[]> = {};
  for (const r of routes) {
    (byMethod[r.method] ||= []).push(r);
  }
  let routeTable = "## API Routes\n\n";
  for (const [method, methodRoutes] of Object.entries(byMethod).sort()) {
    routeTable += `### ${method} (${methodRoutes.length})\n\n`;
    routeTable += "| Path | File | Line |\n|------|------|------|\n";
    for (const r of methodRoutes.sort((a, b) => a.path.localeCompare(b.path))) {
      routeTable += `| ${r.path} | ${r.file} | ${r.line} |\n`;
    }
    routeTable += "\n";
  }
  sections.push(routeTable.trim());
}

// Components
if (components.length > 0) {
  sections.push(`## React Components (${components.length})

${components.map(c => `- ${c}`).join("\n")}`);
}

// Module import mappings (for Marcus — shows dependency chains)
if (consumerMappings.length > 0) {
  let modSection = `## Module Dependencies (top ${consumerMappings.length})\n\n`;
  modSection += "Which modules depend on which — for cascade impact analysis.\n\n";
  modSection += "| Module | Imports From |\n|--------|-------------|\n";
  for (const cm of consumerMappings) {
    modSection += `| ${cm.consumer} | ${cm.imports.join(", ")} |\n`;
  }
  sections.push(modSection.trim());
}

// Page-component mappings (for Quinn — shows which components are on each page)
if (pageMappings.length > 0) {
  let pageSection = `## Page → Component Map (for UI testing)\n\n`;
  pageSection += "Which components render on each page — for targeted UI verification.\n\n";
  for (const pm of pageMappings) {
    pageSection += `### ${pm.page}\n\n`;
    pageSection += pm.components.map(c => `- ${c}`).join("\n") + "\n\n";
  }
  sections.push(pageSection.trim());
}

// Health (fallow findings)
if (fallow) {
  let health = "## Code Health (fallow)\n\n";

  if (fallow.circularDeps.length > 0) {
    health += `### Circular Dependencies (${fallow.circularDeps.length})\n\n`;
    for (const cd of fallow.circularDeps.slice(0, 10)) {
      health += `- ${cd.files.join(" → ")}\n`;
    }
    if (fallow.circularDeps.length > 10) health += `- ... and ${fallow.circularDeps.length - 10} more\n`;
    health += "\n";
  }

  if (fallow.unusedFiles.length > 0) {
    health += `### Unused Files (${fallow.unusedFiles.length})\n\n`;
    for (const f of fallow.unusedFiles.slice(0, 15)) {
      health += `- ${f}\n`;
    }
    if (fallow.unusedFiles.length > 15) health += `- ... and ${fallow.unusedFiles.length - 15} more\n`;
    health += "\n";
  }

  sections.push(health.trim());
} else if (fallowMissing) {
  // Named, not omitted. A missing section and a section reporting nothing
  // wrong are the same absence to a reader, and the reader of a CODE-MAP is
  // an agent deciding whether this project has dead code.
  sections.push(fallowUnmeasuredNotice(fallowMissing));
}

// Scripts
if (pkg.scripts.length > 0) {
  sections.push(`## Package Scripts

${pkg.scripts.map(s => `- \`${s}\``).join("\n")}`);
}

const codeMap = sections.join("\n\n") + "\n";
const outPath = join(projectPath, "CODE-MAP.md");
writeFileSync(outPath, codeMap);
console.log(`\nWritten: ${outPath} (${codeMap.split("\n").length} lines)`);
