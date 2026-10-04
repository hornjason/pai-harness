import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "workflows", "ship.js");
const shipContent = readFileSync(SHIP_PATH, "utf-8");

// Helper: extract Goal phase body (between PHASE 1: GOAL separator block and PHASE 2 separator block)
function getGoalSection(): string {
  // Match everything after the GOAL header separator block, up to the PHASE 2 separator block
  const match = shipContent.match(
    /\/\/ PHASE 1: GOAL\n\/\/ ═+\n([\s\S]*?)(?=\n\/\/ ═+\n\/\/ PHASE 2:)/
  );
  return match?.[1] || "";
}

describe("ship.js goal phase deterministic (#48)", () => {
  // AC-1: Goal phase has zero await agent calls
  test("AC-1: Goal phase contains zero await agent calls", () => {
    const goalSection = getGoalSection();
    const agentCalls = goalSection.match(/await\s+agent\s*\(/g) || [];
    expect(agentCalls.length).toBe(0);
  });

  // AC-2: Goal phase uses exec for gh issue view and SSH pre-flight
  test("AC-2: Goal phase uses exec/spawn for deterministic operations", () => {
    const goalSection = getGoalSection();
    const execCalls = goalSection.match(/execSync|spawnSync|Bun\.\$|exec\(/g) || [];
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
  });

  // AC-3: Deterministic goal parsing populates all four GOAL_SCHEMA fields
  test("AC-3: Goal phase references all four GOAL_SCHEMA fields", () => {
    const goalSection = getGoalSection();
    const fields = ["issueGoal", "successCriteria", "issueTitle", "labels"];
    for (const field of fields) {
      expect(goalSection).toContain(field);
    }
  });

  // AC-4: SSH pre-flight produces reachable field
  test("AC-4: SSH pre-flight produces reachable boolean", () => {
    const goalSection = getGoalSection();
    expect(goalSection).toContain("reachable");
  });

  // Zero gh issue CLI calls remain (kept from old test for backwards compat)
  test("no gh issue CLI calls remain outside goal-parser imports", () => {
    // The goal phase should use lib/goal-parser which calls gh internally;
    // ship.js itself should not have raw gh issue CLI calls
    const ghIssueCalls = shipContent.match(/gh\s+issue\s+(close|comment|edit)/g) || [];
    expect(ghIssueCalls.length).toBe(0);
  });
});
