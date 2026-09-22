/**
 * Hill climb mode — runs test-brief up to MAX_ITERATIONS times,
 * tweaking brief between runs using compliance factors.
 *
 * Stops when target score is reached or max iterations exceeded.
 *
 * SC-404: Hill climb mode: 5 iterations max
 */

import type { ComplianceResult } from "./transcript-checker.js";
import type { Directive } from "./directive-extractor.js";

export const MAX_ITERATIONS = 5;
export const DEFAULT_TARGET_SCORE = 80;

export interface HillClimbIteration {
  iteration: number;
  score: number;
  grade: string;
  followed: number;
  ignored: number;
  checkable: number;
  recommendations: string[];
}

export interface HillClimbResult {
  role: string;
  iterations: HillClimbIteration[];
  finalScore: number;
  targetReached: boolean;
  targetScore: number;
}

/**
 * The 7 compliance factors used to generate recommendations
 * for improving brief directive compliance.
 */
export const COMPLIANCE_FACTORS = [
  "position",       // Move ignored directives higher in the brief
  "language",       // Strengthen language (MUST, MANDATORY, BEFORE)
  "specificity",    // Make targets more specific (exact file paths)
  "deduplication",  // Remove duplicate/conflicting directives
  "section",        // Move to stronger sections (Context > Rules > Reference)
  "evidence",       // Add verification commands for "always" directives
  "consolidation",  // Group related directives to reduce cognitive load
] as const;

export type ComplianceFactor = typeof COMPLIANCE_FACTORS[number];

/**
 * Analyze compliance results and generate improvement recommendations.
 */
export function generateRecommendations(
  results: ComplianceResult[],
): { factor: ComplianceFactor; recommendation: string; directive: Directive }[] {
  const recommendations: { factor: ComplianceFactor; recommendation: string; directive: Directive }[] = [];

  for (const r of results) {
    if (r.status === "IGNORED") {
      // Position: directive is too far down
      if (r.directive.line > 30) {
        recommendations.push({
          factor: "position",
          recommendation: `Move "${r.directive.text.substring(0, 40)}" from L${r.directive.line} to Context section`,
          directive: r.directive,
        });
      }

      // Language: weak phrasing
      const textLower = r.directive.text.toLowerCase();
      if (!textLower.includes("must") && !textLower.includes("mandatory") && !textLower.includes("always")) {
        recommendations.push({
          factor: "language",
          recommendation: `Strengthen language in "${r.directive.text.substring(0, 40)}" -- add MUST or MANDATORY`,
          directive: r.directive,
        });
      }

      // Section: not in a strong section
      const sectionLower = r.directive.section.toLowerCase();
      if (!sectionLower.includes("context") && !sectionLower.includes("always") && !sectionLower.includes("core")) {
        recommendations.push({
          factor: "section",
          recommendation: `Move "${r.directive.text.substring(0, 40)}" from "${r.directive.section}" to Context or Always Do`,
          directive: r.directive,
        });
      }

      // Specificity: vague target
      if (r.directive.type === "read" && r.directive.target && !r.directive.target.includes("/")) {
        recommendations.push({
          factor: "specificity",
          recommendation: `Make target more specific: "${r.directive.target}" -> use full relative path`,
          directive: r.directive,
        });
      }
    }
  }

  return recommendations;
}

/**
 * Build a hill climb iteration result from compliance data.
 */
export function buildIteration(
  iteration: number,
  results: ComplianceResult[],
): HillClimbIteration {
  const followed = results.filter((r) => r.status === "FOLLOWED").length;
  const ignored = results.filter((r) => r.status === "IGNORED").length;
  const checkable = results.filter((r) => r.status !== "N/A").length;
  const score = checkable > 0 ? Math.round((followed / checkable) * 100) : 0;
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  const recs = generateRecommendations(results);

  return {
    iteration,
    score,
    grade,
    followed,
    ignored,
    checkable,
    recommendations: recs.map((r) => `[${r.factor}] ${r.recommendation}`),
  };
}

/**
 * Check if target score has been reached.
 */
export function isTargetReached(score: number, targetScore: number = DEFAULT_TARGET_SCORE): boolean {
  return score >= targetScore;
}

/**
 * Check if more iterations are allowed.
 */
export function canContinue(iteration: number): boolean {
  return iteration < MAX_ITERATIONS;
}

/**
 * Format hill climb progress report.
 */
export function formatHillClimbReport(result: HillClimbResult): string {
  const lines: string[] = [];
  lines.push(`\nHILL CLIMB REPORT: ${result.role}`);
  lines.push(`${"=".repeat(50)}`);
  lines.push(`Target: ${result.targetScore}% | Final: ${result.finalScore}% | ${result.targetReached ? "TARGET REACHED" : "TARGET NOT REACHED"}`);
  lines.push(`Iterations: ${result.iterations.length}/${MAX_ITERATIONS}`);
  lines.push("");

  for (const iter of result.iterations) {
    lines.push(`  Iteration ${iter.iteration}: ${iter.grade} (${iter.score}%) -- ${iter.followed}/${iter.checkable} followed`);
    if (iter.recommendations.length > 0) {
      for (const rec of iter.recommendations.slice(0, 3)) {
        lines.push(`    ${rec}`);
      }
    }
  }

  return lines.join("\n");
}
