#!/usr/bin/env bun
/**
 * Detect SC drift: SCs referencing nonexistent files or missing keywords.
 *
 * Reports two categories:
 * - DRIFT: SC references a file that doesn't exist
 * - STALE: SC expects a keyword in an existing file, but keyword is missing
 *
 * Usage:
 *   bun scripts/detect-sc-drift.ts           # Run against project root
 *   import { detectDrift } from "./detect-sc-drift"  # Programmatic use
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface DriftResult {
  drifted: Map<string, DriftDetail[]>;  // SCs referencing nonexistent files
  stale: Map<string, StaleDetail[]>;    // SCs with missing keywords
  checked: number;                       // Total SCs checked
}

export interface DriftDetail {
  scId: string;
  statement: string;
  path: string;  // The file path that doesn't exist
}

export interface StaleDetail {
  scId: string;
  statement: string;
  path: string;     // The file that exists
  keyword: string;  // The keyword that's missing
}

/**
 * Extract file paths from SC statement text.
 * Matches patterns like: lib/foo.ts, scripts/bar.ts, test/baz.test.ts, etc.
 */
function extractFilePaths(statement: string): string[] {
  const paths: string[] = [];
  // Match file paths: (lib|scripts|test|gates|workflows|hooks)/...(.ts|.js|.md|.json|.hook.ts)
  const pathPattern = /((?:lib|scripts|test|gates|workflows|hooks)\/[^\s,\]]+\.(?:ts|js|md|json))/g;
  let match;
  while ((match = pathPattern.exec(statement)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Extract keyword from "contains [keyword]" pattern.
 * Returns null if no keyword pattern found.
 */
function extractKeyword(statement: string): string | null {
  const match = statement.match(/contains \[([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Detect drift and staleness in SCs across all spec files.
 *
 * @param specsDir - Path to specs directory
 * @param projectRoot - Path to project root for resolving file paths
 * @returns DriftResult with drifted and stale SCs, grouped by spec file
 */
export function detectDrift(specsDir: string, projectRoot: string): DriftResult {
  const drifted = new Map<string, DriftDetail[]>();
  const stale = new Map<string, StaleDetail[]>();
  let checked = 0;

  if (!existsSync(specsDir)) {
    return { drifted, stale, checked };
  }

  // Read all .md files in specs directory
  const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md"));

  for (const specFile of specFiles) {
    const specPath = join(specsDir, specFile);
    const content = readFileSync(specPath, "utf-8");

    // Find all SC lines (both checked and unchecked)
    const scPattern = /^- \[[ x]\] (SC-\d+):\s*(.+)$/gm;
    let match;

    while ((match = scPattern.exec(content)) !== null) {
      const scId = match[1];
      const statement = match[2].trim();
      checked++;

      // Check for file path references
      const paths = extractFilePaths(statement);
      for (const path of paths) {
        const fullPath = join(projectRoot, path);
        if (!existsSync(fullPath)) {
          if (!drifted.has(specFile)) {
            drifted.set(specFile, []);
          }
          drifted.get(specFile)!.push({ scId, statement, path });
        } else {
          // File exists - check for keyword staleness
          const keyword = extractKeyword(statement);
          if (keyword) {
            const fileContent = readFileSync(fullPath, "utf-8");
            if (!fileContent.includes(keyword)) {
              if (!stale.has(specFile)) {
                stale.set(specFile, []);
              }
              stale.get(specFile)!.push({ scId, statement, path, keyword });
            }
          }
        }
      }
    }
  }

  return { drifted, stale, checked };
}

// --- Main (only runs when executed directly) ---
const isDirectExecution = import.meta.main;

if (isDirectExecution) {
  const ROOT = join(import.meta.dir, "..");
  const SPECS_DIR = join(ROOT, "specs");

  const result = detectDrift(SPECS_DIR, ROOT);

  console.log(`\n=== SC Drift Detection ===`);
  console.log(`Checked ${result.checked} SCs across specs\n`);

  let totalDrifted = 0;
  let totalStale = 0;

  if (result.drifted.size > 0) {
    console.log("DRIFTED (file doesn't exist):");
    for (const [specFile, details] of result.drifted) {
      for (const detail of details) {
        console.log(`  ${detail.scId} in ${specFile}: references ${detail.path} but file does not exist`);
        totalDrifted++;
      }
    }
    console.log();
  }

  if (result.stale.size > 0) {
    console.log("STALE (keyword missing):");
    for (const [specFile, details] of result.stale) {
      for (const detail of details) {
        console.log(`  ${detail.scId} in ${specFile}: expects ${detail.path} to contain [${detail.keyword}] but it doesn't`);
        totalStale++;
      }
    }
    console.log();
  }

  if (totalDrifted === 0 && totalStale === 0) {
    console.log("✓ No drift or staleness detected\n");
  } else {
    console.log(`Summary: ${totalDrifted} drifted, ${totalStale} stale\n`);
    process.exit(1);  // Non-zero exit for CI integration
  }
}
