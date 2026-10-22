/**
 * CODE-MAP.md generator — produces code map content from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2).
 * Takes scan data in, produces file content out. No file I/O.
 */
import type { DirEntry, ProjectScan } from "./types";
import { localCalendarDay } from "../local-calendar-day";

/**
 * What CODE-MAP.md guarantees, and what it does not — stated IN the file.
 *
 * #1163's acceptance, and the reason it is a constant rather than a sentence
 * written twice: both renderers in this repo emit the same file
 * (`scripts/generate-code-map.ts` for a real tree, this module for the
 * scaffold's inline fallback), and a disclaimer that is true in one of them
 * and missing from the other is worse than no disclaimer, because a reader
 * who has seen it once stops looking for it.
 *
 * The claim it makes is narrow on purpose. The directory list is stable —
 * MEASURED, 0 of the last 50 commit transitions moved it — and the
 * per-directory file census was removed because 22 of those same 50 moved
 * one. What remains unfixable is the FRONTMATTER: `scanned-at-sha` is
 * `git rev-parse HEAD` at generation time, so it is a branch tip and can
 * never be the squash commit that lands the file. There is no drift gate
 * that survives that, and #1163's scope note forbids pretending otherwise.
 */
export const FRESHNESS_NOTICE =
  "**What this guarantees:** the sections below describe the tree at `scanned-at-sha`.\n" +
  "**What it does not:** that `scanned-at-sha` is the commit you are reading this on. The scan\n" +
  "runs on a branch tip and the squash merge lands it on a `main` that has already moved, so this\n" +
  "file is at best one merge behind and no drift gate can close that (#1163). Per-directory file\n" +
  "counts were removed for the same reason — 22 of 50 consecutive commits moved one. Treat every\n" +
  "row as orientation, not as a fact about your working tree.";

/**
 * The `## Directory Structure` table — header and body, ordered by name.
 *
 * ONE renderer for the two code paths that write CODE-MAP.md
 * (`scripts/generate-code-map.ts` for a real tree, `generateCodeMap` below
 * for the scaffold's inline fallback), and ONE place the row order is
 * decided.
 *
 * That second property is the point. Before #1163 the order came from each
 * of the THREE scanners that build `dirs`, every one of them sorting
 * `b.fileCount - a.fileCount` — so the order was the census with an
 * indirection in front of it, and removing the printed count would have left
 * it behind. Three sites agreeing is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`: a mutation of any one of
 * them leaves the other two holding the answer up. The scanners no longer
 * sort at all; this function does, by name, which is a key a reader can
 * reproduce from what the file prints.
 */
export function directoryTable(dirs: DirEntry[]): string {
  const rows = [...dirs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => `| ${d.name}/ | ${d.types.join(", ")} |`);
  return ["| Directory | Types |", "|-----------|-------|", ...rows].join("\n");
}

/**
 * Generate CODE-MAP.md content from project scan data.
 *
 * Returns the full markdown string. Does NOT write files.
 */
export function generateCodeMap(scan: ProjectScan): string {
  const today = localCalendarDay();
  const { name, dirs, deps, devDeps, modules, routes } = scan;

  let md = `---
doc-type: code-map
status: generated
updated: ${today}
generator: scaffold-project.ts
---

# Code Map — ${name}

Auto-generated architecture snapshot.

${FRESHNESS_NOTICE}

## Summary

| Metric | Count |
|--------|-------|
| Source directories | ${dirs.length} |
| Dependencies | ${deps} |
| Dev dependencies | ${devDeps} |

## Directory Structure

${directoryTable(dirs)}
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
