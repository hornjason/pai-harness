import { test, expect, describe } from "bun:test";
import {
  generateCanaryPhrase,
  getDefaultCanaries,
  plantCanaries,
  checkCanaries,
  type CanaryDefinition,
  type CanaryReport,
} from "../lib/canary";

describe("canary: phrase generation", () => {
  test("generates CANARY-{hex} format", () => {
    const phrase = generateCanaryPhrase();
    expect(phrase).toMatch(/^CANARY-[0-9a-f]{8}$/);
  });

  test("generates unique phrases", () => {
    const phrases = new Set(Array.from({ length: 100 }, generateCanaryPhrase));
    expect(phrases.size).toBe(100);
  });
});

describe("canary: default definitions", () => {
  test("returns at least 2 canaries", () => {
    const canaries = getDefaultCanaries();
    expect(canaries.length).toBeGreaterThanOrEqual(2);
  });

  test("each canary has required fields", () => {
    for (const c of getDefaultCanaries()) {
      expect(c.id).toBeTruthy();
      expect(c.phrase).toMatch(/^CANARY-/);
      expect(c.location).toBeTruthy();
      expect(c.expectedBehavior).toBeTruthy();
      expect(typeof c.checkFn).toBe("function");
    }
  });

  test("checkFn returns true when phrase is in transcript", () => {
    const canaries = getDefaultCanaries();
    const fakeTranscript = `Agent output with ${canaries[0].phrase} embedded`;
    expect(canaries[0].checkFn(fakeTranscript)).toBe(true);
  });

  test("checkFn returns false when phrase is missing", () => {
    const canaries = getDefaultCanaries();
    expect(canaries[0].checkFn("no canary here")).toBe(false);
  });
});

describe("canary: planting", () => {
  test("appends canary instruction to brief", () => {
    const canary: CanaryDefinition = {
      id: "T-1",
      phrase: "CANARY-deadbeef",
      location: "brief",
      expectedBehavior: "test",
      checkFn: (t) => t.includes("CANARY-deadbeef"),
    };

    const { brief, planted } = plantCanaries("Original brief content", [canary]);
    expect(brief).toContain("CANARY-deadbeef");
    expect(brief).toContain("verification token");
    expect(planted).toHaveLength(1);
  });

  test("skips non-brief canaries", () => {
    const canary: CanaryDefinition = {
      id: "T-2",
      phrase: "CANARY-12345678",
      location: "agents-md",
      expectedBehavior: "test",
      checkFn: (t) => t.includes("CANARY-12345678"),
    };

    const { brief, planted } = plantCanaries("Original brief", [canary]);
    expect(brief).toBe("Original brief");
    expect(planted).toHaveLength(0);
  });
});

describe("canary: checking", () => {
  test("reports triggered when phrase found in transcript", () => {
    const canary: CanaryDefinition = {
      id: "T-3",
      phrase: "CANARY-aabbccdd",
      location: "brief",
      expectedBehavior: "test",
      checkFn: (t) => t.includes("CANARY-aabbccdd"),
    };

    const report = checkCanaries("Agent said CANARY-aabbccdd", [canary]);
    expect(report.total).toBe(1);
    expect(report.triggered).toBe(1);
    expect(report.score).toBe(100);
    expect(report.results[0].triggered).toBe(true);
  });

  test("reports not triggered when phrase missing", () => {
    const canary: CanaryDefinition = {
      id: "T-4",
      phrase: "CANARY-11223344",
      location: "brief",
      expectedBehavior: "test",
      checkFn: (t) => t.includes("CANARY-11223344"),
    };

    const report = checkCanaries("No canary here", [canary]);
    expect(report.total).toBe(1);
    expect(report.triggered).toBe(0);
    expect(report.score).toBe(0);
  });

  test("handles mixed results", () => {
    const canaries: CanaryDefinition[] = [
      {
        id: "T-5a",
        phrase: "CANARY-found",
        location: "brief",
        expectedBehavior: "test",
        checkFn: (t) => t.includes("CANARY-found"),
      },
      {
        id: "T-5b",
        phrase: "CANARY-missing",
        location: "brief",
        expectedBehavior: "test",
        checkFn: (t) => t.includes("CANARY-missing"),
      },
    ];

    const report = checkCanaries("Output has CANARY-found", canaries);
    expect(report.total).toBe(2);
    expect(report.triggered).toBe(1);
    expect(report.score).toBe(50);
  });

  test("empty canary list returns 100 score", () => {
    const report = checkCanaries("anything", []);
    expect(report.score).toBe(100);
    expect(report.total).toBe(0);
  });

  test("report includes timestamp", () => {
    const report = checkCanaries("x", []);
    expect(report.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
