/**
 * CODE-MAP.md generator — produces code map content from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2).
 * Takes scan data in, produces file content out. No file I/O.
 */
import type { ProjectScan } from "./types";

/**
 * Generate CODE-MAP.md content from project scan data.
 *
 * Returns the full markdown string. Does NOT write files.
 */
export function generateCodeMap(scan: ProjectScan): string {
  const today = new Date().toISOString().split("T")[0];
  const { name, dirs, deps, devDeps, modules, routes } = scan;

  let md = `---
doc-type: code-map
status: generated
updated: ${today}
generator: scaffold-project.ts
---

# Code Map — ${name}

Auto-generated architecture snapshot.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | ${dirs.length} |
| Dependencies | ${deps} |
| Dev dependencies | ${devDeps} |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
${dirs.map(d => `| ${d.name}/ | ${d.fileCount} | ${d.types.join(", ")} |`).join("\n")}
`;

  if (routes.length > 0) {
    md += `\n## API Routes\n\n| Method | Path | File |\n|--------|------|------|\n`;
    for (const r of routes) {
      md += `| ${r.method} | ${r.path} | ${r.file} |\n`;
    }
  }

  if (modules.length > 0) {
    md += `\n## Source Modules\n\n| File | Exports |\n|------|---------|\n`;
    for (const mod of modules) {
      md += `| ${mod.file} | ${mod.exports.join(", ")} |\n`;
    }
  }

  md += "\n";
  return md;
}
