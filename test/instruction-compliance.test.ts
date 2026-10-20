import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runTemplateCompliance,
  collectComplianceSurface,
  type ComplianceReport,
} from "../lib/compliance";
import { toolProbe, type ToolProbe } from "../lib/tool-probe";

const ROOT = join(import.meta.dir, "..");

describe("Instruction Compliance — Layer 1 (Template Quality)", () => {
  let report: ComplianceReport;

  beforeAll(async () => {
    report = await runTemplateCompliance(ROOT, { writeReport: false });
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

  // #755: these two asked for FINDINGS, so they were green only while the
  // files were bad — they turn red the day an agent brief improves, and they
  // cannot tell three states apart: the tool ran and found nothing, the tool
  // ran and returned nothing because it broke, and the file genuinely got
  // better. All three are `findings.length === 0`. What the name claims —
  // "scored by at least one tool" — is `scoredBy`, which is a reading of
  // which tools READ the file and is unaffected by how good it is.
  test("#755: agent briefs are read by at least one tool", () => {
    const agentFiles = report.files.filter(f => f.file.includes(".claude/agents/"));
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const f of agentFiles) {
      expect(
        f.scoredBy,
        `${f.file} is on the surface and no tool read it — ${report.reading.reason ?? "both tools answered"}`,
      ).not.toEqual([]);
    }
  });

  test("#755: AGENTS.md is read by at least one tool", () => {
    const agentsMd = report.files.find(f => f.file === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(
      agentsMd!.scoredBy,
      `AGENTS.md is on the surface and no tool read it — ${report.reading.reason ?? "both tools answered"}`,
    ).not.toEqual([]);
  });

  // The other direction, and the reason the two cases above are not vacuous:
  // a file nobody read still gets a `FileScore`, with an empty findings list.
  // Both probes are injected absent, so nothing spawns and the case is the
  // same on any machine.
  test("#755: a file no tool read reports an empty coverage, not a clean one", async () => {
    const root = mkdtempSync(join(tmpdir(), "compliance-scoredby-"));
    const file = join(root, "AGENTS.md");
    writeFileSync(file, "# agents\n\nDo the thing.\n");

    const absent = (tool: string): ToolProbe =>
      toolProbe({ outcome: "absent", tool, exitCode: null, reason: `PLANTED-${tool}-absent` });

    const unread = await runTemplateCompliance(root, {
      surface: [file],
      writeReport: false,
      probes: { agnix: absent("agnix"), reporails: absent("reporails") },
    });

    const score = unread.files.find(f => f.file === "AGENTS.md");
    expect(score, "the file must still be reported, or there is nothing to read").toBeDefined();
    // This is the pair the old assertion could not see: zero findings on both
    // sides, opposite coverage.
    expect(score!.findings).toEqual([]);
    expect(score!.scoredBy).toEqual([]);
    expect(unread.reading.reading).toBe("UNMEASURED");
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
});
// The third argument here used to be `{ timeout: 300_000 }`. `describe` takes
// no options in bun:test — it was silently discarded, so the suite never had
// the 300s it looked like it had. The slow work is the agnix/reporails run in
// `beforeAll`, which carries its own 240s timeout (above) and is the only
// place a timeout applies. Removed rather than "fixed" because there is
// nothing left for it to cover. (TS2554, surfaced by #65.)
