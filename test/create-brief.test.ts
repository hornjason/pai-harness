import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { generateBriefTemplate, addRoleToConfig } from "../lib/create-brief";

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
});
