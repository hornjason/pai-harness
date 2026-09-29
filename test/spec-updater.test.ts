/**
 * spec-updater tests — verifies governing spec auto-update on PROVEN verdict
 * AC-1: reads governingSpec.path from goal-record.json
 * AC-2: never hardcodes specific spec filenames
 * AC-3: extracts D-NNN from issue body or GoalRecord
 * AC-4: finds row by D-NNN, replaces ACCEPTED with SHIPPED + issue number
 * AC-A1: skips gracefully when governingSpec absent
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import will be created in implementation step
import { updateSpecStatus, extractDecisionIds } from "../lib/spec-updater.ts";

describe("spec-updater", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-updater-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("AC-1: reads governingSpec.path from GoalRecord", () => {
    test("uses governingSpec.path to locate the spec file", async () => {
      const specPath = join(tmpDir, "my-spec.md");
      writeFileSync(specPath, `# Spec\n\n| ID | Decision | Status |\n|---|---|---|\n| D-042 | Some decision | ACCEPTED |\n`);

      const goalRecord = {
        governingSpec: { path: specPath },
      };

      const result = await updateSpecStatus({
        goalRecord,
        issueNumber: 419,
        decisionIds: ["D-042"],
      });

      expect(result.updated).toBe(true);
      expect(result.specPath).toBe(specPath);
    });

    test("passes through governingSpec.path without modification", async () => {
      const specDir = join(tmpDir, "specs");
      mkdirSync(specDir, { recursive: true });
      const specPath = join(specDir, "custom-spec.md");
      writeFileSync(specPath, `# Custom\n\n| ID | Decision | Status |\n|---|---|---|\n| D-001 | Test | ACCEPTED |\n`);

      const goalRecord = {
        governingSpec: { path: specPath },
      };

      const result = await updateSpecStatus({
        goalRecord,
        issueNumber: 100,
        decisionIds: ["D-001"],
      });

      expect(result.specPath).toBe(specPath);
      const content = readFileSync(specPath, "utf-8");
      expect(content).toContain("**SHIPPED**");
    });
  });

  describe("AC-2: never hardcodes specific spec filenames", () => {
    test("source code does not contain hardcoded spec filenames", () => {
      const source = readFileSync(join(import.meta.dir, "..", "lib", "spec-updater.ts"), "utf-8");
      expect(source).not.toContain("harness-automation-matrix");
      expect(source).not.toContain("HARNESS-GATES");
      expect(source).not.toContain("SESSION-LIFECYCLE");
    });
  });

  describe("AC-3: extracts D-NNN decision IDs", () => {
    test("extracts single D-NNN from text", () => {
      const ids = extractDecisionIds("This implements D-042 for the thing");
      expect(ids).toEqual(["D-042"]);
    });

    test("extracts multiple D-NNN from text", () => {
      const ids = extractDecisionIds("Covers D-016, D-017, and D-020");
      expect(ids).toEqual(["D-016", "D-017", "D-020"]);
    });

    test("returns empty array when no D-NNN found", () => {
      const ids = extractDecisionIds("No decision IDs here");
      expect(ids).toEqual([]);
    });

    test("deduplicates repeated D-NNN", () => {
      const ids = extractDecisionIds("D-001 is related to D-001 again");
      expect(ids).toEqual(["D-001"]);
    });
  });

  describe("AC-4: updates ACCEPTED to SHIPPED with issue number", () => {
    test("replaces ACCEPTED with SHIPPED + issue number in decision table", async () => {
      const specPath = join(tmpDir, "spec.md");
      const specContent = [
        "# Spec Title",
        "",
        "## Council Decisions",
        "",
        "| ID | Decision | Status |",
        "|---|---|---|",
        "| D-041 | Already shipped | **SHIPPED** (#400) |",
        "| D-042 | Target decision | ACCEPTED |",
        "| D-043 | Another decision | ACCEPTED |",
      ].join("\n");
      writeFileSync(specPath, specContent);

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: ["D-042"],
      });

      expect(result.updated).toBe(true);
      expect(result.rowsUpdated).toBe(1);

      const updated = readFileSync(specPath, "utf-8");
      expect(updated).toContain("| D-042 | Target decision | **SHIPPED** (#419) |");
      // D-043 should remain ACCEPTED
      expect(updated).toContain("| D-043 | Another decision | ACCEPTED |");
    });

    test("handles ACCEPTED with extra text like (Wave 7, #386)", async () => {
      const specPath = join(tmpDir, "spec.md");
      writeFileSync(specPath, [
        "| ID | Decision | Status |",
        "|---|---|---|",
        "| D-013 | Regex precision | ACCEPTED (Wave 7, #386) |",
      ].join("\n"));

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: ["D-013"],
      });

      expect(result.updated).toBe(true);
      const updated = readFileSync(specPath, "utf-8");
      expect(updated).toContain("| D-013 | Regex precision | **SHIPPED** (#419) |");
    });

    test("updates multiple D-NNN rows in one call", async () => {
      const specPath = join(tmpDir, "spec.md");
      writeFileSync(specPath, [
        "| ID | Decision | Status |",
        "|---|---|---|",
        "| D-021 | Gate-salt rotation | ACCEPTED |",
        "| D-022 | IssueCloseGuard removal | ACCEPTED |",
        "| D-023 | safe_grep wrapper | ACCEPTED |",
      ].join("\n"));

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 450,
        decisionIds: ["D-021", "D-023"],
      });

      expect(result.rowsUpdated).toBe(2);
      const updated = readFileSync(specPath, "utf-8");
      expect(updated).toContain("| D-021 | Gate-salt rotation | **SHIPPED** (#450) |");
      expect(updated).toContain("| D-022 | IssueCloseGuard removal | ACCEPTED |");
      expect(updated).toContain("| D-023 | safe_grep wrapper | **SHIPPED** (#450) |");
    });

    test("returns rowsUpdated=0 when D-NNN not found in spec", async () => {
      const specPath = join(tmpDir, "spec.md");
      writeFileSync(specPath, [
        "| ID | Decision | Status |",
        "|---|---|---|",
        "| D-001 | Something | ACCEPTED |",
      ].join("\n"));

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: ["D-999"],
      });

      expect(result.updated).toBe(false);
      expect(result.rowsUpdated).toBe(0);
    });

    test("does not modify rows already SHIPPED", async () => {
      const specPath = join(tmpDir, "spec.md");
      const content = "| D-001 | Already done | **SHIPPED** (#100) |\n";
      writeFileSync(specPath, content);

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: ["D-001"],
      });

      expect(result.updated).toBe(false);
      expect(result.rowsUpdated).toBe(0);
      const updated = readFileSync(specPath, "utf-8");
      expect(updated).toContain("**SHIPPED** (#100)");
    });

    test("handles 4-column decision table format", async () => {
      const specPath = join(tmpDir, "spec.md");
      writeFileSync(specPath, [
        "| ID | Decision | Priority | Status |",
        "|---|---|---|---|",
        "| D-025 | Pre-push verify-only | Wave 2 (infra) | ACCEPTED |",
      ].join("\n"));

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: ["D-025"],
      });

      expect(result.updated).toBe(true);
      const updated = readFileSync(specPath, "utf-8");
      expect(updated).toContain("**SHIPPED** (#419)");
      expect(updated).not.toContain("ACCEPTED");
    });
  });

  describe("AC-A1: graceful skip when governingSpec absent", () => {
    test("returns skipped when governingSpec is undefined", async () => {
      const result = await updateSpecStatus({
        goalRecord: {},
        issueNumber: 419,
        decisionIds: ["D-042"],
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("no governing spec");
    });

    test("returns skipped when governingSpec.path is empty", async () => {
      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: "" } },
        issueNumber: 419,
        decisionIds: ["D-042"],
      });

      expect(result.skipped).toBe(true);
    });

    test("returns skipped when spec file does not exist", async () => {
      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: "/nonexistent/spec.md" } },
        issueNumber: 419,
        decisionIds: ["D-042"],
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("not found");
    });

    test("returns skipped when no decisionIds provided", async () => {
      const specPath = join(tmpDir, "spec.md");
      writeFileSync(specPath, "# Spec\n");

      const result = await updateSpecStatus({
        goalRecord: { governingSpec: { path: specPath } },
        issueNumber: 419,
        decisionIds: [],
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("no decision IDs");
    });

    test("does not throw on any missing-spec scenario", async () => {
      // Should never throw, only return skipped
      const scenarios = [
        { goalRecord: {}, issueNumber: 1, decisionIds: [] },
        { goalRecord: { governingSpec: undefined }, issueNumber: 1, decisionIds: ["D-001"] },
        { goalRecord: { governingSpec: { path: "" } }, issueNumber: 1, decisionIds: ["D-001"] },
        { goalRecord: { governingSpec: { path: "/no/such/file.md" } }, issueNumber: 1, decisionIds: ["D-001"] },
      ];

      for (const input of scenarios) {
        const result = await updateSpecStatus(input);
        expect(result.skipped).toBe(true);
      }
    });
  });
});
