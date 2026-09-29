#!/usr/bin/env bun
/**
 * scanner.test.ts — TDD tests for lib/scanner.ts (SC-358, SC-359)
 *
 * Tests the extracted project scanner that returns a typed ProjectScan
 * interface from a project root path.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// AC-1: lib/scanner.ts exports ProjectScan interface and scanProject function
// AC-3: Scanner importable without pulling in generation functions
import { scanProject, type ProjectScan, type ProjectType } from "../../lib/scanner";

function createTempDir(): string {
  const dir = join("/tmp", `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── AC-1: ProjectScan interface has required fields ────────────

describe("scanner: ProjectScan interface shape", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("scanProject returns object with techStack field", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test", type: "module" }));
    const scan = scanProject(tmpDir);
    expect(scan).toHaveProperty("techStack");
    expect(Array.isArray(scan.techStack)).toBe(true);
  });

  test("scanProject returns object with specs field", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const scan = scanProject(tmpDir);
    expect(scan).toHaveProperty("specs");
    expect(Array.isArray(scan.specs)).toBe(true);
  });

  test("scanProject returns object with consumers field", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const scan = scanProject(tmpDir);
    expect(scan).toHaveProperty("consumers");
    expect(Array.isArray(scan.consumers)).toBe(true);
  });

  test("scanProject returns object with sourceDirectories field", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const scan = scanProject(tmpDir);
    expect(scan).toHaveProperty("sourceDirectories");
    expect(Array.isArray(scan.sourceDirectories)).toBe(true);
  });
});

// ── AC-2: Scanner detects tech stack ───────────────────────────

describe("scanner: tech stack detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects Bun runtime from package.json scripts", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "bun-project",
      scripts: { test: "bun test", dev: "bun run dev" },
    }));
    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("Bun");
  });

  test("detects TypeScript from tsconfig.json", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "ts-project" }));
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("TypeScript");
  });

  test("detects ESM from package.json type field", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "esm-project",
      type: "module",
    }));
    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("ESM");
  });

  test("detects Node.js runtime when scripts reference node", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "node-project",
      scripts: { start: "node index.js" },
    }));
    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("Node.js");
  });
});

// ── AC-2: Scanner detects specs ────────────────────────────────

describe("scanner: spec scanning", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("scans spec files with frontmatter", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"));
    writeFileSync(join(tmpDir, "specs", "MY-SPEC.md"), `---
doc-type: spec
testable: true
governs: My feature area
---
# My Spec
`);
    const scan = scanProject(tmpDir);
    expect(scan.specs.length).toBe(1);
    expect(scan.specs[0].file).toBe("MY-SPEC.md");
    expect(scan.specs[0].governs).toBe("My feature area");
    expect(scan.specs[0].testable).toBe("true");
  });

  test("scans multiple spec files", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"));
    writeFileSync(join(tmpDir, "specs", "SPEC-A.md"), `---\ntestable: true\ngoverns: Area A\n---\n# A`);
    writeFileSync(join(tmpDir, "specs", "SPEC-B.md"), `---\ntestable: false\ngoverns: Area B\n---\n# B`);
    const scan = scanProject(tmpDir);
    expect(scan.specs.length).toBe(2);
  });

  test("returns empty specs when no specs/ directory", () => {
    tmpDir = createTempDir();
    const scan = scanProject(tmpDir);
    expect(scan.specs).toEqual([]);
  });
});

// ── AC-2: Scanner detects consumers ────────────────────────────

describe("scanner: consumer detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects consumers from src/ route handler files", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(tmpDir, "src", "index.ts"), `
import { Hono } from "hono";
const app = new Hono();
app.get("/api/health", (c) => c.json({ ok: true }));
export default app;
`);
    const scan = scanProject(tmpDir);
    expect(scan.consumers.length).toBeGreaterThan(0);
    expect(scan.consumers).toContain("index");
  });

  test("detects consumers from named pattern files", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(tmpDir, "src", "user-routes.ts"), `export function routes() {}`);
    const scan = scanProject(tmpDir);
    expect(scan.consumers).toContain("user");
  });

  test("reads consumers from rungate.json when present", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      consumers: ["api", "dashboard"],
    }));
    const scan = scanProject(tmpDir);
    expect(scan.consumers).toContain("api");
    expect(scan.consumers).toContain("dashboard");
  });
});

// ── AC-2: Scanner detects source directories ───────────────────

describe("scanner: source directory detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects src/ when it exists", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"));
    const scan = scanProject(tmpDir);
    expect(scan.sourceDirectories).toContain("src");
  });

  test("detects lib/ when it exists", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "lib"));
    const scan = scanProject(tmpDir);
    expect(scan.sourceDirectories).toContain("lib");
  });

  test("detects multiple source directories", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "lib"));
    mkdirSync(join(tmpDir, "hooks"));
    const scan = scanProject(tmpDir);
    expect(scan.sourceDirectories).toContain("src");
    expect(scan.sourceDirectories).toContain("lib");
    expect(scan.sourceDirectories).toContain("hooks");
  });

  test("returns empty when no source directories exist", () => {
    tmpDir = createTempDir();
    const scan = scanProject(tmpDir);
    expect(scan.sourceDirectories).toEqual([]);
  });
});

// ── AC-2: Project type detection ───────────────────────────────

describe("scanner: project type detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects code project with src/ and package.json", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const scan = scanProject(tmpDir);
    expect(scan.projectType).toBe("code");
  });

  test("detects content project with only markdown", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "posts.md"), "# Posts");
    const scan = scanProject(tmpDir);
    expect(scan.projectType).toBe("content");
  });

  test("detects infra project with docker-compose", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "scripts"));
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const scan = scanProject(tmpDir);
    expect(scan.projectType).toBe("infra");
  });
});

// ── AC-3: Import isolation ─────────────────────────────────────

describe("scanner: import isolation", () => {
  test("scanner.ts has zero generation function imports", async () => {
    const scannerPath = join(import.meta.dir, "..", "..", "lib", "scanner.ts");
    expect(existsSync(scannerPath)).toBe(true);
    const content = await Bun.file(scannerPath).text();
    const generationImports = content.match(/generateAgentsMd|generateCodeMap|generateConformityTest|safeWrite/g);
    expect(generationImports).toBeNull();
  });
});
