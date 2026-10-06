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

  /**
   * Security review of the migration commit, and it was right. Moving the PR
   * step from an MCP tool call to a shell command turned the issue title from
   * a structured argument into command text — and an issue title is written
   * by whoever files the issue. These are source assertions, which is a weak
   * form; the behaviour they stand for is tested properly in
   * test/github-op.test.ts, where a title of `Bad "; rm -rf / #` reaches
   * GitHub intact and never reaches a shell.
   */
  test("the PR title is composed by the script, not interpolated into the command", () => {
    expect(shipContent).toContain("--title-from-issue");
    expect(shipContent).not.toMatch(/--title\s+"[^"\n]*\$\{goalData/);
  });

  test("the sub-issue title goes through a file, since it comes from a spec heading", () => {
    expect(shipContent).toContain("--title-file");
  });

  test("prove.js embeds the sanitised proof body, not the raw one", () => {
    // What the sanitiser actually DOES is executed in
    // test/workflow-security-integration.test.ts; this only pins that the
    // heredoc uses its output. Asserting "prove.js mentions the delimiter"
    // was the version of this that survived deleting the filter.
    const prove = readFileSync(join(__dirname, "..", "workflows", "prove.js"), "utf-8");
    // Wiring, which is the one thing that can only be checked in the source:
    // prove.js is not importable, so nothing can execute the assignment. Both
    // halves are needed — asserting only the heredoc side left
    // `const safeProofComment = proofComment` passing.
    expect(prove).toMatch(/const safeProofComment = heredocSafe\(proofComment, HEREDOC_DELIMITER\)/);
    expect(prove).toMatch(/^\$\{safeProofComment\}$/m);
    expect(prove).not.toMatch(/^\$\{proofComment\}$/m);
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
