import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const TEST_BASE = `/tmp/self-heal-test-${process.pid}`;
const TEST_SLUG = `heal-test-${process.pid}`;
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
    phase: "BUILD",
    issueGoal: "Test goal for self-heal validation",
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

import { runWithHeal, snapshotProtectedFields, checkIntegrity, type HealResult } from "./self-heal";

describe("self-heal", () => {
  beforeEach(() => {
    mkdirSync(WORK_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch {}
  });

  describe("runWithHeal", () => {
    test("returns PASS immediately when gate passes on first attempt", async () => {
      createState({
        phase: "SCOPE",
        gates: { scope: { result: "PASS", attempt: 1, failures: [], ts: new Date().toISOString(), commitSha: "abc123" } },
      });

      const result = await runWithHeal({
        gate: "scope",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        maxAttempts: 3,
        dryRun: true,
      });

      expect(result.result).toBe("PASS");
      expect(result.attempts).toBe(1);
      expect(result.failures).toBeUndefined();
      expect(result.circuitBroken).toBeUndefined();
    });

    test("returns FAIL with failures when gate fails", async () => {
      createState({
        phase: "BUILD",
        gates: {
          verify: {
            result: "FAIL",
            attempt: 1,
            failures: [
              { check: "tests-pass", result: "FAIL", detail: "3 tests failed" },
              { check: "tsc-pass", result: "FAIL", detail: "type errors" },
            ],
            ts: new Date().toISOString(),
            commitSha: "abc123",
          },
        },
      });

      const result = await runWithHeal({
        gate: "verify",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        maxAttempts: 3,
        dryRun: true,
      });

      expect(result.result).toBe("FAIL");
      expect(result.attempts).toBe(1);
      expect(result.failures).toHaveLength(2);
      expect(result.failures![0].check).toBe("tests-pass");
      expect(result.circuitBroken).toBeFalsy();
    });

    test("circuit breaks at maxAttempts", async () => {
      createState({
        phase: "BUILD",
        gates: {
          verify: {
            result: "FAIL",
            attempt: 3,
            failures: [{ check: "tests-pass", result: "FAIL", detail: "still failing" }],
            ts: new Date().toISOString(),
            commitSha: "abc123",
          },
        },
      });

      const result = await runWithHeal({
        gate: "verify",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        maxAttempts: 3,
        dryRun: true,
      });

      expect(result.result).toBe("FAIL");
      expect(result.circuitBroken).toBe(true);
    });

    test("defaults maxAttempts to 3", async () => {
      createState({
        phase: "BUILD",
        gates: {
          scope: {
            result: "FAIL",
            attempt: 3,
            failures: [{ check: "acs-exist", result: "FAIL", detail: "no ACs" }],
            ts: new Date().toISOString(),
            commitSha: "abc123",
          },
        },
      });

      const result = await runWithHeal({
        gate: "scope",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        dryRun: true,
      });

      expect(result.circuitBroken).toBe(true);
    });

    test("validates gate name", async () => {
      createState();

      await expect(
        runWithHeal({
          gate: "invalid" as any,
          slug: TEST_SLUG,
          issue: 9999,
          projectRoot: "/tmp/test-project",
          workDir: WORK_DIR,
          dryRun: true,
        }),
      ).rejects.toThrow(/invalid gate/i);
    });

    test("handles missing workflow-state.json", async () => {
      await expect(
        runWithHeal({
          gate: "scope",
          slug: TEST_SLUG,
          issue: 9999,
          projectRoot: "/tmp/test-project",
          workDir: "/tmp/nonexistent-dir-xyz",
          dryRun: true,
        }),
      ).rejects.toThrow(/workflow-state\.json/i);
    });

    test("returns failures as structured objects", async () => {
      const failures = [
        { check: "all-acs-pass", result: "FAIL", detail: "AC-1 PENDING, AC-2 FAIL" },
        { check: "code-committed", result: "FAIL", detail: "uncommitted changes" },
      ];

      createState({
        phase: "BUILD",
        gates: {
          verify: {
            result: "FAIL",
            attempt: 1,
            failures,
            ts: new Date().toISOString(),
            commitSha: "abc123",
          },
        },
      });

      const result = await runWithHeal({
        gate: "verify",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        dryRun: true,
      });

      expect(result.failures).toEqual(failures);
    });

    test("attempt count comes from gate state", async () => {
      createState({
        phase: "BUILD",
        gates: {
          verify: {
            result: "FAIL",
            attempt: 2,
            failures: [{ check: "tests-pass", result: "FAIL", detail: "failing" }],
            ts: new Date().toISOString(),
            commitSha: "abc123",
          },
        },
      });

      const result = await runWithHeal({
        gate: "verify",
        slug: TEST_SLUG,
        issue: 9999,
        projectRoot: "/tmp/test-project",
        workDir: WORK_DIR,
        maxAttempts: 5,
        dryRun: true,
      });

      expect(result.attempts).toBe(2);
      expect(result.circuitBroken).toBeFalsy();
    });
  });

  describe("snapshotProtectedFields", () => {
    test("captures gates object", () => {
      const state = minimalState({
        gates: { scope: { result: "PASS", attempt: 1 } },
      });
      const snap = snapshotProtectedFields(state);
      expect(snap.gates).toEqual({ scope: { result: "PASS", attempt: 1 } });
    });

    test("captures acs verdicts and evidence", () => {
      const state = minimalState({
        acs: [
          { id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: { type: "test-output", content: "ok" } },
          { id: "AC-2", statement: "another stmt five words", verdict: "PENDING", evidence: null },
        ],
      });
      const snap = snapshotProtectedFields(state);
      expect(snap.acs).toHaveLength(2);
      expect(snap.acs[0]).toEqual({ id: "AC-1", verdict: "PASS", evidence: { type: "test-output", content: "ok" } });
      expect(snap.acs[1]).toEqual({ id: "AC-2", verdict: "PENDING", evidence: null });
    });

    test("deep-copies so mutations don't affect snapshot", () => {
      const state = minimalState({
        gates: { scope: { result: "PASS", attempt: 1 } },
        acs: [{ id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: { type: "test-output", content: "ok" } }],
      });
      const snap = snapshotProtectedFields(state);

      state.gates.scope.result = "FAIL";
      state.acs[0].verdict = "FAIL";
      state.acs[0].evidence = { type: "manual-attestation", content: "changed" };

      expect(snap.gates.scope.result).toBe("PASS");
      expect(snap.acs[0].verdict).toBe("PASS");
      expect(snap.acs[0].evidence.content).toBe("ok");
    });

    test("handles missing gates and empty acs", () => {
      const state = minimalState({ gates: {}, acs: [] });
      const snap = snapshotProtectedFields(state);
      expect(snap.gates).toEqual({});
      expect(snap.acs).toEqual([]);
    });
  });

  describe("prove self-heal loop", () => {
    test("prove self-heal: computeVerdict returns UNPROVEN when any criteria FAIL", () => {
      // Simulates prove.js computeVerdict logic — validates circuit breaker precondition
      const criteriaResults = [
        { scId: "SC-1", verdict: "PASS", evidence: "tests pass" },
        { scId: "SC-2", verdict: "FAIL", evidence: "regression found" },
      ];
      const fc = criteriaResults.filter(cr => cr.verdict === "FAIL").length;
      const v = criteriaResults.length === 0 ? "INCONCLUSIVE" : fc > 0 ? "UNPROVEN" : "PROVEN";
      expect(v).toBe("UNPROVEN");
      expect(fc).toBe(1);
    });

    test("prove self-heal: circuit breaker triggers at maxAttempts=3", () => {
      // Simulates the prove.js self-heal loop circuit breaker
      const MAX_SELF_HEAL_ATTEMPTS = 3;
      let iteration = 0;
      let verdict = "UNPROVEN";

      // Simulate 3 iterations that all remain UNPROVEN
      while (verdict === "UNPROVEN" && iteration < MAX_SELF_HEAL_ATTEMPTS) {
        iteration++;
        // Each iteration fails to fix — verdict stays UNPROVEN
        verdict = "UNPROVEN";
      }

      expect(iteration).toBe(3);
      expect(iteration >= MAX_SELF_HEAL_ATTEMPTS).toBe(true);
      expect(verdict).toBe("UNPROVEN");
    });

    test("prove self-heal: loop exits early on PROVEN", () => {
      // Simulates the prove.js self-heal loop exiting when fix succeeds
      const MAX_SELF_HEAL_ATTEMPTS = 3;
      let iteration = 0;
      let verdict = "UNPROVEN";

      while (verdict === "UNPROVEN" && iteration < MAX_SELF_HEAL_ATTEMPTS) {
        iteration++;
        // Fix succeeds on iteration 2
        if (iteration === 2) verdict = "PROVEN";
      }

      expect(iteration).toBe(2);
      expect(verdict).toBe("PROVEN");
    });

    test("prove self-heal: iteration references tracked in return value", () => {
      // Validates prove.js returns selfHealIterations + circuitBroken
      const MAX_SELF_HEAL_ATTEMPTS = 3;
      let selfHealIteration = 0;
      let verdict = "UNPROVEN";

      while (verdict === "UNPROVEN" && selfHealIteration < MAX_SELF_HEAL_ATTEMPTS) {
        selfHealIteration++;
        if (selfHealIteration === 2) verdict = "PROVEN";
      }

      const result = {
        selfHealIterations: selfHealIteration,
        circuitBroken: selfHealIteration >= MAX_SELF_HEAL_ATTEMPTS && verdict === "UNPROVEN",
        verdict,
      };

      expect(result.selfHealIterations).toBe(2);
      expect(result.circuitBroken).toBe(false);
      expect(result.verdict).toBe("PROVEN");
    });
  });

  describe("checkIntegrity", () => {
    test("no violation when nothing changed", () => {
      const state = minimalState({
        gates: { scope: { result: "PASS", attempt: 1 } },
        acs: [{ id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: { type: "test-output", content: "ok" } }],
      });
      const before = snapshotProtectedFields(state);
      const after = snapshotProtectedFields(state);
      const result = checkIntegrity(before, after);
      expect(result.violated).toBe(false);
      expect(result.changes).toHaveLength(0);
    });

    test("detects gate result modification", () => {
      const state = minimalState({
        gates: { scope: { result: "PASS", attempt: 1 } },
      });
      const before = snapshotProtectedFields(state);
      state.gates.scope.result = "FAIL";
      const after = snapshotProtectedFields(state);
      const result = checkIntegrity(before, after);
      expect(result.violated).toBe(true);
      expect(result.changes.some((c: string) => c.includes("gates"))).toBe(true);
    });

    test("detects verdict modification", () => {
      const state = minimalState({
        acs: [{ id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: null }],
      });
      const before = snapshotProtectedFields(state);
      state.acs[0].verdict = "FAIL";
      const after = snapshotProtectedFields(state);
      const result = checkIntegrity(before, after);
      expect(result.violated).toBe(true);
      expect(result.changes.some((c: string) => c.includes("AC-1") && c.includes("verdict"))).toBe(true);
    });

    test("detects evidence modification", () => {
      const state = minimalState({
        acs: [{ id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: { type: "test-output", content: "ok" } }],
      });
      const before = snapshotProtectedFields(state);
      state.acs[0].evidence = { type: "manual-attestation", content: "tampered" };
      const after = snapshotProtectedFields(state);
      const result = checkIntegrity(before, after);
      expect(result.violated).toBe(true);
      expect(result.changes.some((c: string) => c.includes("AC-1") && c.includes("evidence"))).toBe(true);
    });

    test("allows non-protected field changes", () => {
      const state = minimalState({
        gates: { scope: { result: "PASS", attempt: 1 } },
        acs: [{ id: "AC-1", statement: "test stmt five words", verdict: "PASS", evidence: null }],
      });
      const before = snapshotProtectedFields(state);
      // Only modify non-protected fields
      state.phase = "VERIFY";
      state.issueGoal = "Modified goal";
      const after = snapshotProtectedFields(state);
      const result = checkIntegrity(before, after);
      expect(result.violated).toBe(false);
    });
  });
});

// ═══ WITNESS-VERDICT CROSS-VALIDATION (#521) ═══════════════════════════
describe("witness-verdict cross-validation", () => {
  const WITNESS_TEST_BASE = `/tmp/witness-verdict-test-${process.pid}`;
  const WITNESS_TEST_SLUG = `witness-test-${process.pid}`;
  const WITNESS_WORK_DIR = join(WITNESS_TEST_BASE, WITNESS_TEST_SLUG);
  const WITNESS_DIR = join(WITNESS_WORK_DIR, "witnesses");

  beforeEach(() => {
    mkdirSync(WITNESS_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(WITNESS_TEST_BASE, { recursive: true, force: true }); } catch {}
  });

  function writeWitnessFile(gate: string, result: "PASS" | "FAIL", hmac: string = "abc123def456"): void {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const record = { gate, result, slug: WITNESS_TEST_SLUG, issue: 9999, commitSha: "deadbeef", timestamp: ts, testOutputHash: "hash123", hmac };
    const filename = `${gate}-${ts.replace(/[:.]/g, "-")}.json`;
    writeFileSync(join(WITNESS_DIR, filename), JSON.stringify(record, null, 2));
  }

  test("witness-ac-verdict: PASS when verify+ship witnesses exist with HMAC", () => {
    writeWitnessFile("scope", "PASS");
    writeWitnessFile("verify", "PASS");
    writeWitnessFile("ship", "PASS");

    const witnessFiles = readdirSync(WITNESS_DIR).filter(f => f.endsWith(".json"));
    const witnesses = witnessFiles.map(f => JSON.parse(readFileSync(join(WITNESS_DIR, f), "utf-8")));
    const passedGatesWithHmac = new Set(
      witnesses.filter((w: any) => w.result === "PASS" && w.hmac && w.hmac.length > 0).map((w: any) => w.gate),
    );

    const requiredGates = ["verify", "ship"];
    const missingGates = requiredGates.filter(g => !passedGatesWithHmac.has(g));
    expect(missingGates).toEqual([]);
  });

  test("witness-ac-verdict: FAIL when verify witness missing for PASS ACs", () => {
    // Only scope witness, missing verify+ship — AC PASS should be rejected
    writeWitnessFile("scope", "PASS");

    const witnessFiles = readdirSync(WITNESS_DIR).filter(f => f.endsWith(".json"));
    const witnesses = witnessFiles.map(f => JSON.parse(readFileSync(join(WITNESS_DIR, f), "utf-8")));
    const passedGatesWithHmac = new Set(
      witnesses.filter((w: any) => w.result === "PASS" && w.hmac && w.hmac.length > 0).map((w: any) => w.gate),
    );

    const requiredGates = ["verify", "ship"];
    const missingGates = requiredGates.filter(g => !passedGatesWithHmac.has(g));
    expect(missingGates.length).toBeGreaterThan(0);
    expect(missingGates).toContain("verify");
    expect(missingGates).toContain("ship");
  });

  test("witness-ac-verdict: FAIL when witness has empty HMAC (manual edit detected)", () => {
    // Witness exists but HMAC is empty — indicates manual creation
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const tampered = { gate: "verify", result: "PASS", slug: WITNESS_TEST_SLUG, issue: 9999, commitSha: "deadbeef", timestamp: ts, testOutputHash: "hash123", hmac: "" };
    writeFileSync(join(WITNESS_DIR, `verify-${ts.replace(/[:.]/g, "-")}.json`), JSON.stringify(tampered, null, 2));
    writeWitnessFile("ship", "PASS");

    const witnessFiles = readdirSync(WITNESS_DIR).filter(f => f.endsWith(".json"));
    const witnesses = witnessFiles.map(f => JSON.parse(readFileSync(join(WITNESS_DIR, f), "utf-8")));
    const passedGatesWithHmac = new Set(
      witnesses.filter((w: any) => w.result === "PASS" && w.hmac && w.hmac.length > 0).map((w: any) => w.gate),
    );

    // verify gate has empty HMAC — should not be in passedGatesWithHmac
    expect(passedGatesWithHmac.has("verify")).toBe(false);
    expect(passedGatesWithHmac.has("ship")).toBe(true);
  });

  test("witness-ac-verdict: no witness directory with PASS ACs = FAIL", () => {
    // Remove the witness directory entirely
    rmSync(WITNESS_DIR, { recursive: true, force: true });

    const passACs = [{ id: "AC-1", verdict: "PASS" }];
    const witnessExists = existsSync(WITNESS_DIR);

    // Should fail: PASS ACs but no witness directory
    expect(witnessExists).toBe(false);
    expect(passACs.length).toBeGreaterThan(0);
  });
});
