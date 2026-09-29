import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { generateBriefTemplate, addRoleToConfig, buildAgentMeta } from "../lib/create-brief";

const ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(ROOT, "templates", "agent-briefs");

describe("create-brief", () => {
  describe("AC-1: generateBriefTemplate produces template with PROJECT_IDENTITY", () => {
    test("generated template contains ${PROJECT_IDENTITY} variable placeholder", () => {
      const content = generateBriefTemplate("tester", "Test engineer who verifies changes");
      expect(content).toContain("${PROJECT_IDENTITY}");
    });

    test("generated template has standard frontmatter", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/doc-type:\s*reference/);
      expect(content).toMatch(/status:\s*active/);
    });

    test("generated template has identity line with role name", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      // Should have "You are Tester" (capitalized) identity line
      expect(content).toMatch(/You are.*Tester/i);
    });

    test("generated template contains ${SHARED_RULES} variable placeholder", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toContain("${SHARED_RULES}");
    });
  });

  describe("AC-2: Generated template has >= 5 standard sections", () => {
    test("template has Context section", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^## Context/m);
    });

    test("template has Workflow section", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^## Workflow/m);
    });

    test("template has Never Do section", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^## Never Do/m);
    });

    test("template has Report section", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^## Report/m);
    });

    test("template has Rules section", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      expect(content).toMatch(/^## Rules/m);
    });

    test("template has at least 5 standard sections total", () => {
      const content = generateBriefTemplate("tester", "Test engineer");
      const sectionCount = (content.match(/^## (Context|Workflow|Never Do|Report|Rules)/gm) || []).length;
      expect(sectionCount).toBeGreaterThanOrEqual(5);
    });
  });

  describe("AC-3: addRoleToConfig updates rungate.json", () => {
    const tmpConfig = "/tmp/rungate-create-brief-test/rungate.json";

    beforeAll(() => {
      mkdirSync("/tmp/rungate-create-brief-test", { recursive: true });
    });

    afterAll(() => {
      try { rmSync("/tmp/rungate-create-brief-test", { recursive: true }); } catch {}
    });

    test("adds new role with brief, isolation, and standardTask", () => {
      const initialConfig = {
        project: "test",
        repo: "test/test",
        issueRepo: "test/test",
        roles: {}
      };
      writeFileSync(tmpConfig, JSON.stringify(initialConfig, null, 2));

      addRoleToConfig(tmpConfig, "tester3", "Test engineer who verifies changes");

      const updated = JSON.parse(readFileSync(tmpConfig, "utf-8"));
      expect(updated.roles.tester3).toBeDefined();
      expect(updated.roles.tester3.brief).toBe(".claude/agents/tester3.md");
      expect(updated.roles.tester3.isolation).toBe("worktree");
      expect(updated.roles.tester3.standardTask).toBeTruthy();
    });

    test("does not overwrite existing roles", () => {
      const initialConfig = {
        project: "test",
        repo: "test/test",
        issueRepo: "test/test",
        roles: {
          marcus: {
            brief: ".claude/agents/marcus.md",
            isolation: "worktree",
            standardTask: "existing task"
          }
        }
      };
      writeFileSync(tmpConfig, JSON.stringify(initialConfig, null, 2));

      addRoleToConfig(tmpConfig, "tester3", "Test engineer");

      const updated = JSON.parse(readFileSync(tmpConfig, "utf-8"));
      expect(updated.roles.marcus.standardTask).toBe("existing task");
      expect(updated.roles.tester3).toBeDefined();
    });

    test("throws if role already exists", () => {
      const initialConfig = {
        project: "test",
        repo: "test/test",
        issueRepo: "test/test",
        roles: {
          tester3: {
            brief: ".claude/agents/tester3.md",
            isolation: "worktree",
            standardTask: "existing"
          }
        }
      };
      writeFileSync(tmpConfig, JSON.stringify(initialConfig, null, 2));

      expect(() => addRoleToConfig(tmpConfig, "tester3", "Test engineer")).toThrow(/already exists/);
    });
  });

  describe("AC-4: defaultAgentMeta removed from scaffold-project.ts", () => {
    test("defaultAgentMeta is not hardcoded in scaffold-project.ts", () => {
      const content = readFileSync(join(ROOT, "scripts", "scaffold-project.ts"), "utf-8");
      const matches = (content.match(/defaultAgentMeta/g) || []).length;
      expect(matches).toBe(0);
    });

    test("scaffold-project.ts uses buildAgentMeta from lib/create-brief", () => {
      const content = readFileSync(join(ROOT, "scripts", "scaffold-project.ts"), "utf-8");
      expect(content).toContain("buildAgentMeta");
    });
  });

  describe("AC-5: existing agents produce identical metadata from config", () => {
    // These are the exact values that were previously hardcoded in defaultAgentMeta
    const expectedMeta: Record<string, { description: string; tools: string; model: string; tiers?: Record<string, string[]> }> = {
      discovery: { description: "Discovery agent — reads issue, sizes work, writes ACs with evidence methods", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Discovery Rules"] } },
      marcus: { description: "Principal engineer — implements code changes with TDD, writes tests, commits", tools: "[Bash, Read, Write, Edit]", model: "sonnet", tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] } },
      quinn: { description: "QA engineer — tests as a brand-new user using Playwright MCP tools", tools: "[Bash, Read, mcp__playwright__*]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection", "CLI Testing Mode"] } },
      rook: { description: "Security engineer — scans changed files for vulnerabilities", tools: "[Bash, Read]", model: "sonnet" },
      serena: { description: "Software architect — structural decisions, ADRs, module boundary review", tools: "[Bash, Read]", model: "sonnet" },
      aditi: { description: "UX/UI designer — component specs, visual review, accessibility", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection"] } },
    };

    test("buildAgentMeta produces identical metadata for all 6 existing agents", () => {
      // Read the project's own rungate.json roles as the config source
      const config = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate.json"), "utf-8"));
      const result = buildAgentMeta(config.roles);

      for (const [name, expected] of Object.entries(expectedMeta)) {
        expect(result[name]).toBeDefined();
        expect(result[name].description).toBe(expected.description);
        expect(result[name].tools).toBe(expected.tools);
        expect(result[name].model).toBe(expected.model);
        if (expected.tiers) {
          expect(result[name].tiers).toEqual(expected.tiers);
        } else {
          expect(result[name].tiers).toBeUndefined();
        }
      }
    });

    test("metadata migration is identical for agents without tiers", () => {
      const roles = {
        rook: { description: "Security engineer — scans changed files for vulnerabilities", tools: "[Bash, Read]", model: "sonnet" },
      };
      const result = buildAgentMeta(roles);
      expect(result.rook.description).toBe(expectedMeta.rook.description);
      expect(result.rook.tools).toBe(expectedMeta.rook.tools);
      expect(result.rook.model).toBe(expectedMeta.rook.model);
      expect(result.rook.tiers).toBeUndefined();
    });

    test("metadata migration is identical for agents with tiers", () => {
      const roles = {
        marcus: {
          description: "Principal engineer — implements code changes with TDD, writes tests, commits",
          tools: "[Bash, Read, Write, Edit]",
          model: "sonnet",
          tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] },
        },
      };
      const result = buildAgentMeta(roles);
      expect(result.marcus.tiers).toEqual({ reinforcement: ["Testing Rules"], mechanical: ["Workflow"] });
    });

    test("buildAgentMeta applies defaults for missing fields", () => {
      const roles = {
        newagent: { description: "A new agent" },
      };
      const result = buildAgentMeta(roles);
      expect(result.newagent.description).toBe("A new agent");
      expect(result.newagent.tools).toBe("[Bash, Read]");
      expect(result.newagent.model).toBe("sonnet");
    });

    test("buildAgentMeta uses role name fallback for missing description", () => {
      const roles = {
        newagent: {},
      };
      const result = buildAgentMeta(roles);
      expect(result.newagent.description).toBe("newagent agent");
    });
  });
});
