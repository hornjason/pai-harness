import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We'll test the extracted lib functions
import {
  findWorkflowGateFailure,
  makeEnforcementDecision,
  formatFailures,
  type GateFailure,
  type WorkflowGateFailure,
  type EnforcementDecision,
} from "../lib/gate-enforcement";

// ── Test fixtures ──────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `gate-enforcement-test-${Date.now()}`);

function createWorkflow(slug: string, data: Record<string, unknown>): void {
  const dir = join(TEST_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(data, null, 2));
}

// ── findWorkflowGateFailure ────────────────────────────────

describe("findWorkflowGateFailure", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("returns null when work dir does not exist", () => {
    const result = findWorkflowGateFailure("/nonexistent-dir-abc123");
    expect(result).toBeNull();
  });

  test("returns null when no workflows have gate failures", () => {
    createWorkflow("issue-100", {
      phase: "BUILD",
      issue: 100,
      gates: {
        scope: { result: "PASS", failures: [] },
      },
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns null for DONE-phase workflows", () => {
    createWorkflow("issue-101", {
      phase: "DONE",
      issue: 101,
      gates: {
        verify: { result: "FAIL", failures: [{ check: "test-run", detail: "tests failed" }] },
      },
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).toBeNull();
  });

  test("finds scope gate failure", () => {
    createWorkflow("issue-102", {
      phase: "BUILD",
      issue: 102,
      slug: "feature-x",
      gates: {
        scope: {
          result: "FAIL",
          failures: [{ check: "sc-coverage", detail: "missing SC" }],
        },
      },
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("scope");
    expect(result!.issue).toBe(102);
    expect(result!.failures).toHaveLength(1);
    expect(result!.failures[0].check).toBe("sc-coverage");
  });

  test("finds verify gate failure", () => {
    createWorkflow("issue-103", {
      phase: "VERIFY",
      issue: 103,
      gates: {
        verify: {
          result: "FAIL",
          failures: [{ check: "test-run", detail: "3 tests failed" }],
        },
      },
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("verify");
  });

  test("finds ship gate failure", () => {
    createWorkflow("issue-104", {
      phase: "SHIP",
      issue: 104,
      gates: {
        ship: {
          result: "FAIL",
          failures: [{ check: "ci-pass", detail: "CI red" }],
        },
      },
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("ship");
  });

  test("detects outcome AC failure from acs array", () => {
    createWorkflow("issue-105", {
      phase: "VERIFY",
      issue: 105,
      gates: {
        verify: {
          result: "FAIL",
          failures: [{ check: "ac-verify", detail: "AC failed" }],
        },
      },
      acs: [{ type: "OUTCOME", verdict: "FAIL" }],
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.hasOutcomeAcFailure).toBe(true);
  });

  test("hasOutcomeAcFailure is false when no OUTCOME AC fails", () => {
    createWorkflow("issue-106", {
      phase: "VERIFY",
      issue: 106,
      gates: {
        verify: {
          result: "FAIL",
          failures: [{ check: "test", detail: "fail" }],
        },
      },
      acs: [{ type: "OUTCOME", verdict: "PASS" }],
    });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.hasOutcomeAcFailure).toBe(false);
  });

  test("scans nested directories (e.g. pai/361)", () => {
    const nestedDir = join(TEST_DIR, "pai", "361");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, "workflow-state.json"),
      JSON.stringify({
        phase: "BUILD",
        issue: 361,
        gates: {
          scope: { result: "FAIL", failures: [{ check: "nested", detail: "found" }] },
        },
      }),
    );
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.issue).toBe(361);
  });
});

// ── formatFailures ─────────────────────────────────────────

describe("formatFailures", () => {
  test("formats single failure", () => {
    const failures: GateFailure[] = [{ check: "test-run", detail: "3 tests failed" }];
    const result = formatFailures(failures);
    expect(result).toBe("  - test-run: 3 tests failed");
  });

  test("formats multiple failures", () => {
    const failures: GateFailure[] = [
      { check: "test-run", detail: "failed" },
      { check: "lint", detail: "errors" },
    ];
    const result = formatFailures(failures);
    expect(result).toContain("test-run: failed");
    expect(result).toContain("lint: errors");
    expect(result.split("\n")).toHaveLength(2);
  });

  test("handles empty array", () => {
    expect(formatFailures([])).toBe("");
  });
});

// ── makeEnforcementDecision ────────────────────────────────

describe("makeEnforcementDecision", () => {
  const baseFailure: WorkflowGateFailure = {
    gate: "verify",
    issue: 200,
    slug: "test-slug",
    failures: [{ check: "test", detail: "failed" }],
    hasOutcomeAcFailure: false,
  };

  test("blocks Skill calls on outcome AC failure", () => {
    const failure: WorkflowGateFailure = { ...baseFailure, hasOutcomeAcFailure: true };
    const result = makeEnforcementDecision(failure, "Skill", 0, 3);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("OUTCOME AC");
  });

  test("does NOT block non-Skill calls on outcome AC failure", () => {
    const failure: WorkflowGateFailure = { ...baseFailure, hasOutcomeAcFailure: true };
    const result = makeEnforcementDecision(failure, "Bash", 0, 3);
    expect(result.action).toBe("nag");
  });

  test("blocks Skill calls at max strikes", () => {
    const result = makeEnforcementDecision(baseFailure, "Skill", 3, 3);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("strikes");
  });

  test("blocks Skill calls above max strikes", () => {
    const result = makeEnforcementDecision(baseFailure, "Skill", 5, 3);
    expect(result.action).toBe("block");
  });

  test("nags and increments strike for Skill calls below max", () => {
    const result = makeEnforcementDecision(baseFailure, "Skill", 1, 3);
    expect(result.action).toBe("nag");
    expect(result.newStrikeCount).toBe(2);
  });

  test("nags without incrementing strike for non-Skill tools", () => {
    const result = makeEnforcementDecision(baseFailure, "Read", 1, 3);
    expect(result.action).toBe("nag");
    expect(result.newStrikeCount).toBe(1);
  });

  test("outcome AC block takes priority over strike block", () => {
    const failure: WorkflowGateFailure = { ...baseFailure, hasOutcomeAcFailure: true };
    const result = makeEnforcementDecision(failure, "Skill", 10, 3);
    expect(result.action).toBe("block");
    expect(result.reason).toContain("OUTCOME AC");
  });

  test("decision includes gate and issue info", () => {
    const result = makeEnforcementDecision(baseFailure, "Bash", 0, 3);
    expect(result.gate).toBe("verify");
    expect(result.issue).toBe(200);
  });
});
