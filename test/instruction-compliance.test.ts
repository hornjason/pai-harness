import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runTemplateCompliance,
  collectComplianceSurface,
  COMPLIANCE_TOOLS,
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
  /**
   * A refusal that only says "no coverage" is a refusal nobody can act on:
   * installing something fixes `absent` and does nothing for `errored`. So
   * the message names the file and every tool's own outcome and reason, which
   * is the reading #597 put on the report for exactly this.
   */
  const unread = (file: string) =>
    `${file} is on the surface and no tool read it. ` +
    COMPLIANCE_TOOLS.map(
      t => `${t}: ${report.toolProbes[t].outcome} (${report.toolProbes[t].reason})`,
    ).join("; ") +
    ` — ${report.reading.reason ?? "both tools answered, so this is not a missing tool"}`;

  test("#755: agent briefs are read by at least one tool", () => {
    const agentFiles = report.files.filter(f => f.file.includes(".claude/agents/"));
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const f of agentFiles) {
      expect(f.scoredBy, unread(f.file)).not.toEqual([]);
    }
  });

  test("#755: AGENTS.md is read by at least one tool", () => {
    const agentsMd = report.files.find(f => f.file === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.scoredBy, unread("AGENTS.md")).not.toEqual([]);
  });

  // The other direction, and the reason the two cases above are not vacuous:
  // a file nobody read still gets a `FileScore`, with an empty findings list.
  // Both probes are injected absent, so nothing spawns and the case is the
  // same on any machine.
  test("#755: a file no tool read reports an empty coverage, not a clean one", async () => {
    const root = mkdtempSync(join(tmpdir(), "compliance-scoredby-"));
    writeFileSync(join(root, "AGENTS.md"), "# agents\n\nDo the thing.\n");

    const absent = (tool: string): ToolProbe =>
      toolProbe({ outcome: "absent", tool, exitCode: null, reason: `PLANTED-${tool}-absent` });

    const unread = await runTemplateCompliance(root, {
      // A surface entry is a path RELATIVE to the root, not an absolute one —
      // `collectComplianceSurface` joins it and skips what does not exist, so
      // an absolute path here would silently scan nothing and the case would
      // be asserting over an empty report.
      surface: ["AGENTS.md"],
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

  // The half of that pair that the live surface cannot supply: every file in
  // this repository currently carries findings, so nothing in the tree can
  // witness a file that was READ and came back CLEAN. That is the state the
  // old assertion called unscored, and it is the state this repo is trying to
  // reach — so the fix has to be measured against it before it arrives.
  //
  // Named, because it is the cheapest wrong fix available here: deriving
  // `scoredBy` from `findings.length > 0` passes every other case in this
  // file and is the original defect under a new name. This case is the only
  // thing that refuses it.
  test("#755: a file that was read and is clean reports coverage, not silence", async () => {
    const root = mkdtempSync(join(tmpdir(), "compliance-clean-"));
    writeFileSync(join(root, "AGENTS.md"), "# Project\n\nRun `bun test` before every commit.\n");

    // Only RepoRails is injected — agnix is probed for real, so the case is a
    // measurement of a tool that genuinely read the file rather than of an
    // injected reading.
    const clean = await runTemplateCompliance(root, {
      surface: ["AGENTS.md"],
      writeReport: false,
      probes: {
        reporails: toolProbe({
          outcome: "absent",
          tool: "reporails",
          exitCode: null,
          reason: "PLANTED-reporails-absent",
        }),
      },
    });

    const score = clean.files.find(f => f.file === "AGENTS.md");
    expect(score).toBeDefined();
    expect(score!.findings, "the fixture must be clean, or it witnesses nothing").toEqual([]);

    if (clean.toolProbes.agnix.available) {
      expect(score!.scoredBy).toEqual(["agnix"]);
    } else {
      // agnix is not installed on this machine. That is not a pass: there is
      // nothing here that read the file, so the only honest reading is the
      // one the report already gives, asserted rather than skipped.
      expect(clean.reading.reading).toBe("UNMEASURED");
      expect(score!.scoredBy).toEqual([]);
    }
  }, 60_000);

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
