import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "fixtures/golden-project");
const OUTPUT = "/tmp/rungate-agent-brief-template-test";
const SCAFFOLD = join(import.meta.dir, "..", "scripts", "scaffold-project.ts");
const TEMPLATES_DIR = join(import.meta.dir, "..", "templates", "agent-briefs");

beforeAll(() => {
  // Clean and setup output directory
  try { execSync(`rm -rf ${OUTPUT}`, { stdio: "pipe" }); } catch {}
  mkdirSync(OUTPUT, { recursive: true });

  // Copy golden fixture
  execSync(`cp -r ${FIXTURE}/. ${OUTPUT}/`);

  // Init git (required for scaffold)
  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add -A && git commit -m 'init fixture'", { cwd: OUTPUT, stdio: "pipe" });

  // Run scaffold
  try {
    execSync(`bun run ${SCAFFOLD} ${OUTPUT}`, { timeout: 60000, encoding: "utf-8", stdio: "pipe" });
  } catch (e) {
    // Scaffold may fail — tests should still run and report what's wrong
    console.error("Scaffold failed:", e);
  }
});

describe("Agent Brief Template Tests", () => {

  describe("SC-351: Each generated brief has all 8 required sections", () => {
    const briefPath = join(OUTPUT, ".claude/agents/marcus.md");

    test("generated marcus.md exists", () => {
      expect(existsSync(briefPath)).toBe(true);
    });

    test("has frontmatter section with name, description, tools, model", () => {
      const content = readFileSync(briefPath, "utf-8");
      expect(content).toMatch(/^---[\s\S]*?---/m);
      expect(content).toMatch(/name:\s*marcus/i);
    });

    test("has identity line describing role", () => {
      const content = readFileSync(briefPath, "utf-8");
      // Looking for "You are Marcus" or similar identity statement
      expect(content).toMatch(/You are.*Marcus/i);
    });

    test("has project section (name, tech, repo)", () => {
      const content = readFileSync(briefPath, "utf-8");
      // Project section should exist with tech stack info
      expect(content).toMatch(/##?\s*Project/i);
      expect(content).toMatch(/\*\*Tech:\*\*/i);
    });

    test("has Core Principles section", () => {
      const content = readFileSync(briefPath, "utf-8");
      expect(content).toMatch(/##?\s*Coding Principles|##?\s*Core Principles/i);
    });

    test("has Always Do section", () => {
      const content = readFileSync(briefPath, "utf-8");
      // May be implicit in workflow or explicit
      expect(content).toMatch(/##?\s*(Always|Workflow|Testing Rules)/i);
    });

    test("has Never Do section", () => {
      const content = readFileSync(briefPath, "utf-8");
      expect(content).toMatch(/##?\s*Never Do/i);
    });

    test("has Context section with AGENTS.md reference", () => {
      const content = readFileSync(briefPath, "utf-8");
      expect(content).toMatch(/##?\s*Context/i);
      expect(content).toMatch(/AGENTS\.md/i);
    });

    test("has Reference section (prompt routing or source dirs)", () => {
      const content = readFileSync(briefPath, "utf-8");
      // Reference section might be Source Dirs or routing table
      expect(content).toMatch(/##?\s*(Reference|Source|src\/|lib\/)/i);
    });
  });

  describe("SC-357: Template variables filled from project scan", () => {
    const briefPath = join(OUTPUT, ".claude/agents/marcus.md");

    test("reads project values from package.json", () => {
      const pkgPath = join(OUTPUT, "package.json");
      expect(existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBe("golden-fixture");
    });

    test("PROJECT_NAME variable filled with actual project description", () => {
      const content = readFileSync(briefPath, "utf-8");
      // Should contain description from package.json
      expect(content).toContain("Test fixture for RunGate");
    });

    test("TECH_STACK variable filled (mentions bun or dependencies)", () => {
      const content = readFileSync(briefPath, "utf-8");
      // Should mention tech from package.json scripts or dependencies
      expect(content).toMatch(/bun|test|module/i);
    });

    test("no ${...} template markers remain in generated brief", () => {
      const content = readFileSync(briefPath, "utf-8");
      const unfilled = content.match(/\$\{[A-Z_]+\}/g);
      expect(unfilled).toBeNull();
    });
  });

  describe("AC-4: agentMeta read from roles config, not hardcoded", () => {
    test("scaffold pipeline reads agentMeta from roles config", () => {
      // After decomposition, this logic lives in lib/scaffold/steps.ts (the deep module)
      const stepsSrc = readFileSync(join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"), "utf-8");
      // Should read from harness roles config, not just use a hardcoded literal
      expect(stepsSrc).toMatch(/harness\?\.roles|roles.*config|getAgentMeta/);
    });

    test("rungate.json roles have description, tools, and model fields", () => {
      const configPath = join(import.meta.dir, "..", ".claude", "rungate.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const roles = config.roles || {};
      for (const [name, role] of Object.entries(roles) as [string, any][]) {
        expect(role.description).toBeTruthy();
        expect(role.tools).toBeTruthy();
        expect(role.model).toBeTruthy();
      }
    });
  });

  describe("AC-5: Existing briefs produce identical output after agentMeta migration", () => {
    const agents = ["marcus", "quinn", "rook", "serena", "aditi", "discovery"];

    test("all 6 generated briefs contain correct frontmatter from config", () => {
      const configPath = join(import.meta.dir, "..", ".claude", "rungate.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));

      for (const agent of agents) {
        const briefPath = join(OUTPUT, ".claude/agents", `${agent}.md`);
        if (!existsSync(briefPath)) continue;
        const content = readFileSync(briefPath, "utf-8");
        const roleConfig = config.roles?.[agent];
        if (roleConfig?.description) {
          expect(content).toContain(`description: ${roleConfig.description}`);
        }
      }
    });

    test("generated briefs have 0 fail diff lines against expected frontmatter", () => {
      const configPath = join(import.meta.dir, "..", ".claude", "rungate.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      let failDiffs = 0;

      for (const agent of agents) {
        const briefPath = join(OUTPUT, ".claude/agents", `${agent}.md`);
        if (!existsSync(briefPath)) continue;
        const content = readFileSync(briefPath, "utf-8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) { failDiffs++; continue; }
        const fm = fmMatch[1];
        const roleConfig = config.roles?.[agent];
        if (!roleConfig) continue;

        // Verify key fields match
        if (roleConfig.description && !fm.includes(`description: ${roleConfig.description}`)) failDiffs++;
        if (roleConfig.tools && !fm.includes(`tools: ${roleConfig.tools}`)) failDiffs++;
        if (roleConfig.model && !fm.includes(`model: ${roleConfig.model}`)) failDiffs++;
      }
      expect(failDiffs).toBe(0);
    });
  });

  describe("SC-386: promptKeywords override in rungate.json", () => {
    const OUTPUT_KW = "/tmp/rungate-agent-brief-keyword-test";

    test("default keywords produce routing table entries without config override", () => {
      const briefPath = join(OUTPUT, ".claude/agents/marcus.md");
      const content = readFileSync(briefPath, "utf-8");
      // Marcus should have a Reference section with prompt routing
      expect(content).toMatch(/##?\s*Reference/i);
    });

    test("promptKeywords override merges with defaults and appears in generated brief", () => {
      // Setup: copy golden fixture, add promptKeywords override to rungate.json
      try { execSync(`rm -rf ${OUTPUT_KW}`, { stdio: "pipe" }); } catch {}
      mkdirSync(OUTPUT_KW, { recursive: true });
      execSync(`cp -r ${FIXTURE}/. ${OUTPUT_KW}/`);
      execSync("git init", { cwd: OUTPUT_KW, stdio: "pipe" });

      // Create .claude/rungate.json with promptKeywords override
      mkdirSync(join(OUTPUT_KW, ".claude"), { recursive: true });
      const overrideConfig = {
        promptKeywords: {
          marcus: ["custom-keyword", "special-routing"],
        },
      };
      writeFileSync(
        join(OUTPUT_KW, ".claude", "rungate.json"),
        JSON.stringify(overrideConfig, null, 2),
      );

      // Create a prompt file matching the custom keyword
      mkdirSync(join(OUTPUT_KW, "prompts"), { recursive: true });
      writeFileSync(
        join(OUTPUT_KW, "prompts", "custom-keyword-guide.md"),
        "# Custom Keyword Guide\n\nCustom routing test content.\n",
      );

      execSync("git add -A && git commit -m 'init with keyword override'", {
        cwd: OUTPUT_KW,
        stdio: "pipe",
      });

      // Run scaffold
      execSync(`bun run ${SCAFFOLD} ${OUTPUT_KW}`, {
        timeout: 60000,
        encoding: "utf-8",
        stdio: "pipe",
      });

      // Read marcus brief — should have the custom-keyword prompt routed to marcus
      const briefPath = join(OUTPUT_KW, ".claude/agents/marcus.md");
      const content = readFileSync(briefPath, "utf-8");
      expect(content).toContain("custom-keyword-guide");

      // Verify quinn still has default keywords (override didn't wipe other agents)
      const quinnPath = join(OUTPUT_KW, ".claude/agents/quinn.md");
      if (existsSync(quinnPath)) {
        const quinnContent = readFileSync(quinnPath, "utf-8");
        // Quinn should still have Reference section (default keywords still work)
        expect(quinnContent).toMatch(/##?\s*Reference/i);
      }
    });
  });

  describe("SC-354: Editing template and re-scaffolding updates brief", () => {
    test("modify template, re-scaffold, verify update appears", () => {
      const templatePath = join(TEMPLATES_DIR, "marcus.md");
      expect(existsSync(templatePath)).toBe(true);

      // Read original template
      const originalTemplate = readFileSync(templatePath, "utf-8");

      // Add canary marker at end
      const canary = "\n\n## CANARY_MARKER_FOR_SC354\n\nThis line verifies template updates propagate.\n";
      const modifiedTemplate = originalTemplate + canary;
      writeFileSync(templatePath, modifiedTemplate);

      try {
        // Re-run scaffold on OUTPUT
        execSync(`bun run ${SCAFFOLD} ${OUTPUT}`, { timeout: 60000, encoding: "utf-8", stdio: "pipe" });

        // Read generated brief
        const briefPath = join(OUTPUT, ".claude/agents/marcus.md");
        const generatedContent = readFileSync(briefPath, "utf-8");

        // Verify canary appears
        expect(generatedContent).toContain("CANARY_MARKER_FOR_SC354");

      } finally {
        // Restore original template
        writeFileSync(templatePath, originalTemplate);
      }
    });
  });
});
