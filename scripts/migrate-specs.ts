#!/usr/bin/env bun
/**
 * migrate-specs.ts — Move spec files from docs/specs/ to specs/.
 *
 * Uses `git mv` to preserve git history. Adds missing frontmatter and
 * converts numbered criteria to SC checkbox format during migration.
 *
 * Usage:
 *   bun scripts/migrate-specs.ts /path/to/project
 *   bun scripts/migrate-specs.ts .                    # current directory
 *   bun scripts/migrate-specs.ts /path --dry-run      # preview without moving
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// ── Argument parsing ──────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectPath = args.find(arg => !arg.startsWith("--"));

if (!projectPath) {
  console.error("Usage: bun scripts/migrate-specs.ts /path/to/project [--dry-run]");
  process.exit(1);
}

const docsSpecsDir = join(projectPath, "docs", "specs");
const specsDir = join(projectPath, "specs");

if (!existsSync(docsSpecsDir)) {
  console.log("No docs/specs/ directory found — nothing to migrate.");
  process.exit(0);
}

const specFiles = readdirSync(docsSpecsDir).filter(f => f.endsWith(".md"));
if (specFiles.length === 0) {
  console.log("No .md files in docs/specs/ — nothing to migrate.");
  process.exit(0);
}

// ── Frontmatter injection ─────────────────────────────────────

function ensureFrontmatter(content: string): string {
  const today = new Date().toISOString().split("T")[0];
  if (!content.startsWith("---\n")) {
    const frontmatter = `---\ndoc-type: spec\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\ngoverns: TODO — describe what this spec governs\ntestable: false\n---\n\n`;
    return frontmatter + content;
  }
  return content;
}

// ── Numbered criteria to SC checkboxes ────────────────────────

function convertNumberedCriteria(content: string): string {
  let scCounter = 0;
  return content.replace(/^(\d+)\.\s+(.+)$/gm, (_match, _num, text) => {
    scCounter++;
    return `- [ ] SC-${scCounter}: ${text}`;
  });
}

// ── Migration ─────────────────────────────────────────────────

console.log(`Migrating ${specFiles.length} spec(s) from docs/specs/ to specs/...`);

for (const file of specFiles) {
  const srcPath = join(docsSpecsDir, file);
  const destPath = join(specsDir, file);

  if (existsSync(destPath)) {
    console.log(`  SKIP: specs/${file} already exists — skipping`);
    continue;
  }

  // Read and transform content before moving
  let content = readFileSync(srcPath, "utf-8");
  content = ensureFrontmatter(content);
  content = convertNumberedCriteria(content);

  if (dryRun) {
    console.log(`  DRY-RUN: would move docs/specs/${file} → specs/${file}`);
    continue;
  }

  // Write transformed content back to source before git mv
  writeFileSync(srcPath, content);

  // Use git mv to preserve history
  try {
    execSync(`git mv "${join("docs", "specs", file)}" "${join("specs", file)}"`, {
      cwd: projectPath,
      stdio: "pipe",
    });
    console.log(`  MOVED: docs/specs/${file} → specs/${file}`);
  } catch (err: any) {
    console.error(`  ERROR: Failed to git mv docs/specs/${file}: ${err.message}`);
    process.exit(1);
  }
}

if (!dryRun) {
  console.log(`\nMigration complete. ${specFiles.length} file(s) moved.`);
  console.log("Run `bun test test/scaffold-conformity.test.ts` to verify conformity.");
}
