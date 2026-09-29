/**
 * scaffold-decomposition.test.ts — Tests for scaffold-project.ts decomposition
 *
 * AC-1: scaffold-project.ts <= 200 lines (orchestrator-only)
 * AC-3: config/universal-rules.yaml exists with >= 3 rules
 * AC-7: lib/validators/ exists with validation functions
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("AC-1: scaffold-project.ts is orchestrator-only (<=200 lines)", () => {
  const scaffoldPath = join(ROOT, "scripts/scaffold-project.ts");

  test("scaffold-project.ts exists", () => {
    expect(existsSync(scaffoldPath)).toBe(true);
  });

  test("scaffold-project.ts is <= 200 lines", () => {
    const content = readFileSync(scaffoldPath, "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(200);
  });

  test("scaffold-project.ts imports from lib/scaffold/", () => {
    const content = readFileSync(scaffoldPath, "utf-8");
    expect(content).toMatch(/from\s+["']\.\.\/lib\/scaffold/);
  });

  test("scaffold-project.ts imports from lib/validators/", () => {
    const content = readFileSync(scaffoldPath, "utf-8");
    expect(content).toMatch(/from\s+["']\.\.\/lib\/validators/);
  });

  test("scaffold-project.ts contains no function definitions longer than 30 lines", () => {
    const content = readFileSync(scaffoldPath, "utf-8");
    const lines = content.split("\n");
    let fnStart = -1;
    let fnName = "";
    const longFns: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match function definitions (but not imports or type annotations)
      if (/^function\s+\w+/.test(line) || /^(export\s+)?function\s+\w+/.test(line)) {
        fnStart = i;
        fnName = (line.match(/function\s+(\w+)/) || [])[1] || "unknown";
      }
      // End of function (top-level closing brace)
      if (fnStart >= 0 && /^}$/.test(line.trimEnd())) {
        const fnLength = i - fnStart + 1;
        if (fnLength > 30) {
          longFns.push(`${fnName} (${fnLength} lines)`);
        }
        fnStart = -1;
      }
    }

    expect(longFns).toEqual([]);
  });
});

describe("AC-3: config/universal-rules.yaml with extracted rules", () => {
  const rulesPath = join(ROOT, "config/universal-rules.yaml");

  test("config/universal-rules.yaml exists", () => {
    expect(existsSync(rulesPath)).toBe(true);
  });

  test("contains >= 3 rule entries", () => {
    const content = readFileSync(rulesPath, "utf-8");
    // Count lines starting with "- " (YAML list items)
    const ruleLines = content.split("\n").filter(line => /^\s*- /.test(line));
    expect(ruleLines.length).toBeGreaterThanOrEqual(3);
  });

  test("contains rules previously hardcoded in scaffold", () => {
    const content = readFileSync(rulesPath, "utf-8");
    // These rules were hardcoded in the agents-md generator
    expect(content).toContain("Verify before asserting");
    expect(content).toContain("Never fake results");
    expect(content).toContain("Fix all test failures");
  });

  test("rules are loadable as a valid YAML structure", () => {
    const content = readFileSync(rulesPath, "utf-8");
    // Should have a top-level key like 'rules:' or 'universal-rules:'
    expect(content).toMatch(/^(rules|universal-rules):/m);
  });
});

describe("AC-7: lib/validators/ with validation functions", () => {
  const validatorsDir = join(ROOT, "lib/validators");

  test("lib/validators/ directory exists", () => {
    expect(existsSync(validatorsDir)).toBe(true);
  });

  test(">= 1 validator files exist", () => {
    const files = readdirSync(validatorsDir).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  test("spec-validators.ts exports detectOversizedSpecs", () => {
    const content = readFileSync(join(validatorsDir, "spec-validators.ts"), "utf-8");
    expect(content).toMatch(/export\s+function\s+detectOversizedSpecs/);
  });

  test("spec-validators.ts exports checkGovernsAlignment", () => {
    const content = readFileSync(join(validatorsDir, "spec-validators.ts"), "utf-8");
    expect(content).toMatch(/export\s+function\s+checkGovernsAlignment/);
  });

  test("spec-validators.ts exports addFrontmatterToSpecs", () => {
    const content = readFileSync(join(validatorsDir, "spec-validators.ts"), "utf-8");
    expect(content).toMatch(/export\s+function\s+addFrontmatterToSpecs/);
  });

  test("spec-validators.ts exports addFrontmatterToAdrs", () => {
    const content = readFileSync(join(validatorsDir, "spec-validators.ts"), "utf-8");
    expect(content).toMatch(/export\s+function\s+addFrontmatterToAdrs/);
  });

  test("scaffold-project.ts no longer contains validator function bodies", () => {
    const scaffold = readFileSync(join(ROOT, "scripts/scaffold-project.ts"), "utf-8");
    // These functions should no longer be defined in scaffold — only imported
    expect(scaffold).not.toMatch(/^function detectOversizedSpecs/m);
    expect(scaffold).not.toMatch(/^function checkGovernsAlignment/m);
    expect(scaffold).not.toMatch(/^function addFrontmatterToSpecs/m);
    expect(scaffold).not.toMatch(/^function addFrontmatterToAdrs/m);
  });
});

// ── AC-4/5/6: Config-driven key files, agentConfig, universal rules ──
// These are batch 2 features — scaffold decomposition landed but config-driven
// features are follow-up work. Tracked as TODOs.

describe("AC-4/5/6: config-driven scaffold features (follow-up)", () => {
  test.todo("AC-4: rungate.json includes keyFiles field");
  test.todo("AC-5: rungate.json includes agentConfig field");
  test.todo("AC-6: project-specific rules merge with universal rules");
});
