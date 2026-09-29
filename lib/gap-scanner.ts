import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface GapResult {
  check: string;
  status: "PASS" | "WARN" | "SKIP";
  detail: string;
}

export interface GapScanResult {
  results: GapResult[];
  warnings: number;
  passes: number;
}

export function scanGaps(
  projectRoot: string,
  workDir?: string
): GapScanResult {
  const runGateWorkDir =
    workDir || process.env.RUNGATE_WORK_DIR || join(process.env.HOME!, ".rungate");

  const results: GapResult[] = [];

  // 1. orphaned-workdirs
  results.push(checkOrphanedWorkdirs(runGateWorkDir));

  // 2. stale-doc-refs
  results.push(checkStaleDocRefs(projectRoot));

  // 3. no-new-todos-without-issue
  results.push(checkTodosWithoutIssue(projectRoot));

  // 4. spec-sc-unchecked-ratio
  results.push(checkSpecScRatio(projectRoot));

  // 5. hook-line-budget
  results.push(checkHookLineBudget(projectRoot));

  // 6. test-suite-health
  results.push(checkTestSuiteHealth(projectRoot));

  const warnings = results.filter((r) => r.status === "WARN").length;
  const passes = results.filter((r) => r.status === "PASS").length;

  return { results, warnings, passes };
}

function checkOrphanedWorkdirs(workDir: string): GapResult {
  if (!existsSync(workDir)) {
    return {
      check: "orphaned-workdirs",
      status: "SKIP",
      detail: "Work directory does not exist",
    };
  }

  try {
    const dirs = readdirSync(workDir).filter((entry) => {
      const fullPath = join(workDir, entry);
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });

    const orphaned = dirs.filter((dir) => {
      const stateFile = join(workDir, dir, "workflow-state.json");
      return !existsSync(stateFile);
    });

    const count = orphaned.length;
    if (count > 5) {
      return {
        check: "orphaned-workdirs",
        status: "WARN",
        detail: `${count} orphaned work directories without workflow-state.json`,
      };
    }

    return {
      check: "orphaned-workdirs",
      status: "PASS",
      detail: `${count} orphaned work directories (threshold: 5)`,
    };
  } catch (error) {
    return {
      check: "orphaned-workdirs",
      status: "SKIP",
      detail: `Error checking work directories: ${error}`,
    };
  }
}

function checkStaleDocRefs(projectRoot: string): GapResult {
  const docFiles = ["CLAUDE.md", "AGENTS.md"];
  const missing: string[] = [];

  for (const docFile of docFiles) {
    const docPath = join(projectRoot, docFile);
    if (!existsSync(docPath)) {
      continue;
    }

    try {
      const content = readFileSync(docPath, "utf-8");
      const lines = content.split("\n");

      // Look for markdown table rows with file references
      for (const line of lines) {
        // Match table rows: | filename | ...
        const match = line.match(/^\|\s*([^|]+?)\s*\|/);
        if (match && match[1]) {
          const potentialFile = match[1].trim();

          // Skip headers, separators, and non-file entries
          if (
            potentialFile === "File" ||
            potentialFile.includes("---") ||
            potentialFile.length === 0 ||
            potentialFile.startsWith("**")
          ) {
            continue;
          }

          // Check if it looks like a file reference (has extension or is a directory)
          if (potentialFile.includes(".") || potentialFile.endsWith("/")) {
            const fullPath = join(projectRoot, potentialFile);
            if (!existsSync(fullPath)) {
              missing.push(potentialFile);
            }
          }
        }
      }
    } catch (error) {
      // Continue to next file on error
    }
  }

  if (missing.length > 0) {
    return {
      check: "stale-doc-refs",
      status: "WARN",
      detail: `Missing file references: ${missing.join(", ")}`,
    };
  }

  return {
    check: "stale-doc-refs",
    status: "PASS",
    detail: "All file references exist",
  };
}

function checkTodosWithoutIssue(projectRoot: string): GapResult {
  try {
    const diff = execSync("git diff HEAD~5 --unified=0", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const lines = diff.split("\n");
    const todosWithoutIssue: string[] = [];

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const content = line.slice(1).trim();
        // #470 Check for code comments with TODO/FIXME/HACK without issue numbers
        if (/TODO|FIXME|HACK/.test(content) && !/#\d+/.test(content)) {
          todosWithoutIssue.push(content);
        }
      }
    }

    if (todosWithoutIssue.length > 0) {
      return {
        check: "no-new-todos-without-issue",
        status: "WARN",
        detail: `${todosWithoutIssue.length} new code comments with TODO/FIXME/HACK (missing #NNN)`,
      };
    }

    return {
      check: "no-new-todos-without-issue",
      status: "PASS",
      detail: "No new code comments with TODO/FIXME/HACK missing issue reference",
    };
  } catch (error) {
    return {
      check: "no-new-todos-without-issue",
      status: "SKIP",
      detail: "Not in a git repository or insufficient history",
    };
  }
}

function checkSpecScRatio(projectRoot: string): GapResult {
  const specsDir = join(projectRoot, "specs");

  if (!existsSync(specsDir)) {
    return {
      check: "spec-sc-unchecked-ratio",
      status: "SKIP",
      detail: "No specs directory found",
    };
  }

  let totalChecked = 0;
  let totalUnchecked = 0;

  try {
    const specFiles = readdirSync(specsDir).filter((f) => f.endsWith(".md"));

    for (const file of specFiles) {
      const content = readFileSync(join(specsDir, file), "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        if (/^- \[x\] SC-/i.test(line)) {
          totalChecked++;
        } else if (/^- \[ \] SC-/i.test(line)) {
          totalUnchecked++;
        }
      }
    }

    const total = totalChecked + totalUnchecked;
    if (total === 0) {
      return {
        check: "spec-sc-unchecked-ratio",
        status: "SKIP",
        detail: "No SCs found in spec files",
      };
    }

    const uncheckedPercent = Math.round((totalUnchecked / total) * 100);

    if (uncheckedPercent > 60) {
      return {
        check: "spec-sc-unchecked-ratio",
        status: "WARN",
        detail: `${uncheckedPercent}% unchecked SCs (${totalUnchecked}/${total})`,
      };
    }

    return {
      check: "spec-sc-unchecked-ratio",
      status: "PASS",
      detail: `${uncheckedPercent}% unchecked SCs (${totalUnchecked}/${total})`,
    };
  } catch (error) {
    return {
      check: "spec-sc-unchecked-ratio",
      status: "SKIP",
      detail: `Error checking spec files: ${error}`,
    };
  }
}

function checkHookLineBudget(projectRoot: string): GapResult {
  const hooksDir = join(projectRoot, "hooks");

  if (!existsSync(hooksDir)) {
    return {
      check: "hook-line-budget",
      status: "SKIP",
      detail: "No hooks directory found",
    };
  }

  try {
    const hookFiles = readdirSync(hooksDir).filter((f) => f.endsWith(".hook.ts"));
    const violations: string[] = [];

    for (const file of hookFiles) {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const lines = content.split("\n").length;

      if (lines > 150) {
        violations.push(`${file} (${lines} lines)`);
      }
    }

    if (violations.length > 0) {
      return {
        check: "hook-line-budget",
        status: "WARN",
        detail: `Hooks exceeding 150 lines: ${violations.join(", ")}`,
      };
    }

    return {
      check: "hook-line-budget",
      status: "PASS",
      detail: `All ${hookFiles.length} hooks under 150 lines`,
    };
  } catch (error) {
    return {
      check: "hook-line-budget",
      status: "SKIP",
      detail: `Error checking hook files: ${error}`,
    };
  }
}

function checkTestSuiteHealth(projectRoot: string): GapResult {
  const packageJsonPath = join(projectRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return {
      check: "test-suite-health",
      status: "SKIP",
      detail: "No package.json found",
    };
  }

  // For now, just return SKIP since running the full test suite is expensive
  // This check would need more sophisticated implementation in real usage
  return {
    check: "test-suite-health",
    status: "SKIP",
    detail: "Test suite health check not implemented (would run bun test)",
  };
}
