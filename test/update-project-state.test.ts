import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PROJECT_STATE = join(ROOT, "PROJECT-STATE.md");
const PROJECT_STATE_BACKUP = join(ROOT, "PROJECT-STATE.md.test-backup");
const TEST_SPECS_DIR = join(ROOT, "test-specs-temp");

describe("update-project-state", () => {
  beforeEach(() => {
    // Ensure PROJECT-STATE.md exists for each test
    if (!existsSync(PROJECT_STATE) && existsSync(PROJECT_STATE_BACKUP)) {
      writeFileSync(PROJECT_STATE, readFileSync(PROJECT_STATE_BACKUP, "utf-8"));
    }

    // Clean up any leftover test spec files from previous runs
    const specsDir = join(ROOT, "specs");
    if (existsSync(specsDir)) {
      const testFiles = [
        "test-spec.md",
        "test-phase-complete.md",
        "phase-0-complete.md",
        "phase-1-incomplete.md",
        "test-preserve-structure.md"
      ];
      for (const file of testFiles) {
        const filePath = join(specsDir, file);
        if (existsSync(filePath)) {
          rmSync(filePath);
        }
      }
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

  test("updates frontmatter date to today", () => {
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");
    const dateMatch = after.match(/updated: (\d{4}-\d{2}-\d{2})/);
    expect(dateMatch).toBeTruthy();
    // Date should be today
    const today = new Date().toISOString().split("T")[0];
    expect(dateMatch![1]).toBe(today);
  });

  test("is idempotent - two runs produce same output", () => {
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const first = readFileSync(PROJECT_STATE, "utf-8");
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const second = readFileSync(PROJECT_STATE, "utf-8");
    expect(first).toBe(second);
  });

  test("updates table row status emoji to match spec SC status", () => {
    // Create a mock spec with completed SC
    mkdirSync(join(ROOT, "specs"), { recursive: true });
    writeFileSync(
      join(ROOT, "specs/test-spec.md"),
      `---
doc-type: spec
testable: true
---

# Test Spec

## Success Criteria

- [x] SC-999: This is completed
- [ ] SC-998: This is open
`
    );

    // Create a PROJECT-STATE.md with those SCs
    const testState = `---
updated: 2026-01-01
---

# Project State

**Current phase: Phase 1**

## 🔄 Phase 1 — Test Phase

| Status | SC | What |
|---|---|---|
| ⬜ | SC-999 | Should flip to completed |
| ⬜ | SC-998 | Should stay open |

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);

    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // SC-999 should be ✅ (completed)
    expect(after).toContain("| ✅ | SC-999 |");
    // SC-998 should be ⬜ (open)
    expect(after).toContain("| ⬜ | SC-998 |");

    // Cleanup
    rmSync(join(ROOT, "specs/test-spec.md"));
  });

  test("flips phase header from 🔄 to ✅ when all SCs complete", () => {
    // Create a mock spec with all SCs completed
    mkdirSync(join(ROOT, "specs"), { recursive: true });
    writeFileSync(
      join(ROOT, "specs/test-phase-complete.md"),
      `---
doc-type: spec
testable: true
---

# Test Spec

## Success Criteria

- [x] SC-997: First completed
- [x] SC-996: Second completed
`
    );

    // Create a PROJECT-STATE.md with in-progress phase
    const testState = `---
updated: 2026-01-01
---

# Project State

**Current phase: Phase 1**

## 🔄 Phase 1 — Test Phase (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-997 | Test |
| ⬜ | SC-996 | Test |

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);

    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // Phase header should flip to ✅ and say COMPLETE
    expect(after).toContain("## ✅ Phase 1 — Test Phase (COMPLETE)");

    // Cleanup
    rmSync(join(ROOT, "specs/test-phase-complete.md"));
  });

  test("updates current phase line to first incomplete phase", () => {
    // Create specs with mixed completion
    mkdirSync(join(ROOT, "specs"), { recursive: true });
    writeFileSync(
      join(ROOT, "specs/phase-0-complete.md"),
      `- [x] SC-950: Done`
    );
    writeFileSync(
      join(ROOT, "specs/phase-1-incomplete.md"),
      `- [x] SC-940: Done
- [ ] SC-941: Open
- [ ] SC-942: Open`
    );

    const testState = `---
updated: 2026-01-01
---

# Project State

**Current phase: Phase 0 — Old description**

## ✅ Phase 0 — Scaffold (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-950 | Test |

## 🔄 Phase 1 — Knowledge Extraction

| Status | SC | What |
|---|---|---|
| ✅ | SC-940 | Test |
| ⬜ | SC-941 | Test |
| ⬜ | SC-942 | Test |

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);

    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // Current phase should be Phase 1 with 2 open SCs
    expect(after).toMatch(/\*\*Current phase: Phase 1 — Knowledge Extraction — 2 SCs open\*\*/);

    // Cleanup
    rmSync(join(ROOT, "specs/phase-0-complete.md"));
    rmSync(join(ROOT, "specs/phase-1-incomplete.md"));
  });

  test("--session-end adds session summary with git commits", () => {
    // Make a test commit
    execSync("git config user.name 'Test' && git config user.email 'test@test.com'", { cwd: ROOT });
    execSync("touch .test-commit-file", { cwd: ROOT });
    execSync("git add .test-commit-file", { cwd: ROOT });

    try {
      execSync("git commit -m 'test: session-end test commit'", { cwd: ROOT, stdio: "ignore" });
    } catch (_) {
      // Commit might fail in CI - that's OK for this test
    }

    const testState = `---
updated: 2026-01-01
---

# Project State

**Current phase: Phase 1**

**Previous session (2026-09-19):**
- Old stuff

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);

    execSync("bun scripts/update-project-state.ts --skip-tests --session-end", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // Should have a session summary for today
    const today = new Date().toISOString().split("T")[0];
    expect(after).toContain(`**Session ${today} summary:**`);

    // Should mention commits or say no commits
    expect(after).toMatch(/(test: session-end test commit|No commits in last 8 hours)/);
  });

  test("preserves existing content structure", () => {
    // Create spec files with matching SCs
    mkdirSync(join(ROOT, "specs"), { recursive: true });
    writeFileSync(
      join(ROOT, "specs/test-preserve-structure.md"),
      `- [x] SC-1: Complete SC
- [ ] SC-2: Open SC`
    );

    const testState = `---
updated: 2026-01-01
---

# Project State

**Current phase: Phase 1**

## ✅ Phase 0 — Complete Phase (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-1 | Test |

## 🔄 Phase 1 — In Progress Phase (IN PROGRESS)

| Status | SC | What |
|---|---|---|
| ⬜ | SC-2 | Test |

**Tests:** 0 pass, 0 fail

## Live Tracking

Some tracking info
`;

    writeFileSync(PROJECT_STATE, testState);
    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });
    const after = readFileSync(PROJECT_STATE, "utf-8");

    // Should preserve key structure
    expect(after).toContain("# Project State");
    expect(after).toContain("## Live Tracking");

    // Should preserve Complete phase as-is
    expect(after).toContain("## ✅ Phase 0");

    // Should preserve In Progress phase as-is
    expect(after).toContain("## 🔄 Phase 1");

    // Cleanup
    rmSync(join(ROOT, "specs/test-preserve-structure.md"));
  });

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
      const output = execSync("bun scripts/update-project-state.ts --skip-tests", {
        cwd: ROOT,
        encoding: "utf-8"
      });

      // Should log that it's skipping
      expect(output).toContain("PROJECT-STATE.md not found, skipping update");
    } finally {
      // Restore file
      if (hadFile && existsSync(backup)) {
        writeFileSync(PROJECT_STATE, readFileSync(backup, "utf-8"));
        execSync(`rm "${backup}"`, { cwd: ROOT });
      }
    }
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
    expect(content).toMatch(/\*\*Tests:\*\* \d+ pass, \d+ fail/);
  }, 200000); // 200 second timeout for this test

  test("archives previous session when using --session-end", () => {
    const testState = `---
updated: 2026-01-01
---

# Project State

**Session 2026-09-19 summary:**
- Old commit 1
- Old commit 2

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);

    execSync("bun scripts/update-project-state.ts --skip-tests --session-end", { cwd: ROOT });

    // Check that old session was archived
    const archiveFile = join(ROOT, "docs/session-log/2026-09-19.md");
    expect(existsSync(archiveFile)).toBe(true);

    if (existsSync(archiveFile)) {
      const archived = readFileSync(archiveFile, "utf-8");
      expect(archived).toContain("Session 2026-09-19");
      expect(archived).toContain("Old commit 1");
    }

    // Clean up
    if (existsSync(join(ROOT, "docs/session-log"))) {
      rmSync(join(ROOT, "docs/session-log"), { recursive: true });
    }
  });

  test("trims PROJECT-STATE.md to 150 lines when exceeded", () => {
    // Create a large PROJECT-STATE.md with >150 lines
    const lines: string[] = ["---", "updated: 2026-01-01", "---", "", "# Project State"];

    // Add 200 lines of content
    for (let i = 0; i < 200; i++) {
      lines.push(`Line ${i + 1}: Some content here`);
    }

    writeFileSync(PROJECT_STATE, lines.join("\n"));

    execSync("bun scripts/update-project-state.ts --skip-tests", { cwd: ROOT });

    const after = readFileSync(PROJECT_STATE, "utf-8");
    const afterLines = after.split("\n");

    expect(afterLines.length).toBeLessThanOrEqual(150);
    expect(after).toContain("Content trimmed to 150-line cap");
  });

  test("keeps only 3 most recent archived sessions", () => {
    // Create session log directory
    const sessionLogDir = join(ROOT, "docs/session-log");
    mkdirSync(sessionLogDir, { recursive: true });

    // Create 5 old session files
    const dates = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    dates.forEach((date, i) => {
      const filePath = join(sessionLogDir, `${date}.md`);
      writeFileSync(filePath, `# Session ${date}\n- Content`);
      // Set different modification times
      execSync(`touch -t ${date.replace(/-/g, "")}1200 "${filePath}"`, { cwd: ROOT });
    });

    // Run with --session-end to trigger cleanup
    const testState = `---
updated: 2026-01-01
---

# Project State

**Session 2026-09-14 summary:**
- Old session

**Tests:** 0 pass, 0 fail
`;

    writeFileSync(PROJECT_STATE, testState);
    execSync("bun scripts/update-project-state.ts --skip-tests --session-end", { cwd: ROOT });

    // Should have at most 3 archived files + 1 new one = 4 total
    const archivedFiles = readdirSync(sessionLogDir).filter(f => f.endsWith(".md"));
    expect(archivedFiles.length).toBeLessThanOrEqual(4);

    // Clean up
    if (existsSync(sessionLogDir)) {
      rmSync(sessionLogDir, { recursive: true });
    }
  });
});
