import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const shipJs = readFileSync(
  join(import.meta.dir, "..", "workflows", "ship.js"),
  "utf-8",
);

describe("MCP migration — ship.js agent prompts", () => {
  test("AC-1: Goal phase references mcp__github__get_issue instead of gh issue view", () => {
    expect(shipJs).toContain("mcp__github__get_issue");
  });

  test("AC-2: Prove phase references mcp__github__add_issue_comment instead of gh issue comment", () => {
    expect(shipJs).toContain("mcp__github__add_issue_comment");
  });

  test("AC-2: Prove phase references mcp__github__update_issue instead of gh issue edit/close", () => {
    expect(shipJs).toContain("mcp__github__update_issue");
  });

  test("AC-3: No gh issue CLI commands remain in agent prompts", () => {
    // Extract only agent prompt sections (template literals passed to agent())
    // We check that no `gh issue` commands appear in ship.js agent prompts.
    // The gate test (workflow.test.ts:993) uses gh issue in its OWN code — that's fine.
    // We only care about ship.js itself.
    const ghIssueMatches = shipJs.match(/gh issue (view|comment|edit|close)/g) || [];
    expect(ghIssueMatches.length).toBe(0);
  });
});
