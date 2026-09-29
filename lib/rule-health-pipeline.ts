/**
 * Rule health pipeline — merges agnix findings with auditor verdicts,
 * generates improvement plans, and rescores after rewrites.
 *
 * Deep module: 3 exports (mergeFindings, generateImprovementPlan, rescoreAfterRewrite),
 * simple interface hiding join logic, factor analysis, and rescore mechanics.
 *
 * AC-2: mergeFindings export
 * AC-3: generateImprovementPlan export
 * AC-4: rescoreAfterRewrite export
 */

import { basename } from "path";
import type { InstructionFinding } from "./compliance.js";
import type { AgentAuditResult } from "./agent-audit.js";
import { COMPLIANCE_FACTORS, type ComplianceFactor } from "./hill-climb.js";

// ── Types ───────────────────────────────────────────────

export interface RuleHealthEntry {
  ruleId: string;
  file: string;
  line: number;
  agnixSeverity: "HIGH" | "MEDIUM" | "LOW" | null;
  agnixMessage: string | null;
  agnixSuggestion: string | null;
  auditVerdict: "FOLLOWED" | "IGNORED" | null;
  auditEvidence: string | null;
  auditWeight: number | null;
}

export interface ImprovementRecommendation {
  ruleId: string;
  file: string;
  line: number;
  factors: ComplianceFactor[];
  recommendations: string[];
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface ImprovementPlan {
  timestamp: string;
  recommendations: ImprovementRecommendation[];
  totalEntries: number;
  actionableCount: number;
}

export interface FileScoreDelta {
  before: number;
  after: number;
  delta: number;
}

export interface RescoreDelta {
  timestamp: string;
  files: Record<string, FileScoreDelta>;
  totalDelta: number;
}

// ── AC-2: mergeFindings ─────────────────────────────────

/**
 * Join agnix InstructionFinding array with auditor rule verdicts
 * on matching rule ID, producing unified RuleHealthEntry records.
 *
 * Unmatched agnix findings get null audit fields.
 * Unmatched audit rules get null agnix fields.
 */
export function mergeFindings(
  agnixFindings: InstructionFinding[],
  auditRules: AgentAuditResult["rules"],
): RuleHealthEntry[] {
  const entries: RuleHealthEntry[] = [];
  const matchedAuditIds = new Set<string>();

  // Match agnix findings to audit rules by rule ID
  for (const finding of agnixFindings) {
    const matchingRule = auditRules.find((r) => r.id === finding.rule);
    if (matchingRule) {
      matchedAuditIds.add(matchingRule.id);
    }

    entries.push({
      ruleId: finding.rule,
      file: finding.file,
      line: finding.line,
      agnixSeverity: finding.severity,
      agnixMessage: finding.message,
      agnixSuggestion: finding.suggestion,
      auditVerdict: matchingRule?.verdict ?? null,
      auditEvidence: matchingRule?.evidence ?? null,
      auditWeight: matchingRule?.weight ?? null,
    });
  }

  // Add unmatched audit rules
  for (const rule of auditRules) {
    if (!matchedAuditIds.has(rule.id)) {
      entries.push({
        ruleId: rule.id,
        file: "",
        line: 0,
        agnixSeverity: null,
        agnixMessage: null,
        agnixSuggestion: null,
        auditVerdict: rule.verdict,
        auditEvidence: rule.evidence,
        auditWeight: rule.weight,
      });
    }
  }

  return entries;
}

// ── AC-3: generateImprovementPlan ───────────────────────

/**
 * Read merged findings and produce an improvement plan with per-rule
 * rewrite recommendations using the 7 compliance factors.
 *
 * Only generates recommendations for rules with IGNORED audit verdict
 * or HIGH agnix severity.
 */
export function generateImprovementPlan(
  entries: RuleHealthEntry[],
): ImprovementPlan {
  const recommendations: ImprovementRecommendation[] = [];

  for (const entry of entries) {
    // Skip rules that are already followed and have no agnix issues
    if (entry.auditVerdict === "FOLLOWED" && entry.agnixSeverity !== "HIGH") {
      continue;
    }

    const factors: ComplianceFactor[] = [];
    const recs: string[] = [];

    // Position: rule is too far down in the file
    if (entry.line > 30) {
      factors.push("position");
      recs.push(`Move rule ${entry.ruleId} from L${entry.line} to top section`);
    }

    // Language: if agnix flagged weak language
    if (entry.agnixMessage?.toLowerCase().includes("vague") ||
        entry.agnixMessage?.toLowerCase().includes("weak") ||
        entry.agnixMessage?.toLowerCase().includes("ambiguous")) {
      factors.push("language");
      recs.push(`Strengthen language: ${entry.agnixSuggestion || "add MUST/MANDATORY"}`);
    }

    // Specificity: missing specific target
    if (entry.agnixMessage?.toLowerCase().includes("specific") ||
        entry.agnixSuggestion?.toLowerCase().includes("specific")) {
      factors.push("specificity");
      recs.push("Make target more specific with exact file paths");
    }

    // Section: rule not in a strong section
    if (entry.auditVerdict === "IGNORED") {
      factors.push("section");
      recs.push("Move to Context or Always Do section for higher compliance");
    }

    // Evidence: no verification command associated
    if (entry.auditVerdict === "IGNORED" && entry.auditWeight && entry.auditWeight >= 10) {
      factors.push("evidence");
      recs.push("Add verification command to make compliance mechanically checkable");
    }

    // If we still have no factors but the rule is IGNORED, add language as default
    if (factors.length === 0 && entry.auditVerdict === "IGNORED") {
      factors.push("language");
      recs.push("Strengthen language to improve compliance");
    }

    // Only add HIGH agnix entries that are already FOLLOWED
    if (factors.length === 0 && entry.agnixSeverity === "HIGH") {
      factors.push("language");
      recs.push(`Address HIGH severity finding: ${entry.agnixMessage}`);
    }

    if (factors.length > 0) {
      const priority = entry.agnixSeverity === "HIGH" || entry.auditVerdict === "IGNORED"
        ? (entry.auditWeight && entry.auditWeight >= 15 ? "HIGH" : "MEDIUM")
        : "LOW";

      recommendations.push({
        ruleId: entry.ruleId,
        file: entry.file,
        line: entry.line,
        factors,
        recommendations: recs,
        priority,
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    recommendations,
    totalEntries: entries.length,
    actionableCount: recommendations.length,
  };
}

// ── AC-4: rescoreAfterRewrite ───────────────────────────

/**
 * Re-run agnix on modified files and return a before-after delta object
 * with per-file score changes.
 *
 * Uses simple word-count heuristic when agnix is not available,
 * counting directive keywords (MUST, NEVER, ALWAYS, MANDATORY).
 */
export function rescoreAfterRewrite(
  modifiedFiles: string[],
  beforeScores: Record<string, number>,
): RescoreDelta {
  const files: Record<string, FileScoreDelta> = {};
  let totalDelta = 0;

  for (const filePath of modifiedFiles) {
    const fileName = basename(filePath);
    const before = beforeScores[fileName] ?? 0;

    // Try agnix, fall back to heuristic word count
    let after = 0;
    try {
      const result = Bun.spawnSync(["agnix", filePath, "--format", "json"], {
        timeout: 10_000,
      });
      const stdout = result.stdout.toString().trim();
      if (stdout) {
        const parsed = JSON.parse(stdout);
        after = (parsed.diagnostics || []).length;
      }
    } catch {
      // Heuristic fallback: count directive keywords in file
      try {
        const { readFileSync } = require("fs");
        const content = readFileSync(filePath, "utf-8");
        const keywords = ["MUST", "NEVER", "ALWAYS", "MANDATORY", "BEFORE"];
        after = keywords.reduce((count, kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, "gi");
          return count + (content.match(regex) || []).length;
        }, 0);
      } catch {
        after = 0;
      }
    }

    const delta = after - before;
    files[fileName] = { before, after, delta };
    totalDelta += delta;
  }

  return {
    timestamp: new Date().toISOString(),
    files,
    totalDelta,
  };
}
