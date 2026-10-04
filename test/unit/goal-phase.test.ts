import { test, expect, describe } from "bun:test";

// Import will be created in lib/goal-parser.ts
import { parseGoalFromIssue, extractSuccessCriteria } from "../../lib/goal-parser";

describe("goal-parser: extractSuccessCriteria", () => {
  test("extracts SC items from checkbox format", () => {
    const body = `## Goal
Some goal text.

## Success Criteria
- [ ] SC-100: First criterion
- [ ] SC-101: Second criterion
- [x] SC-102: Third criterion already done
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "SC-100: First criterion",
      "SC-101: Second criterion",
      "SC-102: Third criterion already done",
    ]);
  });

  test("extracts AC items from numbered list", () => {
    const body = `## Acceptance Criteria
1. AC-1: Goal phase has zero agent calls
2. AC-2: Uses exec for gh issue view
3. AC-3: Parses all four fields
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "AC-1: Goal phase has zero agent calls",
      "AC-2: Uses exec for gh issue view",
      "AC-3: Parses all four fields",
    ]);
  });

  test("returns empty array when no SCs found", () => {
    const body = "Just a description with no criteria";
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([]);
  });

  test("handles mixed SC and AC patterns", () => {
    const body = `## Success Criteria
- [ ] SC-200: A success criterion
- [ ] AC-1: An acceptance criterion
`;
    const scs = extractSuccessCriteria(body);
    expect(scs.length).toBe(2);
  });
});

describe("goal-parser: parseGoalFromIssue", () => {
  test("populates all four GOAL_SCHEMA fields from gh issue JSON", () => {
    const issueJson = {
      title: "Replace ceremony agents with deterministic bash",
      body: `## Goal
Replace read-issue and preflight agents with workflow-native code.

## Success Criteria
- [ ] SC-1: Zero agent calls in goal phase
- [ ] SC-2: Uses exec for gh issue view
`,
      labels: [{ name: "enhancement" }, { name: "P0" }],
    };

    const result = parseGoalFromIssue(issueJson);
    expect(result.issueTitle).toBe("Replace ceremony agents with deterministic bash");
    expect(result.issueGoal).toContain("Replace read-issue");
    expect(result.successCriteria).toBeArrayOfSize(2);
    expect(result.labels).toEqual(["enhancement", "P0"]);
  });

  test("uses title as goal when body has no clear first paragraph", () => {
    const issueJson = {
      title: "Short issue",
      body: "## Success Criteria\n- [ ] SC-1: Do something",
      labels: [],
    };

    const result = parseGoalFromIssue(issueJson);
    expect(result.issueGoal).toBe("Short issue");
    expect(result.issueTitle).toBe("Short issue");
    expect(result.successCriteria).toEqual(["SC-1: Do something"]);
    expect(result.labels).toEqual([]);
  });

  test("handles null body gracefully", () => {
    const issueJson = {
      title: "Empty issue",
      body: null,
      labels: [],
    };

    const result = parseGoalFromIssue(issueJson);
    expect(result.issueTitle).toBe("Empty issue");
    expect(result.issueGoal).toBe("Empty issue");
    expect(result.successCriteria).toEqual([]);
    expect(result.labels).toEqual([]);
  });
});
