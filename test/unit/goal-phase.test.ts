import { test, expect, describe } from "bun:test";

// Import the functions we will create in lib/goal-phase.ts
import { parseGoalFromIssue, extractSuccessCriteria } from "../../lib/goal-phase";

describe("goal-phase: extractSuccessCriteria", () => {
  test("extracts SC lines with checkbox format", () => {
    const body = `## Goal
Some goal text here.

## Success Criteria
- [ ] SC-100: First criterion
- [ ] SC-101: Second criterion
- [x] SC-102: Third criterion (done)
`;
    const result = extractSuccessCriteria(body);
    expect(result).toEqual([
      "SC-100: First criterion",
      "SC-101: Second criterion",
      "SC-102: Third criterion (done)",
    ]);
  });

  test("extracts AC lines with checkbox format", () => {
    const body = `## Acceptance Criteria
- [ ] AC-1: Goal phase has zero agent calls
- [ ] AC-2: Uses exec for gh issue view
`;
    const result = extractSuccessCriteria(body);
    expect(result).toEqual([
      "AC-1: Goal phase has zero agent calls",
      "AC-2: Uses exec for gh issue view",
    ]);
  });

  test("returns empty array when no SCs found", () => {
    const body = `Just a regular issue body with no criteria.`;
    const result = extractSuccessCriteria(body);
    expect(result).toEqual([]);
  });

  test("handles mixed SC and AC formats", () => {
    const body = `## Plan
- [ ] SC-200: A success criterion
- [ ] AC-3: An acceptance criterion
- Some other bullet
`;
    const result = extractSuccessCriteria(body);
    expect(result).toEqual([
      "SC-200: A success criterion",
      "AC-3: An acceptance criterion",
    ]);
  });

  test("handles numbered list format", () => {
    const body = `## Success Criteria
1. SC-300: First
2. SC-301: Second
`;
    const result = extractSuccessCriteria(body);
    expect(result).toEqual(["SC-300: First", "SC-301: Second"]);
  });
});

describe("goal-phase: parseGoalFromIssue", () => {
  test("populates all four GOAL_SCHEMA fields", () => {
    const issueJson = {
      title: "Pipeline optimization phase 1",
      body: `Replace ceremony agents with deterministic bash.

## Success Criteria
- [ ] SC-100: Zero agent calls in goal phase
- [ ] SC-101: Uses exec for gh issue view
`,
      labels: [{ name: "enhancement" }, { name: "P0" }],
    };
    const result = parseGoalFromIssue(issueJson);
    expect(result.issueTitle).toBe("Pipeline optimization phase 1");
    expect(result.issueGoal).toBe(
      "Replace ceremony agents with deterministic bash."
    );
    expect(result.successCriteria).toEqual([
      "SC-100: Zero agent calls in goal phase",
      "SC-101: Uses exec for gh issue view",
    ]);
    expect(result.labels).toEqual(["enhancement", "P0"]);
  });

  test("uses title as goal when body is short", () => {
    const issueJson = {
      title: "Fix the thing",
      body: "",
      labels: [],
    };
    const result = parseGoalFromIssue(issueJson);
    expect(result.issueGoal).toBe("Fix the thing");
    expect(result.issueTitle).toBe("Fix the thing");
    expect(result.successCriteria).toEqual([]);
    expect(result.labels).toEqual([]);
  });

  test("extracts first paragraph as goal", () => {
    const issueJson = {
      title: "Big feature",
      body: `This is the main goal statement that spans one paragraph.

## Details
More stuff here.

## Success Criteria
- [ ] SC-1: Something
`,
      labels: [{ name: "feature" }],
    };
    const result = parseGoalFromIssue(issueJson);
    expect(result.issueGoal).toBe(
      "This is the main goal statement that spans one paragraph."
    );
    expect(result.successCriteria).toEqual(["SC-1: Something"]);
  });
});
