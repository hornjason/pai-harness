import { test, expect, describe } from "bun:test";
import { extractSuccessCriteria, parseIssueGoal } from "../../lib/goal-parser";

describe("goal-parser: extractSuccessCriteria", () => {
  test("extracts SC items from checkbox format", () => {
    const body = `## Goal
Some description here.

## Success Criteria
- [ ] SC-1: First criterion
- [ ] SC-2: Second criterion
- [ ] SC-3: Third criterion
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "SC-1: First criterion",
      "SC-2: Second criterion",
      "SC-3: Third criterion",
    ]);
  });

  test("extracts SC items from checked checkboxes", () => {
    const body = `## Success Criteria
- [x] SC-1: Already done
- [ ] SC-2: Not done yet
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "SC-1: Already done",
      "SC-2: Not done yet",
    ]);
  });

  test("extracts AC items when labeled as AC instead of SC", () => {
    const body = `## Acceptance Criteria
- [ ] AC-1: First acceptance criterion
- [ ] AC-2: Second acceptance criterion
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "AC-1: First acceptance criterion",
      "AC-2: Second acceptance criterion",
    ]);
  });

  test("extracts plain checkbox items without SC/AC prefix", () => {
    const body = `## Success Criteria
- [ ] Replace agent calls with exec
- [ ] Add unit tests for parser
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "Replace agent calls with exec",
      "Add unit tests for parser",
    ]);
  });

  test("returns empty array when no SCs found", () => {
    const body = `## Goal
Just a simple description with no criteria.
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([]);
  });

  test("handles numbered list format", () => {
    const body = `## Success Criteria
1. SC-1: First item
2. SC-2: Second item
3. SC-3: Third item
`;
    const scs = extractSuccessCriteria(body);
    expect(scs).toEqual([
      "SC-1: First item",
      "SC-2: Second item",
      "SC-3: Third item",
    ]);
  });
});

describe("goal-parser: parseIssueGoal", () => {
  test("populates all four GOAL_SCHEMA fields from gh issue JSON", () => {
    const issueJson = {
      title: "Pipeline optimization phase 1",
      body: `Replace ceremony agents with deterministic bash.

## Success Criteria
- [ ] SC-1: Goal phase has zero agent calls
- [ ] SC-2: Uses execSync for gh issue view
`,
      labels: [{ name: "enhancement" }, { name: "P0" }],
    };

    const result = parseIssueGoal(issueJson);
    expect(result.issueTitle).toBe("Pipeline optimization phase 1");
    expect(result.issueGoal).toBe("Replace ceremony agents with deterministic bash.");
    expect(result.successCriteria).toEqual([
      "SC-1: Goal phase has zero agent calls",
      "SC-2: Uses execSync for gh issue view",
    ]);
    expect(result.labels).toEqual(["enhancement", "P0"]);
  });

  test("uses title as goal when body is short", () => {
    const issueJson = {
      title: "Fix the bug",
      body: "",
      labels: [],
    };

    const result = parseIssueGoal(issueJson);
    expect(result.issueTitle).toBe("Fix the bug");
    expect(result.issueGoal).toBe("Fix the bug");
    expect(result.successCriteria).toEqual([]);
    expect(result.labels).toEqual([]);
  });

  test("extracts first paragraph as goal", () => {
    const issueJson = {
      title: "Some title",
      body: `This is the main goal statement that spans
multiple lines in the first paragraph.

## Details
More details here.

## Success Criteria
- [ ] SC-1: Something
`,
      labels: [{ name: "bug" }],
    };

    const result = parseIssueGoal(issueJson);
    expect(result.issueGoal).toBe(
      "This is the main goal statement that spans\nmultiple lines in the first paragraph."
    );
    expect(result.successCriteria).toEqual(["SC-1: Something"]);
    expect(result.labels).toEqual(["bug"]);
  });
});
