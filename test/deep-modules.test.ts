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

describe("SC-373: Gate contract typed interfaces", () => {
  const GATE_FILES = [
    "gates/brief-assembler.ts",
    "gates/error-classifier.ts",
    "gates/gate-executor.ts",
    "gates/orchestrator.ts",
    "gates/preload.ts",
    "gates/run-gate.ts",
    "gates/schema.ts",
    "gates/self-heal.ts",
    "gates/ship-orchestrator.ts",
    "gates/witness.ts",
  ];

  test("AC-1: all 10 gate files export typed Input and Output/Result interfaces", () => {
    let count = 0;
    const missing: string[] = [];
    for (const f of GATE_FILES) {
      const content = readFileSync(join(ROOT, f), "utf-8");
      const hasInput = /export (interface|type) \w+Input/.test(content);
      const hasOutput = /export (interface|type) \w+(Result|Output)/.test(content);
      if (hasInput && hasOutput) {
        count++;
      } else {
        missing.push(`${f}: input=${hasInput}, output=${hasOutput}`);
      }
    }
    expect(missing).toEqual([]);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  test("AC-2: spec has per-gate pass/fail SCs for all 10 gates", () => {
    const spec = readFileSync(join(ROOT, "specs/GATE-CONTRACTS-SPEC.md"), "utf-8");
    const gates = [
      "brief-assembler", "error-classifier", "gate-executor", "orchestrator", "preload",
      "run-gate", "schema", "self-heal", "ship-orchestrator", "witness",
    ];
    let found = 0;
    const missing: string[] = [];
    for (const gate of gates) {
      const re = new RegExp(`SC-\\d+:.*${gate}`, "i");
      if (re.test(spec)) {
        found++;
      } else {
        missing.push(gate);
      }
    }
    expect(missing).toEqual([]);
    expect(found).toBeGreaterThanOrEqual(10);
  });

  test("SC-376: gates/run-gate.ts is under 400 lines", () => {
    const content = readFileSync(join(ROOT, "gates/run-gate.ts"), "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(400);
  });

  test("AC-3: spec documents gate chain with >= 5 arrow connections", () => {
    const spec = readFileSync(join(ROOT, "specs/GATE-CONTRACTS-SPEC.md"), "utf-8");
    const arrows = (spec.match(/→|-->|->(?!\.)/g) || []).length;
    expect(arrows).toBeGreaterThanOrEqual(5);
  });
});

describe("SC-376: run-gate.ts decomposition", () => {
  test("gates/run-gate.ts is under 400 lines", () => {
    const content = readFileSync(join(ROOT, "gates/run-gate.ts"), "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThan(400);
  });

  test("gates/gate-executor.ts exists and exports GateExecutorInput + GateExecutorResult", () => {
    const content = readFileSync(join(ROOT, "gates/gate-executor.ts"), "utf-8");
    expect(content).toMatch(/export interface GateExecutorInput/);
    expect(content).toMatch(/export interface GateExecutorResult/);
  });

  test("run-gate.ts imports from gate-executor", () => {
    const content = readFileSync(join(ROOT, "gates/run-gate.ts"), "utf-8");
    expect(content).toContain("./gate-executor");
  });
});

describe("SC-544: Hook extraction — thin hooks delegate to lib/", () => {
  test("AC-1: GateEnforcement.hook.ts is under 100 lines", () => {
    const content = readFileSync(join(ROOT, "hooks/GateEnforcement.hook.ts"), "utf-8");
    const lineCount = content.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(100);
  });

  test("AC-2: No hook file exceeds 150 lines (excluding AgentBriefGuard)", () => {
    const { readdirSync } = require("fs");
    const hookFiles = readdirSync(join(ROOT, "hooks"))
      .filter((f: string) => f.endsWith(".hook.ts") && !f.startsWith("AgentBriefGuard"));
    const overLimit: string[] = [];
    for (const f of hookFiles) {
      const content = readFileSync(join(ROOT, "hooks", f), "utf-8");
      const lineCount = content.trimEnd().split("\n").length;
      if (lineCount > 150) overLimit.push(`${f}: ${lineCount} lines`);
    }
    expect(overLimit).toEqual([]);
  });

  test("AC-3: lib/gate-enforcement.ts exports findWorkflowGateFailure", () => {
    const content = readFileSync(join(ROOT, "lib/gate-enforcement.ts"), "utf-8");
    expect(content).toMatch(/export function findWorkflowGateFailure/);
  });

  test("AC-3: lib/gate-enforcement.ts exports logSignal", () => {
    const content = readFileSync(join(ROOT, "lib/gate-enforcement.ts"), "utf-8");
    expect(content).toMatch(/export function logSignal/);
  });

  test("AC-3: lib/gate-enforcement.ts exports buildGatePending", () => {
    const content = readFileSync(join(ROOT, "lib/gate-enforcement.ts"), "utf-8");
    expect(content).toMatch(/export function buildGatePending/);
  });

  test("AC-3: lib/gate-enforcement.ts exports makeEnforcementDecision", () => {
    const content = readFileSync(join(ROOT, "lib/gate-enforcement.ts"), "utf-8");
    expect(content).toMatch(/export function makeEnforcementDecision/);
  });

  test("AC-3: lib/stale-cleanup.ts exports cleanStaleFiles", () => {
    const content = readFileSync(join(ROOT, "lib/stale-cleanup.ts"), "utf-8");
    expect(content).toMatch(/export function cleanStaleFiles/);
  });

  test("AC-3: lib/verdict-capture.ts exports findActiveWorkflow and extractVerdict", () => {
    const content = readFileSync(join(ROOT, "lib/verdict-capture.ts"), "utf-8");
    expect(content).toMatch(/export function findActiveWorkflow/);
    expect(content).toMatch(/export function extractVerdict/);
  });

  test("GateEnforcement.hook.ts imports from lib/gate-enforcement", () => {
    const content = readFileSync(join(ROOT, "hooks/GateEnforcement.hook.ts"), "utf-8");
    expect(content).toContain("../lib/gate-enforcement");
  });

  test("StaleTTLCleanup.hook.ts imports from lib/stale-cleanup", () => {
    const content = readFileSync(join(ROOT, "hooks/StaleTTLCleanup.hook.ts"), "utf-8");
    expect(content).toContain("../lib/stale-cleanup");
  });

  test("AgentVerdictCapture.hook.ts imports from lib/verdict-capture", () => {
    const content = readFileSync(join(ROOT, "hooks/AgentVerdictCapture.hook.ts"), "utf-8");
    expect(content).toContain("../lib/verdict-capture");
  });
});

describe("Deep modules: conformity engine agent brief checks", () => {
  const conformitySrc = readFileSync(join(ROOT, "lib/conformity.ts"), "utf-8");

  test("AGENT-7 check exists: required sections validation", () => {
    expect(conformitySrc).toContain("AGENT-7");
    expect(conformitySrc).toMatch(/required.*section/i);
  });

  test("AGENT-8 check exists: model: sonnet validation", () => {
    expect(conformitySrc).toContain("AGENT-8");
    expect(conformitySrc).toMatch(/model.*sonnet/i);
  });

  test("AGENT-9 check exists: line count under 120", () => {
    expect(conformitySrc).toContain("AGENT-9");
    expect(conformitySrc).toMatch(/120/);
  });

  test("AGENT-10 check exists: no unfilled template variables", () => {
    expect(conformitySrc).toContain("AGENT-10");
    expect(conformitySrc).toMatch(/template.*variable|unfilled|\$\{/i);
  });
});
