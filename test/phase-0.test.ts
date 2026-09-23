import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { runScaffoldConformity } from "../lib/conformity";

const SPEC_HASHES: Record<string, string> = { bootstrap: "230dbd993b03bb8e", testPlan: "7fb0bb69a53a466d" };

function checkSpecDrift() {
  const specs = [
    { name: "bootstrap", path: join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md") },
    { name: "testPlan", path: join(import.meta.dir, "..", "specs", "BOOTSTRAP-TEST-PLAN.md") },
  ];
  for (const { name, path } of specs) {
    if (!existsSync(path)) continue;
    const hash = execSync(`shasum -a 256 "${path}" | cut -c1-16`, { encoding: "utf-8" }).trim();
    const expected = SPEC_HASHES[name];
    if (expected !== "UPDATE_AFTER_SPEC_CHANGE" && hash !== expected)
      throw new Error(`SPEC DRIFT: ${name} changed (${hash} != ${expected}). Update SPEC_HASHES.${name} to "${hash}".`);
  }
}

const FIXTURE = join(import.meta.dir, "fixtures/golden-project");
const OUTPUT = "/tmp/rungate-phase0-test";
const SCAFFOLD = join(import.meta.dir, "..", "scripts", "scaffold-project.ts");

beforeAll(() => {
  try { execSync(`rm -rf ${OUTPUT}`, { stdio: "pipe" }); } catch {}
  mkdirSync(OUTPUT, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${OUTPUT}/`);
  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add -A && git commit -m 'init fixture'", { cwd: OUTPUT, stdio: "pipe" });
  try {
    execSync(`bun run ${SCAFFOLD} ${OUTPUT}`, { timeout: 60000, encoding: "utf-8", stdio: "pipe" });
  } catch {
    // Scaffold may not exist yet or may fail — tests should still run and FAIL
  }
});

describe("Phase 0: Pre-flight + static files", () => {
  test("spec-drift: governing specs haven't changed", () => { checkSpecDrift(); });

  // ── Conformity engine: auto-matched SCs from OUTPUT specs ──
  // SC-S01 through SC-S53 in scaffold-verification-spec.md
  runScaffoldConformity(OUTPUT);

  // ── Harness template verification (not in OUTPUT — cross-project) ──
  describe("SC-88/SC-89: harness prompt templates", () => {
    const harnessPrompts = join(import.meta.dir, "..", "prompts");
    const templates = [
      "discovery", "marcus", "quinn", "rook", "serena", "aditi",
      "environment", "container-rebuild", "container-verify",
      "rca", "blast-radius", "prevention", "regression", "read-before-write",
      "quinn-decision-tree", "evidence-hierarchy", "ac-format",
      "coding-principles", "testing-strategy", "escalation-decision-tree",
    ];
    for (const t of templates) {
      test(`${t}.md exists`, () => { expect(existsSync(join(harnessPrompts, `${t}.md`))).toBe(true); });
    }
  });

  // ── Config-driven output verification (relationship checks) ──
  describe("config-driven verification", () => {
    test("SC-101: rungate.json has detected port from Makefile (3000)", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(new Date(config.scaffoldedAt).getTime()).toBeGreaterThan(0);
      expect(config.dev.apiBase).toBe("http://localhost:3000");
    });

    test("SC-101: rungate.json has envVars from .env.example", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.envVars).toContain("API_PORT");
      expect(config.envVars).toContain("DATABASE_URL");
      expect(config.envVars).toContain("SECRET_KEY");
    });

    test("SC-6: no hardcoded project names", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.project).not.toContain("DailyBriefDashboard");
      expect(config.project).not.toContain("asaCommandCenter");
    });

    test("SC-15: fields without source are null, not guessed", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.start).toBeDefined();
      expect(config.dev.uiBase).toBeNull();
      expect(config.dev).toHaveProperty("uiBase");
    });

    test("SC-21: no hardcoded port defaults (5173, 7778)", () => {
      const raw = readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8");
      expect(raw).not.toContain("5173");
      expect(raw).not.toContain("7778");
    });

    test("SC-86: ci.yml uses runner and bunVersion from rungate.json", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      const ci = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain(config.ci.runner);
      expect(ci).toContain(config.ci.bunVersion);
    });

    test("SC-107: prod.apiBase null (not in Makefile)", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.prod.apiBase).toBeNull();
    });

    test("SC-2: rungate.json consumers from CODE-MAP scan", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(Array.isArray(config.consumers)).toBe(true);
      expect(config.consumers.length).toBeGreaterThan(0);
      expect(config.consumers).toContain("index");
    });

    test("SC-3: AGENTS.md environment shows config values", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      if (config.dev?.apiBase) expect(content).toContain(config.dev.apiBase);
      if (config.dev?.start) expect(content).toContain(config.dev.start);
    });

    test("quinn.md shows detected port, not hardcoded default", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/quinn.md"), "utf-8");
      expect(content).not.toContain("localhost:7778");
      expect(content).not.toContain("localhost:5173");
    });

    test("CODE-MAP detects routes from src/index.ts", () => {
      const content = readFileSync(join(OUTPUT, "CODE-MAP.md"), "utf-8");
      expect(content).toContain("/api/health");
    });
  });

  // ── Git state verification ──
  describe("post-scaffold git state", () => {
    test("SC-91: pre-commit hook with secret scan", () => {
      expect(existsSync(join(OUTPUT, ".git/hooks/pre-commit"))).toBe(true);
      const content = readFileSync(join(OUTPUT, ".git/hooks/pre-commit"), "utf-8");
      expect(content).toMatch(/secret|AKIA|sk-|ghp_|password/i);
    });

    test("SC-92: pre-push hook with conformity", () => {
      expect(existsSync(join(OUTPUT, ".git/hooks/pre-push"))).toBe(true);
      const content = readFileSync(join(OUTPUT, ".git/hooks/pre-push"), "utf-8");
      expect(content).toMatch(/bun test|conformity/i);
    });

    test("SC-99: scaffold files tracked by git", () => {
      const status = execSync("git status --porcelain", { cwd: OUTPUT, encoding: "utf-8" });
      const untrackedHarness = status.split("\n").filter(
        (l) => l.startsWith("??") && (l.includes("AGENTS.md") || l.includes("CODE-MAP.md") || l.includes(".claude/"))
      );
      expect(untrackedHarness).toEqual([]);
    });

    test("SC-100: scaffold creates a commit", () => {
      const log = execSync("git log --oneline -1", { cwd: OUTPUT, encoding: "utf-8" });
      expect(log.toLowerCase()).toContain("scaffold");
    });
  });

  // ── Brief quality verification (custom logic — not auto-matchable) ──
  describe("brief quality", () => {
    test("SC-138: Core Principles block has <= 10 rules", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const match = content.match(/## Core Principles\n([\s\S]*?)(?=\n## )/);
      if (match) {
        const rules = match[1].split("\n").filter(l => l.startsWith("- "));
        expect(rules.length).toBeLessThanOrEqual(10);
      }
    });

    test("SC-139: AGENTS.md rules content under 200 words", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      const lines = content.split("\n")
        .filter(l => !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```") && l.trim().length > 0);
      const words = lines.join(" ").split(/\s+/).length;
      expect(words).toBeLessThanOrEqual(200);
    });

    test("SC-140/SC-145: identity before principles before methodology", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const nameIdx = content.indexOf("name: marcus");
      const principlesIdx = content.indexOf("## Core Principles");
      const alwaysDoIdx = content.indexOf("## Always Do");
      expect(nameIdx).toBeLessThan(principlesIdx);
      expect(principlesIdx).toBeLessThan(alwaysDoIdx);
    });

    test("SC-74: tsconfig.json strict mode", () => {
      const tsconfig = JSON.parse(readFileSync(join(OUTPUT, "tsconfig.json"), "utf-8"));
      expect(tsconfig.compilerOptions?.strict).toBe(true);
    });
  });

});
