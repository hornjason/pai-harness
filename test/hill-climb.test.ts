import { describe, test, expect } from "bun:test";
import {
  MAX_ITERATIONS,
  DEFAULT_TARGET_SCORE,
  COMPLIANCE_FACTORS,
  buildIteration,
  generateRecommendations,
  isTargetReached,
  canContinue,
  formatHillClimbReport,
  type HillClimbResult,
} from "../lib/hill-climb.js";
import type { ComplianceResult } from "../lib/transcript-checker.js";
import type { Directive } from "../lib/directive-extractor.js";

function makeResult(status: ComplianceResult["status"], line = 1, section = "Test"): ComplianceResult {
  return {
    directive: { text: "test", type: "read", line, section, target: "file.md" },
    status,
    evidence: "test evidence",
  };
}

describe("hill-climb", () => {
  test("MAX_ITERATIONS is 5 (AC-5)", () => {
    expect(MAX_ITERATIONS).toBe(5);
  });

  test("DEFAULT_TARGET_SCORE is 80", () => {
    expect(DEFAULT_TARGET_SCORE).toBe(80);
  });

  test("has 7 compliance factors (AC-5)", () => {
    expect(COMPLIANCE_FACTORS).toHaveLength(7);
    expect(COMPLIANCE_FACTORS).toContain("position");
    expect(COMPLIANCE_FACTORS).toContain("language");
    expect(COMPLIANCE_FACTORS).toContain("specificity");
    expect(COMPLIANCE_FACTORS).toContain("deduplication");
    expect(COMPLIANCE_FACTORS).toContain("section");
    expect(COMPLIANCE_FACTORS).toContain("evidence");
    expect(COMPLIANCE_FACTORS).toContain("consolidation");
  });

  test("buildIteration computes score from results", () => {
    const results: ComplianceResult[] = [
      makeResult("FOLLOWED"),
      makeResult("FOLLOWED"),
      makeResult("IGNORED"),
    ];
    const iter = buildIteration(1, results);

    expect(iter.iteration).toBe(1);
    expect(iter.score).toBe(67); // 2/3
    expect(iter.followed).toBe(2);
    expect(iter.ignored).toBe(1);
    expect(iter.checkable).toBe(3);
  });

  test("buildIteration skips N/A results in score", () => {
    const results: ComplianceResult[] = [
      makeResult("FOLLOWED"),
      makeResult("N/A"),
    ];
    const iter = buildIteration(1, results);

    expect(iter.score).toBe(100);
    expect(iter.checkable).toBe(1);
  });

  test("isTargetReached returns true when score meets target", () => {
    expect(isTargetReached(80, 80)).toBe(true);
    expect(isTargetReached(90, 80)).toBe(true);
    expect(isTargetReached(79, 80)).toBe(false);
  });

  test("canContinue returns true when iteration < MAX_ITERATIONS", () => {
    expect(canContinue(0)).toBe(true);
    expect(canContinue(4)).toBe(true);
    expect(canContinue(5)).toBe(false);
    expect(canContinue(6)).toBe(false);
  });

  test("generateRecommendations identifies position issues for deep directives", () => {
    const results: ComplianceResult[] = [
      {
        directive: { text: "Read file.md", type: "read", line: 50, section: "Reference", target: "file.md" },
        status: "IGNORED",
        evidence: "Not read",
      },
    ];
    const recs = generateRecommendations(results);

    expect(recs.some((r) => r.factor === "position")).toBe(true);
  });

  test("generateRecommendations identifies weak language", () => {
    const results: ComplianceResult[] = [
      {
        directive: { text: "Read file.md", type: "read", line: 5, section: "Reference", target: "file.md" },
        status: "IGNORED",
        evidence: "Not read",
      },
    ];
    const recs = generateRecommendations(results);

    expect(recs.some((r) => r.factor === "language")).toBe(true);
  });

  test("generateRecommendations skips FOLLOWED directives", () => {
    const results: ComplianceResult[] = [
      makeResult("FOLLOWED"),
    ];
    const recs = generateRecommendations(results);

    expect(recs).toHaveLength(0);
  });

  test("formatHillClimbReport includes role and target info", () => {
    const result: HillClimbResult = {
      role: "marcus",
      iterations: [{ iteration: 1, score: 70, grade: "C", followed: 7, ignored: 3, checkable: 10, recommendations: [] }],
      finalScore: 70,
      targetReached: false,
      targetScore: 80,
    };
    const report = formatHillClimbReport(result);

    expect(report).toContain("marcus");
    expect(report).toContain("80%");
    expect(report).toContain("70%");
    expect(report).toContain("TARGET NOT REACHED");
  });

  test("formatHillClimbReport shows TARGET REACHED when score meets target", () => {
    const result: HillClimbResult = {
      role: "marcus",
      iterations: [{ iteration: 1, score: 85, grade: "B", followed: 8, ignored: 2, checkable: 10, recommendations: [] }],
      finalScore: 85,
      targetReached: true,
      targetScore: 80,
    };
    const report = formatHillClimbReport(result);

    expect(report).toContain("TARGET REACHED");
  });
});
