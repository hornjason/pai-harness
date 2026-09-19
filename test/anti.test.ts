import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const HARNESS = join(import.meta.dir, "..");

describe("Anti-Criteria: must NOT happen", () => {

  // SC-A1: No workflow file references specific projects
  describe("SC-A1: no project-specific references in workflows", () => {
    test("no DailyBriefDashboard references", () => {
      const files = findTsFiles(HARNESS, ["gates", "scripts", "lib"]);
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).not.toContain("DailyBriefDashboard");
    });

    test("no asaCommandCenter references", () => {
      const files = findTsFiles(HARNESS, ["gates", "scripts", "lib"]);
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).not.toContain("asaCommandCenter");
    });
  });

  // SC-A2: No hardcoded file paths in rungate.json generation
  describe("SC-A2: no hardcoded paths in config generation", () => {
    test("no dashboard/src/App.tsx in scaffold", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).not.toContain("dashboard/src/App.tsx");
    });

    test("no callGemini patterns in scaffold", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(scaffold).not.toContain("callGemini");
    });
  });

  // SC-A3: No "PAI" references in runtime paths
  describe("SC-A3: no PAI naming in runtime paths", () => {
    test("no .pai- prefixed paths in gate/lib code", () => {
      const files = findTsFiles(HARNESS, ["gates", "lib", "scripts"]);
      for (const f of files) {
        const content = readFileSync(f, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments and strings that are documentation
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          // Check for .pai- in actual path construction
          if (line.match(/["'`].*\.pai-/) && !line.includes("CLAUDE.md") && !line.includes("doc-type")) {
            expect(`${f}:${i + 1}: ${line.trim()}`).not.toMatch(/\.pai-/);
          }
        }
      }
    });

    test("lock files use rungate naming", () => {
      const files = findTsFiles(HARNESS, ["gates", "lib", "scripts"]);
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      // If there are lock file references, they should use rungate, not pai
      if (content.includes("lock")) {
        expect(content).not.toMatch(/pai-testing-lock|\.pai-lock/);
      }
    });
  });
});

function findTsFiles(root: string, dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    if (!existsSync(dirPath)) continue;
    for (const f of readdirSync(dirPath)) {
      if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
        files.push(join(dirPath, f));
      }
    }
  }
  return files;
}
