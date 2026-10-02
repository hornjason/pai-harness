import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { harnessRoot } from "../lib/paths";

const HR = harnessRoot();
const SHIP_JS = readFileSync(join(HR, "workflows/ship.js"), "utf-8");

describe("MCP migration: ship.js gh CLI → mcp__github__ tools (#25)", () => {
  test("AC-1: Goal phase references mcp__github__get_issue for issue retrieval", () => {
    // The Goal phase agent prompt must reference the MCP tool instead of gh CLI
    expect(SHIP_JS).toContain("mcp__github__get_issue");
  });

  test("AC-2: ship.js contains zero gh issue CLI calls", () => {
    // All gh issue view/comment/edit/close calls must be replaced
    const ghIssueCalls = SHIP_JS.match(/gh\s+issue\s+(view|close|comment|edit)/g) || [];
    expect(ghIssueCalls.length).toBe(0);
  });

  test("AC-4: ship.js contains at least three mcp__github tool references", () => {
    const mcpRefs = SHIP_JS.match(/mcp__github__/g) || [];
    expect(mcpRefs.length).toBeGreaterThanOrEqual(3);
  });
});
