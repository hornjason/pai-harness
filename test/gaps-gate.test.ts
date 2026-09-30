import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const GATES_DIR = join(import.meta.dir, "..", "gates");
const RUN_GATE_FILE = join(GATES_DIR, "run-gate.ts");
const GATE_EXECUTOR_FILE = join(GATES_DIR, "gate-executor.ts");

describe("gaps gate", () => {
  test("run-gate.ts accepts --gate gaps", () => {
    const src = readFileSync(RUN_GATE_FILE, "utf-8");
    // Should include "gaps" in the allowed gates list
    expect(src).toMatch(/["']gaps["']/);
  });

  test("gate-executor.ts imports scanGaps from lib/gap-scanner", () => {
    const src = readFileSync(GATE_EXECUTOR_FILE, "utf-8");
    // Should import scanGaps from lib/gap-scanner
    expect(src).toMatch(/import.*scanGaps.*from.*gap-scanner/);
  });

  test("gaps gate implementation exists in gate-executor.ts", () => {
    const src = readFileSync(GATE_EXECUTOR_FILE, "utf-8");
    // Should have logic that handles the gaps gate
    expect(src).toMatch(/gate === ["']gaps["']/);
  });

  test("gaps gate returns WARN-only results (never FAIL)", () => {
    const src = readFileSync(GATE_EXECUTOR_FILE, "utf-8");
    // Within gaps gate logic, results should never have result: "FAIL"
    // This is a structural check - implementation should only push WARN or PASS results
    const gapsGateSection = src.match(/if \(gate === ['"]gaps['"]\)[\s\S]*?\}/);
    if (gapsGateSection) {
      // Should not set result to FAIL within gaps gate logic
      expect(gapsGateSection[0]).not.toMatch(/result:\s*["']FAIL["']/);
    }
  });
});
