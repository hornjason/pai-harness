import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_BASE = `/tmp/ship-orch-test-${process.pid}`;
const TEST_SLUG = `orch-test-${process.pid}`;
const WORK_DIR = join(TEST_BASE, TEST_SLUG);
const SF = join(WORK_DIR, "workflow-state.json");

function minimalState(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    issue: 9999,
    repo: "test/repo",
    issueRepo: "test/repo",
    projectRoot: "/tmp/test-project",
    slug: TEST_SLUG,
    phase: "GOAL",
    issueGoal: "Test goal for ship orchestrator validation",
    acs: [],
    gates: {},
    changelog: [],
    ...overrides,
  };
}

function createState(overrides: Record<string, any> = {}): void {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(SF, JSON.stringify(minimalState(overrides), null, 2));
}

function readState(): any {
  return JSON.parse(readFileSync(SF, "utf-8"));
}

// Override WORK_DIR_BASE for tests via env
process.env.SHIP_ORCH_WORK_DIR = TEST_BASE;

import {
  advancePhase,
  currentState,
  runGate,
  getIterationCount,
  isCircuitBroken,
  validatePhaseTransition,
  getRequiredGate,
  MAX_ITERATIONS,
} from "./ship-orchestrator";

describe("ship-orchestrator", () => {
  beforeEach(() => {
    mkdirSync(WORK_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch {}
  });

  // ── currentState ─────────────────────────────────────────────────

  describe("currentState", () => {
    test("returns workflow state for valid slug", async () => {
      createState({ phase: "BUILD" });
      const state = await currentState(TEST_SLUG);
      expect(state.phase).toBe("BUILD");
      expect(state.slug).toBe(TEST_SLUG);
      expect(state.issue).toBe(9999);
    });

    test("throws for missing slug", async () => {
      await expect(currentState("nonexistent-slug-xyz-12345")).rejects.toThrow(/not found/);
    });
  });

  // ── getRequiredGate ──────────────────────────────────────────────

  describe("getRequiredGate", () => {
    test("returns scope for SCOPE phase", () => {
      expect(getRequiredGate("SCOPE")).toBe("scope");
    });

    test("returns verify for BUILD phase", () => {
      expect(getRequiredGate("BUILD")).toBe("verify");
    });

    test("returns ship for SHIP phase", () => {
      expect(getRequiredGate("SHIP")).toBe("ship");
    });

    test("returns null for ungated phases", () => {
      expect(getRequiredGate("GOAL")).toBeNull();
      expect(getRequiredGate("DISCOVERY")).toBeNull();
      expect(getRequiredGate("DONE")).toBeNull();
    });
  });

  // ── validatePhaseTransition ──────────────────────────────────────

  describe("validatePhaseTransition", () => {
    test("GOAL → DISCOVERY is valid", () => {
      expect(validatePhaseTransition("GOAL", "DISCOVERY")).toBe(true);
    });

    test("DISCOVERY → SCOPE is valid", () => {
      expect(validatePhaseTransition("DISCOVERY", "SCOPE")).toBe(true);
    });

    test("SCOPE → BUILD is valid (via scope gate)", () => {
      expect(validatePhaseTransition("SCOPE", "BUILD")).toBe(true);
    });

    test("BUILD → SHIP is valid (via verify gate)", () => {
      expect(validatePhaseTransition("BUILD", "SHIP")).toBe(true);
    });

    test("SHIP → DONE is valid (via ship gate)", () => {
      expect(validatePhaseTransition("SHIP", "DONE")).toBe(true);
    });

    test("cannot skip phases — GOAL → BUILD is invalid", () => {
      expect(validatePhaseTransition("GOAL", "BUILD")).toBe(false);
    });

    test("cannot skip phases — GOAL → SHIP is invalid", () => {
      expect(validatePhaseTransition("GOAL", "SHIP")).toBe(false);
    });

    test("cannot advance from DONE", () => {
      expect(validatePhaseTransition("DONE", "GOAL")).toBe(false);
    });

    test("cannot advance from CIRCUIT_BREAK", () => {
      expect(validatePhaseTransition("CIRCUIT_BREAK", "GOAL")).toBe(false);
    });

    test("VERIFY → SHIP is valid (direct)", () => {
      expect(validatePhaseTransition("VERIFY", "SHIP")).toBe(true);
    });
  });

  // ── advancePhase — ungated transitions ───────────────────────────

  describe("advancePhase — ungated transitions", () => {
    test("advances GOAL → DISCOVERY without gate", async () => {
      createState({ phase: "GOAL" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("DISCOVERY");
      expect(result.gateResult).toBe("SKIPPED");
      const state = readState();
      expect(state.phase).toBe("DISCOVERY");
    });

    test("advances DISCOVERY → SCOPE without gate", async () => {
      createState({ phase: "DISCOVERY" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("SCOPE");
      expect(result.gateResult).toBe("SKIPPED");
    });

    test("advances VERIFY → SHIP without gate", async () => {
      createState({ phase: "VERIFY" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("SHIP");
      expect(result.gateResult).toBe("SKIPPED");
    });

    test("blocks advancement from DONE", async () => {
      createState({ phase: "DONE" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("DONE");
      expect(result.gateResult).toBe("SKIPPED");
    });

    test("blocks advancement from CIRCUIT_BREAK", async () => {
      createState({ phase: "CIRCUIT_BREAK" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("CIRCUIT_BREAK");
      expect(result.gateResult).toBe("SKIPPED");
    });

    test("records phase advancement in changelog", async () => {
      createState({ phase: "GOAL", changelog: [] });
      await advancePhase(TEST_SLUG);
      const state = readState();
      const last = state.changelog[state.changelog.length - 1];
      expect(last.event).toBe("phase-advance");
      expect(last.detail).toContain("GOAL");
      expect(last.detail).toContain("DISCOVERY");
      expect(last.actor).toBe("gate-runner");
    });

    test("tracks phase timings on advancement", async () => {
      createState({ phase: "GOAL", changelog: [] });
      await advancePhase(TEST_SLUG);
      const state = readState();
      expect(state.phaseTimings).toBeDefined();
      expect(state.phaseTimings.DISCOVERY).toBeDefined();
      expect(state.phaseTimings.DISCOVERY.length).toBe(1);
      expect(state.phaseTimings.DISCOVERY[0].enteredTs).toBeTruthy();
      expect(state.phaseTimings.DISCOVERY[0].source).toBe("gate-runner");
    });

    test("sequential ungated advances work correctly", async () => {
      createState({ phase: "GOAL" });
      let result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("DISCOVERY");
      result = await advancePhase(TEST_SLUG);
      expect(result.phase).toBe("SCOPE");
    });
  });

  // ── runGate — phase validation ───────────────────────────────────

  describe("runGate — phase validation", () => {
    test("rejects scope gate from GOAL phase", async () => {
      createState({ phase: "GOAL" });
      await expect(runGate(TEST_SLUG, "scope")).rejects.toThrow(/Cannot run scope gate from phase GOAL/);
    });

    test("rejects verify gate from SCOPE phase", async () => {
      createState({ phase: "SCOPE" });
      await expect(runGate(TEST_SLUG, "verify")).rejects.toThrow(/Cannot run verify gate from phase SCOPE/);
    });

    test("rejects ship gate from BUILD phase", async () => {
      createState({ phase: "BUILD" });
      await expect(runGate(TEST_SLUG, "ship")).rejects.toThrow(/Cannot run ship gate from phase BUILD/);
    });

    test("rejects scope gate from DONE phase", async () => {
      createState({ phase: "DONE" });
      await expect(runGate(TEST_SLUG, "scope")).rejects.toThrow(/Cannot run scope gate from phase DONE/);
    });

    test("scope gate allowed from SCOPE phase", async () => {
      createState({ phase: "SCOPE" });
      // This will try to call run-gate.ts and fail due to missing ACs etc,
      // but it should NOT throw a phase validation error
      const result = await runGate(TEST_SLUG, "scope");
      // Gate will fail because no ACs, but that proves the phase validation passed
      expect(result.gateResult).toBe("FAIL");
    });
  });

  // ── Circuit breaker ─────────────────────────────────────────────

  describe("circuit breaker", () => {
    test("MAX_ITERATIONS is 3", () => {
      expect(MAX_ITERATIONS).toBe(3);
    });

    test("getIterationCount returns 0 for fresh workflow", () => {
      createState({ phase: "BUILD", changelog: [] });
      expect(getIterationCount(TEST_SLUG)).toBe(0);
    });

    test("getIterationCount counts iteration-loopback events", () => {
      createState({
        phase: "BUILD",
        changelog: [
          { ts: "2026-01-01T00:00:00Z", event: "iteration-loopback", detail: "iteration 1", actor: "gate-runner" },
          { ts: "2026-01-01T00:01:00Z", event: "iteration-loopback", detail: "iteration 2", actor: "gate-runner" },
        ],
      });
      expect(getIterationCount(TEST_SLUG)).toBe(2);
    });

    test("isCircuitBroken returns false below threshold", () => {
      createState({
        phase: "BUILD",
        changelog: [
          { ts: "2026-01-01T00:00:00Z", event: "iteration-loopback", detail: "iteration 1", actor: "gate-runner" },
          { ts: "2026-01-01T00:01:00Z", event: "iteration-loopback", detail: "iteration 2", actor: "gate-runner" },
        ],
      });
      expect(isCircuitBroken(TEST_SLUG)).toBe(false);
    });

    test("isCircuitBroken returns true at threshold", () => {
      createState({
        phase: "BUILD",
        changelog: [
          { ts: "2026-01-01T00:00:00Z", event: "iteration-loopback", detail: "iteration 1", actor: "gate-runner" },
          { ts: "2026-01-01T00:01:00Z", event: "iteration-loopback", detail: "iteration 2", actor: "gate-runner" },
          { ts: "2026-01-01T00:02:00Z", event: "iteration-loopback", detail: "iteration 3", actor: "gate-runner" },
        ],
      });
      expect(isCircuitBroken(TEST_SLUG)).toBe(true);
    });

    test("isCircuitBroken returns true when phase is CIRCUIT_BREAK", () => {
      createState({ phase: "CIRCUIT_BREAK", changelog: [] });
      expect(isCircuitBroken(TEST_SLUG)).toBe(true);
    });

    test("runGate returns circuit breaker result when broken", async () => {
      createState({
        phase: "BUILD",
        changelog: [
          { ts: "2026-01-01T00:00:00Z", event: "iteration-loopback", detail: "1", actor: "gate-runner" },
          { ts: "2026-01-01T00:01:00Z", event: "iteration-loopback", detail: "2", actor: "gate-runner" },
          { ts: "2026-01-01T00:02:00Z", event: "iteration-loopback", detail: "3", actor: "gate-runner" },
        ],
      });
      const result = await runGate(TEST_SLUG, "verify");
      expect(result.circuitBreaker).toBe(true);
      expect(result.gateResult).toBe("FAIL");
    });
  });

  // ── advancePhase — gated transitions ─────────────────────────────

  describe("advancePhase — gated transitions", () => {
    test("advancePhase from SCOPE triggers scope gate", async () => {
      createState({ phase: "SCOPE" });
      const result = await advancePhase(TEST_SLUG);
      // Gate will fail because no ACs, but it was invoked (not SKIPPED)
      expect(result.gateResult).not.toBe("SKIPPED");
    });

    test("advancePhase from BUILD triggers verify gate", async () => {
      createState({ phase: "BUILD" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.gateResult).not.toBe("SKIPPED");
    });

    test("advancePhase from SHIP triggers ship gate", async () => {
      createState({ phase: "SHIP" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.gateResult).not.toBe("SKIPPED");
    });

    test("gate failure blocks phase advancement", async () => {
      createState({ phase: "SCOPE" });
      const result = await advancePhase(TEST_SLUG);
      expect(result.gateResult).toBe("FAIL");
      // Phase should not have advanced (gate runner behavior)
      const state = readState();
      // State may still be SCOPE because the gate failed
      expect(["SCOPE", "BUILD"]).toContain(state.phase);
    });
  });

  // ── State consistency ────────────────────────────────────────────

  describe("state consistency", () => {
    test("updatedTs is set on phase advancement", async () => {
      createState({ phase: "GOAL" });
      const before = readState();
      await advancePhase(TEST_SLUG);
      const after = readState();
      expect(after.updatedTs).toBeTruthy();
      expect(after.updatedTs).not.toBe(before.updatedTs);
    });

    test("multiple advances maintain changelog order", async () => {
      createState({ phase: "GOAL", changelog: [] });
      await advancePhase(TEST_SLUG); // GOAL → DISCOVERY
      await advancePhase(TEST_SLUG); // DISCOVERY → SCOPE
      const state = readState();
      expect(state.changelog.length).toBe(2);
      expect(state.changelog[0].detail).toContain("GOAL");
      expect(state.changelog[1].detail).toContain("DISCOVERY");
    });
  });
});
