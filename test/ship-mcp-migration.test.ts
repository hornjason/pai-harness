import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "workflows", "ship.js");
const shipContent = readFileSync(SHIP_PATH, "utf-8");

describe("ship.js MCP migration (#25) + Goal determinism (#48)", () => {
  // Goal phase uses gh CLI for issue reading (deterministic, no MCP agent)
  test("Goal phase read-issue uses gh CLI, not mcp__github__get_issue", () => {
    const goalPhase = shipContent.match(/PHASE 1: GOAL[^\n]*\n[\s\S]*?(?=\n\/\/ ═{20,})/)?.[0] || "";
    expect(goalPhase).toContain("gh issue view");
    expect(goalPhase).not.toContain("mcp__github__get_issue");
  });

  // Goal phase supports pre-computed goalData bypass
  test("Goal phase accepts pre-computed goalData from args", () => {
    expect(shipContent).toContain("parsedArgs.goalData");
  });

  // Goal phase supports pre-computed preflight bypass
  test("Goal phase accepts pre-computed preflightResults from args", () => {
    expect(shipContent).toContain("parsedArgs.preflightResults");
  });

  // Goal phase supports pre-computed context bypass
  test("Goal phase accepts preloadedContexts from args", () => {
    expect(shipContent).toContain("parsedArgs.preloadedContexts");
  });

  // Other phases still use MCP GitHub tools (PR creation, issue comments, etc.)
  test("MCP GitHub tools still used in non-Goal phases", () => {
    const mcpRefs = shipContent.match(/mcp__github__/g) || [];
    expect(mcpRefs.length).toBeGreaterThanOrEqual(3);
  });
});
