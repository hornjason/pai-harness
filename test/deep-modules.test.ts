/**
 * Deep modules verification — ensures phase test files follow thin consumer pattern.
 * AC-1: phase-0 delegates to conformity engine, <= 200 lines
 * AC-2: phase-1-5 tests engine internals directly, >= 2 references
 * AC-3: phase-1 under 200 lines after migration
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("Deep modules: phase test thin consumers", () => {
  test("AC-1: phase-0.test.ts <= 200 lines", () => {
    const content = readFileSync(join(ROOT, "test/phase-0.test.ts"), "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(200);
  });

  test("AC-1: phase-0 calls runScaffoldConformity", () => {
    const content = readFileSync(join(ROOT, "test/phase-0.test.ts"), "utf-8");
    expect(content).toContain("runScaffoldConformity");
  });

  test("AC-2: phase-1-5 imports engine internals (resolveAndContain, matchPattern)", () => {
    const content = readFileSync(join(ROOT, "test/phase-1-5.test.ts"), "utf-8");
    const refs = (content.match(/resolveAndContain|matchPattern/g) || []).length;
    expect(refs).toBeGreaterThanOrEqual(2);
  });

  test("AC-3: phase-1.test.ts < 200 lines", () => {
    const content = readFileSync(join(ROOT, "test/phase-1.test.ts"), "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThan(200);
  });
});
