#!/usr/bin/env bun
/**
 * Generate governs: frontmatter for spec files that are missing it.
 * Reads the file's title and first section to infer intent. No LLM needed —
 * uses the H1 title and first paragraph as the governs description.
 *
 * Usage:
 *   bun scripts/generate-governs.ts           # Show what would change
 *   bun scripts/generate-governs.ts --apply   # Apply changes
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");
const apply = process.argv.includes("--apply");

if (!existsSync(SPECS_DIR)) {
  console.log("No specs/ directory found");
  process.exit(0);
}

let count = 0;

function processFile(filePath: string, relPath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;

  const fm = fmMatch[1];
  const governsMatch = fm.match(/governs:\s*(.+)/);

  if (governsMatch && !governsMatch[1].trim().startsWith("TODO")) return;

  // Infer governs from H1 title and first content paragraph
  const body = content.substring(fmMatch[0].length).trim();
  const h1Match = body.match(/^# (.+)/m);
  const title = h1Match ? h1Match[1].trim() : relPath.replace(/\.md$/, "").replace(/-/g, " ");

  // Get first non-empty paragraph after any heading
  const paragraphs = body.split(/\n\n+/).filter(p => p.trim() && !p.startsWith("#"));
  const firstPara = paragraphs[0]?.trim().split("\n")[0] || "";
  const summary = firstPara.length > 80 ? firstPara.slice(0, 77) + "..." : firstPara;

  const governs = summary ? `${title} — ${summary}` : title;
  const truncated = governs.slice(0, 120);

  console.log(`${apply ? "✅" : "⬜"} ${relPath}`);
  console.log(`   governs: ${truncated}`);

  if (apply) {
    let newContent: string;
    if (governsMatch) {
      newContent = content.replace(/governs:\s*.+/, `governs: ${truncated}`);
    } else {
      const fmEnd = content.indexOf("\n---", 4);
      newContent = content.substring(0, fmEnd) + `\ngoverns: ${truncated}` + content.substring(fmEnd);
    }
    writeFileSync(filePath, newContent);
  }
  count++;
}

for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: SPECS_DIR, absolute: false })) {
  processFile(join(SPECS_DIR, file), `specs/${file}`);
}

if (count === 0) {
  console.log("✅ All spec files have governs: fields");
} else {
  console.log(`\n${apply ? "Updated" : "Would update"} ${count} files`);
  if (!apply) console.log("Run with --apply to write changes");
}
