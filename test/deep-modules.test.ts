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
    "gates/orchestrator.ts",
    "gates/preload.ts",
    "gates/run-gate.ts",
    "gates/schema.ts",
    "gates/self-heal.ts",
    "gates/ship-orchestrator.ts",
    "gates/witness.ts",
  ];

  test("AC-1: all 9 gate files export typed Input and Output/Result interfaces", () => {
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
    expect(count).toBeGreaterThanOrEqual(9);
  });

  test("AC-2: spec has per-gate pass/fail SCs for all 9 gates", () => {
    const spec = readFileSync(join(ROOT, "specs/GATE-CONTRACTS-SPEC.md"), "utf-8");
    const gates = [
      "brief-assembler", "error-classifier", "orchestrator", "preload",
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
    expect(found).toBeGreaterThanOrEqual(9);
  });

  test("AC-3: spec documents gate chain with >= 5 arrow connections", () => {
    const spec = readFileSync(join(ROOT, "specs/GATE-CONTRACTS-SPEC.md"), "utf-8");
    const arrows = (spec.match(/→|-->|->(?!\.)/g) || []).length;
    expect(arrows).toBeGreaterThanOrEqual(5);
  });
});
