/**
 * gate-enforcement.test.ts — Unit tests for lib/gate-enforcement.ts
 *
 * Tests gate enforcement logic extracted from GateEnforcement.hook.ts
 * per Hook Architecture Spec D-2 (hook logic in lib/ with unit tests).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const TEST_DIR = `/tmp/gate-enforcement-test-${process.pid}`;
const SIGNALS_DIR = join(TEST_DIR, "signals");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(SIGNALS_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// -- formatFailures tests --

describe("formatFailures", () => {
  test("formats single failure", () => {
    const { formatFailures } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = formatFailures([{ check: "scope-check", detail: "missing AC" }]);
    expect(result).toContain("scope-check");
    expect(result).toContain("missing AC");
  });

  test("formats multiple failures", () => {
    const { formatFailures } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = formatFailures([
      { check: "check-1", detail: "detail-1" },
      { check: "check-2", detail: "detail-2" },
    ]);
    expect(result).toContain("check-1");
    expect(result).toContain("check-2");
    expect(result.split("\n").length).toBe(2);
  });

  test("formats empty failures array", () => {
    const { formatFailures } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = formatFailures([]);
    expect(result).toBe("");
  });
});

// -- findWorkflowGateFailure tests --

describe("findWorkflowGateFailure", () => {
  test("returns null when workDir does not exist", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = findWorkflowGateFailure("/nonexistent/path");
    expect(result).toBeNull();
  });

  test("returns null when no workflow-state.json files exist", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    mkdirSync(join(TEST_DIR, "some-issue"), { recursive: true });
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns null when all workflows are in DONE phase", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-1");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({
      phase: "DONE",
      gates: { scope: { result: "FAIL", failures: [{ check: "c", detail: "d" }] } },
    }));
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).toBeNull();
  });

  test("detects scope gate failure", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-2");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({
      phase: "BUILD",
      issue: 42,
      slug: "test-slug",
      gates: {
        scope: { result: "FAIL", failures: [{ check: "ac-count", detail: "not enough ACs" }] },
      },
    }));
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("scope");
    expect(result!.issue).toBe(42);
    expect(result!.slug).toBe("test-slug");
    expect(result!.failures).toHaveLength(1);
    expect(result!.failures[0].check).toBe("ac-count");
  });

  test("detects verify gate failure", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-3");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({
      phase: "VERIFY",
      issue: 99,
      slug: "verify-slug",
      gates: {
        verify: { result: "FAIL", failures: [{ check: "tests", detail: "3 tests failing" }] },
      },
    }));
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("verify");
  });

  test("detects ship gate failure", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-4");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({
      phase: "SHIP",
      issue: 77,
      slug: "ship-slug",
      gates: {
        ship: { result: "FAIL", failures: [{ check: "commit", detail: "no commit" }] },
      },
    }));
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("ship");
  });

  test("detects outcome AC failure", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-5");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({
      phase: "BUILD",
      issue: 55,
      slug: "outcome-slug",
      gates: {
        scope: { result: "FAIL", failures: [{ check: "ac-check", detail: "failed" }] },
      },
      acs: [{ type: "OUTCOME", verdict: "FAIL" }],
    }));
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.hasOutcomeAcFailure).toBe(true);
  });

  test("handles malformed workflow-state.json gracefully", () => {
    const { findWorkflowGateFailure } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const issueDir = join(TEST_DIR, "issue-6");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), "not valid json");
    const result = findWorkflowGateFailure(TEST_DIR);
    expect(result).toBeNull();
  });
});

// -- makeEnforcementDecision tests --

describe("makeEnforcementDecision", () => {
  test("returns block for outcome AC failure on Skill call", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "scope",
      issue: 42,
      slug: "test",
      failures: [{ check: "ac", detail: "failed" }],
      hasOutcomeAcFailure: true,
      strikeCount: 0,
      maxStrikes: 3,
    }, "Skill");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("OUTCOME AC");
  });

  test("returns pass for outcome AC failure on non-Skill call", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "scope",
      issue: 42,
      slug: "test",
      failures: [{ check: "ac", detail: "failed" }],
      hasOutcomeAcFailure: true,
      strikeCount: 0,
      maxStrikes: 3,
    }, "Bash");
    expect(result.action).toBe("nag");
  });

  test("returns block for Skill call at max strikes", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "verify",
      issue: 99,
      slug: "test",
      failures: [{ check: "tests", detail: "failing" }],
      hasOutcomeAcFailure: false,
      strikeCount: 3,
      maxStrikes: 3,
    }, "Skill");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("strikes");
  });

  test("returns nag for Skill call below max strikes", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "verify",
      issue: 99,
      slug: "test",
      failures: [{ check: "tests", detail: "failing" }],
      hasOutcomeAcFailure: false,
      strikeCount: 1,
      maxStrikes: 3,
    }, "Skill");
    expect(result.action).toBe("nag");
    expect(result.newStrikeCount).toBe(2);
  });

  test("returns nag for non-Skill call without incrementing strikes", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "verify",
      issue: 99,
      slug: "test",
      failures: [{ check: "tests", detail: "failing" }],
      hasOutcomeAcFailure: false,
      strikeCount: 2,
      maxStrikes: 3,
    }, "Read");
    expect(result.action).toBe("nag");
    expect(result.newStrikeCount).toBe(2);
  });

  test("nag output contains system-reminder tags", () => {
    const { makeEnforcementDecision } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const result = makeEnforcementDecision({
      gate: "scope",
      issue: 10,
      slug: "test",
      failures: [{ check: "check-1", detail: "d" }],
      hasOutcomeAcFailure: false,
      strikeCount: 0,
      maxStrikes: 3,
    }, "Bash");
    expect(result.output).toContain("<system-reminder>");
    expect(result.output).toContain("</system-reminder>");
  });
});

// -- logSignal tests --

describe("logSignal", () => {
  test("appends signal to existing signals file", () => {
    const { logSignal } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const signalsFile = join(SIGNALS_DIR, "signals.jsonl");
    writeFileSync(signalsFile, "");
    logSignal({ type: "test", ts: "2026-01-01" }, SIGNALS_DIR, signalsFile);
    const content = readFileSync(signalsFile, "utf-8");
    expect(content).toContain('"type":"test"');
  });

  test("does not throw when signals file does not exist", () => {
    const { logSignal } = require("../../lib/gate-enforcement") as typeof import("../../lib/gate-enforcement");
    const signalsFile = join(SIGNALS_DIR, "signals.jsonl");
    // File does not exist — should not throw
    expect(() => logSignal({ type: "test" }, SIGNALS_DIR, signalsFile)).not.toThrow();
  });
});
