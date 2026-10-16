/**
 * Anti-criteria — things that must NOT be true of the harness.
 *
 * Covers SC-737 of GATE-CONTRACTS-SPEC.md.
 */
import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const HARNESS = join(import.meta.dir, "..");

describe("Anti-Criteria: must NOT happen", () => {

  // SC-A1: No workflow file references specific projects
  //
  // #304. `findTsFiles` does not recurse, so for the whole life of this check
  // the three consumer references under `lib/scaffold/` were invisible to it
  // — a guard passing because of what it never looked at, in the file whose
  // entire job is refusing consumer specifics. It is now recursive, and the
  // three are held as an exact list below: a subdirectory left out of the
  // walk is a subdirectory nobody measures again, where a count refuses
  // growth and goes red as an instruction to delist.
  describe("SC-A1: no project-specific references in workflows", () => {
    const CONSUMER = "DailyBriefDashboard";
    // `lib/scaffold/managed-workflow.ts` delisted in #482: the comment that
    // named a consumer was on the merge path that issue deleted, and the
    // replacement says "a real consumer" with the detail in the issue. The
    // ratchet caught it the moment the file went clean, which is the half of
    // "both ways" that usually never fires.
    const KNOWN = [
      "lib/scaffold/steps.ts",
    ];

    const hits = (needle: string) =>
      findTsFiles(HARNESS, ["gates", "scripts", "lib"])
        .filter(f => readFileSync(f, "utf-8").includes(needle))
        .map(f => f.slice(HARNESS.length + 1))
        .sort();

    test(`no ${CONSUMER} references outside the known list`, () => {
      const unexpected = hits(CONSUMER).filter(f => !KNOWN.includes(f));
      expect(
        unexpected,
        `${CONSUMER} named in: ${unexpected.join(", ")}. The harness must not name one of ` +
          `its consumers; say "one consumer" and put the detail in the issue (#304).`,
      ).toEqual([]);
    });

    test("the known list is exactly what is there — it ratchets both ways", () => {
      // A stale entry is as bad as a missing one: it reads as a measured
      // exception while naming a file that no longer has the problem.
      expect(
        hits(CONSUMER),
        "the known-reference list is stale. Delist what you fixed; do not add to it.",
      ).toEqual(KNOWN);
    });

    test("the walk reaches subdirectories — planted control", () => {
      // The assertion above would pass vacuously against a non-recursive
      // walk, which is exactly how it passed before #304. `lib/scaffold/` is
      // the directory it could not see.
      const files = findTsFiles(HARNESS, ["lib"]).map(f => f.slice(HARNESS.length + 1));
      expect(files.some(f => f.startsWith("lib/scaffold/"))).toBe(true);
      expect(files.length, "the walk found suspiciously few files").toBeGreaterThan(30);
    });

    test("no asaCommandCenter references", () => {
      expect(hits("asaCommandCenter")).toEqual([]);
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

  // SC-A4: Generated briefs minimize inferable content
  test.todo("SC-A4: generated briefs minimize inferable content");

  // SC-A5: External tool findings never silently dropped
  test.todo("SC-A5: external tool findings never silently dropped");

  // SC-A6: Composite scoring never rewards inferable heading presence
  test.todo("SC-A6: composite scoring excludes inferable headings");
});

/**
 * Recursive since #304. The flat version read only the top level of each
 * directory, so every check in this file that joined its output and searched
 * the result was reporting on a fraction of the tree it claimed to cover.
 */
function findTsFiles(root: string, dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dirPath: string) => {
    if (!existsSync(dirPath)) return;
    for (const e of readdirSync(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "test-fixtures") continue;
        walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        files.push(p);
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return files;
}
