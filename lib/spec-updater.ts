/**
 * spec-updater — patches governing spec decision tables on PROVEN verdict.
 * Reads governingSpec.path from GoalRecord, finds D-NNN rows,
 * replaces ACCEPTED status with SHIPPED + issue number.
 * Project-agnostic: never hardcodes any specific spec filename.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

export interface SpecUpdateInput {
  goalRecord: {
    governingSpec?: { path: string; detectedFrom?: string };
  };
  issueNumber: number;
  decisionIds: string[];
}

export interface SpecUpdateResult {
  updated: boolean;
  skipped: boolean;
  specPath?: string;
  rowsUpdated: number;
  reason?: string;
}

/**
 * Extract D-NNN decision IDs from arbitrary text (issue body, GoalRecord fields, etc.)
 */
export function extractDecisionIds(text: string): string[] {
  const matches = text.match(/D-\d{3}/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * Update the governing spec's decision table rows from ACCEPTED to SHIPPED.
 * Skips gracefully when governingSpec is absent, path is empty, or file not found.
 */
export async function updateSpecStatus(input: SpecUpdateInput): Promise<SpecUpdateResult> {
  const { goalRecord, issueNumber, decisionIds } = input;

  // Guard: no governing spec
  if (!goalRecord.governingSpec?.path) {
    return { updated: false, skipped: true, rowsUpdated: 0, reason: "no governing spec in GoalRecord" };
  }

  const specPath = goalRecord.governingSpec.path;

  // Guard: empty path
  if (!specPath.trim()) {
    return { updated: false, skipped: true, specPath, rowsUpdated: 0, reason: "governing spec path is empty" };
  }

  // Guard: file not found
  if (!existsSync(specPath)) {
    return { updated: false, skipped: true, specPath, rowsUpdated: 0, reason: `spec file not found at ${specPath}` };
  }

  // Guard: no decision IDs to update
  if (!decisionIds.length) {
    return { updated: false, skipped: true, specPath, rowsUpdated: 0, reason: "no decision IDs to update" };
  }

  let content = readFileSync(specPath, "utf-8");
  let rowsUpdated = 0;

  for (const dId of decisionIds) {
    // Match a table row containing the decision ID and an ACCEPTED status cell.
    // Handles both 3-column (| ID | Decision | Status |) and
    // 4-column (| ID | Decision | Priority | Status |) formats.
    // The ACCEPTED cell may have trailing text like "(Wave 7, #386)".
    const pattern = new RegExp(
      `^(\\|\\s*${escapeRegExp(dId)}\\s*\\|.+\\|)\\s*ACCEPTED(?:\\s*\\([^)]*\\))?\\s*\\|`,
      "m"
    );

    if (pattern.test(content)) {
      content = content.replace(pattern, `$1 **SHIPPED** (#${issueNumber}) |`);
      rowsUpdated++;
    }
  }

  if (rowsUpdated > 0) {
    writeFileSync(specPath, content);
  }

  return {
    updated: rowsUpdated > 0,
    skipped: false,
    specPath,
    rowsUpdated,
  };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
