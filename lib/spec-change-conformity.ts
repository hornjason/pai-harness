/**
 * Spec-change conformity — detects spec file modifications and runs conformity checks.
 *
 * Thin lib module called by hooks/SpecConformityTrigger.hook.ts.
 * Delegates to sync-sc-status functions for SC scanning, checking, and checkbox flipping.
 *
 * Issue: #581
 */

import {
  findUncheckedSCs,
  checkConformitySCs,
  flipCheckboxes,
  scopedKey,
} from "../scripts/sync-sc-status";

export interface SpecChangeConformityResult {
  triggered: boolean;
  flippedCount: number;
  passing: string[];
  failing: string[];
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
