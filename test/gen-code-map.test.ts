/**
 * Generator unit test: code-map
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateCodeMap } from "../lib/generators/code-map";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";

describe("generateCodeMap with mock ProjectScan", () => {
  test("returns string with code-map frontmatter", () => {
    const scan = mockProjectScan({
      name: "map-project",
      dirs: [{ name: "src", fileCount: 10, types: ["ts"] }],
      deps: 5,
      devDeps: 3,
    });
    const result = generateCodeMap(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("doc-type: code-map");
    expect(result).toContain("status: generated");
  });

  test("includes project name in title", () => {
    const scan = mockProjectScan({ name: "named-project" });
    const result = generateCodeMap(scan);
    expect(result).toContain("# Code Map — named-project");
  });

  test("includes directory structure table", () => {
    const scan = mockProjectScan({
      name: "dir-test",
      dirs: [
        { name: "src", fileCount: 20, types: ["ts", "tsx"] },
        { name: "lib", fileCount: 8, types: ["ts"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Directory Structure");
    expect(result).toContain("| src/ | 20 | ts, tsx |");
    expect(result).toContain("| lib/ | 8 | ts |");
  });

  test("includes dependency counts", () => {
    const scan = mockProjectScan({
      name: "deps-test",
      deps: 15,
      devDeps: 9,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Dependencies | 15 |");
    expect(result).toContain("| Dev dependencies | 9 |");
  });

  test("includes API routes when present", () => {
    const scan = mockProjectScan({
      name: "api-test",
      routes: [
        { method: "POST", path: "/api/users", file: "src/routes.ts" },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## API Routes");
    expect(result).toContain("| POST | /api/users | src/routes.ts |");
  });

  test("omits API routes section when empty", () => {
    const scan = mockProjectScan({
      name: "no-routes",
      routes: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## API Routes");
  });

  test("includes source modules when present", () => {
    const scan = mockProjectScan({
      name: "modules-test",
      modules: [
        { file: "src/helpers.ts", exports: ["parseDate", "formatCurrency"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Source Modules");
    expect(result).toContain("| src/helpers.ts | parseDate, formatCurrency |");
  });

  test("omits modules section when empty", () => {
    const scan = mockProjectScan({
      name: "no-modules",
      modules: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## Source Modules");
  });

  test("includes summary table with counts", () => {
    const scan = mockProjectScan({
      name: "summary-test",
      dirs: [
        { name: "a", fileCount: 1, types: ["ts"] },
        { name: "b", fileCount: 2, types: ["js"] },
        { name: "c", fileCount: 3, types: ["md"] },
      ],
      deps: 10,
      devDeps: 5,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Source directories | 3 |");
    expect(result).toContain("| Dependencies | 10 |");
  });
});
