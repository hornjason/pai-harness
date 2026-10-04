import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "precompute-goal.ts");

describe("precompute-goal", () => {
  test("extracts goalData from a real issue", () => {
    const output = execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 20000,
    });
    const result = JSON.parse(output);

    expect(result.goalData).toBeDefined();
    expect(result.goalData.issueTitle).toContain("Phase 1");
    expect(result.goalData.successCriteria.length).toBeGreaterThanOrEqual(4);
    expect(result.goalData.labels).toBeInstanceOf(Array);
  });

  test("extracts preloadedContexts with reinforcement rules", () => {
    const output = execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 20000,
    });
    const result = JSON.parse(output);

    expect(result.preloadedContexts).toBeDefined();
    expect(result.preloadedContexts.marcus).toBeDefined();
    expect(result.preloadedContexts.marcus.rules.length).toBeGreaterThanOrEqual(3);
    expect(result.preloadedContexts.marcus.rules.some((r: string) => r.includes("bun test"))).toBe(true);
    expect(result.preloadedContexts.discovery.rules.length).toBeGreaterThanOrEqual(4);
  });

  test("does not include non-rule lines in reinforcement", () => {
    const output = execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 20000,
    });
    const result = JSON.parse(output);
    const marcusRules = result.preloadedContexts.marcus.rules;
    expect(marcusRules.every((r: string) => !r.startsWith("`lib/"))).toBe(true);
    expect(marcusRules.every((r: string) => !r.startsWith("`gates/"))).toBe(true);
  });

  test("exits with error on missing args", () => {
    expect(() => {
      execFileSync("bun", [SCRIPT], { encoding: "utf-8", timeout: 10000 });
    }).toThrow();
  });
});
