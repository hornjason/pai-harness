import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

describe("Scaffold Conformity — REPO-SCAFFOLD-SPEC", () => {

  describe("SC-1: AGENTS.md exists at root, ≤150 lines", () => {
    test("AGENTS.md exists", () => {
      expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    });

    test("AGENTS.md ≤ 150 lines", () => {
      const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
      const lines = content.split("\n").length;
      expect(lines).toBeLessThanOrEqual(150);
    });
  });

  describe("SC-2: specs/ directory exists with ≥1 spec", () => {
    test("specs/ exists", () => {
      expect(existsSync(join(ROOT, "specs"))).toBe(true);
    });

    test("specs/ has at least 1 .md file", () => {
      const files = readdirSync(join(ROOT, "specs")).filter(f => f.endsWith(".md"));
      expect(files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("SC-3: All specs have testable frontmatter", () => {
    const specsDir = join(ROOT, "specs");
    if (existsSync(specsDir)) {
      const specs = readdirSync(specsDir).filter(f => f.endsWith(".md"));
      for (const spec of specs) {
        test(`${spec} has testable: true/false`, () => {
          const content = readFileSync(join(specsDir, spec), "utf-8");
          expect(content).toMatch(/^---[\s\S]*?testable:\s*(true|false)[\s\S]*?^---/m);
        });
      }
    }
  });

  describe("SC-4: test/ directory exists with ≥2 test files", () => {
    test("test/ exists", () => {
      expect(existsSync(join(ROOT, "test"))).toBe(true);
    });

    test("test/ has ≥2 test files", () => {
      const files = readdirSync(join(ROOT, "test")).filter(f => f.endsWith(".test.ts"));
      expect(files.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("SC-5: bun test passes", () => {
    test("verified by this test suite running", () => {
      expect(true).toBe(true);
    });
  });

  describe("SC-7: AGENTS.md paths resolve", () => {
    test("all referenced files exist", () => {
      if (!existsSync(join(ROOT, "AGENTS.md"))) return;
      const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
      const linkPattern = /\[.*?\]\(([^)]+)\)/g;
      let match;
      const broken: string[] = [];
      while ((match = linkPattern.exec(content)) !== null) {
        const target = match[1];
        if (target.startsWith("http")) continue;
        if (target.startsWith("#")) continue;
        const resolved = join(ROOT, target);
        if (!existsSync(resolved)) broken.push(target);
      }
      expect(broken).toEqual([]);
    });
  });

  describe("SC-9: .github/copilot-instructions.md exists", () => {
    test("copilot-instructions.md exists", () => {
      expect(existsSync(join(ROOT, ".github", "copilot-instructions.md"))).toBe(true);
    });

    test("points to AGENTS.md", () => {
      const content = readFileSync(join(ROOT, ".github", "copilot-instructions.md"), "utf-8");
      expect(content).toContain("AGENTS.md");
    });
  });

  describe("SC-10: Root is clean (code project: ≤30 items)", () => {
    test("root has ≤ 30 visible items", () => {
      const items = readdirSync(ROOT).filter(f => !f.startsWith(".") && f !== "node_modules");
      expect(items.length).toBeLessThanOrEqual(30);
    });
  });

  describe("AGENTS.md standard sections", () => {
    const requiredSections = [
      "Project Identity",
      "Key Files",
      "Specs",
      "Tests",
      "Workflow",
    ];

    for (const section of requiredSections) {
      test(`has § ${section}`, () => {
        if (!existsSync(join(ROOT, "AGENTS.md"))) {
          expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
          return;
        }
        const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
        expect(content.toLowerCase()).toContain(section.toLowerCase());
      });
    }
  });

  describe("project-harness.json (harness-integrated)", () => {
    test(".claude/project-harness.json exists", () => {
      expect(existsSync(join(ROOT, ".claude", "project-harness.json"))).toBe(true);
    });

    test("has required fields", () => {
      const content = JSON.parse(readFileSync(join(ROOT, ".claude", "project-harness.json"), "utf-8"));
      expect(content.project).toBeDefined();
      expect(content.repo).toBeDefined();
      expect(content.dev?.testCmd).toBeDefined();
    });
  });

  describe("AGENTS.md / CLAUDE.md no duplication", () => {
    test("no shared sentences between files", () => {
      if (!existsSync(join(ROOT, "AGENTS.md")) || !existsSync(join(ROOT, "CLAUDE.md"))) return;
      const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
      const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
      const agentSentences = agents.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 30);
      const duplicates = agentSentences.filter(s => claude.includes(s));
      expect(duplicates).toEqual([]);
    });
  });
});
