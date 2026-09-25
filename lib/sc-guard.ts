/**
 * SC Guard — Core validation logic for spec SC lines.
 *
 * Detects new SC lines in spec edits and validates they are either:
 * 1. Matchable by the matcher registry (testable)
 * 2. Explicitly marked (behavioral) with justification
 *
 * Deep module: hook file is thin, all logic lives here.
 *
 * Issue: #591
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { parseFrontmatter, isMatchablePattern, isBehavioralSC } from "./conformity";
import type { ParsedSC } from "./conformity";

// ── Types ──────────────────────────────────────────────────

export interface NewSC {
  id: string;
  statement: string;
}

export interface SCValidationResult {
  scId: string;
  statement: string;
  blocked: boolean;
  reason: string;
  message: string;
}

// ── SC Detection ───────────────────────────────────────────

const SC_LINE_PATTERN = /^- \[ \] (SC-\w+):\s*(.+)$/gm;

/**
 * Extract all unchecked SC lines from content.
 */
function extractSCLines(content: string): NewSC[] {
  const scs: NewSC[] = [];
  const pattern = new RegExp(SC_LINE_PATTERN.source, "gm");
  let match;
  while ((match = pattern.exec(content)) !== null) {
    scs.push({ id: match[1], statement: match[2].trim() });
  }
  return scs;
}

/**
 * Detect new SC lines added in newContent that were not in oldContent.
 * Compares by SC id — if an SC id exists in old content, it's not new.
 */
export function detectNewSCs(oldContent: string, newContent: string): NewSC[] {
  const oldSCs = extractSCLines(oldContent);
  const newSCs = extractSCLines(newContent);
  const oldIds = new Set(oldSCs.map(sc => sc.id));
  return newSCs.filter(sc => !oldIds.has(sc.id));
}

// ── SC Validation ──────────────────────────────────────────

/**
 * Validate new SCs against the matcher registry and behavioral rules.
 *
 * Returns only SCs that have issues (unmatchable without behavioral suffix).
 * Empty array = all SCs are valid.
 *
 * - strict mode: blocked = true for unmatchable SCs
 * - permissive mode: blocked = false (warn only)
 */
export function validateNewSCs(
  newSCs: NewSC[],
  compliance: "strict" | "permissive",
  projectRoot?: string,
): SCValidationResult[] {
  const results: SCValidationResult[] = [];

  for (const sc of newSCs) {
    const parsed: ParsedSC = {
      id: sc.id,
      statement: sc.statement,
      specFile: "",
    };

    // Check if SC has (behavioral) suffix
    if (isBehavioralSC(parsed)) {
      continue; // Explicitly behavioral = allowed
    }

    // Check if SC matches any pattern in the registry
    if (isMatchablePattern(parsed, projectRoot)) {
      continue; // Matchable = allowed
    }

    // Unmatchable and not behavioral — generate validation result
    const blocked = compliance === "strict";
    const reason = blocked
      ? `No matching pattern found in matcher-registry.json`
      : `No matching pattern found (permissive mode — warn only)`;

    const message = blocked
      ? `${sc.id}: Blocked — no matching pattern found. ` +
        `Either rewrite the SC to match a pattern from config/matcher-registry.json ` +
        `(use \`bun scripts/create-sc.ts --list\` to see available patterns), ` +
        `or add the (behavioral) suffix if this SC requires runtime verification.`
      : `${sc.id}: Warning (permissive) — no matching pattern found. ` +
        `Consider rewriting to match a pattern from config/matcher-registry.json ` +
        `or adding the (behavioral) suffix.`;

    results.push({
      scId: sc.id,
      statement: sc.statement,
      blocked,
      reason,
      message,
    });
  }

  return results;
}

// ── Git diff helper ────────────────────────────────────────

/**
 * Get the last committed version of a file from git.
 * Returns empty string if file is not tracked.
 */
export function getLastCommittedContent(filePath: string, cwd?: string): string {
  try {
    const result = spawnSync("git", ["show", `HEAD:${filePath}`], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0) {
      return result.stdout;
    }
    return "";
  } catch {
    return "";
  }
}

// ── Frontmatter helpers ────────────────────────────────────

/**
 * Extract compliance mode from spec frontmatter.
 * Defaults to "strict" if not specified.
 */
export function getComplianceMode(content: string): "strict" | "permissive" {
  const fm = parseFrontmatter(content);
  if (fm?.compliance === "permissive") return "permissive";
  return "strict";
}
