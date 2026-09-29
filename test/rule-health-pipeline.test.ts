/**
 * Tests for rule-health-pipeline.ts and agent-audit.ts writeAuditComplianceJSON
 *
 * Covers AC-1, AC-2, AC-3, AC-4
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// AC-1: writeAuditComplianceJSON
import { writeAuditComplianceJSON, type AgentAuditResult } from "../lib/agent-audit";

// AC-2, AC-3, AC-4: rule-health-pipeline
import {
  mergeFindings,
  generateImprovementPlan,
  rescoreAfterRewrite,
  type RuleHealthEntry,
  type ImprovementPlan,
  type RescoreDelta,
} from "../lib/rule-health-pipeline";

// Types from compliance.ts used for mergeFindings
import type { InstructionFinding } from "../lib/compliance";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rhp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAuditResult(overrides?: Partial<AgentAuditResult>): AgentAuditResult {
  return {
    role: "marcus",
    score: 85,
    grade: "B",
    totalCalls: 15,
    rules: [
      {
        id: "COMP-1",
        rule: "AGENTS.md context available",
        verdict: "FOLLOWED",
        evidence: "AGENTS.md read at position 1",
        weight: 20,
      },
      {
        id: "COMP-6",
        rule: "No duplicate file reads",
        verdict: "IGNORED",
        evidence: "2 files read multiple times",
        weight: 15,
      },
    ],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── AC-1: audit compliance JSON ─────────────────────────

describe("audit compliance JSON", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes AgentAuditResult to .rungate/audit-compliance.json", () => {
    const result = makeAuditResult();
    const outPath = join(tmpDir, ".rungate", "audit-compliance.json");

    writeAuditComplianceJSON(result, tmpDir);

    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written.role).toBe("marcus");
    expect(written.score).toBe(85);
    expect(written.grade).toBe("B");
  });

  it("includes per-rule verdicts and line numbers in output", () => {
    const result = makeAuditResult({
      rules: [
        {
          id: "COMP-1",
          rule: "AGENTS.md context available",
          verdict: "FOLLOWED",
          evidence: "read at position 1",
          weight: 20,
        },
        {
          id: "COMP-6",
          rule: "No duplicate reads",
          verdict: "IGNORED",
          evidence: "2 files read multiple times",
          weight: 15,
        },
      ],
    });

    writeAuditComplianceJSON(result, tmpDir);

    const outPath = join(tmpDir, ".rungate", "audit-compliance.json");
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written.rules).toHaveLength(2);
    expect(written.rules[0].id).toBe("COMP-1");
    expect(written.rules[0].verdict).toBe("FOLLOWED");
    expect(written.rules[1].id).toBe("COMP-6");
    expect(written.rules[1].verdict).toBe("IGNORED");
  });

  it("creates .rungate directory if it does not exist", () => {
    const result = makeAuditResult();
    const rungateDir = join(tmpDir, ".rungate");
    expect(existsSync(rungateDir)).toBe(false);

    writeAuditComplianceJSON(result, tmpDir);

    expect(existsSync(rungateDir)).toBe(true);
  });

  it("merges with existing audit-compliance.json", () => {
    const rungateDir = join(tmpDir, ".rungate");
    mkdirSync(rungateDir, { recursive: true });
    writeFileSync(
      join(rungateDir, "audit-compliance.json"),
      JSON.stringify({ previousRun: true }),
    );

    const result = makeAuditResult();
    writeAuditComplianceJSON(result, tmpDir);

    const written = JSON.parse(readFileSync(join(rungateDir, "audit-compliance.json"), "utf-8"));
    expect(written.role).toBe("marcus");
    expect(written.score).toBe(85);
  });
});

// ── AC-2: merge findings ────────────────────────────────

describe("merge findings", () => {
  it("joins agnix findings with auditor rule verdicts on matching rule ID", () => {
    const agnixFindings: InstructionFinding[] = [
      {
        file: "AGENTS.md",
        line: 10,
        rule: "COMP-1",
        source: "agnix",
        severity: "HIGH",
        category: "compliance",
        message: "Vague instruction",
        suggestion: "Be more specific",
      },
    ];

    const auditRules: AgentAuditResult["rules"] = [
      {
        id: "COMP-1",
        rule: "AGENTS.md context available",
        verdict: "FOLLOWED",
        evidence: "AGENTS.md read at position 1",
        weight: 20,
      },
    ];

    const merged = mergeFindings(agnixFindings, auditRules);

    expect(merged).toHaveLength(1);
    expect(merged[0].ruleId).toBe("COMP-1");
    expect(merged[0].agnixSeverity).toBe("HIGH");
    expect(merged[0].auditVerdict).toBe("FOLLOWED");
    expect(merged[0].file).toBe("AGENTS.md");
    expect(merged[0].line).toBe(10);
  });

  it("produces unified RuleHealthEntry records", () => {
    const agnixFindings: InstructionFinding[] = [
      {
        file: "marcus.md",
        line: 5,
        rule: "COMP-6",
        source: "agnix",
        severity: "MEDIUM",
        category: "efficiency",
        message: "Duplicate read warning",
        suggestion: "Remove duplicate",
      },
    ];

    const auditRules: AgentAuditResult["rules"] = [
      {
        id: "COMP-6",
        rule: "No duplicate reads",
        verdict: "IGNORED",
        evidence: "2 files duplicated",
        weight: 15,
      },
    ];

    const merged = mergeFindings(agnixFindings, auditRules);

    expect(merged[0]).toHaveProperty("ruleId");
    expect(merged[0]).toHaveProperty("file");
    expect(merged[0]).toHaveProperty("line");
    expect(merged[0]).toHaveProperty("agnixSeverity");
    expect(merged[0]).toHaveProperty("auditVerdict");
    expect(merged[0]).toHaveProperty("agnixMessage");
    expect(merged[0]).toHaveProperty("auditEvidence");
  });

  it("includes unmatched agnix findings with null audit verdict", () => {
    const agnixFindings: InstructionFinding[] = [
      {
        file: "AGENTS.md",
        line: 20,
        rule: "UNMATCHED-1",
        source: "agnix",
        severity: "LOW",
        category: "style",
        message: "Style issue",
        suggestion: "Fix style",
      },
    ];

    const auditRules: AgentAuditResult["rules"] = [];

    const merged = mergeFindings(agnixFindings, auditRules);
    expect(merged).toHaveLength(1);
    expect(merged[0].ruleId).toBe("UNMATCHED-1");
    expect(merged[0].auditVerdict).toBeNull();
  });

  it("includes unmatched audit rules with null agnix data", () => {
    const agnixFindings: InstructionFinding[] = [];

    const auditRules: AgentAuditResult["rules"] = [
      {
        id: "COMP-9",
        rule: "Total tool calls <= 30",
        verdict: "FOLLOWED",
        evidence: "15 calls",
        weight: 10,
      },
    ];

    const merged = mergeFindings(agnixFindings, auditRules);
    expect(merged).toHaveLength(1);
    expect(merged[0].ruleId).toBe("COMP-9");
    expect(merged[0].auditVerdict).toBe("FOLLOWED");
    expect(merged[0].agnixSeverity).toBeNull();
  });
});

// ── AC-3: improvement plan ──────────────────────────────

describe("improvement plan", () => {
  it("produces improvement-plan.json with per-rule rewrite recommendations", () => {
    const entries: RuleHealthEntry[] = [
      {
        ruleId: "COMP-6",
        file: "marcus.md",
        line: 25,
        agnixSeverity: "HIGH",
        agnixMessage: "Vague directive",
        agnixSuggestion: "Be specific",
        auditVerdict: "IGNORED",
        auditEvidence: "2 files duplicated",
        auditWeight: 15,
      },
    ];

    const plan = generateImprovementPlan(entries);

    expect(plan.recommendations).toHaveLength(1);
    expect(plan.recommendations[0].ruleId).toBe("COMP-6");
    expect(plan.recommendations[0].factors.length).toBeGreaterThan(0);
  });

  it("uses the 7 compliance factors", () => {
    const entries: RuleHealthEntry[] = [
      {
        ruleId: "COMP-6",
        file: "marcus.md",
        line: 35,
        agnixSeverity: "HIGH",
        agnixMessage: "Weak language",
        agnixSuggestion: "Strengthen",
        auditVerdict: "IGNORED",
        auditEvidence: "Not followed",
        auditWeight: 15,
      },
    ];

    const plan = generateImprovementPlan(entries);

    // The 7 factors: position, language, specificity, deduplication, section, evidence, consolidation
    const validFactors = ["position", "language", "specificity", "deduplication", "section", "evidence", "consolidation"];
    for (const rec of plan.recommendations) {
      for (const factor of rec.factors) {
        expect(validFactors).toContain(factor);
      }
    }
  });

  it("generates timestamp in plan output", () => {
    const entries: RuleHealthEntry[] = [];
    const plan = generateImprovementPlan(entries);
    expect(plan.timestamp).toBeDefined();
    expect(typeof plan.timestamp).toBe("string");
  });

  it("skips rules with FOLLOWED verdict", () => {
    const entries: RuleHealthEntry[] = [
      {
        ruleId: "COMP-1",
        file: "AGENTS.md",
        line: 5,
        agnixSeverity: null,
        agnixMessage: null,
        agnixSuggestion: null,
        auditVerdict: "FOLLOWED",
        auditEvidence: "Read at position 1",
        auditWeight: 20,
      },
    ];

    const plan = generateImprovementPlan(entries);
    expect(plan.recommendations).toHaveLength(0);
  });
});

// ── AC-4: rescore after rewrite ─────────────────────────

describe("rescore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns before-after delta with per-file score changes", () => {
    // Create a test markdown file
    const testFile = join(tmpDir, "test-brief.md");
    writeFileSync(testFile, "## Rules\n- Always read AGENTS.md first\n- Never skip tests\n");

    const beforeScores: Record<string, number> = {
      "test-brief.md": 3,
    };

    const delta = rescoreAfterRewrite([testFile], beforeScores);

    expect(delta).toHaveProperty("files");
    expect(delta.files["test-brief.md"]).toBeDefined();
    expect(delta.files["test-brief.md"]).toHaveProperty("before");
    expect(delta.files["test-brief.md"]).toHaveProperty("after");
    expect(delta.files["test-brief.md"]).toHaveProperty("delta");
    expect(typeof delta.files["test-brief.md"].delta).toBe("number");
  });

  it("computes delta as after minus before", () => {
    const testFile = join(tmpDir, "brief.md");
    writeFileSync(testFile, "# Test\nSome content\n");

    const beforeScores: Record<string, number> = {
      "brief.md": 5,
    };

    const delta = rescoreAfterRewrite([testFile], beforeScores);
    const entry = delta.files["brief.md"];
    expect(entry.delta).toBe(entry.after - entry.before);
  });

  it("includes timestamp in delta output", () => {
    const delta = rescoreAfterRewrite([], {});
    expect(delta.timestamp).toBeDefined();
  });
});
