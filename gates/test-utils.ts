/**
 * Shared test utilities for gate test files.
 *
 * Provides safe accessors for workflow-state.json with graceful
 * error handling when no active workflow is present (standalone runs).
 */
import { readFileSync, existsSync } from "fs";

/**
 * Whether the test suite is running in standalone mode (no active workflow).
 * When true, tests that depend on workflow-state.json should skip.
 */
export const STANDALONE = !process.env.TEST_WORK_DIR;

/**
 * Safely read and parse a JSON file. Returns null on ENOENT or parse error.
 */
export function safeReadJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Create a safe workflow-state accessor for a given file path.
 * Returns undefined for any path if the file doesn't exist.
 */
export function createSf(statePath: string): (path: string) => any {
  return (path: string): any => {
    const raw = safeReadJson(statePath);
    if (!raw) return undefined;
    const parts = path.replace(/^\./, "").split(".").filter(Boolean);
    let val: any = raw;
    for (const p of parts) {
      if (val == null) return undefined;
      val = val[p];
    }
    return val;
  };
}
