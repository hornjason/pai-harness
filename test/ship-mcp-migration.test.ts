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

  /**
   * #137 replaced the assertion that used to live here.
   *
   * It read: "MCP GitHub tools still used in non-Goal phases", and passed as
   * long as ship.js mentioned `mcp__github__` at least three times. It was
   * green for every run in which the PR step did nothing at all, because
   * counting references in a prompt says nothing about whether the tool
   * exists in the session running it — and it did not. No role grants
   * `mcp__github__*`, and the server `.mcp.json` names is deprecated on npm
   * and does not connect.
   *
   * What replaces it asserts the operation, not the vocabulary: the GitHub
   * work goes through `scripts/github-op.ts`, which is covered end to end in
   * test/github-op.test.ts against a real HTTP server.
   */
  test("non-Goal GitHub work goes through the Octokit script, not MCP", () => {
    expect(shipContent).not.toContain("mcp__github__");
    expect(shipContent).toContain("scripts/github-op.ts pr-upsert");
    expect(shipContent).toContain("scripts/github-op.ts comment");
  });

  test("the PR step reports whether a PR was actually opened", () => {
    // The step returned nothing before, so a run that opened no PR was
    // indistinguishable from one that did — which is half of why #136 went
    // unnoticed for as long as it did.
    expect(shipContent).toContain("label: 'record-env-and-pr'");
    expect(shipContent).toMatch(/prStep\s*=\s*await agent\(/);
    expect(shipContent).toContain("prStep.ok");
  });
});
