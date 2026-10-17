import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { join, resolve } from "path";
import { runScaffoldConformity } from "../lib/conformity";
import { checkSpecDrift } from "./helpers/scaffold-fixture";

const ROOT = resolve(import.meta.dir, "..");

// Auto-generated conformity tests from specs
runScaffoldConformity(ROOT);

// Custom tail: phase-5 specific checks
describe("Phase 5 — Instruction Compliance (custom checks)", () => {
  test("spec-drift: governing spec hasn't changed", () => {
    // One binding (#579). This was a second hash pin over the same spec, in
    // a second file, with its own constant — two deciders answering one
    // question about one input, which is
    // `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape. Updating
    // one and not the other is how it surfaced: `test/helpers/scaffold-fixture.ts`
    // was re-pinned for a deliberate frontmatter change and this file stayed
    // red with an identical message, pointing at an identical fact.
    //
    // `checkSpecDrift` already covers this spec AND the test plan, so the
    // copy was also narrower than the thing it duplicated.
    checkSpecDrift();
  });

  test.todo("SC-236: test-navigability produces navigability-score.json");
  test.todo("SC-237: navigability-score.json has required fields");
  test.todo("SC-238: canary values planted and checked");
  test.todo("SC-239: rule-health produces rule-health.json");
  test.todo("SC-241: generated compliance compares against baseline");
  test.todo("SC-242: behavioral compliance spawns agent and auditor");
  test.todo("SC-243: hill climb loop with max iterations");
  test.todo("SC-244: 7 compliance factors defined");

  test("SC-245: compliance surface covers 4 file types", () => {
    const { collectComplianceSurface } = require("../lib/compliance");
    const files = collectComplianceSurface(ROOT);
    const hasPrompts = files.some((f: string) => f.includes("/prompts/"));
    const hasAgentsMd = files.some((f: string) => f.endsWith("AGENTS.md"));
    const hasAgentBriefs = files.some((f: string) => f.includes(".claude/agents/"));
    const hasClaudeMd = files.some((f: string) => f.endsWith("CLAUDE.md"));
    expect(hasPrompts).toBe(true);
    expect(hasAgentsMd).toBe(true);
    expect(hasAgentBriefs).toBe(true);
    expect(hasClaudeMd).toBe(true);
  });

  test.todo("SC-246: failing instructions escalate to mechanical");
  test.todo("SC-247: compliance-report.json written with required schema");
  test.todo("SC-248: auditor spawns after agent completion");

  test("SC-249: all agent files have name field matching filename", () => {
    const { existsSync, readFileSync, readdirSync } = require("fs");
    const agentsDir = join(ROOT, ".claude", "agents");
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

  test("SC-249: ship.js uses config-driven roles for all agent spawns", () => {
    const { readFileSync } = require("fs");
    const shipPath = join(ROOT, "workflows", "ship.js");
    const content = readFileSync(shipPath, "utf-8");
    expect(content).not.toContain("agentType:");
    expect(content).toContain("role: 'marcus'");
    expect(content).toContain("role: 'quinn'");
    expect(content).toContain("role: 'rook'");
    expect(content).toContain("briefedAgent(");
  });

  test.todo("SC-250: five-layer measurement model implemented");
});
