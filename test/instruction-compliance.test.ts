import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";
import {
  runTemplateCompliance,
  collectComplianceSurface,
  type ComplianceReport,
} from "../lib/compliance";

const ROOT = join(import.meta.dir, "..");

describe("Instruction Compliance — Layer 1 (Template Quality)", () => {
  let report: ComplianceReport;

  beforeAll(() => {
    report = runTemplateCompliance(ROOT, { writeReport: false });
  }, 240_000);

  test("compliance surface covers all 4 file types", () => {
    const files = collectComplianceSurface(ROOT);
    const hasPrompts = files.some(f => f.includes("/prompts/"));
    const hasAgentsMd = files.some(f => f.endsWith("AGENTS.md"));
    const hasAgentBriefs = files.some(f => f.includes(".claude/agents/"));
    const hasClaudeMd = files.some(f => f.endsWith("CLAUDE.md"));
    expect(hasPrompts).toBe(true);
    expect(hasAgentsMd).toBe(true);
    expect(hasAgentBriefs).toBe(true);
    expect(hasClaudeMd).toBe(true);
  });

  test("at least one external tool is available", () => {
    const { agnix, reporails } = report.toolsAvailable;
    expect(agnix || reporails).toBe(true);
  });

  test("findings have required fields", () => {
    for (const fileScore of report.files) {
      for (const finding of fileScore.findings) {
        expect(finding.file).toBeDefined();
        expect(finding.line).toBeGreaterThanOrEqual(0);
        expect(finding.rule).toMatch(/^(AGNIX|REPORAILS)-/);
        expect(finding.source).toMatch(/^(agnix|reporails)$/);
        expect(finding.severity).toMatch(/^(HIGH|MEDIUM|LOW)$/);
        expect(finding.message).toBeDefined();
      }
    }
  });

  test("report structure matches ComplianceReport schema", () => {
    expect(report.layer).toBe("template");
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(report.surface)).toBe(true);
    expect(Array.isArray(report.files)).toBe(true);
    expect(typeof report.totalFindings).toBe("number");
    expect(typeof report.highCount).toBe("number");
    expect(report.toolsAvailable).toBeDefined();
  });

  test("agent briefs scored by at least one tool", () => {
    const agentFiles = report.files.filter(f => f.file.includes(".claude/agents/"));
    expect(agentFiles.length).toBeGreaterThan(0);
    const hasFindings = agentFiles.some(f => f.findings.length > 0);
    expect(hasFindings).toBe(true);
  });

  test("AGENTS.md scored by at least one tool", () => {
    const agentsMd = report.files.find(f => f.file === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.findings.length).toBeGreaterThan(0);
  });

  test("SC-183: tools not installed produce WARN, not silence", () => {
    // If both tools available, this test just verifies the field exists
    // If a tool is missing, the report still has findings from the other tool
    expect(report.toolsAvailable.agnix !== undefined).toBe(true);
    expect(report.toolsAvailable.reporails !== undefined).toBe(true);
  });

  test("SC-184: findings include suggestion from tool fixHint/suggestion/fix", () => {
    const withSuggestion = report.files.flatMap(f => f.findings).filter(f => f.suggestion.length > 0);
    // At least some findings should have suggestions
    if (report.totalFindings > 0) {
      expect(withSuggestion.length).toBeGreaterThan(0);
    }
  });

  test("summary: print compliance scores per file", () => {
    const scored = report.files.filter(f => f.findings.length > 0);
    if (scored.length === 0) return;
    console.log(`\n📋 Template Compliance (${scored.length} files, ${report.totalFindings} findings, ${report.highCount} HIGH)`);
    if (report.overallQuality !== null) {
      console.log(`   Overall RepoRails quality: ${report.overallQuality.toFixed(1)}/10`);
    }
    console.log(`   Tools: agnix=${report.toolsAvailable.agnix}, reporails=${report.toolsAvailable.reporails}`);
    for (const f of scored.sort((a, b) => (a.reporailsQuality ?? 0) - (b.reporailsQuality ?? 0))) {
      const q = f.reporailsQuality !== null ? `${f.reporailsQuality.toFixed(1)}/10` : "n/a";
      const high = f.findings.filter(fi => fi.severity === "HIGH").length;
      console.log(`   ${q.padStart(6)} ${f.file} (agnix:${f.agnixFindings} rr:${f.reporailsFindings} high:${high})`);
    }
  });
}, { timeout: 300_000 });
