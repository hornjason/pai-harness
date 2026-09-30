import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  appendComplianceHistory,
  loadComplianceHistory,
  generateComplianceReport,
  formatComplianceReport,
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
});
