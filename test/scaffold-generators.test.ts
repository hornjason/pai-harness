/**
 * AC-5: Verify scaffold pipeline uses generators from lib/generators/
 * AC-4: Verify >= 3 test files reference ProjectScan
 *
 * After SCAFFOLD-DECOMPOSITION-SPEC, scaffold-project.ts is orchestrator-only.
 * Generator imports live in lib/scaffold/steps.ts (the deep module).
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { mockProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");

describe("AC-5: scaffold pipeline imports from lib/generators/", () => {
  // After decomposition, generator imports live in lib/scaffold/steps.ts
  const stepsSrc = readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8");
  const scaffoldSrc = readFileSync(join(ROOT, "scripts/scaffold-project.ts"), "utf-8");

  test("scaffold imports from lib/scaffold/ (orchestrator pattern)", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/scaffold/);
  });

  test("scaffold imports from lib/validators/ (decomposed validators)", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/validators/);
  });

  test("steps.ts has >= 3 import statements from lib/generators/", () => {
    const importMatches = stepsSrc.match(/from\s+["']\.\.\/generators[^"']*["']/g) || [];
    expect(importMatches.length).toBeGreaterThanOrEqual(3);
  });

  test("scaffold imports ProjectType from lib/generators/types", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/generators\/types["']/);
  });
});

describe("AC-4: >= 3 test files reference ProjectScan", () => {
  test("at least 3 test files import or reference ProjectScan", () => {
    const testDir = join(ROOT, "test");
    const testFiles = readdirSync(testDir).filter(f => f.endsWith(".test.ts"));
    let count = 0;
    for (const f of testFiles) {
      const content = readFileSync(join(testDir, f), "utf-8");
      if (content.includes("ProjectScan") || content.includes("mockProjectScan")) {
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
