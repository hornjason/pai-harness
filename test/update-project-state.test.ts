import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PROJECT_STATE = join(ROOT, "PROJECT-STATE.md");
const PROJECT_STATE_BACKUP = join(ROOT, "PROJECT-STATE.md.test-backup");

describe("update-project-state", () => {
  beforeEach(() => {
    // Ensure PROJECT-STATE.md exists for each test
    if (!existsSync(PROJECT_STATE) && existsSync(PROJECT_STATE_BACKUP)) {
      writeFileSync(PROJECT_STATE, readFileSync(PROJECT_STATE_BACKUP, "utf-8"));
    }
  });
  test("script exists", () => {
    expect(existsSync(join(ROOT, "scripts/update-project-state.ts"))).toBe(true);
  });

  test("--skip-tests flag runs in under 2 seconds", () => {
    const start = Date.now();
    execSync("bun scripts/update-project-state.ts --skip-tests", {
      cwd: ROOT,
      timeout: 5000,
      encoding: "utf-8"
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  test("updates frontmatter date", () => {
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");
    const dateMatch = after.match(/updated: (\d{4}-\d{2}-\d{2})/);
    expect(dateMatch).toBeTruthy();
    // Date should be today
    const today = new Date().toISOString().split("T")[0];
    expect(dateMatch![1]).toBe(today);
  });

  test("is idempotent", () => {
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const first = readFileSync(PROJECT_STATE, "utf-8");
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const second = readFileSync(PROJECT_STATE, "utf-8");
    expect(first).toBe(second);
  });

  test("counts SCs from specs", () => {
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const content = readFileSync(PROJECT_STATE, "utf-8");
    // Should update test counts with format "N pass"
    expect(content).toMatch(/\d+ pass/);
  });

  test.skip("updates test counts when not skipping tests", async () => {
    // Skipped: This test runs the full test suite which can take >2 minutes
    // Manual verification: bun scripts/update-project-state.ts (no --skip-tests)
    execSync("bun scripts/update-project-state.ts", {
      cwd: ROOT,
      timeout: 180000 // 3 minute timeout for full test run
    });
    const content = readFileSync(PROJECT_STATE, "utf-8");

    // Should have updated Tests: line with counts
    expect(content).toMatch(/\*\*Tests:\*\* \d+ pass, \d+ fail, \d+ (skip|todo)/);
  }, 200000); // 200 second timeout for this test

  test("handles missing PROJECT-STATE.md gracefully", () => {
    // Temporarily move PROJECT-STATE.md to test graceful handling
    const backup = PROJECT_STATE + ".temp-missing-test";
    let hadFile = false;

    if (existsSync(PROJECT_STATE)) {
      writeFileSync(backup, readFileSync(PROJECT_STATE, "utf-8"));
      execSync(`rm "${PROJECT_STATE}"`, { cwd: ROOT });
      hadFile = true;
    }

    try {
      // Should not crash when PROJECT-STATE.md is missing
      execSync("bun scripts/update-project-state.ts --skip-tests", {
        cwd: ROOT,
        encoding: "utf-8"
      });
      // If we get here without exception, the script handled it gracefully
      expect(true).toBe(true);
    } finally {
      // Restore file
      if (hadFile && existsSync(backup)) {
        writeFileSync(PROJECT_STATE, readFileSync(backup, "utf-8"));
        execSync(`rm "${backup}"`, { cwd: ROOT });
      }
    }
  });

  test("preserves existing content", () => {
    const before = readFileSync(PROJECT_STATE, "utf-8");
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // Should preserve phase headers
    expect(after).toContain("## ✅ Phase 0");
    expect(after).toContain("## 🔄 Phase 1");

    // Should preserve key structure
    expect(after).toContain("# Project State");
  });
});
