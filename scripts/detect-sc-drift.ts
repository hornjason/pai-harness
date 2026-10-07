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
 * The keywords a `contains [a, b, c]` clause requires.
 *
 * It used to return the bracket contents as ONE string, so a multi-keyword SC
 * was checked for the literal text `"resolveSyncPaths, harnessRoot"` — comma
 * and space included — which no source file ever contains. Every such SC was
 * therefore reported stale no matter what the file held, and
 * `scripts/sync-sc-status.ts` refuses to flip a stale SC. A criterion the
 * conformity engine had just PASSED could not be marked done, and the reason
 * printed was "keyword missing from file", which is not what was wrong.
 *
 * A comma inside a keyword would split wrongly, so only split where the parts
 * look like separate terms: the registry's own syntax is comma-separated and
 * no matcher keyword in this repo contains one.
 */
export function extractKeywords(statement: string): string[] {
  // `not contains [...]` is an absence clause, and this detector only answers
  // "a file exists but lacks a term it should have". Reading it as a positive
  // requirement inverted the SC: SC-539 says ship.js must NOT contain
  // `git merge ${worktreeBranch}`, and the detector reported it stale FOR
  // being correct.
  const match = statement.match(/(?<!not )contains \[([^\]]+)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map(k => k.trim())
    .filter(Boolean);
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
          // File exists — check each required keyword separately.
          const keywords = extractKeywords(statement);
          if (keywords.length) {
            const fileContent = readFileSync(fullPath, "utf-8");
            const missing = keywords.filter(k => !fileContent.includes(k));
            if (missing.length) {
              if (!stale.has(specFile)) {
                stale.set(specFile, []);
              }
              // Report every missing term, not just the first: a reader who
              // fixes one and re-runs should not discover the next one by
              // iteration.
              stale.get(specFile)!.push({ scId, statement, path, keyword: missing.join(", ") });
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
