#!/usr/bin/env bun
/**
 * witness.ts — Tamper-evident witness signing and verification
 *
 * Issue: #471
 * ADR: ADR-008 (harness v3)
 *
 * Provides HMAC-signed witness files for gate results.
 * Used by run-gate.ts (write) and pre-push (verify).
 *
 * Witness chain: scope -> verify -> ship
 * Each witness stores gate result + commit SHA + HMAC signature.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { createHmac } from "crypto";
import { execSync } from "child_process";

import { gateSaltPath } from "../lib/paths";

const GATE_SALT_PATH = gateSaltPath();

const REQUIRED_GATES = ["scope", "ship"] as const;

export interface WitnessRecord {
  gate: string;
  result: "PASS" | "FAIL";
  slug: string;
  issue: number;
  commitSha: string;
  timestamp: string;
  testOutputHash: string;
  hmac: string;
}

// ── Internal helpers ────────────────────────────────────────────────

function getSalt(): string {
  if (!existsSync(GATE_SALT_PATH)) {
    throw new Error(`Gate salt not found at ${GATE_SALT_PATH}`);
  }
  return readFileSync(GATE_SALT_PATH, "utf-8").trim();
}

function gitSha(cwd?: string): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", timeout: 5000, cwd }).trim();
  } catch {
    return "unknown";
  }
}

function hashTestOutput(testOutput: string): string {
  return createHmac("sha256", "test-output")
    .update(testOutput)
    .digest("hex")
    .slice(0, 16);
}

function computeHmac(record: Omit<WitnessRecord, "hmac">): string {
  const salt = getSalt();
  const input = [
    record.gate,
    record.result,
    record.slug,
    record.issue,
    record.commitSha,
    record.timestamp,
    record.testOutputHash,
  ].join(":");
  return createHmac("sha256", salt).update(input).digest("hex").slice(0, 16);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Write a signed witness file after gate execution.
 * Returns the path to the witness file.
 */
export function writeWitness(
  slug: string,
  gate: string,
  result: "PASS" | "FAIL",
  testOutput: string,
  issue: number = 0,
  projectRoot?: string,
): string {
  const base = process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate");
  const wDir = join(base, slug);
  const witnessDir = join(wDir, "witnesses");
  mkdirSync(witnessDir, { recursive: true });

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const commitSha = gitSha(projectRoot);
  const testOutputHash = hashTestOutput(testOutput);

  const record: Omit<WitnessRecord, "hmac"> = {
    gate,
    result,
    slug,
    issue,
    commitSha,
    timestamp: ts,
    testOutputHash,
  };

  const hmac = computeHmac(record);
  const witness: WitnessRecord = { ...record, hmac };

  const filename = `${gate}-${ts.replace(/[:.]/g, "-")}.json`;
  const witnessPath = join(witnessDir, filename);
  writeFileSync(witnessPath, JSON.stringify(witness, null, 2) + "\n");

  return witnessPath;
}

/**
 * Verify a single witness file's HMAC signature.
 * Returns { valid, record, error? }
 */
export function verifyWitness(
  witnessPath: string,
): { valid: boolean; record: WitnessRecord | null; error?: string } {
  if (!existsSync(witnessPath)) {
    return { valid: false, record: null, error: "Witness file not found" };
  }

  let record: WitnessRecord;
  try {
    record = JSON.parse(readFileSync(witnessPath, "utf-8"));
  } catch {
    return { valid: false, record: null, error: "Invalid JSON in witness file" };
  }

  // Check required fields
  const required = ["gate", "result", "slug", "issue", "commitSha", "timestamp", "testOutputHash", "hmac"];
  for (const field of required) {
    if (!(field in record)) {
      return { valid: false, record, error: `Missing field: ${field}` };
    }
  }

  // Verify HMAC
  const { hmac: storedHmac, ...fields } = record;
  let expectedHmac: string;
  try {
    expectedHmac = computeHmac(fields);
  } catch (e: any) {
    return { valid: false, record, error: `HMAC computation failed: ${e.message}` };
  }

  if (storedHmac !== expectedHmac) {
    return { valid: false, record, error: `HMAC mismatch: stored=${storedHmac}, expected=${expectedHmac}` };
  }

  return { valid: true, record };
}

/**
 * Verify the complete witness chain for a workflow.
 * Checks: required gates present, HMACs valid, latest SHA matches HEAD.
 *
 * Returns { valid, errors[], witnesses[] }
 */
export function verifyWitnessChain(
  slug: string,
  headSha?: string,
): { valid: boolean; errors: string[]; witnesses: WitnessRecord[] } {
  const base = process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate");
  const wDir = join(base, slug);
  const witnessDir = join(wDir, "witnesses");
  const errors: string[] = [];
  const witnesses: WitnessRecord[] = [];

  if (!existsSync(witnessDir)) {
    return { valid: false, errors: ["No witnesses directory found"], witnesses };
  }

  // Read all witness files
  const files = readdirSync(witnessDir).filter(f => f.endsWith(".json")).sort();
  if (files.length === 0) {
    return { valid: false, errors: ["No witness files found"], witnesses };
  }

  // Verify each witness
  for (const file of files) {
    const result = verifyWitness(join(witnessDir, file));
    if (!result.valid) {
      errors.push(`${file}: ${result.error}`);
    }
    if (result.record) {
      witnesses.push(result.record);
    }
  }

  // Check required gates have PASS witnesses
  const passedGates = new Set(
    witnesses
      .filter(w => w.result === "PASS")
      .map(w => w.gate),
  );

  for (const gate of REQUIRED_GATES) {
    if (!passedGates.has(gate)) {
      errors.push(`Missing PASS witness for required gate: ${gate}`);
    }
  }

  // Check latest witness commitSha matches HEAD
  const currentHead = headSha || gitSha();
  const latestWitness = witnesses[witnesses.length - 1];
  if (latestWitness && latestWitness.commitSha !== currentHead) {
    errors.push(
      `Stale witness: latest commitSha=${latestWitness.commitSha} but HEAD=${currentHead}`,
    );
  }

  return { valid: errors.length === 0, errors, witnesses };
}
