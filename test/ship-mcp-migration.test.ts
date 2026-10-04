import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "workflows", "ship.js");
const shipContent = readFileSync(SHIP_PATH, "utf-8");

// Extract Goal phase section (between PHASE 1: GOAL and PHASE 2: DISCOVERY markers)
const goalPhaseMatch = shipContent.match(
  /\/\/ ═+ *\n\/\/ PHASE 1: GOAL[^\n]*\n\/\/ ═+[\s\S]*?(?=\/\/ ═+ *\n\/\/ PHASE 2:)/
);
const goalPhaseContent = goalPhaseMatch ? goalPhaseMatch[0] : "";

describe("ship.js Goal phase deterministic (#47)", () => {
  // AC-1: Zero await agent calls labeled phase Goal
  test("AC-1: Goal phase contains zero await agent calls", () => {
    const agentCalls =
      goalPhaseContent.match(/await\s+agent\s*\(/g) || [];
    expect(agentCalls.length).toBe(0);
  });

  // AC-2: Goal phase uses exec for gh issue view and SSH pre-flight
  test("AC-2: Goal phase uses exec for gh issue view", () => {
    const execCalls =
      goalPhaseContent.match(/execSync|spawnSync|Bun\.\$|exec\s*\(/g) || [];
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
  });

  // AC-3: Deterministic goal parsing populates all four GOAL_SCHEMA fields
  test("AC-3: Goal phase references all four GOAL_SCHEMA fields", () => {
    const fields = ["issueGoal", "successCriteria", "issueTitle", "labels"];
    for (const field of fields) {
      expect(goalPhaseContent).toContain(field);
    }
  });

  // AC-4: SSH pre-flight produces reachable boolean
  test("AC-4: SSH pre-flight contains reachable field", () => {
    expect(goalPhaseContent).toContain("reachable");
  });
});

describe("ship.js non-Goal phases still use MCP tools (#25)", () => {
  // Verify that MCP tool references still exist in non-Goal phases (Ship, Prove, etc.)
  test("at least three mcp__github__ tool references in non-Goal phases", () => {
    // Remove goal phase content to check the rest
    const nonGoalContent = shipContent.replace(goalPhaseContent, "");
    const mcpRefs = nonGoalContent.match(/mcp__github__/g) || [];
    expect(mcpRefs.length).toBeGreaterThanOrEqual(3);
  });
});
