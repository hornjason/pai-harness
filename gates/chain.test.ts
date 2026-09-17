import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { GoalRecordSchema, ShipEvidenceSchema, ProveEvidenceSchema } from "./schema";

const TEST_DIR = process.env.TEST_WORK_DIR || "";

function tryRead(filename: string) {
  const path = `${TEST_DIR}/${filename}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("chain: goal → ship → prove artifacts", () => {
  test("goal-record.json validates if present", () => {
    const data = tryRead("goal-record.json");
    if (!data) return;
    const result = GoalRecordSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      expect(issues).toEqual([]);
    }
  });

  test("goal-record has non-empty success criteria", () => {
    const data = tryRead("goal-record.json");
    if (!data) return;
    expect(data.successCriteria.length).toBeGreaterThan(0);
  });

  test("goal-record SCs all have thresholds", () => {
    const data = tryRead("goal-record.json");
    if (!data) return;
    const missing = data.successCriteria.filter((sc: any) => !sc.threshold);
    expect(missing.map((sc: any) => sc.id)).toEqual([]);
  });

  test("ship-evidence.json validates if present", () => {
    const data = tryRead("ship-evidence.json");
    if (!data) return;
    const result = ShipEvidenceSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      expect(issues).toEqual([]);
    }
  });

  test("ship-evidence has no FAIL results when status is PASS", () => {
    const data = tryRead("ship-evidence.json");
    if (!data || data.gateOut.status !== "PASS") return;
    const fails = data.gateOut.evidence.filter((e: any) => e.result === "FAIL");
    expect(fails.map((e: any) => e.criterion)).toEqual([]);
  });

  test("prove-evidence.json validates if present", () => {
    const data = tryRead("prove-evidence.json");
    if (!data) return;
    const result = ProveEvidenceSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      expect(issues).toEqual([]);
    }
  });

  test("prove verdict consistent with before/after evidence", () => {
    const data = tryRead("prove-evidence.json");
    if (!data) return;
    if (data.verdict === "PROVEN") {
      expect(data.afterEvidence.description.length).toBeGreaterThan(0);
      expect(data.comparisonSummary.length).toBeGreaterThan(0);
    }
  });

  test("prove PROVEN has no unresolved gaps", () => {
    const data = tryRead("prove-evidence.json");
    if (!data || data.verdict !== "PROVEN") return;
    const unresolved = (data.gaps || []).filter((g: any) => g.status === "UNPROVEN");
    expect(unresolved.map((g: any) => g.ac)).toEqual([]);
  });

  test("chain consistency: issue numbers match across artifacts", () => {
    const goal = tryRead("goal-record.json");
    const ship = tryRead("ship-evidence.json");
    const prove = tryRead("prove-evidence.json");
    if (!goal || !ship) return;
    const goalNum = parseInt(goal.id.replace("issue-", ""));
    expect(ship.issueNumber).toBe(goalNum);
    if (prove) {
      expect(prove.issueNumber).toBe(goalNum);
    }
  });
});
