import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const SPEC_HASH = "1dd7bd560bfe8b86";

describe("Phase 5 — Instruction Compliance", () => {
  test("spec-drift: governing spec hasn't changed", () => {
    const specPath = join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md");
    const hash = execSync(`shasum -a 256 "${specPath}" | cut -c1-16`, { encoding: "utf-8" }).trim();
    if (hash !== SPEC_HASH) {
      throw new Error(
        `SPEC DRIFT: bootstrap spec changed (hash ${hash} != ${SPEC_HASH}). ` +
        `Update SPEC_HASH to "${hash}".`
      );
    }
  });

  // SC-236: rungate test-navigability spawns fresh agent, auditor scores transcript
  test.todo("SC-236: test-navigability produces navigability-score.json");

  // SC-237: navigability-score.json schema
  test.todo("SC-237: navigability-score.json has required fields");

  // SC-238: canary values checked by auditor
  test.todo("SC-238: canary values planted and checked");

  // SC-239: rungate rule-health cross-references quality with compliance
  test.todo("SC-239: rule-health produces rule-health.json");

  // SC-240: runTemplateCompliance uses agnix + RepoRails via Bun.spawnSync
  test("SC-240: lib/compliance.ts uses Bun.spawnSync for external tools", () => {
    const { existsSync, readFileSync } = require("fs");
    const compliancePath = join(import.meta.dir, "..", "lib", "compliance.ts");
    if (!existsSync(compliancePath)) {
      expect(existsSync(compliancePath)).toBe(true);
      return;
    }
    const content = readFileSync(compliancePath, "utf-8");
    expect(content).toContain("Bun.spawnSync");
    expect(content).toContain("agnix");
    expect(content).toContain("reporails");
    // Must NOT use regex for scoring (SC-240 explicit requirement)
    expect(content).not.toContain("INSTRUCTION_PATTERNS");
  });

  // SC-241: runGeneratedCompliance compares against baseline
  test.todo("SC-241: generated compliance compares against baseline");

  // SC-242: runBehavioralCompliance spawns fresh agent + auditor
  test.todo("SC-242: behavioral compliance spawns agent and auditor");

  // SC-243: hill climb loop max 5 iterations
  test.todo("SC-243: hill climb loop with max iterations");

  // SC-244: 7 compliance factors scored per instruction
  test.todo("SC-244: 7 compliance factors defined");

  // SC-245: compliance surface is exactly 4 file types
  test("SC-245: compliance surface covers 4 file types", () => {
    const { collectComplianceSurface } = require("../lib/compliance");
    const root = join(import.meta.dir, "..");
    const files = collectComplianceSurface(root);
    const hasPrompts = files.some((f: string) => f.includes("/prompts/"));
    const hasAgentsMd = files.some((f: string) => f.endsWith("AGENTS.md"));
    const hasAgentBriefs = files.some((f: string) => f.includes(".claude/agents/"));
    const hasClaudeMd = files.some((f: string) => f.endsWith("CLAUDE.md"));
    expect(hasPrompts).toBe(true);
    expect(hasAgentsMd).toBe(true);
    expect(hasAgentBriefs).toBe(true);
    expect(hasClaudeMd).toBe(true);
  });

  // SC-246: escalate to mechanical after 5 iterations
  test.todo("SC-246: failing instructions escalate to mechanical");

  // SC-247: compliance report written to compliance-report.json
  test.todo("SC-247: compliance-report.json written with required schema");

  // SC-248: post-completion auditor after every agent
  test.todo("SC-248: auditor spawns after agent completion");

  // SC-249: agent briefs load with matching agentType
  test("SC-249: all agent files have name field matching filename", () => {
    const { existsSync, readFileSync, readdirSync } = require("fs");
    const agentsDir = join(import.meta.dir, "..", ".claude", "agents");
    if (!existsSync(agentsDir)) return;
    const mismatched: string[] = [];
    for (const f of readdirSync(agentsDir).filter((f: string) => f.endsWith(".md"))) {
      const content = readFileSync(join(agentsDir, f), "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const expected = f.replace(".md", "");
      if (!nameMatch) mismatched.push(`${f}: missing name field`);
      else if (nameMatch[1].trim() !== expected) mismatched.push(`${f}: name="${nameMatch[1].trim()}" != "${expected}"`);
    }
    expect(mismatched).toEqual([]);
  });

  test("SC-249: ship.js uses matching agentType for all spawns", () => {
    const { readFileSync } = require("fs");
    const shipPath = join(import.meta.dir, "..", "workflows", "ship.js");
    const content = readFileSync(shipPath, "utf-8");
    expect(content).not.toContain("agentType: 'Engineer'");
    expect(content).not.toContain("agentType: 'Pentester'");
    expect(content).toContain("agentType: 'marcus'");
    expect(content).toContain("agentType: 'quinn'");
    expect(content).toContain("agentType: 'rook'");
  });

  // SC-250: five-layer measurement model
  test.todo("SC-250: five-layer measurement model implemented");
});
