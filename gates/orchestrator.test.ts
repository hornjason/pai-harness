import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";
import {
  writeGateResult,
  generateHmac,
  runConvergence,
  generateShipEvidence,
  writeGateSummary,
  writeWorkflowState,
  initWorkflow,
  writeACs,
  markCommandlessACsAsSkip,
  initBatchPlan,
  recordBatchShipped,
  recordBatchSkipped,
  validateBatchComplete,
} from "./orchestrator";

const TMP_DIR = `/tmp/orchestrator-test-${process.pid}`;
const SF = join(TMP_DIR, "workflow-state.json");
const PROFILE = join(TMP_DIR, "ceremony-profiles.json");
const PENDING = join(process.env.HOME || "", ".claude", "MEMORY", "STATE", "gate-pending.json");

function makeState(overrides: Record<string, any> = {}): any {
  return {
    schemaVersion: 2,
    issue: 432,
    slug: "test-orch",
    phase: "SCOPE",
    issueGoal: "Port orchestrator",
    acs: [
      {
        id: "SC-1",
        statement: "orchestrator.ts file exists on disk and is valid",
        threshold: { op: "==", value: "true" },
        evidenceMethod: { type: "FILE_EXISTS" },
        evidence: null,
      },
    ],
    gates: {},
    changelog: [],
    sizing: { predicted: "M", ceremonyTier: "STANDARD" },
    phaseTimings: {},
    ...overrides,
  };
}

function makeProfile(): any {
  return {
    tiers: {
      LIGHT: { maxIterations: 3, checks: { scope: [], verify: [], ship: [] } },
      STANDARD: { maxIterations: 5, checks: { scope: [], verify: [], ship: [] } },
      THOROUGH: { maxIterations: 8, checks: { scope: [], verify: [], ship: [] } },
    },
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(SF, JSON.stringify(makeState(), null, 2));
  writeFileSync(PROFILE, JSON.stringify(makeProfile(), null, 2));
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  try { rmSync(PENDING, { force: true }); } catch {}
});

// ═══ writeGateResult ═══════════════════════════════════════════════════

describe("writeGateResult", () => {
  test("writes correct gate result to workflow state", () => {
    const results = [
      { check: "acs-exist", result: "PASS" as const, detail: "3 ACs" },
      { check: "sizing", result: "PASS" as const, detail: "size=M" },
    ];
    const { resultVal, attempt } = writeGateResult(SF, "scope", 2, 0, 0, results);

    expect(resultVal).toBe("PASS");
    expect(attempt).toBe(1);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.gates.scope.result).toBe("PASS");
    expect(state.gates.scope.attempt).toBe(1);
    expect(state.gates.scope.failures).toEqual([]);
    expect(state.gates.scope.ts).toBeTruthy();
    expect(state.gates.scope.commitSha).toBeTruthy();
  });

  test("records failures when checks fail", () => {
    const results = [
      { check: "acs-exist", result: "FAIL" as const, detail: "no ACs" },
      { check: "sizing", result: "PASS" as const, detail: "size=M" },
    ];
    const { resultVal } = writeGateResult(SF, "scope", 1, 1, 0, results);

    expect(resultVal).toBe("FAIL");

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.gates.scope.result).toBe("FAIL");
    expect(state.gates.scope.failures).toHaveLength(1);
    expect(state.gates.scope.failures[0].check).toBe("acs-exist");
  });

  test("advances phase on PASS: scope->BUILD", () => {
    const results = [{ check: "acs-exist", result: "PASS" as const, detail: "ok" }];
    writeGateResult(SF, "scope", 1, 0, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("BUILD");
    expect(state.phaseTimings.BUILD).toHaveLength(1);
    expect(state.phaseTimings.BUILD[0].enteredTs).toBeTruthy();
  });

  test("advances phase on PASS: verify->SHIP", () => {
    writeFileSync(SF, JSON.stringify(makeState({ phase: "VERIFY" }), null, 2));
    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    writeGateResult(SF, "verify", 1, 0, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("SHIP");
  });

  test("advances phase on PASS: ship->DONE", () => {
    writeFileSync(SF, JSON.stringify(makeState({ phase: "SHIP" }), null, 2));
    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    writeGateResult(SF, "ship", 1, 0, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("DONE");
    expect(state.mergeCommitSha).toBeTruthy();
  });

  test("does NOT advance phase on FAIL", () => {
    const results = [{ check: "acs-exist", result: "FAIL" as const, detail: "none" }];
    writeGateResult(SF, "scope", 0, 1, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("SCOPE");
  });

  // #514 SC-1: Phase cannot advance to DONE when non-OUTCOME AC has verdict FAIL
  test("blocks ship→DONE when non-OUTCOME AC has FAIL verdict", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "SHIP",
      acs: [
        {
          id: "SC-1", type: "CODE",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "GREP_CHECK" },
          evidence: { type: "command-output", content: "false" },
          verdict: "FAIL",
        },
      ],
    }), null, 2));

    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    const { resultVal } = writeGateResult(SF, "ship", 1, 0, 0, results);

    expect(resultVal).toBe("FAIL");
    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).not.toBe("DONE");
  });

  test("blocks verify→SHIP when non-OUTCOME AC has FAIL verdict", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "VERIFY",
      acs: [
        {
          id: "SC-1", type: "CODE",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "GREP_CHECK" },
          evidence: { type: "command-output", content: "false" },
          verdict: "FAIL",
        },
      ],
    }), null, 2));

    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    const { resultVal } = writeGateResult(SF, "verify", 1, 0, 0, results);

    expect(resultVal).toBe("FAIL");
    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).not.toBe("SHIP");
  });

  test("allows ship→DONE when OUTCOME AC has FAIL (OUTCOME exemption)", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "SHIP",
      acs: [
        {
          id: "SC-1", type: "OUTCOME",
          statement: "batch completes with success message visible",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "PLAYWRIGHT" },
          evidence: null,
          verdict: "FAIL",
        },
      ],
    }), null, 2));

    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    const { resultVal } = writeGateResult(SF, "ship", 1, 0, 0, results);

    expect(resultVal).toBe("PASS");
    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("DONE");
  });

  test("allows advance when all ACs are PASS or SKIP", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "SHIP",
      acs: [
        {
          id: "SC-1", type: "CODE",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "GREP_CHECK", command: "echo true" },
          evidence: { type: "command-output", content: "true" },
          verdict: "PASS",
        },
        {
          id: "SC-2", type: "CODE",
          statement: "file includes the expected configuration value",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "FILE_EXISTS" },
          evidence: { type: "manual-attestation", content: "No command" },
          verdict: "SKIP",
        },
      ],
    }), null, 2));

    const results = [{ check: "all-pass", result: "PASS" as const, detail: "ok" }];
    const { resultVal } = writeGateResult(SF, "ship", 1, 0, 0, results);

    expect(resultVal).toBe("PASS");
    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("DONE");
  });

  // #514 SC-2: Ship gate failure resets phase to VERIFY
  test("ship gate FAIL resets phase to VERIFY", () => {
    writeFileSync(SF, JSON.stringify(makeState({ phase: "SHIP" }), null, 2));
    const results = [{ check: "code-committed", result: "FAIL" as const, detail: "not committed" }];
    writeGateResult(SF, "ship", 0, 1, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("VERIFY");
    const regression = state.changelog.find((e: any) => e.event === "ship-fail-regression");
    expect(regression).toBeTruthy();
  });

  test("increments attempt number", () => {
    const results = [{ check: "x", result: "FAIL" as const, detail: "d" }];
    writeGateResult(SF, "scope", 0, 1, 0, results);
    writeGateResult(SF, "scope", 0, 1, 0, results);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.gates.scope.attempt).toBe(2);
  });
});

// ═══ generateHmac ══════════════════════════════════════════════════════

describe("generateHmac", () => {
  test("computes hash and writes to workflow state", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "SHIP",
      gates: { ship: { result: "PASS", attempt: 1, failures: [], ts: "t" } },
    }), null, 2));

    const hash = generateHmac(SF, "test-orch", 432);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.gates.ship.hash).toBe(hash);
  });

  test("salt file has chmod 600", () => {
    const saltPath = join(process.env.HOME || "", ".claude", "hooks", "lib", ".gate-salt");
    generateHmac(SF, "test-orch", 432);

    const perms = statSync(saltPath).mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

// ═══ runConvergence ════════════════════════════════════════════════════

describe("runConvergence", () => {
  test("skips when gate != verify or result != FAIL", () => {
    const r1 = runConvergence(SF, "scope", "FAIL", PROFILE);
    expect(r1.action).toBe("skip");

    const r2 = runConvergence(SF, "verify", "PASS", PROFILE);
    expect(r2.action).toBe("skip");
  });

  test("fires circuit breaker at maxIterations", () => {
    const changelog = Array.from({ length: 4 }, (_, i) => ({
      ts: "t",
      event: "iteration-loopback",
      detail: `iteration ${i + 1}`,
      failureHash: `fail-${i}`,
      actor: "gate-runner",
    }));

    writeFileSync(SF, JSON.stringify(makeState({
      phase: "VERIFY",
      changelog,
      gates: { verify: { result: "FAIL", failures: [{ check: "x", result: "FAIL", detail: "d" }] } },
    }), null, 2));

    const result = runConvergence(SF, "verify", "FAIL", PROFILE);
    expect(result.action).toBe("circuit-break");
    expect(result.iteration).toBe(5);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("CIRCUIT_BREAK");
  });

  test("detects stall: same failureHash in consecutive iterations", () => {
    const changelog = [
      {
        ts: "t",
        event: "iteration-loopback",
        detail: "iteration 1",
        failureHash: "x",
        actor: "gate-runner",
      },
    ];

    writeFileSync(SF, JSON.stringify(makeState({
      phase: "VERIFY",
      changelog,
      gates: { verify: { result: "FAIL", failures: [{ check: "x", result: "FAIL", detail: "d" }] } },
    }), null, 2));

    const result = runConvergence(SF, "verify", "FAIL", PROFILE);
    expect(result.action).toBe("stall");

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    const councilEvents = state.changelog.filter((e: any) => e.event === "council-recommended");
    expect(councilEvents.length).toBe(1);
  });

  test("preserves read-before-append ordering", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "VERIFY",
      changelog: [],
      gates: { verify: { result: "FAIL", failures: [{ check: "a", result: "FAIL", detail: "d" }] } },
    }), null, 2));

    // First iteration — no previous hash to compare
    const r1 = runConvergence(SF, "verify", "FAIL", PROFILE);
    expect(r1.action).toBe("loop-back");

    // Second iteration with different failures — should NOT be stall
    const state2 = JSON.parse(readFileSync(SF, "utf-8"));
    state2.gates.verify.failures = [{ check: "b", result: "FAIL", detail: "d" }];
    writeFileSync(SF, JSON.stringify(state2, null, 2));

    const r2 = runConvergence(SF, "verify", "FAIL", PROFILE);
    expect(r2.action).toBe("loop-back");

    const finalState = JSON.parse(readFileSync(SF, "utf-8"));
    const loopbacks = finalState.changelog.filter((e: any) => e.event === "iteration-loopback");
    expect(loopbacks).toHaveLength(2);
    expect(loopbacks[0].failureHash).not.toBe(loopbacks[1].failureHash);
  });

  test("loops back to BUILD phase", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "VERIFY",
      gates: { verify: { result: "FAIL", failures: [{ check: "x", result: "FAIL", detail: "d" }] } },
    }), null, 2));

    runConvergence(SF, "verify", "FAIL", PROFILE);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("BUILD");
    expect(state.phaseTimings.BUILD).toHaveLength(1);
  });
});

// ═══ generateShipEvidence ══════════════════════════════════════════════

describe("generateShipEvidence", () => {
  test("writes valid ship-evidence.json", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "SHIP",
      acs: [
        {
          id: "SC-1",
          statement: "file exists on disk and is accessible",
          verdict: "PASS",
          evidence: { type: "file-citation", content: "found" },
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "FILE_EXISTS" },
        },
      ],
    }), null, 2));

    const path = generateShipEvidence(SF, TMP_DIR, 432, "", 1, 0, 0);

    expect(existsSync(path)).toBe(true);
    const evidence = JSON.parse(readFileSync(path, "utf-8"));
    expect(evidence.contractVersion).toBe("1.0");
    expect(evidence.issueNumber).toBe(432);
    expect(evidence.gateOut.status).toBe("PASS");
    expect(evidence.gateOut.evidence).toHaveLength(1);
    expect(evidence.mergeCommitSha).toBeTruthy();
    expect(evidence.capturedAt).toBeTruthy();
    expect(evidence.iterationCount).toBeGreaterThanOrEqual(1);
    expect(evidence.sizing.predicted).toBe("M");
  });
});

// ═══ writeGateSummary ══════════════════════════════════════════════════

describe("writeGateSummary", () => {
  test("writes gate-pending.json on FAIL", () => {
    const results = [
      { check: "acs-exist", result: "FAIL" as const, detail: "no ACs" },
    ];

    const outcome = writeGateSummary("scope", 0, 1, 0, results, 432, "test", "sess-1");

    expect(outcome).toBe("BLOCKED");
    expect(existsSync(PENDING)).toBe(true);

    const pending = JSON.parse(readFileSync(PENDING, "utf-8"));
    expect(pending.gate).toBe("scope");
    expect(pending.issue).toBe(432);
    expect(pending.failures).toHaveLength(1);
    expect(pending.failures[0].check).toBe("acs-exist");
    expect(pending.strike_count).toBe(0);
    expect(pending.max_strikes).toBe(3);
  });

  test("deletes gate-pending.json on PASS", () => {
    // Create a pending file first
    mkdirSync(join(process.env.HOME || "", ".claude", "MEMORY", "STATE"), { recursive: true });
    writeFileSync(PENDING, JSON.stringify({ gate: "old" }));
    expect(existsSync(PENDING)).toBe(true);

    const results = [
      { check: "acs-exist", result: "PASS" as const, detail: "3 ACs" },
    ];
    const outcome = writeGateSummary("scope", 1, 0, 0, results, 432, "test", "sess-1");

    expect(outcome).toBe("ALL CLEAR");
    expect(existsSync(PENDING)).toBe(false);
  });
});

// ═══ writeWorkflowState ══════════════════════════════════════════════════

describe("writeWorkflowState", () => {
  test("writes valid state to disk", () => {
    const state = makeState();
    writeWorkflowState(SF, state);
    const written = JSON.parse(readFileSync(SF, "utf-8"));
    expect(written.schemaVersion).toBe(2);
    expect(written.phase).toBe("SCOPE");
    expect(written.slug).toBe("test-orch");
  });

  test("throws on invalid phase enum", () => {
    const state = makeState({ phase: "INVALID_PHASE" });
    expect(() => writeWorkflowState(SF, state)).toThrow(/expected/i);
  });

  test("throws on invalid threshold op 'eq'", () => {
    const state = makeState({
      acs: [{
        id: "SC-1",
        statement: "test fixture validates gate behavior correctly",
        threshold: { op: "eq", value: "true" },
        evidenceMethod: { type: "GREP_CHECK" },
        evidence: null,
      }],
    });
    expect(() => writeWorkflowState(SF, state)).toThrow(/expected/i);
  });

  test("error message includes valid enum values", () => {
    const state = makeState({ phase: "BOGUS" });
    try {
      writeWorkflowState(SF, state);
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("GOAL");
      expect(err.message).toContain("BUILD");
      expect(err.message).toContain("VERIFY");
    }
  });

  test("passes through extra fields via passthrough()", () => {
    const state = { ...makeState(), customField: "preserved" };
    writeWorkflowState(SF, state);
    const written = JSON.parse(readFileSync(SF, "utf-8"));
    expect(written.customField).toBe("preserved");
  });
});

// ═══ initWorkflow ════════════════════════════════════════════════════════

describe("initWorkflow", () => {
  test("creates workflow-state.json with correct initial structure", () => {
    const target = join(TMP_DIR, "sub", "workflow-state.json");
    initWorkflow(target, {
      issue: 453,
      repo: "hornjason/pai-config",
      projectRoot: "/tmp/test",
      slug: "write-time-validation",
      issueGoal: "Add Zod write-time validation",
    });

    expect(existsSync(target)).toBe(true);
    const state = JSON.parse(readFileSync(target, "utf-8"));
    expect(state.schemaVersion).toBe(2);
    expect(state.phase).toBe("GOAL");
    expect(state.acs).toEqual([]);
    expect(state.gates).toEqual({});
    expect(state.changelog).toEqual([]);
    expect(state.issue).toBe(453);
    expect(state.slug).toBe("write-time-validation");
    expect(state.issueGoal).toBe("Add Zod write-time validation");
  });

  test("sets issueRepo to opts.issueRepo when provided", () => {
    const target = join(TMP_DIR, "init-test-1.json");
    initWorkflow(target, {
      issue: 453,
      repo: "hornjason/pai-config",
      issueRepo: "hornjason/asaCommandCenter",
      projectRoot: "/tmp/test",
      slug: "test",
      issueGoal: "test goal",
    });

    const state = JSON.parse(readFileSync(target, "utf-8"));
    expect(state.issueRepo).toBe("hornjason/asaCommandCenter");
  });

  test("defaults issueRepo to opts.repo when not provided", () => {
    const target = join(TMP_DIR, "init-test-2.json");
    initWorkflow(target, {
      issue: 453,
      repo: "hornjason/pai-config",
      projectRoot: "/tmp/test",
      slug: "test",
      issueGoal: "test goal",
    });

    const state = JSON.parse(readFileSync(target, "utf-8"));
    expect(state.issueRepo).toBe("hornjason/pai-config");
  });

  test("creates parent directory if it doesn't exist", () => {
    const target = join(TMP_DIR, "deep", "nested", "dir", "workflow-state.json");
    initWorkflow(target, {
      issue: 453,
      repo: "hornjason/pai-config",
      projectRoot: "/tmp/test",
      slug: "test",
      issueGoal: "test goal",
    });

    expect(existsSync(target)).toBe(true);
  });

  test("includes optional fields when provided", () => {
    const target = join(TMP_DIR, "init-opts.json");
    initWorkflow(target, {
      issue: 453,
      repo: "hornjason/pai-config",
      projectRoot: "/tmp/test",
      slug: "test",
      issueGoal: "test goal",
      sizing: { predicted: "M", ceremonyTier: "STANDARD" },
      sourceSpecs: [{ path: "spec.md", citedInDiscovery: true }],
      bootstrappedFrom: "session-abc",
    });

    const state = JSON.parse(readFileSync(target, "utf-8"));
    expect(state.sizing.predicted).toBe("M");
    expect(state.sourceSpecs).toHaveLength(1);
    expect(state.bootstrappedFrom).toBe("session-abc");
  });
});

// ═══ writeACs ════════════════════════════════════════════════════════════

describe("writeACs", () => {
  test("writes ACs with evidence null and verdict PENDING", () => {
    writeFileSync(SF, JSON.stringify(makeState(), null, 2));
    writeACs(SF, [
      {
        id: "SC-1",
        type: "CODE",
        statement: "writeWorkflowState function exists and is callable",
        threshold: { op: "==", value: "true" },
        evidenceMethod: { type: "GREP_CHECK" },
      },
      {
        id: "SC-2",
        type: "OUTCOME",
        statement: "invalid enum value throws validation error",
        threshold: { op: ">=", value: "2" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ]);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.acs).toHaveLength(2);
    expect(state.acs[0].evidence).toBeNull();
    expect(state.acs[0].verdict).toBe("PENDING");
    expect(state.acs[1].evidence).toBeNull();
    expect(state.acs[1].verdict).toBe("PENDING");
  });

  test("throws on invalid AC type enum", () => {
    writeFileSync(SF, JSON.stringify(makeState(), null, 2));
    expect(() => writeACs(SF, [
      {
        id: "SC-1",
        type: "INVALID_TYPE" as any,
        statement: "test fixture validates gate behavior correctly",
        threshold: { op: "==", value: "true" },
        evidenceMethod: { type: "GREP_CHECK" },
      },
    ])).toThrow();
  });

  test("throws on invalid threshold op", () => {
    writeFileSync(SF, JSON.stringify(makeState(), null, 2));
    expect(() => writeACs(SF, [
      {
        id: "SC-1",
        statement: "test fixture validates gate behavior correctly",
        threshold: { op: "eq" as any, value: "true" },
        evidenceMethod: { type: "GREP_CHECK" },
      },
    ])).toThrow();
  });

  test("preserves existing state fields", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      phase: "BUILD",
      gates: { scope: { result: "PASS", attempt: 1 } },
    }), null, 2));

    writeACs(SF, [
      {
        id: "SC-1",
        statement: "test fixture validates gate behavior correctly",
        threshold: { op: "==", value: "true" },
        evidenceMethod: { type: "GREP_CHECK" },
      },
    ]);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.phase).toBe("BUILD");
    expect(state.gates.scope.result).toBe("PASS");
    expect(state.acs).toHaveLength(1);
  });
});

// ═══ AFK Batch Plan (#468) ═══════════════════════════════════════════

describe("initBatchPlan", () => {
  test("creates valid afk-batch.json with planned issues", () => {
    const batchDir = join(TMP_DIR, "batch");
    initBatchPlan(batchDir, [100, 101, 102]);

    const fp = join(batchDir, "afk-batch.json");
    expect(existsSync(fp)).toBe(true);

    const plan = JSON.parse(readFileSync(fp, "utf-8"));
    expect(plan.planned).toEqual([100, 101, 102]);
    expect(plan.shipped).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.inProgress).toBeNull();
    expect(plan.approvedAt).toBeTruthy();
  });

  test("creates parent directory if needed", () => {
    const batchDir = join(TMP_DIR, "deep", "nested", "batch");
    initBatchPlan(batchDir, [200]);

    expect(existsSync(join(batchDir, "afk-batch.json"))).toBe(true);
  });
});

describe("recordBatchShipped", () => {
  test("moves issue to shipped array", () => {
    const batchDir = join(TMP_DIR, "batch-ship");
    initBatchPlan(batchDir, [100, 101, 102]);
    recordBatchShipped(batchDir, 100);

    const plan = JSON.parse(readFileSync(join(batchDir, "afk-batch.json"), "utf-8"));
    expect(plan.shipped).toEqual([100]);
    expect(plan.planned).toEqual([100, 101, 102]);
  });

  test("does not duplicate if called twice", () => {
    const batchDir = join(TMP_DIR, "batch-ship-dup");
    initBatchPlan(batchDir, [100]);
    recordBatchShipped(batchDir, 100);
    recordBatchShipped(batchDir, 100);

    const plan = JSON.parse(readFileSync(join(batchDir, "afk-batch.json"), "utf-8"));
    expect(plan.shipped).toEqual([100]);
  });

  test("clears inProgress when shipped issue matches", () => {
    const batchDir = join(TMP_DIR, "batch-ship-ip");
    initBatchPlan(batchDir, [100, 101]);

    // Manually set inProgress
    const fp = join(batchDir, "afk-batch.json");
    const plan = JSON.parse(readFileSync(fp, "utf-8"));
    plan.inProgress = 100;
    writeFileSync(fp, JSON.stringify(plan, null, 2));

    recordBatchShipped(batchDir, 100);

    const updated = JSON.parse(readFileSync(fp, "utf-8"));
    expect(updated.inProgress).toBeNull();
  });
});

describe("recordBatchSkipped", () => {
  test("rejects 'needs investigation' as skip reason", () => {
    const batchDir = join(TMP_DIR, "batch-skip-reject");
    initBatchPlan(batchDir, [100]);

    expect(() => recordBatchSkipped(batchDir, 100, "needs investigation")).toThrow(/Rejected skip reason/);
  });

  test("rejects 'needs browser testing' as skip reason", () => {
    const batchDir = join(TMP_DIR, "batch-skip-reject2");
    initBatchPlan(batchDir, [100]);

    expect(() => recordBatchSkipped(batchDir, 100, "needs browser testing")).toThrow(/Rejected skip reason/);
  });

  test("rejects 'can't do from here' as skip reason", () => {
    const batchDir = join(TMP_DIR, "batch-skip-reject3");
    initBatchPlan(batchDir, [100]);

    expect(() => recordBatchSkipped(batchDir, 100, "can't do from here")).toThrow(/Rejected skip reason/);
  });

  test("accepts valid skip reason with delegation action", () => {
    const batchDir = join(TMP_DIR, "batch-skip-valid");
    initBatchPlan(batchDir, [100, 101]);

    recordBatchSkipped(batchDir, 100, "spawned Quinn, awaiting results", "Quinn QA pass pending");

    const plan = JSON.parse(readFileSync(join(batchDir, "afk-batch.json"), "utf-8"));
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].issue).toBe(100);
    expect(plan.skipped[0].reason).toBe("spawned Quinn, awaiting results");
    expect(plan.skipped[0].delegationAction).toBe("Quinn QA pass pending");
  });

  test("accepts 'closed as by-design with evidence' as skip reason", () => {
    const batchDir = join(TMP_DIR, "batch-skip-bydesign");
    initBatchPlan(batchDir, [100]);

    recordBatchSkipped(batchDir, 100, "closed as by-design with evidence");

    const plan = JSON.parse(readFileSync(join(batchDir, "afk-batch.json"), "utf-8"));
    expect(plan.skipped).toHaveLength(1);
  });

  test("clears inProgress when skipped issue matches", () => {
    const batchDir = join(TMP_DIR, "batch-skip-ip");
    initBatchPlan(batchDir, [100]);

    const fp = join(batchDir, "afk-batch.json");
    const plan = JSON.parse(readFileSync(fp, "utf-8"));
    plan.inProgress = 100;
    writeFileSync(fp, JSON.stringify(plan, null, 2));

    recordBatchSkipped(batchDir, 100, "closed as by-design with evidence");

    const updated = JSON.parse(readFileSync(fp, "utf-8"));
    expect(updated.inProgress).toBeNull();
  });
});

describe("validateBatchComplete", () => {
  test("returns complete when all planned issues are shipped", () => {
    const batchDir = join(TMP_DIR, "batch-complete");
    initBatchPlan(batchDir, [100, 101, 102]);
    recordBatchShipped(batchDir, 100);
    recordBatchShipped(batchDir, 101);
    recordBatchShipped(batchDir, 102);

    const result = validateBatchComplete(batchDir);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("returns complete when mix of shipped and skipped covers all planned", () => {
    const batchDir = join(TMP_DIR, "batch-complete-mix");
    initBatchPlan(batchDir, [100, 101, 102]);
    recordBatchShipped(batchDir, 100);
    recordBatchShipped(batchDir, 101);
    recordBatchSkipped(batchDir, 102, "closed as by-design with evidence");

    const result = validateBatchComplete(batchDir);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("returns incomplete with missing issues", () => {
    const batchDir = join(TMP_DIR, "batch-incomplete");
    initBatchPlan(batchDir, [100, 101, 102]);
    recordBatchShipped(batchDir, 100);

    const result = validateBatchComplete(batchDir);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([101, 102]);
  });

  test("returns complete for empty plan", () => {
    const batchDir = join(TMP_DIR, "batch-empty");
    initBatchPlan(batchDir, []);

    const result = validateBatchComplete(batchDir);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

// ═══ markCommandlessACsAsSkip (#513) ══════════════════════════════════

describe("markCommandlessACsAsSkip", () => {
  test("marks ACs without evidenceMethod.command as SKIP", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      acs: [
        {
          id: "SC-1",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "FILE_EXISTS" },
          evidence: null,
          verdict: "PENDING",
        },
      ],
    }), null, 2));

    const count = markCommandlessACsAsSkip(SF);
    expect(count).toBe(1);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.acs[0].verdict).toBe("SKIP");
    expect(state.acs[0].evidence.content).toContain("No evidenceMethod.command");
  });

  test("does not touch ACs with a command", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      acs: [
        {
          id: "SC-1",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "COMMAND", command: "echo true" },
          evidence: null,
          verdict: "PENDING",
        },
      ],
    }), null, 2));

    const count = markCommandlessACsAsSkip(SF);
    expect(count).toBe(0);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.acs[0].verdict).toBe("PENDING");
  });

  test("skips ACs that already have non-PENDING verdict", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      acs: [
        {
          id: "SC-1",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "FILE_EXISTS" },
          evidence: { type: "command-output", content: "true" },
          verdict: "PASS",
        },
      ],
    }), null, 2));

    const count = markCommandlessACsAsSkip(SF);
    expect(count).toBe(0);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.acs[0].verdict).toBe("PASS");
  });

  test("handles mixed ACs — only marks commandless PENDING ones", () => {
    writeFileSync(SF, JSON.stringify(makeState({
      acs: [
        {
          id: "SC-1",
          statement: "function exists and is callable from CLI",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "COMMAND", command: "echo true" },
          evidence: null,
          verdict: "PENDING",
        },
        {
          id: "SC-2",
          statement: "file includes the expected configuration value",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "FILE_EXISTS" },
          evidence: null,
          verdict: "PENDING",
        },
        {
          id: "SC-3",
          statement: "output matches the expected formatting pattern",
          threshold: { op: "==", value: "true" },
          evidenceMethod: { type: "COMMAND", command: "echo true" },
          evidence: { type: "command-output", content: "true" },
          verdict: "PASS",
        },
      ],
    }), null, 2));

    const count = markCommandlessACsAsSkip(SF);
    expect(count).toBe(1);

    const state = JSON.parse(readFileSync(SF, "utf-8"));
    expect(state.acs[0].verdict).toBe("PENDING");
    expect(state.acs[1].verdict).toBe("SKIP");
    expect(state.acs[2].verdict).toBe("PASS");
  });
});
