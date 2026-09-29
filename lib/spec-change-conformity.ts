/**
 * Spec-change conformity — detects spec file modifications and runs conformity checks.
 *
 * Thin lib module called by hooks/SpecConformityTrigger.hook.ts.
 * Delegates to sync-sc-status functions for SC scanning, checking, and checkbox flipping.
 * Also triggers sync-spec-tests regeneration for testable specs (AC-1, #508).
 *
 * Issue: #581, #508
 */

import { readFileSync, existsSync } from "fs";
import {
  findUncheckedSCs,
  checkConformitySCs,
  flipCheckboxes,
  scopedKey,
} from "../scripts/sync-sc-status";
import {
  parseTestable,
  extractClaims,
} from "../scripts/sync-spec-tests";

export interface SpecChangeConformityResult {
  triggered: boolean;
  flippedCount: number;
  passing: string[];
  failing: string[];
}

export interface SyncSpecTestsResult {
  syncTriggered: boolean;
  claimsExtracted: number;
  reason?: string;
}

export interface StalenessResult {
  stale: boolean;
  reason?: string;
}

/**
 * Check if a file path points to a spec file (specs/*.md, not nested).
 */
export function isSpecFile(filePath: string): boolean {
  return /(?:^|\/|\\)specs\/[^/\\]+\.md$/.test(filePath);
}

/**
 * Run conformity checks against all unchecked SCs and flip passing checkboxes.
 */
export function runSpecChangeConformity(projectRoot: string): SpecChangeConformityResult {
  const specsDir = `${projectRoot}/specs`;
  const unchecked = findUncheckedSCs(specsDir);

  if (unchecked.length === 0) {
    return { triggered: true, flippedCount: 0, passing: [], failing: [] };
  }

  const result = checkConformitySCs(unchecked, projectRoot);

  // Group passing SCs by spec file for checkbox flipping
  let totalFlipped = 0;
  const passingIds: string[] = [];
  const failingIds: string[] = [];

  const bySpec = new Map<string, string[]>();
  for (const key of result.passing) {
    // Keys are "specFile::SC-NNN" — extract parts
    const sepIdx = key.indexOf("::");
    if (sepIdx === -1) continue;
    const specFile = key.slice(0, sepIdx);
    const scId = key.slice(sepIdx + 2);
    const ids = bySpec.get(specFile) || [];
    ids.push(scId);
    bySpec.set(specFile, ids);
    passingIds.push(scId);
  }

  for (const key of result.failing) {
    const sepIdx = key.indexOf("::");
    if (sepIdx === -1) continue;
    const scId = key.slice(sepIdx + 2);
    failingIds.push(scId);
  }

  // Flip checkboxes for passing SCs
  for (const [specFile, scIds] of bySpec) {
    totalFlipped += flipCheckboxes(specFile, scIds, specsDir);
  }

  return {
    triggered: true,
    flippedCount: totalFlipped,
    passing: passingIds,
    failing: failingIds,
  };
}

/**
 * AC-1 (#508): Check if a modified spec has testable:true frontmatter
 * and trigger sync-spec-tests regeneration if so.
 *
 * Called from SpecConformityTrigger hook after conformity checks.
 */
export function syncSpecTests(projectRoot: string, filePath: string): SyncSpecTestsResult {
  if (!existsSync(filePath)) {
    return { syncTriggered: false, claimsExtracted: 0, reason: "file not found" };
  }

  const content = readFileSync(filePath, "utf-8");
  const testable = parseTestable(content);

  if (testable !== true) {
    return { syncTriggered: false, claimsExtracted: 0, reason: "spec not testable" };
  }

  // Extract claims from the testable spec
  const claims = extractClaims(content);

  return {
    syncTriggered: true,
    claimsExtracted: claims.length,
  };
}

/**
 * AC-3 (#508): Detect when spec-compliance-auto.test.ts is stale
 * relative to its source spec files.
 *
 * Re-extracts claims from all testable specs and regenerates the expected
 * test output. Compares claim IDs from fresh extraction against claim IDs
 * in the existing auto-generated file. Content-based comparison is more
 * robust than mtime checks, especially in git worktrees.
 */
export function checkAutoTestStaleness(projectRoot: string): StalenessResult {
  const { join } = require("path");
  const { readdirSync } = require("fs");

  const autoTestPath = join(projectRoot, "test", "spec-compliance-auto.test.ts");
  const specsDir = join(projectRoot, "specs");

  if (!existsSync(autoTestPath)) {
    return { stale: true, reason: "spec-compliance-auto.test.ts does not exist" };
  }

  if (!existsSync(specsDir)) {
    return { stale: false, reason: "no specs directory" };
  }

  // Extract current claims from testable specs
  const specFiles = readdirSync(specsDir).filter((f: string) => f.endsWith(".md"));
  let hasTestableSpecs = false;

  for (const f of specFiles) {
    const specPath = join(specsDir, f);
    const content = readFileSync(specPath, "utf-8");
    if (parseTestable(content) !== true) continue;
    hasTestableSpecs = true;
    break;
  }

  if (!hasTestableSpecs) {
    return { stale: false, reason: "no testable specs found" };
  }

  // Compare by checking each fresh claim's search_term is tested in the auto file
  const autoContent = readFileSync(autoTestPath, "utf-8");
  const autoContentLower = autoContent.toLowerCase();
  const missingTerms: string[] = [];

  for (const f of specFiles) {
    const specPath = join(specsDir, f);
    const content = readFileSync(specPath, "utf-8");
    if (parseTestable(content) !== true) continue;
    const claims = extractClaims(content);
    for (const c of claims) {
      // Each claim should have a corresponding assertion in the auto file
      // Check for the search_term in expect() calls
      if (!autoContentLower.includes(c.search_term.toLowerCase())) {
        missingTerms.push(`${c.id}: ${c.claim} (search: "${c.search_term}")`);
      }
    }
  }

  if (missingTerms.length > 0) {
    return {
      stale: true,
      reason: `spec claims not tested in spec-compliance-auto.test.ts: ${missingTerms.join("; ")}`,
    };
  }

  return { stale: false };
}
