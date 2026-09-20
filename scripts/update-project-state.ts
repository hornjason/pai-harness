#!/usr/bin/env bun
/**
 * Auto-update PROJECT-STATE.md with current test results and SC status
 *
 * Usage:
 *   bun scripts/update-project-state.ts           # Full update with test run
 *   bun scripts/update-project-state.ts --skip-tests  # Fast SC-only update
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PROJECT_STATE = join(ROOT, "PROJECT-STATE.md");

interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
}

interface SCCounts {
  completed: number;
  open: number;
}

/**
 * Parse test output for counts
 */
function parseTestOutput(output: string): TestCounts {
  const counts: TestCounts = { pass: 0, fail: 0, skip: 0, todo: 0 };

  // Bun test output format:
  //  942 pass
  //  8 skip
  //  45 todo
  //  6 fail

  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const skipMatch = output.match(/(\d+)\s+skip/);
  const todoMatch = output.match(/(\d+)\s+todo/);

  if (passMatch) counts.pass = parseInt(passMatch[1], 10);
  if (failMatch) counts.fail = parseInt(failMatch[1], 10);
  if (skipMatch) counts.skip = parseInt(skipMatch[1], 10);
  if (todoMatch) counts.todo = parseInt(todoMatch[1], 10);

  return counts;
}

/**
 * Get current test counts
 */
function getTestCounts(): TestCounts | null {
  try {
    const output = execSync("bun test", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120000, // 2 minute timeout
      stdio: ["ignore", "pipe", "pipe"]
    });

    return parseTestOutput(output);
  } catch (error: any) {
    // Tests may fail, but we can still parse output
    if (error.stdout || error.stderr) {
      const output = (error.stdout || "") + (error.stderr || "");
      return parseTestOutput(output);
    }
    return null;
  }
}

/**
 * Scan specs for SC counts
 */
function scanSCCounts(): SCCounts {
  const counts: SCCounts = { completed: 0, open: 0 };

  // Use Bun's built-in glob
  const glob = new Bun.Glob("**/*.md");
  const specsDir = join(ROOT, "specs");

  if (!existsSync(specsDir)) {
    return counts;
  }

  for (const file of glob.scanSync({ cwd: specsDir, absolute: true })) {
    if (!existsSync(file)) continue;

    const content = readFileSync(file, "utf-8");

    // Count completed SCs: - [x] SC-NNN:
    const completedMatches = content.matchAll(/- \[x\] SC-\d+:/gi);
    counts.completed += Array.from(completedMatches).length;

    // Count open SCs: - [ ] SC-NNN:
    const openMatches = content.matchAll(/- \[ \] SC-\d+:/gi);
    counts.open += Array.from(openMatches).length;
  }

  return counts;
}

/**
 * Update PROJECT-STATE.md
 */
function updateProjectState(testCounts: TestCounts | null, skipTests: boolean): void {
  if (!existsSync(PROJECT_STATE)) {
    console.log("PROJECT-STATE.md not found, skipping update");
    return;
  }

  let content = readFileSync(PROJECT_STATE, "utf-8");

  // 1. Update the date in frontmatter
  const today = new Date().toISOString().split("T")[0];
  content = content.replace(
    /^updated: \d{4}-\d{2}-\d{2}$/m,
    `updated: ${today}`
  );

  // 2. Update test counts if we have them
  if (testCounts && !skipTests) {
    // Format: **Tests:** N pass, N fail, N skip, N todo
    const testLine = `**Tests:** ${testCounts.pass} pass, ${testCounts.fail} fail, ${testCounts.skip} skip, ${testCounts.todo} todo`;

    // Replace existing test lines
    content = content.replace(
      /\*\*Tests:\*\* \d+ pass.*$/gm,
      testLine
    );
  }

  writeFileSync(PROJECT_STATE, content, "utf-8");

  console.log(`✅ Updated PROJECT-STATE.md`);
  if (testCounts) {
    console.log(`   Tests: ${testCounts.pass} pass, ${testCounts.fail} fail, ${testCounts.skip} skip, ${testCounts.todo} todo`);
  }
}

/**
 * Main
 */
function main(): void {
  const args = process.argv.slice(2);
  const skipTests = args.includes("--skip-tests");

  let testCounts: TestCounts | null = null;

  if (!skipTests) {
    console.log("Running tests...");
    testCounts = getTestCounts();
  } else {
    console.log("Skipping tests (--skip-tests flag)");
  }

  const scCounts = scanSCCounts();
  console.log(`SCs: ${scCounts.completed} completed, ${scCounts.open} open`);

  updateProjectState(testCounts, skipTests);
}

main();
