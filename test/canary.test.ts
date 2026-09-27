import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  generateCanaryPhrase,
  getDefaultCanaries,
  plantCanaries,
  checkCanaries,
  type CanaryDefinition,
  type CanaryReport,
} from "../lib/canary";
import { assembleBrief } from "../gates/brief-assembler";
import { checkComplianceWithCanaries } from "../lib/transcript-checker";
import { extractDirectives } from "../lib/directive-extractor";

const ROOT = join(import.meta.dir, "..");

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

describe("canary: brief assembler integration", () => {
  const tmpDir = join(ROOT, "test/fixtures/tmp-canary-integration");

  afterAll(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("assembleBrief plants canaries in the output brief", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "workflow-state.json"),
      JSON.stringify({
        acs: [{ id: "AC-1", statement: "test canary integration", type: "CODE" }],
        issue: 999,
        issueGoal: "Test canary planting in brief assembler",
      }),
    );

    const result = await assembleBrief({
      slug: "test-canary",
      workDir: tmpDir,
      projectRoot: ROOT,
    });

    const briefContent = readFileSync(result.briefPath, "utf-8");
    expect(briefContent).toContain("CANARY-");
    expect(briefContent).toContain("Canary Check");
    expect(briefContent).toContain("verification token");
  });

  test("brief-assembler.ts imports canary module", () => {
    const content = readFileSync(join(ROOT, "gates/brief-assembler.ts"), "utf-8");
    expect(content).toContain("plantCanaries");
    expect(content).toMatch(/from\s+["'].*canary/);
  });
});

describe("canary: transcript checker integration", () => {
  test("checkComplianceWithCanaries combines directive and canary checks", () => {
    const briefContent = readFileSync(join(ROOT, ".claude/agents/marcus.md"), "utf-8");
    const directives = extractDirectives(briefContent);
    const canaries: CanaryDefinition[] = [
      {
        id: "integration-test",
        phrase: "CANARY-integration1",
        location: "brief",
        expectedBehavior: "test integration",
        checkFn: (t) => t.includes("CANARY-integration1"),
      },
    ];

    const transcript = readFileSync(
      join(ROOT, "test/fixtures/transcripts/agent-marcus-impl1.jsonl"),
      "utf-8",
    );

    const result = checkComplianceWithCanaries(directives, transcript, canaries);
    expect(result.compliance).toBeDefined();
    expect(result.compliance.length).toBeGreaterThan(0);
    expect(result.canaryReport).toBeDefined();
    expect(result.canaryReport.total).toBe(1);
    // Canary phrase is NOT in the fixture transcript, so it should not be triggered
    expect(result.canaryReport.triggered).toBe(0);
  });

  test("transcript-checker.ts imports canary module", () => {
    const content = readFileSync(join(ROOT, "lib/transcript-checker.ts"), "utf-8");
    expect(content).toContain("checkCanaries");
    expect(content).toMatch(/from\s+["'].*canary/);
  });
});
