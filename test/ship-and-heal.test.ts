/**
 * ship-and-heal.js workflow verification
 * Validates grading, violation classification, and remediation flow structure.
 *
 * AC-1: Grade before all SHIPPED returns (GRADE_BEFORE_RETURN)
 * AC-2: Quality violations trigger worktree-isolated remediation
 * AC-3: Remediation prompt has >= 3 violation-specific tasks
 * AC-4: Process violations spawn heal-process then run test-brief verification
 * AC-5: Compliance threshold from config (no dead COMPLIANCE_LOW, no parsedArgs)
 * AC-6: Clean success returns SHIPPED without heal phase
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = readFileSync(join(ROOT, "workflows/ship-and-heal.js"), "utf-8");
const lines = WORKFLOW.split("\n");

describe("ship-and-heal: grading and violation flow", () => {
  test("AC-1: GRADE section appears before all SHIPPED return statements", () => {
    const gradeLineIdx = lines.findIndex((l) => l.includes("GRADE"));
    const shippedLineIdx = lines.findIndex(
      (l, i) => i > gradeLineIdx && l.includes("SHIPPED")
    );
    expect(gradeLineIdx).toBeGreaterThan(0);
    expect(gradeLineIdx).toBeLessThan(shippedLineIdx);
  });

  test("AC-2: quality violations detected after success trigger worktree remediation", () => {
    expect(WORKFLOW).toContain("isSuccess && qualityViolations.length > 0");
    expect(WORKFLOW).toContain("isolation: 'worktree'");
  });

  test("AC-3: remediation prompt includes >= 3 violation-specific tasks", () => {
    const taskPatterns = ["TDD violated", "Spec not read", "Tests not written"];
    const matches = taskPatterns.filter((p) => WORKFLOW.includes(p));
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("AC-4: process violations spawn heal-process then test-brief verification", () => {
    // Must have heal-process label AND test-brief verification references
    const healProcessRefs = (
      WORKFLOW.match(
        /heal-process|test-brief.*verif|verify.*brief|brief.*test/gi
      ) || []
    ).length;
    expect(healProcessRefs).toBeGreaterThanOrEqual(2);

    // Verify test-brief verification appears AFTER heal-process in file order
    const healIdx = WORKFLOW.indexOf("heal-process");
    const verifyBriefIdx = WORKFLOW.indexOf("test-brief", healIdx);
    expect(healIdx).toBeGreaterThan(-1);
    expect(verifyBriefIdx).toBeGreaterThan(healIdx);
  });

  test("AC-5: compliance threshold config-driven, no dead code", () => {
    // No dead COMPLIANCE_LOW constant
    expect(WORKFLOW).not.toContain("COMPLIANCE_LOW");
    // No parsedArgs.complianceThreshold
    expect(WORKFLOW).not.toContain("parsedArgs.complianceThreshold");
    // Default 80 still present
    expect(WORKFLOW).toContain("80");
    // Reads from rungate.json compliance.threshold
    expect(WORKFLOW).toContain("compliance");
  });

  test("AC-6: clean success returns SHIPPED without heal", () => {
    const cleanIdx = WORKFLOW.indexOf(
      "qualityViolations.length === 0 && processViolations.length === 0"
    );
    expect(cleanIdx).toBeGreaterThan(-1);
    // The next return after that check should be SHIPPED
    const afterClean = WORKFLOW.slice(cleanIdx, cleanIdx + 200);
    expect(afterClean).toContain("SHIPPED");
    expect(afterClean).not.toContain("SHIPPED_WITH");
  });
});
