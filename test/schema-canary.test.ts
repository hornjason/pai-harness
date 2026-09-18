import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  parseProjectHarness,
  safeParseProjectHarness,
} from "../lib/project-harness-schema";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "";

describe("schema-canary", () => {
  test("DDB project-harness.json validates (if available)", () => {
    const ddbPath = join(HOME, "Projects/DailyBriefDashboard/.claude/project-harness.json");
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
