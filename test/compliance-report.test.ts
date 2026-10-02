import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  appendComplianceHistory,
  loadComplianceHistory,
  generateComplianceReport,
  formatComplianceReport,
  detectHillClimbNeeds,
  applyHillClimb,
  type ComplianceEntry,
  type ComplianceReport,
} from "../lib/compliance-report.js";

const TMP = "/tmp/rungate-compliance-test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<ComplianceEntry> = {}): ComplianceEntry {
  return {
    timestamp: new Date().toISOString(),
    issue: "#100",
    role: "marcus",
    scores: {
      "COMP-7": "FOLLOWED",
      "COMP-12": "FOLLOWED",
      "COMP-13": "FOLLOWED",
    },
    total: 13,
    followed: 11,
    pct: 85,
    flagged: [],
    ...overrides,
  };
}

describe("compliance-report", () => {
  describe("history persistence", () => {
    test("appendComplianceHistory creates file if missing", () => {
      const historyPath = join(TMP, "history.jsonl");
      appendComplianceHistory(historyPath, makeEntry());
      expect(existsSync(historyPath)).toBe(true);
    });

    test("appendComplianceHistory appends entries", () => {
      const historyPath = join(TMP, "history.jsonl");
      appendComplianceHistory(historyPath, makeEntry({ issue: "#1" }));
      appendComplianceHistory(historyPath, makeEntry({ issue: "#2" }));
      const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).issue).toBe("#1");
      expect(JSON.parse(lines[1]).issue).toBe("#2");
    });

    test("loadComplianceHistory reads entries", () => {
      const historyPath = join(TMP, "history.jsonl");
      appendComplianceHistory(historyPath, makeEntry({ issue: "#1" }));
      appendComplianceHistory(historyPath, makeEntry({ issue: "#2" }));
      const entries = loadComplianceHistory(historyPath);
      expect(entries.length).toBe(2);
    });

    test("loadComplianceHistory returns empty for missing file", () => {
      const entries = loadComplianceHistory(join(TMP, "missing.jsonl"));
      expect(entries).toEqual([]);
    });
  });

  describe("report generation", () => {
    test("generates report with current score and threshold", () => {
      const current = makeEntry({ followed: 11, total: 13, pct: 85 });
      const report = generateComplianceReport(current, [], 70);
      expect(report.current.pct).toBe(85);
      expect(report.threshold).toBe(70);
      expect(report.belowThreshold).toBe(false);
    });

    test("belowThreshold true when score under threshold", () => {
      const current = makeEntry({ followed: 6, total: 13, pct: 46 });
      const report = generateComplianceReport(current, [], 70);
      expect(report.belowThreshold).toBe(true);
    });

    test("computes trend from history", () => {
      const history = [
        makeEntry({ pct: 50, issue: "#1" }),
        makeEntry({ pct: 60, issue: "#2" }),
        makeEntry({ pct: 70, issue: "#3" }),
        makeEntry({ pct: 80, issue: "#4" }),
      ];
      const current = makeEntry({ pct: 85, issue: "#5" });
      const report = generateComplianceReport(current, history, 70);
      expect(report.trend.pcts).toEqual([50, 60, 70, 80, 85]);
      expect(report.trend.direction).toBe("improving");
    });

    test("detects declining trend", () => {
      const history = [
        makeEntry({ pct: 90, issue: "#1" }),
        makeEntry({ pct: 85, issue: "#2" }),
        makeEntry({ pct: 75, issue: "#3" }),
        makeEntry({ pct: 65, issue: "#4" }),
      ];
      const current = makeEntry({ pct: 60, issue: "#5" });
      const report = generateComplianceReport(current, history, 70);
      expect(report.trend.direction).toBe("declining");
    });

    test("generates per-COMP trend lines", () => {
      const history = [
        makeEntry({ scores: { "COMP-7": "IGNORED", "COMP-13": "FOLLOWED" } }),
        makeEntry({ scores: { "COMP-7": "FOLLOWED", "COMP-13": "FOLLOWED" } }),
      ];
      const current = makeEntry({ scores: { "COMP-7": "FOLLOWED", "COMP-13": "FOLLOWED" } });
      const report = generateComplianceReport(current, history, 70);
      const comp7 = report.compTrends.find((t) => t.compId === "COMP-7");
      expect(comp7).toBeDefined();
      expect(comp7!.passRate).toBeGreaterThan(0.5);
    });

    test("generates alerts for consistently failing COMPs", () => {
      const history = [
        makeEntry({ scores: { "COMP-1": "IGNORED", "COMP-7": "FOLLOWED" } }),
        makeEntry({ scores: { "COMP-1": "IGNORED", "COMP-7": "FOLLOWED" } }),
        makeEntry({ scores: { "COMP-1": "IGNORED", "COMP-7": "FOLLOWED" } }),
      ];
      const current = makeEntry({ scores: { "COMP-1": "IGNORED", "COMP-7": "FOLLOWED" } });
      const report = generateComplianceReport(current, history, 70);
      expect(report.alerts.length).toBeGreaterThan(0);
      expect(report.alerts.some((a) => a.includes("COMP-1"))).toBe(true);
    });
  });

  describe("report formatting", () => {
    test("formatComplianceReport produces readable output", () => {
      const report: ComplianceReport = {
        role: "marcus",
        issue: "#547",
        current: { followed: 11, total: 13, pct: 85 },
        threshold: 70,
        belowThreshold: false,
        trend: { pcts: [62, 69, 77, 85], direction: "improving" },
        compTrends: [
          { compId: "COMP-7", rule: "No cat/head via Bash", lastN: ["FOLLOWED", "FOLLOWED"], passRate: 1.0, direction: "stable" },
          { compId: "COMP-1", rule: "AGENTS.md context", lastN: ["IGNORED", "IGNORED"], passRate: 0, direction: "stable" },
        ],
        alerts: ["COMP-1: 0% pass rate — consider adding AGENTS.md injection"],
      };
      const output = formatComplianceReport(report);
      expect(output).toContain("COMPLIANCE REPORT");
      expect(output).toContain("marcus");
      expect(output).toContain("85%");
      expect(output).toContain("COMP-7");
      expect(output).toContain("ALERT");
    });

    test("formatComplianceReport shows threshold warning when below", () => {
      const report: ComplianceReport = {
        role: "marcus",
        issue: "#100",
        current: { followed: 5, total: 13, pct: 38 },
        threshold: 70,
        belowThreshold: true,
        trend: { pcts: [38], direction: "stable" },
        compTrends: [],
        alerts: [],
      };
      const output = formatComplianceReport(report);
      expect(output).toContain("BELOW THRESHOLD");
    });
  });

  describe("auto hill-climb", () => {
    test("detectHillClimbNeeds returns actions for 3+ consecutive fails", () => {
      const report: ComplianceReport = {
        role: "marcus",
        issue: "#100",
        current: { followed: 8, total: 13, pct: 62 },
        threshold: 70,
        belowThreshold: true,
        trend: { pcts: [62], direction: "stable" },
        compTrends: [
          { compId: "COMP-7", rule: "No cat/head via Bash", lastN: ["IGNORED", "IGNORED", "IGNORED"], passRate: 0, direction: "stable" },
          { compId: "COMP-13", rule: "TDD ordering", lastN: ["FOLLOWED", "FOLLOWED", "FOLLOWED"], passRate: 1, direction: "stable" },
          { compId: "COMP-12", rule: "Grep before Read", lastN: ["IGNORED", "FOLLOWED", "IGNORED"], passRate: 0.33, direction: "stable" },
        ],
        alerts: [],
      };
      const actions = detectHillClimbNeeds(report);
      expect(actions.length).toBe(1);
      expect(actions[0].compId).toBe("COMP-7");
      expect(actions[0].consecutiveFails).toBe(3);
    });

    test("detectHillClimbNeeds ignores non-brief-fixable COMPs", () => {
      const report: ComplianceReport = {
        role: "marcus",
        issue: "#100",
        current: { followed: 8, total: 13, pct: 62 },
        threshold: 70,
        belowThreshold: true,
        trend: { pcts: [62], direction: "stable" },
        compTrends: [
          { compId: "COMP-1", rule: "AGENTS.md context", lastN: ["IGNORED", "IGNORED", "IGNORED"], passRate: 0, direction: "stable" },
          { compId: "COMP-5", rule: "Governing spec", lastN: ["IGNORED", "IGNORED", "IGNORED"], passRate: 0, direction: "stable" },
        ],
        alerts: [],
      };
      const actions = detectHillClimbNeeds(report);
      expect(actions.length).toBe(0);
    });

    test("applyHillClimb adds reinforcement to brief", () => {
      const briefPath = join(TMP, "marcus.md");
      writeFileSync(briefPath, `---
name: marcus
---

## Core Principles
- Verify before asserting

## Efficiency Rules
- Don't run pwd

## Workflow
1. Write test first
`);
      const actions = [{
        compId: "COMP-7",
        rule: "No cat/head via Bash",
        reinforcement: "NEVER use cat, head, or tail via Bash — including piped (grep | head). Use Read with offset/limit.",
        consecutiveFails: 3,
      }];
      const result = applyHillClimb(briefPath, actions);
      expect(result.applied.length).toBe(1);
      expect(result.applied[0]).toContain("COMP-7");

      const updated = readFileSync(briefPath, "utf-8");
      expect(updated).toContain("REINFORCED (auto)");
      expect(updated).toContain("NEVER use cat");
    });

    test("applyHillClimb skips if reinforcement already present", () => {
      const briefPath = join(TMP, "marcus.md");
      writeFileSync(briefPath, `---
name: marcus
---

## Efficiency Rules
- NEVER use cat, head, or tail via Bash — including piped (grep | head). Use Read with offset/limit.

## Workflow
1. Write test first
`);
      const actions = [{
        compId: "COMP-7",
        rule: "No cat/head via Bash",
        reinforcement: "NEVER use cat, head, or tail via Bash — including piped (grep | head). Use Read with offset/limit.",
        consecutiveFails: 4,
      }];
      const result = applyHillClimb(briefPath, actions);
      expect(result.applied.length).toBe(0);
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0]).toContain("already present");
    });

    test("detectHillClimbNeeds maps DIR-L29 to COMP-2 for escalation", () => {
      const report: ComplianceReport = {
        role: "marcus",
        issue: "#100",
        current: { followed: 8, total: 13, pct: 62 },
        threshold: 70,
        belowThreshold: true,
        trend: { pcts: [62], direction: "stable" },
        compTrends: [
          { compId: "DIR-L29", rule: "bun test at most TWICE", lastN: ["VIOLATED", "VIOLATED", "VIOLATED", "VIOLATED", "VIOLATED", "VIOLATED"], passRate: 0, direction: "stable" },
        ],
        alerts: [],
      };
      const actions = detectHillClimbNeeds(report);
      expect(actions.length).toBe(1);
      expect(actions[0].compId).toBe("COMP-2");
      expect(actions[0].consecutiveFails).toBe(6);
      expect(actions[0].tier).toBe(3);
      expect(actions[0].promotion).toContain("test-run limiter");
    });

    test("detectHillClimbNeeds maps DIR-L25 to COMP-7 for escalation", () => {
      const report: ComplianceReport = {
        role: "discovery",
        issue: "#100",
        current: { followed: 3, total: 6, pct: 50 },
        threshold: 70,
        belowThreshold: true,
        trend: { pcts: [50], direction: "stable" },
        compTrends: [
          { compId: "DIR-L25", rule: "cat via Bash", lastN: ["VIOLATED", "VIOLATED", "VIOLATED", "VIOLATED", "VIOLATED"], passRate: 0, direction: "stable" },
        ],
        alerts: [],
      };
      const actions = detectHillClimbNeeds(report);
      expect(actions.length).toBe(1);
      expect(actions[0].compId).toBe("COMP-7");
      expect(actions[0].tier).toBe(3);
    });
  });
});
