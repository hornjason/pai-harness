#!/usr/bin/env bun
/**
 * scaffold-project.test.ts — TDD tests for scripts/scaffold-project.ts
 *
 * Tests the CLI that bootstraps any project to scaffold conformity.
 * Validates: project type detection, directory creation, AGENTS.md generation,
 * test file creation, spec frontmatter injection, no-overwrite guarantee.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "scaffold-project.ts");

function createTempDir(): string {
  const dir = join("/tmp", `scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runScaffold(projectPath: string, opts?: { expectFail?: boolean }): string {
  try {
    return execSync(`bun ${SCRIPT} ${projectPath}`, {
      encoding: "utf-8",
      timeout: 15000,
    });
  } catch (e: any) {
    if (opts?.expectFail) return e.stderr || e.stdout || "";
    throw e;
  }
}

// ── Test 1: Project Type Detection ─────────────────────────────

describe("scaffold-project: project type detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects code project when src/ and package.json exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-code", dependencies: {} }));
    const output = runScaffold(tmpDir);
    expect(output).toContain("code");
  });

  test("detects content project when only markdown files exist", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "posts.md"), "# Posts\n\nSome content.");
    writeFileSync(join(tmpDir, "README.md"), "# readme");
    const output = runScaffold(tmpDir);
    expect(output).toContain("content");
  });

  test("detects infra project when scripts/ or manifests exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const output = runScaffold(tmpDir);
    expect(output).toContain("infra");
  });
});

// ── Test 2: Directory Creation ─────────────────────────────────

describe("scaffold-project: directory creation", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates specs/, reference/, tests/, .github/ when missing", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    expect(existsSync(join(tmpDir, "specs"))).toBe(true);
    expect(existsSync(join(tmpDir, "reference"))).toBe(true);
    // tests/ OR test/ accepted
    const hasTests = existsSync(join(tmpDir, "tests")) || existsSync(join(tmpDir, "test"));
    expect(hasTests).toBe(true);
    expect(existsSync(join(tmpDir, ".github"))).toBe(true);
  });

  test("does not create dirs that already exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    writeFileSync(join(tmpDir, "specs", "existing.md"), "---\ntestable: true\n---\n# Existing");
    runScaffold(tmpDir);

    // specs/ still exists, existing file still there
    expect(existsSync(join(tmpDir, "specs", "existing.md"))).toBe(true);
  });
});

// ── Test 3: AGENTS.md Generation ───────────────────────────────

describe("scaffold-project: AGENTS.md generation", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("generates AGENTS.md with all standard sections", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "my-project" }));
    runScaffold(tmpDir);

    const agentsPath = join(tmpDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    const requiredSections = [
      "Project Identity",
      "Key Files",
      "Specs",
      "Tests",
      "Commands",
      "Workflow",
      "Quick Reference",
      "Harness-Managed Files",
    ];
    for (const section of requiredSections) {
      expect(content.toLowerCase()).toContain(section.toLowerCase());
    }
  });

  test("AGENTS.md is ≤150 lines", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content.split("\n").length).toBeLessThanOrEqual(150);
  });

  test("AGENTS.md contains TODO markers for customization", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("TODO");
  });
});

// ── Test 4: No-Overwrite Guarantee ─────────────────────────────

describe("scaffold-project: no-overwrite guarantee", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("never overwrites existing AGENTS.md", () => {
    tmpDir = createTempDir();
    const existingContent = "# My Custom AGENTS.md\n\nThis should not be overwritten.";
    writeFileSync(join(tmpDir, "AGENTS.md"), existingContent);
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toBe(existingContent);
  });

  test("never overwrites existing copilot-instructions.md", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    const existing = "# Custom instructions\nDo not touch.";
    writeFileSync(join(tmpDir, ".github", "copilot-instructions.md"), existing);
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, ".github", "copilot-instructions.md"), "utf-8");
    expect(content).toBe(existing);
  });

  test("never overwrites existing test files", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    const existing = "// my custom test\n";
    writeFileSync(join(tmpDir, "tests", "scaffold-conformity.test.ts"), existing);
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "tests", "scaffold-conformity.test.ts"), "utf-8");
    expect(content).toBe(existing);
  });
});

// ── Test 5: Copilot Instructions ───────────────────────────────

describe("scaffold-project: copilot instructions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates .github/copilot-instructions.md with pointer to AGENTS.md", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    const path = join(tmpDir, ".github", "copilot-instructions.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("AGENTS.md");
  });
});

// ── Test 6: Thin Conformity Test File ──────────────────────────

describe("scaffold-project: conformity test file", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates scaffold-conformity.test.ts in tests/", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    // Should create in tests/ (or test/ if that already exists)
    const testDir = existsSync(join(tmpDir, "test")) ? "test" : "tests";
    const testFile = join(tmpDir, testDir, "scaffold-conformity.test.ts");
    expect(existsSync(testFile)).toBe(true);

    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("runScaffoldConformity");
    expect(content).toContain("rungate");
  });
});

// ── Test 7: Spec Frontmatter Injection ─────────────────────────

describe("scaffold-project: spec frontmatter injection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("adds frontmatter to bare spec files in specs/", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    // Write a spec file WITHOUT frontmatter
    writeFileSync(join(tmpDir, "specs", "bare-spec.md"), "# My Spec\n\nSome content here.");
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "specs", "bare-spec.md"), "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("testable:");
    expect(content).toContain("doc-type: spec");
  });

  test("does not modify spec files that already have frontmatter", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const existing = "---\ndoc-type: spec\ntestable: true\n---\n# Already Good";
    writeFileSync(join(tmpDir, "specs", "good-spec.md"), existing);
    runScaffold(tmpDir);

    const content = readFileSync(join(tmpDir, "specs", "good-spec.md"), "utf-8");
    expect(content).toBe(existing);
  });
});

// ── Test 8: Package.json devDeps ───────────────────────────────

describe("scaffold-project: package.json devDeps", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("adds rungate to package.json devDependencies when package.json exists", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test", dependencies: {} }, null, 2));
    runScaffold(tmpDir);

    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies["rungate"]).toBeDefined();
  });

  test("does not create package.json when it does not exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(join(tmpDir, "docs", "notes.md"), "# Notes");
    runScaffold(tmpDir);

    // Content project — no package.json should be created
    expect(existsSync(join(tmpDir, "package.json"))).toBe(false);
  });
});

// ── Test 9: Report Output ──────────────────────────────────────

describe("scaffold-project: report output", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("reports what it created and what it skipped", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const output = runScaffold(tmpDir);

    expect(output).toContain("CREATED");
    // Should report at least AGENTS.md creation
    expect(output).toContain("AGENTS.md");
  });

  test("reports AUDITED or SKIPPED for existing files", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Existing");
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const output = runScaffold(tmpDir);

    expect(output).toMatch(/SKIP|AUDITED/);
    expect(output).toContain("AGENTS.md");
  });
});

// ── Test 10: CLI Error Handling ────────────────────────────────

describe("scaffold-project: CLI error handling", () => {
  test("exits with error when no path provided", () => {
    try {
      execSync(`bun ${SCRIPT}`, { encoding: "utf-8", timeout: 10000 });
      expect(false).toBe(true); // should not reach here
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
  });

  test("exits with error when path does not exist", () => {
    try {
      execSync(`bun ${SCRIPT} /nonexistent/path/that/surely/does/not/exist`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
  });
});

// ── Test 11: Existing test/ dir is respected ───────────────────

describe("scaffold-project: respects existing test/ directory name", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("uses test/ if it exists instead of creating tests/", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir);

    // Should place conformity test in existing test/ dir
    expect(existsSync(join(tmpDir, "test", "scaffold-conformity.test.ts"))).toBe(true);
    // Should NOT create a second tests/ dir
    expect(existsSync(join(tmpDir, "tests"))).toBe(false);
  });
});

// ── Test 12: Hard Constraints last-section edge case ─────────

describe("scaffold-project: hard constraints regex", () => {
  test("Hard Constraints preserved when last section in AGENTS.md", () => {
    const content = `## Identity\nTest project\n\n## Hard Constraints (non-inferrable)\n\n- **Rule one** — important\n- **Rule two** — also important\n`;
    const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
    expect(hcMatch).not.toBeNull();
    expect(hcMatch![1]).toContain("Rule one");
    expect(hcMatch![1]).toContain("Rule two");
  });
});

// ── Test 13: Per-type staleness thresholds ────────────────────

describe("scaffold-project: per-type staleness thresholds", () => {
  function classifyStale(ref: string, daysSince: number): boolean {
    const isAdr = ref.includes('docs/adr/') || /ADR/i.test(ref);
    if (isAdr) return false;
    const threshold = ref.startsWith('specs/') ? 90 : 180;
    return daysSince > threshold;
  }

  test("ADR paths are never stale regardless of age", () => {
    expect(classifyStale("docs/adr/ADR-001.md", 500)).toBe(false);
  });

  test("spec paths use 90-day threshold", () => {
    expect(classifyStale("specs/BOOTSTRAP.md", 91)).toBe(true);
    expect(classifyStale("specs/BOOTSTRAP.md", 89)).toBe(false);
  });

  test("other doc paths use 180-day threshold", () => {
    expect(classifyStale("docs/GUIDE.md", 181)).toBe(true);
    expect(classifyStale("docs/GUIDE.md", 179)).toBe(false);
  });
});
