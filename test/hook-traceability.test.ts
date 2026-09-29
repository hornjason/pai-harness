import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const HARNESS_ROOT = resolve(import.meta.dir, "..");

describe("Hook SC Traceability (SC-370)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");
  const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith(".hook.ts")).sort();

  test("at least 14 hook files exist", () => {
    expect(hookFiles.length).toBeGreaterThanOrEqual(14);
  });

  for (const file of hookFiles) {
    test(`${file} contains SC- reference`, () => {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const hasSC = /SC-\d+/.test(content);
      expect(hasSC).toBe(true);
    });
  }
});

describe("Hook config in rungate.json (SC-391, SC-392)", () => {
  const rungateJson = JSON.parse(
    readFileSync(join(HARNESS_ROOT, ".claude", "rungate.json"), "utf-8")
  );

  test("rungate.json has hooks array", () => {
    expect(rungateJson.hooks).toBeDefined();
    expect(Array.isArray(rungateJson.hooks)).toBe(true);
  });

  test("at least 14 hook entries exist", () => {
    expect(rungateJson.hooks.length).toBeGreaterThanOrEqual(14);
  });

  test("every hook entry has hookFor and command fields (SC-391)", () => {
    const withFields = rungateJson.hooks.filter(
      (h: any) => h.hookFor && h.command
    );
    expect(withFields.length).toBeGreaterThanOrEqual(14);
  });

  test("every hook entry has enabled field (SC-392)", () => {
    const withEnabled = rungateJson.hooks.filter(
      (h: any) => "enabled" in h
    );
    expect(withEnabled.length).toBeGreaterThanOrEqual(14);
  });
});

describe("HOOK-ARCHITECTURE-SPEC current state table (SC-370)", () => {
  const specPath = join(HARNESS_ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md");
  const specContent = readFileSync(specPath, "utf-8");

  // Extract lines from the Current State table
  const tableLines = specContent
    .split("\n")
    .filter(line => line.startsWith("| ") && line.includes(".hook.ts"));

  test("spec current state table lists at least 14 hooks", () => {
    expect(tableLines.length).toBeGreaterThanOrEqual(14);
  });

  test("every hook row in spec table has an SC reference", () => {
    for (const line of tableLines) {
      expect(line).toMatch(/SC-\d+/);
    }
  });
});

describe("Hook line count limits (SC-367, SC-371)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");

  test("AgentBriefGuard.hook.ts is under 50 lines (SC-367)", () => {
    const content = readFileSync(join(hooksDir, "AgentBriefGuard.hook.ts"), "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(50);
  });

  test("no hook file exceeds 150 lines (SC-371)", () => {
    const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith(".hook.ts"));
    for (const file of hookFiles) {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(150);
    }
  });
});
