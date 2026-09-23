import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  parseProjectHarness,
  safeParseProjectHarness,
} from "../lib/rungate-schema";
import {
  parseMatcherRegistry,
  safeParseMatcherRegistry,
} from "../lib/matcher-registry-schema";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "";

describe("schema-canary", () => {
  test("DDB rungate.json validates (if available)", () => {
    const ddbPath = join(HOME, "Projects/DailyBriefDashboard/.claude/rungate.json");
    if (!existsSync(ddbPath)) return;
    const raw = JSON.parse(readFileSync(ddbPath, "utf-8"));
    const result = safeParseProjectHarness(raw);
    if (!result.success) {
      console.error("Validation errors:", result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  test("missing required field produces Zod error", () => {
    const bad = { repo: "org/repo", issueRepo: "org/issues" };
    const result = safeParseProjectHarness(bad);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toContain("project");
  });

  test("schema has schemaVersion field with default", () => {
    const minimal = { project: "test", repo: "org/repo", issueRepo: "org/issues" };
    const result = parseProjectHarness(minimal);
    expect(result.schemaVersion).toBe(1);
  });

  test("dev section requires start, apiBase, uiBase when present", () => {
    const withPartialDev = {
      project: "test",
      repo: "org/repo",
      issueRepo: "org/issues",
      dev: { start: "make dev" },
    };
    const result = safeParseProjectHarness(withPartialDev);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toContain("dev.apiBase");
    expect(paths).toContain("dev.uiBase");
  });
});

describe("matcher-registry schema validation", () => {
  test("config/matcher-registry.json validates against schema", () => {
    const registryPath = join(HARNESS_ROOT, "config", "matcher-registry.json");
    if (!existsSync(registryPath)) {
      expect(existsSync(registryPath)).toBe(true);
      return;
    }
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    const result = safeParseMatcherRegistry(raw);
    if (!result.success) {
      console.error("Validation errors:", result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  test("parseMatcherRegistry returns typed result on valid input", () => {
    const registryPath = join(HARNESS_ROOT, "config", "matcher-registry.json");
    if (!existsSync(registryPath)) {
      expect(existsSync(registryPath)).toBe(true);
      return;
    }
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    const parsed = parseMatcherRegistry(raw);
    expect(parsed.patterns.length).toBeGreaterThanOrEqual(19);
    expect(parsed.patterns[0].name).toBeDefined();
  });

  test("rejects entry with missing name field", () => {
    const bad = {
      patterns: [{
        syntax: "{file} exists",
        regex: "^(\\S+)\\s+exists?\\b",
        example: "AGENTS.md exists",
        notes: "Basic file existence check",
      }],
    };
    const result = safeParseMatcherRegistry(bad);
    expect(result.success).toBe(false);
  });

  test("rejects entry with empty string fields", () => {
    const bad = {
      patterns: [{
        name: "",
        syntax: "{file} exists",
        regex: "^(\\S+)\\s+exists?\\b",
        example: "AGENTS.md exists",
        notes: "Basic file existence check",
      }],
    };
    const result = safeParseMatcherRegistry(bad);
    expect(result.success).toBe(false);
  });

  test("rejects entry with invalid regex", () => {
    const bad = {
      patterns: [{
        name: "bad-regex",
        syntax: "{file} exists",
        regex: "[invalid((",
        example: "AGENTS.md exists",
        notes: "Should fail validation",
      }],
    };
    const result = safeParseMatcherRegistry(bad);
    expect(result.success).toBe(false);
  });
});
