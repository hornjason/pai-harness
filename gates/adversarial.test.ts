import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { writeWitness, verifyWitness, verifyWitnessChain } from "./witness";

// HOME_DIR is set so workDir resolves correctly via RUNGATE_WORK_DIR
const HOME_DIR = `/tmp/adversarial-home-${process.pid}`;
const SLUG = "adversarial-test";
const WORK_DIR = join(HOME_DIR, ".rungate", SLUG);
const WITNESS_DIR = join(WORK_DIR, "witnesses");

const origHome = process.env.HOME;
const origRungateWorkDir = process.env.RUNGATE_WORK_DIR;

beforeEach(() => {
  mkdirSync(WITNESS_DIR, { recursive: true });
  // Copy gate salt into test HOME so HMAC functions work
  const saltSrc = join(origHome!, ".claude", "hooks", "lib", ".gate-salt");
  const saltDst = join(HOME_DIR, ".claude", "hooks", "lib", ".gate-salt");
  mkdirSync(join(HOME_DIR, ".claude", "hooks", "lib"), { recursive: true });
  if (existsSync(saltSrc)) {
    writeFileSync(saltDst, readFileSync(saltSrc));
  }
  process.env.HOME = HOME_DIR;
  delete process.env.RUNGATE_WORK_DIR;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origRungateWorkDir !== undefined) process.env.RUNGATE_WORK_DIR = origRungateWorkDir;
  else delete process.env.RUNGATE_WORK_DIR;
  try { rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
});

// ── Helper: create a properly-signed witness file ───────────────────

function createSignedWitness(
  gate: string,
  result: "PASS" | "FAIL",
  commitSha: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  // Use the real writeWitness path by writing directly with known salt
  const saltPath = join(origHome!, ".claude", "hooks", "lib", ".gate-salt");
  const salt = readFileSync(saltPath, "utf-8").trim();
  const { createHmac } = require("crypto");

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const testOutputHash = createHmac("sha256", "test-output")
    .update("test output")
    .digest("hex")
    .slice(0, 16);

  const record: Record<string, unknown> = {
    gate,
    result,
    slug: SLUG,
    issue: 471,
    commitSha,
    timestamp: ts,
    testOutputHash,
    ...overrides,
  };

  const input = [
    record.gate,
    record.result,
    record.slug,
    record.issue,
    record.commitSha,
    record.timestamp,
    record.testOutputHash,
  ].join(":");
  const hmac = createHmac("sha256", salt).update(input).digest("hex").slice(0, 16);
  record.hmac = hmac;

  const filename = `${gate}-${ts.replace(/[:.]/g, "-")}.json`;
  const witnessPath = join(WITNESS_DIR, filename);
  writeFileSync(witnessPath, JSON.stringify(record, null, 2) + "\n");
  return witnessPath;
}

function createForgedWitness(
  gate: string,
  result: "PASS" | "FAIL",
  commitSha: string,
): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const record = {
    gate,
    result,
    slug: SLUG,
    issue: 471,
    commitSha,
    timestamp: ts,
    testOutputHash: "forged-hash-value",
    hmac: "aaaa1111bbbb2222", // forged HMAC
  };

  const filename = `${gate}-${ts.replace(/[:.]/g, "-")}.json`;
  const witnessPath = join(WITNESS_DIR, filename);
  writeFileSync(witnessPath, JSON.stringify(record, null, 2) + "\n");
  return witnessPath;
}

// ── Test 1: Write protection — blocks direct gate result writes ─────

describe("adversarial-write-protection", () => {
  test("detects gate result fields in workflow-state.json content", () => {
    // Simulate what GateResultProtection.hook.ts checks:
    // Parse JSON content for gate result fields
    const blockedContent = JSON.stringify({
      phase: "BUILD",
      gates: {
        scope: { result: "PASS", attempt: 1 },
      },
    });

    // Check: does content contain gate result fields?
    const parsed = JSON.parse(blockedContent);
    const hasGateResult =
      parsed.gates?.scope?.result ||
      parsed.gates?.verify?.result ||
      parsed.gates?.ship?.result;
    const hasDonePhase = parsed.phase === "DONE";

    expect(hasGateResult).toBeTruthy();
    expect(hasDonePhase).toBe(false);
  });

  test("allows non-gate-field writes to workflow-state.json", () => {
    const allowedContent = JSON.stringify({
      phase: "BUILD",
      acs: [{ id: "SC-1", statement: "test" }],
      changelog: [{ ts: "2026-09-10", event: "ac-added" }],
    });

    const parsed = JSON.parse(allowedContent);
    const hasGateResult =
      parsed.gates?.scope?.result ||
      parsed.gates?.verify?.result ||
      parsed.gates?.ship?.result;
    const hasDonePhase = parsed.phase === "DONE";

    expect(hasGateResult).toBeFalsy();
    expect(hasDonePhase).toBe(false);
  });

  test("detects DONE phase as blocked", () => {
    const blockedContent = JSON.stringify({ phase: "DONE" });
    const parsed = JSON.parse(blockedContent);
    expect(parsed.phase === "DONE").toBe(true);
  });

  test("detects gate result in Edit new_string", () => {
    // Simulates Edit tool — check if new_string contains gate result patterns
    const editNewString = '"result": "PASS"';
    const blocked =
      editNewString.includes('"result": "PASS"') ||
      editNewString.includes('"result": "FAIL"') ||
      editNewString.includes('"phase": "DONE"');

    expect(blocked).toBe(true);
  });
});

// ── Test 2: HMAC forgery — rejects witness without valid HMAC ───────

describe("adversarial-hmac-forgery", () => {
  test("rejects witness with forged HMAC", () => {
    const forgedPath = createForgedWitness("scope", "PASS", "abc123");
    const result = verifyWitness(forgedPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("HMAC mismatch");
  });

  test("accepts witness with valid HMAC", () => {
    const validPath = createSignedWitness("scope", "PASS", "abc123");
    const result = verifyWitness(validPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("rejects witness with missing fields", () => {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const incomplete = { gate: "scope", result: "PASS" }; // missing most fields
    const witnessPath = join(WITNESS_DIR, "incomplete.json");
    writeFileSync(witnessPath, JSON.stringify(incomplete));

    const result = verifyWitness(witnessPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing field");
  });

  test("rejects witness with tampered result field", () => {
    // Create valid witness, then tamper with result
    const validPath = createSignedWitness("scope", "FAIL", "abc123");
    const data = JSON.parse(readFileSync(validPath, "utf-8"));
    data.result = "PASS"; // tamper: FAIL -> PASS
    writeFileSync(validPath, JSON.stringify(data));

    const result = verifyWitness(validPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HMAC mismatch");
  });
});

// ── Test 3: Ground-truth — detects stale commit SHA ─────────────────

describe("adversarial-ground-truth", () => {
  test("detects stale commit SHA in witness chain", () => {
    const oldSha = "aaa111bbb222ccc333";
    const currentSha = "ddd444eee555fff666";

    createSignedWitness("scope", "PASS", oldSha);
    createSignedWitness("ship", "PASS", oldSha);

    // Verify chain with different HEAD
    const result = verifyWitnessChain(SLUG, currentSha);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Stale witness"))).toBe(true);
  });

  test("accepts matching commit SHA", () => {
    const sha = "abc123def456789";

    createSignedWitness("scope", "PASS", sha);
    createSignedWitness("ship", "PASS", sha);

    const result = verifyWitnessChain(SLUG, sha);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Test 4: Chain incomplete — blocks push with missing gates ───────

describe("adversarial-chain-incomplete", () => {
  test("rejects chain with only scope (no ship)", () => {
    createSignedWitness("scope", "PASS", "abc123");
    // No ship witness

    const result = verifyWitnessChain(SLUG, "abc123");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Missing PASS witness for required gate: ship"))).toBe(true);
  });

  test("rejects chain with only ship (no scope)", () => {
    createSignedWitness("ship", "PASS", "abc123");
    // No scope witness

    const result = verifyWitnessChain(SLUG, "abc123");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Missing PASS witness for required gate: scope"))).toBe(true);
  });

  test("rejects empty witness directory", () => {
    // WITNESS_DIR exists but is empty
    const result = verifyWitnessChain(SLUG, "abc123");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("No witness files found"))).toBe(true);
  });

  test("rejects when required gate has only FAIL witness", () => {
    createSignedWitness("scope", "PASS", "abc123");
    createSignedWitness("ship", "FAIL", "abc123"); // FAIL, not PASS

    const result = verifyWitnessChain(SLUG, "abc123");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Missing PASS witness for required gate: ship"))).toBe(true);
  });
});
