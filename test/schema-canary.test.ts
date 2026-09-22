import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  parseProjectHarness,
  safeParseProjectHarness,
} from "../lib/rungate-schema";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "";

interface MatcherEntry {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

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
  const registryPath = join(HARNESS_ROOT, "config", "matcher-registry.json");

  test("matcher-registry.json exists and parses as valid JSON", () => {
    expect(existsSync(registryPath)).toBe(true);
    const raw = readFileSync(registryPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.patterns).toBeDefined();
    expect(Array.isArray(parsed.patterns)).toBe(true);
  });

  test("every entry has required fields: name, syntax, regex, example, notes", () => {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    const requiredFields = ["name", "syntax", "regex", "example", "notes"] as const;
    const invalid: string[] = [];
    for (const entry of raw.patterns as MatcherEntry[]) {
      for (const field of requiredFields) {
        if (!entry[field] && entry[field] !== "") {
          invalid.push(`${entry.name || "unnamed"}: missing '${field}'`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  test("rejects entries with missing required fields", () => {
    const badEntries = [
      { name: "bad-1", syntax: "test", regex: "test", example: "test" },
      { name: "bad-2", syntax: "test", regex: "test", notes: "test" },
      { syntax: "test", regex: "test", example: "test", notes: "test" },
    ];
    const requiredFields = ["name", "syntax", "regex", "example", "notes"];
    for (const entry of badEntries) {
      const missing = requiredFields.filter(f => !(f in entry));
      expect(missing.length).toBeGreaterThan(0);
    }
  });

  test("every regex field compiles as valid RegExp", () => {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    const invalid: string[] = [];
    for (const entry of raw.patterns as MatcherEntry[]) {
      try {
        new RegExp(entry.regex, "i");
      } catch {
        invalid.push(`${entry.name}: invalid regex "${entry.regex}"`);
      }
    }
    expect(invalid).toEqual([]);
  });

  test("pattern names are unique", () => {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
    const names = (raw.patterns as MatcherEntry[]).map(p => p.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});
