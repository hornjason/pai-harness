/**
 * scanner.test.ts — TDD tests for lib/scanner.ts
 *
 * Verifies the ProjectScan interface and scanProject function extract
 * tech stack, specs, consumers, and source directories from a project root.
 * AC-1: ProjectScan interface with >= 4 named fields
 * AC-2: Scanner detects >= 4 detection categories
 * AC-3: Scanner importable without generation function imports
 * AC-6: >= 4 test cases for scanner
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

function createTempDir(): string {
  const dir = join("/tmp", `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("lib/scanner.ts: ProjectScan interface and scanProject function", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  // ── AC-1: ProjectScan interface has >= 4 named fields ──

  test("AC-1: ProjectScan interface exports techStack, specs, consumers, sourceDirectories fields", async () => {
    const scannerSrc = await import("../../lib/scanner");
    // Verify the exported scanProject returns an object with the required fields
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-project", type: "module" }));
    const result = scannerSrc.scanProject(tmpDir);
    expect(result).toHaveProperty("techStack");
    expect(result).toHaveProperty("specs");
    expect(result).toHaveProperty("consumers");
    expect(result).toHaveProperty("sourceDirectories");
    expect(Array.isArray(result.techStack)).toBe(true);
    expect(Array.isArray(result.specs)).toBe(true);
    expect(Array.isArray(result.consumers)).toBe(true);
    expect(Array.isArray(result.sourceDirectories)).toBe(true);
  });

  // ── AC-2: Scanner detects tech stack ──

  test("AC-2a: detects Bun runtime from package.json scripts", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "bun-project",
      scripts: { test: "bun test", dev: "bun run dev" },
      type: "module",
    }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "export default {}");
    const result = scanProject(tmpDir);
    expect(result.techStack).toContain("Bun");
  });

  test("AC-2a: detects TypeScript from tsconfig.json", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "ts-project" }));
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const result = scanProject(tmpDir);
    expect(result.techStack).toContain("TypeScript");
  });

  test("AC-2a: detects ESM from package.json type field", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "esm-project", type: "module" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const result = scanProject(tmpDir);
    expect(result.techStack).toContain("ESM");
  });

  // ── AC-2: Scanner detects specs ──

  test("AC-2b: detects specs from specs/ directory with frontmatter", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "spec-project" }));
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    writeFileSync(join(tmpDir, "specs", "MY-SPEC.md"), `---
doc-type: spec
testable: true
governs: Widget rendering pipeline
---
# My Spec
`);
    writeFileSync(join(tmpDir, "specs", "OTHER-SPEC.md"), `---
doc-type: spec
testable: false
governs: TODO
---
# Other Spec
`);
    const result = scanProject(tmpDir);
    expect(result.specs.length).toBe(2);
    expect(result.specs.find(s => s.filename === "MY-SPEC.md")).toBeTruthy();
    const mySpec = result.specs.find(s => s.filename === "MY-SPEC.md")!;
    expect(mySpec.governs).toContain("Widget rendering pipeline");
    expect(mySpec.testable).toBe("true");
  });

  // ── AC-2: Scanner detects consumers ──

  test("AC-2c: detects consumers from src/ route handlers", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-project" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "health-routes.ts"), `app.get("/api/health", (c) => c.json({ ok: true }));`);
    writeFileSync(join(tmpDir, "src", "index.ts"), `export default app;`);
    const result = scanProject(tmpDir);
    expect(result.consumers.length).toBeGreaterThan(0);
    expect(result.consumers).toContain("health");
  });

  // ── AC-2: Scanner detects source directories ──

  test("AC-2d: detects source directories (src/, lib/, etc.)", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "srcdir-project" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "lib"), { recursive: true });
    mkdirSync(join(tmpDir, "gates"), { recursive: true });
    const result = scanProject(tmpDir);
    expect(result.sourceDirectories).toContain("src");
    expect(result.sourceDirectories).toContain("lib");
    expect(result.sourceDirectories).toContain("gates");
  });

  // ── AC-2: Project type detection ──

  test("AC-2e: detects project type code for package.json + src/", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "code-project" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const result = scanProject(tmpDir);
    expect(result.projectType).toBe("code");
  });

  test("AC-2e: detects project type content for markdown-only projects", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "README.md"), "# Docs");
    const result = scanProject(tmpDir);
    expect(result.projectType).toBe("content");
  });

  test("AC-2e: detects project type infra for docker/scripts projects", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const result = scanProject(tmpDir);
    expect(result.projectType).toBe("infra");
  });

  // ── AC-3: No generation imports ──

  test("AC-3: scanner.ts does not import generation functions", async () => {
    const { readFileSync } = await import("fs");
    const { join: pathJoin } = await import("path");
    const scannerSrc = readFileSync(pathJoin(import.meta.dir, "..", "..", "lib", "scanner.ts"), "utf-8");
    // Verify no generation function imports
    expect(scannerSrc).not.toContain("generateAgentsMd");
    expect(scannerSrc).not.toContain("generateCodeMap");
    expect(scannerSrc).not.toContain("generateConformityTest");
    expect(scannerSrc).not.toContain("safeWrite");
  });

  // ── Additional: ProjectScan has projectName and projectDescription ──

  test("ProjectScan includes projectName from package.json", async () => {
    const { scanProject } = await import("../../lib/scanner");
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "my-awesome-project",
      description: "An awesome test project",
    }));
    const result = scanProject(tmpDir);
    expect(result.projectName).toBe("my-awesome-project");
    expect(result.projectDescription).toBe("An awesome test project");
  });
});
