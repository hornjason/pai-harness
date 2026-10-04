import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "workflows", "ship.js");
const shipContent = readFileSync(SHIP_PATH, "utf-8");

// Extract Goal phase section (between PHASE 1: GOAL line and next ═══ PHASE 2 block)
const goalPhaseMatch = shipContent.match(
  /PHASE 1: GOAL[^\n]*\n([\s\S]*?)(?=\/\/ ═{4,}\n\/\/ PHASE 2)/
);
const goalPhase = goalPhaseMatch ? goalPhaseMatch[1] : "";

describe("ship.js deterministic goal phase (#47)", () => {
  // AC-1: Goal phase has zero await agent calls
  test("AC-1: Goal phase contains zero await agent() calls", () => {
    const agentCalls = goalPhase.match(/await\s+agent\s*\(/g) || [];
    expect(agentCalls.length).toBe(0);
  });

  // AC-2: Goal phase uses execSync for gh issue view and SSH pre-flight
  test("AC-2: Goal phase uses execSync for gh CLI and SSH pre-flight", () => {
    const execCalls = goalPhase.match(/execSync\s*\(/g) || [];
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
  });

  // AC-3: Goal phase populates all four GOAL_SCHEMA fields
  test("AC-3: Goal phase populates issueGoal, successCriteria, issueTitle, labels", () => {
    const fields = ["issueGoal", "successCriteria", "issueTitle", "labels"];
    for (const field of fields) {
      expect(goalPhase).toContain(field);
    }
  });

  // AC-4: SSH pre-flight produces reachable boolean
  test("AC-4: SSH pre-flight produces reachable field", () => {
    expect(goalPhase).toContain("reachable");
  });
});

describe("ship.js MCP migration (#25) — updated for deterministic approach", () => {
  // The old mcp__github__get_issue references should be gone from Goal phase
  test("Goal phase no longer references mcp__github__get_issue", () => {
    const mcpInGoal = goalPhase.match(/mcp__github__get_issue/g) || [];
    expect(mcpInGoal.length).toBe(0);
  });

  // Goal phase uses gh issue view via execSync instead
  test("Goal phase uses gh issue view via execSync", () => {
    expect(goalPhase).toContain("gh issue view");
  });
});
