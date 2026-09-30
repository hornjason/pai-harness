import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { applyCeremonyOverrides } from "../gates/gate-executor";
import type { ProjectHarness } from "../lib/rungate-schema";

const TEST_DIR = join(__dirname, "..", ".rungate-test", "ceremony-overrides");

describe("ceremony overrides", () => {
  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("SC-A1: base profile loads without overrides", () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const baseProfile = {
      tiers: {
        STANDARD: {
          maxIterations: 5,
          checks: {
            verify: ["all-acs-have-evidence", "tests-pass", "tsc-pass"],
            ship: ["branch-merged", "code-pushed"],
          },
        },
      },
    };

    const baseProfilePath = join(TEST_DIR, "ceremony-profiles.json");
    writeFileSync(baseProfilePath, JSON.stringify(baseProfile, null, 2));

    const result = applyCeremonyOverrides(baseProfilePath, null, TEST_DIR);

    // Should return the original path when no overrides
    expect(result).toBe(baseProfilePath);
  });

  test("SC-A2: override merges maxIterations correctly", () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const baseProfile = {
      tiers: {
        STANDARD: {
          maxIterations: 5,
          checks: {
            verify: ["all-acs-have-evidence", "tests-pass", "tsc-pass"],
          },
        },
      },
    };

    const baseProfilePath = join(TEST_DIR, "ceremony-profiles.json");
    writeFileSync(baseProfilePath, JSON.stringify(baseProfile, null, 2));

    const harnessConfig: Partial<ProjectHarness> = {
      ceremonyOverrides: {
        STANDARD: {
          maxIterations: 3,
        },
      },
    };

    const resultPath = applyCeremonyOverrides(baseProfilePath, harnessConfig as ProjectHarness, TEST_DIR);

    // Should create a merged profile
    expect(resultPath).not.toBe(baseProfilePath);
    expect(existsSync(resultPath)).toBe(true);

    const merged = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(merged.tiers.STANDARD.maxIterations).toBe(3);
    expect(merged.tiers.STANDARD.checks.verify).toContain("all-acs-have-evidence");
    expect(merged.tiers.STANDARD.checks.verify).toContain("tests-pass");
    expect(merged.tiers.STANDARD.checks.verify).toContain("tsc-pass");
  });

  test("SC-A3: override merges check lists correctly", () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const baseProfile = {
      tiers: {
        STANDARD: {
          maxIterations: 5,
          checks: {
            verify: ["all-acs-have-evidence", "all-acs-pass", "tests-pass", "tsc-pass", "code-committed"],
            ship: ["all-gates-pass", "branch-merged", "code-pushed"],
          },
        },
      },
    };

    const baseProfilePath = join(TEST_DIR, "ceremony-profiles.json");
    writeFileSync(baseProfilePath, JSON.stringify(baseProfile, null, 2));

    const harnessConfig: Partial<ProjectHarness> = {
      ceremonyOverrides: {
        STANDARD: {
          checks: {
            verify: ["all-acs-have-evidence", "tests-pass", "code-committed"],
          },
        },
      },
    };

    const resultPath = applyCeremonyOverrides(baseProfilePath, harnessConfig as ProjectHarness, TEST_DIR);

    const merged = JSON.parse(readFileSync(resultPath, "utf-8"));

    // The override replaces the array
    expect(merged.tiers.STANDARD.checks.verify).toContain("all-acs-have-evidence");
    expect(merged.tiers.STANDARD.checks.verify).toContain("tests-pass");
    expect(merged.tiers.STANDARD.checks.verify).toContain("code-committed");

    // But protected checks should be re-added
    expect(merged.tiers.STANDARD.checks.verify).toContain("tsc-pass");
    expect(merged.tiers.STANDARD.checks.verify).toContain("all-acs-pass");

    // Ship checks should remain unchanged since no override
    expect(merged.tiers.STANDARD.checks.ship).toEqual(["all-gates-pass", "branch-merged", "code-pushed"]);
  });

  test("SC-A4: protected checks re-added after override removes them", () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const baseProfile = {
      tiers: {
        STANDARD: {
          maxIterations: 5,
          checks: {
            verify: ["all-acs-have-evidence", "all-acs-pass", "tests-pass", "tsc-pass", "code-committed"],
            ship: ["all-gates-pass", "branch-merged", "code-pushed"],
          },
        },
      },
    };

    const baseProfilePath = join(TEST_DIR, "ceremony-profiles.json");
    writeFileSync(baseProfilePath, JSON.stringify(baseProfile, null, 2));

    const harnessConfig: Partial<ProjectHarness> = {
      ceremonyOverrides: {
        STANDARD: {
          checks: {
            verify: ["custom-check-only"],
            ship: ["custom-ship-check"],
          },
        },
      },
    };

    const resultPath = applyCeremonyOverrides(baseProfilePath, harnessConfig as ProjectHarness, TEST_DIR);

    const merged = JSON.parse(readFileSync(resultPath, "utf-8"));

    // Protected verify checks should be re-added
    expect(merged.tiers.STANDARD.checks.verify).toContain("custom-check-only");
    expect(merged.tiers.STANDARD.checks.verify).toContain("tests-pass");
    expect(merged.tiers.STANDARD.checks.verify).toContain("tsc-pass");
    expect(merged.tiers.STANDARD.checks.verify).toContain("code-committed");
    expect(merged.tiers.STANDARD.checks.verify).toContain("all-acs-have-evidence");
    expect(merged.tiers.STANDARD.checks.verify).toContain("all-acs-pass");

    // Protected ship checks should be re-added
    expect(merged.tiers.STANDARD.checks.ship).toContain("custom-ship-check");
    expect(merged.tiers.STANDARD.checks.ship).toContain("branch-merged");
    expect(merged.tiers.STANDARD.checks.ship).toContain("code-pushed");
  });

  test("SC-A5: multiple tier overrides", () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const baseProfile = {
      tiers: {
        LIGHT: {
          maxIterations: 3,
          checks: {
            verify: ["all-acs-have-evidence", "tests-pass"],
          },
        },
        STANDARD: {
          maxIterations: 5,
          checks: {
            verify: ["all-acs-have-evidence", "all-acs-pass", "tests-pass", "tsc-pass"],
          },
        },
      },
    };

    const baseProfilePath = join(TEST_DIR, "ceremony-profiles.json");
    writeFileSync(baseProfilePath, JSON.stringify(baseProfile, null, 2));

    const harnessConfig: Partial<ProjectHarness> = {
      ceremonyOverrides: {
        LIGHT: {
          maxIterations: 2,
        },
        STANDARD: {
          maxIterations: 4,
        },
      },
    };

    const resultPath = applyCeremonyOverrides(baseProfilePath, harnessConfig as ProjectHarness, TEST_DIR);

    const merged = JSON.parse(readFileSync(resultPath, "utf-8"));

    expect(merged.tiers.LIGHT.maxIterations).toBe(2);
    expect(merged.tiers.STANDARD.maxIterations).toBe(4);
  });
});
