/**
 * Scanner unit tests — verifies lib/scanner.ts extraction per SCAFFOLD-DECOMPOSITION-SPEC SC-358/359.
 *
 * AC-1: lib/scanner.ts exports scanProject returning ProjectScan
 * AC-2: Scanner detects tech stack, specs, consumers, source directories
 * AC-3: Scanner imports no generation logic (only fs, path, types)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// AC-1: scanner exports scanProject
import { scanProject } from "../lib/scanner";
import type { ProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");

describe("lib/scanner.ts — scanProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- AC-1: exports scanProject returning ProjectScan ---

  test("AC-1: scanProject is a function", () => {
    expect(typeof scanProject).toBe("function");
  });

  test("AC-1: scanProject returns a ProjectScan with required fields", () => {
    // Minimal code project: just package.json + src/
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-proj",
      description: "A test project",
      type: "module",
      scripts: { test: "bun test" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.name).toBe("test-proj");
    expect(scan.type).toBe("code");
    expect(scan.root).toBe(tmpDir);
    expect(scan.identity).toBeTruthy();
    expect(Array.isArray(scan.techStack)).toBe(true);
    expect(Array.isArray(scan.keyFiles)).toBe(true);
    expect(Array.isArray(scan.specs)).toBe(true);
    expect(Array.isArray(scan.consumers)).toBe(true);
    expect(Array.isArray(scan.sourceDirs)).toBe(true);
  });

  // --- AC-2: detects tech stack ---

  test("AC-2: detects Bun runtime from package.json scripts", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "bun-proj",
      scripts: { test: "bun test", dev: "bun run dev" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("Bun");
  });

  test("AC-2: detects TypeScript from tsconfig.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "ts-proj",
      scripts: { test: "bun test" },
    }));
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("TypeScript");
  });

  test("AC-2: detects ESM from package.json type field", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "esm-proj",
      type: "module",
      scripts: { test: "bun test" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("ESM");
  });

  // --- AC-2: detects specs ---

  test("AC-2: scans spec files with frontmatter", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "spec-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "specs"));
    writeFileSync(join(tmpDir, "specs", "MY-SPEC.md"), `---
doc-type: spec
governs: Something important
testable: true
---
# My Spec
`);

    const scan = scanProject(tmpDir);
    expect(scan.specs.length).toBeGreaterThanOrEqual(1);
    const spec = scan.specs.find(s => s.file === "MY-SPEC.md");
    expect(spec).toBeDefined();
    expect(spec!.governs).toBe("Something important");
    expect(spec!.testable).toBe("true");
  });

  // --- AC-2: detects consumers ---

  test("AC-2: reads consumers from harness config", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      consumers: ["project-a", "project-b"],
    }));

    const scan = scanProject(tmpDir);
    expect(scan.consumers).toContain("project-a");
    expect(scan.consumers).toContain("project-b");
  });

  // --- AC-2: detects source directories ---

  test("AC-2: detects source directories", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "dirs-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "lib"));

    const scan = scanProject(tmpDir);
    expect(scan.sourceDirs).toContain("src");
    expect(scan.sourceDirs).toContain("lib");
  });

  // --- AC-2: detects project type ---

  test("AC-2: detects code project type", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "code-proj" }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.type).toBe("code");
  });

  test("AC-2: detects content project type (no package.json, no manifests)", () => {
    // Content project: no package.json, no infra markers
    mkdirSync(join(tmpDir, "docs"));
    writeFileSync(join(tmpDir, "docs", "README.md"), "# Content");

    const scan = scanProject(tmpDir);
    expect(scan.type).toBe("content");
  });

  // --- AC-2: more scan fields ---

  test("AC-2: detects test command from package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-cmd-proj",
      scripts: { test: "jest --coverage" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.testCmd).toBe("jest --coverage");
  });

  test("AC-2: scans key files including package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "keys-proj" }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    const files = scan.keyFiles.map(kf => kf.file);
    expect(files).toContain("package.json");
  });

  test("AC-2: scans test files", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "tests-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "test"));
    writeFileSync(join(tmpDir, "test", "example.test.ts"), "test('x', () => {});");

    const scan = scanProject(tmpDir);
    expect(scan.testFiles.length).toBeGreaterThanOrEqual(1);
    expect(scan.testFiles[0].file).toBe("example.test.ts");
  });
});

describe("AC-3: Scanner import isolation", () => {
  test("scanner.ts imports no generation modules", () => {
    const content = readFileSync(join(ROOT, "lib/scanner.ts"), "utf-8");
    // Must not import from generators/agents-md, generators/agent-briefs, generators/code-map
    expect(content).not.toMatch(/from.*generators\/(agents-md|agent-briefs|code-map)/);
    // May import from generators/types (that's the typed interface, not generation logic)
    expect(content).toMatch(/from.*generators\/types|from.*\.\/generators\/types/);
  });
});
