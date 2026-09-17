import { test, expect, describe } from "bun:test";
import { ACSchema } from "./schema";

function makeAC(overrides: Record<string, any> = {}) {
  return {
    id: "AC-1",
    statement: "Email body assembled from 7 template blocks with personalization tokens",
    threshold: { op: ">=", value: 7 },
    evidence: null,
    ...overrides,
  };
}

function validate(ac: Record<string, any>) {
  return ACSchema.safeParse(ac);
}

function issueMessages(result: ReturnType<typeof validate>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

describe("AC heuristic quality checks", () => {
  test("garbage statement 'file exists' fails validation", () => {
    const result = validate(makeAC({ statement: "file exists" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("garbage statement 'it works' fails validation", () => {
    const result = validate(makeAC({ statement: "it works" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("garbage statement 'tests pass' fails validation", () => {
    const result = validate(makeAC({ statement: "tests pass" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("garbage statement 'code is correct' fails validation", () => {
    const result = validate(makeAC({ statement: "code is correct" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("garbage statement 'no errors' fails validation", () => {
    const result = validate(makeAC({ statement: "no errors" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("garbage statement 'changes are made' fails validation", () => {
    const result = validate(makeAC({ statement: "changes are made" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(true);
  });

  test("weak threshold >= 1 fails validation", () => {
    const result = validate(makeAC({ threshold: { op: ">=", value: 1 } }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("threshold too weak"))).toBe(true);
  });

  test("weak threshold >= 0 fails validation", () => {
    const result = validate(makeAC({ threshold: { op: ">=", value: 0 } }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("threshold too weak"))).toBe(true);
  });

  test("valid statement with threshold >= 7 passes", () => {
    const result = validate(makeAC({
      statement: "Email body assembled from 7 blocks",
      threshold: { op: ">=", value: 7 },
    }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("tautological/garbage"))).toBe(false);
    expect(msgs.some((m) => m.includes("threshold too weak"))).toBe(false);
    expect(msgs.some((m) => m.includes("statement too short"))).toBe(false);
  });

  test("short statement 'fix bug' fails validation (< 5 words)", () => {
    const result = validate(makeAC({ statement: "fix bug" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("statement too short"))).toBe(true);
  });

  test("short statement 'add test' fails validation (< 5 words)", () => {
    const result = validate(makeAC({ statement: "add test" }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("statement too short"))).toBe(true);
  });

  test("threshold >= 5 does NOT trigger weak threshold", () => {
    const result = validate(makeAC({ threshold: { op: ">=", value: 5 } }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("threshold too weak"))).toBe(false);
  });

  test("threshold == 1 does NOT trigger weak threshold (only >= is checked)", () => {
    const result = validate(makeAC({ threshold: { op: "==", value: 1 } }));
    const msgs = issueMessages(result);
    expect(msgs.some((m) => m.includes("threshold too weak"))).toBe(false);
  });
});
