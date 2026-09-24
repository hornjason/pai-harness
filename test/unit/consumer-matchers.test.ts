/**
 * Consumer matcher extension tests — verifies that consumer projects
 * can extend the matcher registry with domain-specific patterns.
 *
 * AC-1: loadRegistry merges consumer-defined custom matchers from project-local config
 * AC-2: create-spec SC validation uses merged registry for consumer custom matchers
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "../..");

// ── Fixture helpers ──────────────────────────────────────────────

function createConsumerProject(): string {
  const projectRoot = join(tmpdir(), `consumer-matchers-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const claudeDir = join(projectRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  return projectRoot;
}

function writeRunGateConfig(projectRoot: string, customMatchers: unknown[]): void {
  const configPath = join(projectRoot, ".claude", "rungate.json");
  writeFileSync(configPath, JSON.stringify({
    project: "test-consumer",
    repo: "test/consumer",
    customMatchers,
  }, null, 2));
}

function cleanupProject(projectRoot: string): void {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true });
  }
}

const CUSTOM_MATCHER = {
  name: "api-endpoint",
  syntax: "{method} {path} returns {status}",
  regex: "^(GET|POST|PUT|DELETE)\\s+(\\S+)\\s+returns\\s+(\\d+)",
  example: "GET /api/health returns 200",
  notes: "Validates API endpoint responses",
};

// ── AC-1: loadRegistry merges consumer custom matchers ───────────

describe("AC-1: loadRegistry merges consumer custom matchers", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = createConsumerProject();
  });

  afterEach(() => {
    cleanupProject(projectRoot);
  });

  test("loadRegistry(projectRoot) merges consumer custom matchers from .claude/rungate.json", async () => {
    writeRunGateConfig(projectRoot, [CUSTOM_MATCHER]);

    const { loadRegistry } = await import("../../lib/create-sc");
    const registry = loadRegistry(projectRoot);

    // Should contain both built-in and custom matchers
    expect(registry.some(e => e.name === "file-exists")).toBe(true);
    expect(registry.some(e => e.name === "api-endpoint")).toBe(true);
    expect(registry.length).toBeGreaterThanOrEqual(20); // 19 built-in + 1 custom
  });

  test("consumer custom matcher overrides built-in with same name", async () => {
    writeRunGateConfig(projectRoot, [
      {
        name: "file-exists",
        syntax: "{file} exists in project",
        regex: "^(\\S+)\\s+exists\\s+in\\s+project",
        example: "README.md exists in project",
        notes: "Consumer override of file-exists",
      },
    ]);

    const { loadRegistry } = await import("../../lib/create-sc");
    const registry = loadRegistry(projectRoot);

    const fileExists = registry.find(e => e.name === "file-exists");
    expect(fileExists).toBeDefined();
    expect(fileExists!.notes).toBe("Consumer override of file-exists");
    // No duplicates — override, not append
    const fileExistsCount = registry.filter(e => e.name === "file-exists").length;
    expect(fileExistsCount).toBe(1);
  });

  test("loadRegistry returns only built-in when consumer has no customMatchers", async () => {
    const configPath = join(projectRoot, ".claude", "rungate.json");
    writeFileSync(configPath, JSON.stringify({
      project: "test-consumer",
      repo: "test/consumer",
    }, null, 2));

    const { loadRegistry } = await import("../../lib/create-sc");
    const builtIn = loadRegistry();
    const withProject = loadRegistry(projectRoot);

    expect(withProject.length).toBe(builtIn.length);
  });

  test("loadRegistry returns only built-in when no project root given", async () => {
    const { loadRegistry } = await import("../../lib/create-sc");
    const registry = loadRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(19);
    expect(registry.some(e => e.name === "file-exists")).toBe(true);
  });
});

// ── AC-2: create-spec SC validation uses merged registry ─────────

describe("AC-2: create-spec validation uses merged registry", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = createConsumerProject();
    mkdirSync(join(projectRoot, "specs"), { recursive: true });
  });

  afterEach(() => {
    cleanupProject(projectRoot);
  });

  test("isMatchablePattern returns true for consumer custom pattern with projectRoot", async () => {
    writeRunGateConfig(projectRoot, [CUSTOM_MATCHER]);

    const { isMatchablePattern } = await import("../../lib/conformity");
    const sc = {
      id: "SC-999",
      statement: "GET /api/health returns 200",
      specFile: "test.md",
    };

    // Without project root, consumer pattern should NOT match
    const noMatch = isMatchablePattern(sc);
    expect(noMatch).toBe(false);

    // With project root, consumer pattern SHOULD match
    const matched = isMatchablePattern(sc, projectRoot);
    expect(matched).toBe(true);
  });

  test("isMatchablePattern returns true for built-in patterns regardless of projectRoot", async () => {
    const { isMatchablePattern } = await import("../../lib/conformity");
    const sc = {
      id: "SC-999",
      statement: "AGENTS.md exists",
      specFile: "test.md",
    };

    expect(isMatchablePattern(sc)).toBe(true);
    expect(isMatchablePattern(sc, projectRoot)).toBe(true);
  });

  test("create-spec --project-root validates SCs against merged registry", () => {
    writeRunGateConfig(projectRoot, [CUSTOM_MATCHER]);

    const CREATE_SPEC_SCRIPT = join(ROOT, "scripts", "create-spec.ts");

    // An SC matching the consumer custom pattern should be accepted
    const result = spawnSync("bun", [
      CREATE_SPEC_SCRIPT,
      "API Test Spec",
      "API endpoint testing",
      "--sc", "GET /api/health returns 200",
      "--project-root", projectRoot,
    ], {
      cwd: projectRoot,
      env: { ...process.env },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
    // Should not contain error about unmatched SC
    expect(output).not.toContain("do not match any pattern");
  });

  test("create-spec without --project-root rejects consumer-specific SC", () => {
    writeRunGateConfig(projectRoot, [CUSTOM_MATCHER]);

    const CREATE_SPEC_SCRIPT = join(ROOT, "scripts", "create-spec.ts");

    // Without --project-root, the consumer pattern is not loaded,
    // so this SC should be rejected as unmatched
    const result = spawnSync("bun", [
      CREATE_SPEC_SCRIPT,
      "API Test Spec",
      "API endpoint testing",
      "--sc", "GET /api/health returns 200",
    ], {
      cwd: ROOT,
      env: { ...process.env },
      timeout: 15000,
    });

    expect(result.status).toBe(1);
  });
});
