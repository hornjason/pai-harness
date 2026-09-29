import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { scanGaps } from "../lib/gap-scanner";
import type { GapResult, GapScanResult } from "../lib/gap-scanner";

const TEST_ROOT = join(import.meta.dir, "..", ".gap-scanner-test");
const TEST_WORK_DIR = join(TEST_ROOT, "workdirs");

beforeEach(() => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_WORK_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

describe("gap-scanner", () => {
  describe("orphaned-workdirs", () => {
    test("WARN when more than 5 orphaned dirs", () => {
      // Create 7 dirs without workflow-state.json
      for (let i = 0; i < 7; i++) {
        mkdirSync(join(TEST_WORK_DIR, `orphan-${i}`), { recursive: true });
      }

      const result = scanGaps(TEST_ROOT, TEST_WORK_DIR);
      const orphanCheck = result.results.find((r) => r.check === "orphaned-workdirs");

      expect(orphanCheck).toBeDefined();
      expect(orphanCheck!.status).toBe("WARN");
      expect(orphanCheck!.detail).toContain("7 orphaned");
      expect(result.warnings).toBeGreaterThan(0);
    });

    test("PASS when 5 or fewer orphaned dirs", () => {
      // Create 3 dirs without workflow-state.json
      for (let i = 0; i < 3; i++) {
        mkdirSync(join(TEST_WORK_DIR, `orphan-${i}`), { recursive: true });
      }

      const result = scanGaps(TEST_ROOT, TEST_WORK_DIR);
      const orphanCheck = result.results.find((r) => r.check === "orphaned-workdirs");

      expect(orphanCheck).toBeDefined();
      expect(orphanCheck!.status).toBe("PASS");
      expect(orphanCheck!.detail).toContain("3 orphaned");
      expect(result.passes).toBeGreaterThan(0);
    });

    test("handles dirs with workflow-state.json correctly", () => {
      // Create 7 dirs total: 3 with state, 4 orphaned
      for (let i = 0; i < 3; i++) {
        const dir = join(TEST_WORK_DIR, `with-state-${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "workflow-state.json"), "{}");
      }
      for (let i = 0; i < 4; i++) {
        mkdirSync(join(TEST_WORK_DIR, `orphan-${i}`), { recursive: true });
      }

      const result = scanGaps(TEST_ROOT, TEST_WORK_DIR);
      const orphanCheck = result.results.find((r) => r.check === "orphaned-workdirs");

      expect(orphanCheck).toBeDefined();
      expect(orphanCheck!.status).toBe("PASS");
      expect(orphanCheck!.detail).toContain("4 orphaned");
    });
  });

  describe("stale-doc-refs", () => {
    test("WARN when file references are missing", () => {
      const projectRoot = TEST_ROOT;
      const claudeMd = join(projectRoot, "CLAUDE.md");
      const agentsMd = join(projectRoot, "AGENTS.md");

      // Create CLAUDE.md with valid and invalid file refs
      writeFileSync(
        claudeMd,
        `# Project
| File | What |
|------|------|
| existing.md | Valid |
| missing.md | Invalid |
`
      );

      // Create only existing.md
      writeFileSync(join(projectRoot, "existing.md"), "content");

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const staleCheck = result.results.find((r) => r.check === "stale-doc-refs");

      expect(staleCheck).toBeDefined();
      expect(staleCheck!.status).toBe("WARN");
      expect(staleCheck!.detail).toContain("missing.md");
      expect(result.warnings).toBeGreaterThan(0);
    });

    test("PASS when all file references exist", () => {
      const projectRoot = TEST_ROOT;
      const claudeMd = join(projectRoot, "CLAUDE.md");

      writeFileSync(
        claudeMd,
        `# Project
| File | What |
|------|------|
| file1.md | First |
| file2.md | Second |
`
      );

      writeFileSync(join(projectRoot, "file1.md"), "content");
      writeFileSync(join(projectRoot, "file2.md"), "content");

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const staleCheck = result.results.find((r) => r.check === "stale-doc-refs");

      expect(staleCheck).toBeDefined();
      expect(staleCheck!.status).toBe("PASS");
      expect(result.passes).toBeGreaterThan(0);
    });
  });

  describe("hook-line-budget", () => {
    test("WARN when hook exceeds 150 lines", () => {
      const projectRoot = TEST_ROOT;
      const hooksDir = join(projectRoot, "hooks");
      mkdirSync(hooksDir, { recursive: true });

      // Create a 160-line hook file
      const lines = Array(160).fill("// line").join("\n");
      writeFileSync(join(hooksDir, "large.hook.ts"), lines);

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const budgetCheck = result.results.find((r) => r.check === "hook-line-budget");

      expect(budgetCheck).toBeDefined();
      expect(budgetCheck!.status).toBe("WARN");
      expect(budgetCheck!.detail).toContain("large.hook.ts");
      expect(budgetCheck!.detail).toContain("160");
      expect(result.warnings).toBeGreaterThan(0);
    });

    test("PASS when all hooks under 150 lines", () => {
      const projectRoot = TEST_ROOT;
      const hooksDir = join(projectRoot, "hooks");
      mkdirSync(hooksDir, { recursive: true });

      // Create hooks under budget
      writeFileSync(join(hooksDir, "small1.hook.ts"), Array(50).fill("// line").join("\n"));
      writeFileSync(join(hooksDir, "small2.hook.ts"), Array(100).fill("// line").join("\n"));

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const budgetCheck = result.results.find((r) => r.check === "hook-line-budget");

      expect(budgetCheck).toBeDefined();
      expect(budgetCheck!.status).toBe("PASS");
      expect(result.passes).toBeGreaterThan(0);
    });
  });

  describe("spec-sc-unchecked-ratio", () => {
    test("WARN when unchecked SCs > 60%", () => {
      const projectRoot = TEST_ROOT;
      const specsDir = join(projectRoot, "specs");
      mkdirSync(specsDir, { recursive: true });

      // Create spec with 70% unchecked (7 unchecked, 3 checked)
      writeFileSync(
        join(specsDir, "test.md"),
        `# Spec
- [x] SC-1
- [x] SC-2
- [x] SC-3
- [ ] SC-4
- [ ] SC-5
- [ ] SC-6
- [ ] SC-7
- [ ] SC-8
- [ ] SC-9
- [ ] SC-10
`
      );

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const ratioCheck = result.results.find((r) => r.check === "spec-sc-unchecked-ratio");

      expect(ratioCheck).toBeDefined();
      expect(ratioCheck!.status).toBe("WARN");
      expect(ratioCheck!.detail).toContain("70%");
      expect(result.warnings).toBeGreaterThan(0);
    });

    test("PASS when unchecked SCs <= 60%", () => {
      const projectRoot = TEST_ROOT;
      const specsDir = join(projectRoot, "specs");
      mkdirSync(specsDir, { recursive: true });

      // Create spec with 50% unchecked (5 unchecked, 5 checked)
      writeFileSync(
        join(specsDir, "test.md"),
        `# Spec
- [x] SC-1
- [x] SC-2
- [x] SC-3
- [x] SC-4
- [x] SC-5
- [ ] SC-6
- [ ] SC-7
- [ ] SC-8
- [ ] SC-9
- [ ] SC-10
`
      );

      const result = scanGaps(projectRoot, TEST_WORK_DIR);
      const ratioCheck = result.results.find((r) => r.check === "spec-sc-unchecked-ratio");

      expect(ratioCheck).toBeDefined();
      expect(ratioCheck!.status).toBe("PASS");
      expect(result.passes).toBeGreaterThan(0);
    });
  });

  describe("no-new-todos-without-issue", () => {
    test("returns PASS or SKIP based on git availability", () => {
      const result = scanGaps(TEST_ROOT, TEST_WORK_DIR);
      const todoCheck = result.results.find((r) => r.check === "no-new-todos-without-issue");

      expect(todoCheck).toBeDefined();
      // #470 When run within a git repo, returns PASS if no task markers found
      // When run outside git or with insufficient history, returns SKIP
      expect(["PASS", "SKIP", "WARN"]).toContain(todoCheck!.status);
    });
  });

  describe("test-suite-health", () => {
    test("SKIP when no test command available", () => {
      const result = scanGaps(TEST_ROOT, TEST_WORK_DIR);
      const testCheck = result.results.find((r) => r.check === "test-suite-health");

      expect(testCheck).toBeDefined();
      expect(testCheck!.status).toBe("SKIP");
      expect(testCheck!.detail).toContain("No package.json");
    });
  });

  describe("result aggregation", () => {
    test("correctly counts warnings and passes", () => {
      const projectRoot = TEST_ROOT;
      const claudeMd = join(projectRoot, "CLAUDE.md");
      const hooksDir = join(projectRoot, "hooks");

      mkdirSync(hooksDir, { recursive: true });

      // Create CLAUDE.md with missing ref (WARN)
      writeFileSync(
        claudeMd,
        `| File | What |
|------|------|
| missing.md | Invalid |
`
      );

      // Create small hook (PASS)
      writeFileSync(join(hooksDir, "small.hook.ts"), Array(50).fill("// line").join("\n"));

      // Create 3 orphaned dirs (PASS)
      for (let i = 0; i < 3; i++) {
        mkdirSync(join(TEST_WORK_DIR, `orphan-${i}`), { recursive: true });
      }

      const result = scanGaps(projectRoot, TEST_WORK_DIR);

      expect(result.warnings).toBeGreaterThanOrEqual(1); // stale-doc-refs
      expect(result.passes).toBeGreaterThanOrEqual(2); // orphaned-workdirs, hook-line-budget
      expect(result.results.length).toBeGreaterThanOrEqual(6); // All checks ran
    });
  });
});
