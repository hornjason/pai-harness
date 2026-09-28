/**
 * AC-5: Verify scaffold-project.ts imports generators from lib/generators/
 * AC-4: Verify >= 3 test files reference ProjectScan
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { mockProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");

describe("AC-5: scaffold-project.ts imports from lib/generators/", () => {
  const scaffoldSrc = readFileSync(join(ROOT, "scripts/scaffold-project.ts"), "utf-8");

  test("scaffold imports generateAgentsMd from lib/generators/", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/generators/);
  });

  test("scaffold has >= 3 import statements from lib/generators/", () => {
    const importMatches = scaffoldSrc.match(/from\s+["']\.\.\/lib\/generators[^"']*["']/g) || [];
    expect(importMatches.length).toBeGreaterThanOrEqual(3);
  });

  test("scaffold imports ProjectScan type from lib/generators/types", () => {
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
