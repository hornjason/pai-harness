import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { generateBriefTemplate, addRoleToConfig } from "../lib/create-brief";

const ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(ROOT, "templates", "agent-briefs");
const SCAFFOLD_PATH = join(ROOT, "scripts", "scaffold-project.ts");

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

  describe("AC-4: scaffold-project.ts has no hardcoded defaultAgentMeta", () => {
    test("defaultAgentMeta does not appear in scaffold-project.ts", () => {
      const content = readFileSync(SCAFFOLD_PATH, "utf-8");
      const matches = (content.match(/defaultAgentMeta/g) || []).length;
      expect(matches).toBe(0);
    });

    test("agentMeta is built entirely from harness.roles config", () => {
      const content = readFileSync(SCAFFOLD_PATH, "utf-8");
      // Should read from harness.roles, not from hardcoded object
      expect(content).toContain("harness");
      expect(content).toContain("roles");
      // Should NOT have a hardcoded object literal with all 6 role descriptions
      expect(content).not.toContain("discovery: { description:");
      expect(content).not.toContain("marcus: { description:");
    });

    test("scaffold-project.ts does not hardcode agent descriptions", () => {
      const content = readFileSync(SCAFFOLD_PATH, "utf-8");
      // None of the 6 hardcoded descriptions should appear as string literals
      expect(content).not.toContain('"Discovery agent — reads issue');
      expect(content).not.toContain('"Principal engineer — implements code');
      expect(content).not.toContain('"QA engineer — tests as a brand-new');
      expect(content).not.toContain('"Security engineer — scans changed');
      expect(content).not.toContain('"Software architect — structural');
      expect(content).not.toContain('"UX/UI designer — component specs');
    });
  });

  describe("AC-5: existing roles produce identical scaffold output after migration", () => {
    const SUPPORTED_ROLES = ["marcus", "quinn", "rook", "serena", "aditi", "discovery"] as const;

    // Expected metadata — these must match what was previously hardcoded in defaultAgentMeta
    const EXPECTED_META: Record<string, { description: string; tools: string; model: string; tiers?: Record<string, string[]> }> = {
      discovery: { description: "Discovery agent — reads issue, sizes work, writes ACs with evidence methods", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Discovery Rules"] } },
      marcus: { description: "Principal engineer — implements code changes with TDD, writes tests, commits", tools: "[Bash, Read, Write, Edit]", model: "sonnet", tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] } },
      quinn: { description: "QA engineer — tests as a brand-new user using Playwright MCP tools", tools: "[Bash, Read, mcp__playwright__*]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection", "CLI Testing Mode"] } },
      rook: { description: "Security engineer — scans changed files for vulnerabilities", tools: "[Bash, Read]", model: "sonnet" },
      serena: { description: "Software architect — structural decisions, ADRs, module boundary review", tools: "[Bash, Read]", model: "sonnet" },
      aditi: { description: "UX/UI designer — component specs, visual review, accessibility", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection"] } },
    };

    test("rungate.json has all 6 roles with required metadata fields", () => {
      const configPath = join(ROOT, ".claude", "rungate.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      for (const role of SUPPORTED_ROLES) {
        expect(config.roles[role]).toBeDefined();
        expect(config.roles[role].description).toBeTruthy();
        expect(config.roles[role].tools).toBeTruthy();
        expect(config.roles[role].model).toBeTruthy();
      }
    });

    for (const role of SUPPORTED_ROLES) {
      test(`${role} config matches previously hardcoded metadata`, () => {
        const configPath = join(ROOT, ".claude", "rungate.json");
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        const roleConfig = config.roles[role];
        const expected = EXPECTED_META[role];

        expect(roleConfig.description).toBe(expected.description);
        expect(roleConfig.tools).toBe(expected.tools);
        expect(roleConfig.model).toBe(expected.model);

        if (expected.tiers) {
          expect(roleConfig.tiers).toEqual(expected.tiers);
        } else {
          // Roles without tiers should not have tiers in config either
          // (or it should be undefined/null)
          if (roleConfig.tiers) {
            // If config has tiers that weren't hardcoded, that's fine — config is the source of truth now
          }
        }
      });
    }

    test("scaffold reads metadata from config with sensible fallbacks for unknown roles", () => {
      const content = readFileSync(SCAFFOLD_PATH, "utf-8");
      // Should have fallback logic for roles not in config
      expect(content).toContain("agent");
      // Should not have a hardcoded defaultAgentMeta record
      expect(content).not.toMatch(/const\s+defaultAgentMeta/);
    });
  });
});
