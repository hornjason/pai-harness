import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "workflows", "ship.js");
const shipContent = readFileSync(SHIP_PATH, "utf-8");

describe("ship.js MCP migration (#25)", () => {
  // AC-1: Goal phase uses mcp__github__get_issue
  test("AC-1: Goal phase references mcp__github__get_issue for issue retrieval", () => {
    const matches = shipContent.match(/mcp__github__get_issue/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // AC-2: Zero gh issue CLI calls remain
  test("AC-2: no gh issue CLI calls remain in ship.js", () => {
    const ghIssueCalls = shipContent.match(/gh\s+issue\s+(view|close|comment|edit)/g) || [];
    expect(ghIssueCalls.length).toBe(0);
  });

  // AC-4: At least three mcp__github tool references
  test("AC-4: at least three mcp__github__ tool references", () => {
    const mcpRefs = shipContent.match(/mcp__github__/g) || [];
    expect(mcpRefs.length).toBeGreaterThanOrEqual(3);
  });
});
