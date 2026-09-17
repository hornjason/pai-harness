import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ProjectHarnessSchema,
  parseProjectHarness,
  safeParseProjectHarness,
} from "../lib/project-harness-schema";

const DDB_PATH = join(
  process.env.HOME || "",
  "Projects/DailyBriefDashboard/.claude/project-harness.json",
);

describe("schema-canary", () => {
  test("DDB project-harness.json validates against schema", () => {
    const raw = JSON.parse(readFileSync(DDB_PATH, "utf-8"));
    const result = safeParseProjectHarness(raw);
    if (!result.success) {
      console.error("Validation errors:", result.error.issues);
    }
    expect(result.success).toBe(true);
    expect(result.data!.project).toBe("DailyBriefDashboard");
    expect(result.data!.repo).toBe("hornjason/asaCommandCenter");
    expect(result.data!.dev?.start).toBe("make dev-all");
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
