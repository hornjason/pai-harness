import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const GATES_DIR = join(import.meta.dir, "..", "gates");

const GATE_FILES = [
  "run-gate.ts",
  "gate-executor.ts",
  "orchestrator.ts",
  "ship-orchestrator.ts",
  "brief-assembler.ts",
  "witness.ts",
  "self-heal.ts",
  "error-classifier.ts",
  "preload.ts",
];

describe("gate contracts: typed interface exports", () => {
  test("typed interface: each gate file exports at least one Input interface", () => {
    const missing: string[] = [];
    for (const file of GATE_FILES) {
      const src = readFileSync(join(GATES_DIR, file), "utf-8");
      const inputMatch = src.match(/export (interface|type) \w+Input/g);
      if (!inputMatch || inputMatch.length < 1) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });

  test("typed interface: each gate file exports at least one Output or Result interface", () => {
    const missing: string[] = [];
    for (const file of GATE_FILES) {
      const src = readFileSync(join(GATES_DIR, file), "utf-8");
      const outputMatch = src.match(/export (interface|type) \w+(Output|Result)/g);
      if (!outputMatch || outputMatch.length < 1) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });

  test("typed interface: at least 7 gate files have both Input and Output/Result", () => {
    let count = 0;
    for (const file of GATE_FILES) {
      const src = readFileSync(join(GATES_DIR, file), "utf-8");
      const hasInput = /export (interface|type) \w+Input/.test(src);
      const hasOutput = /export (interface|type) \w+(Output|Result)/.test(src);
      if (hasInput && hasOutput) count++;
    }
    expect(count).toBeGreaterThanOrEqual(7);
  });
});

describe("gate contracts: no any params in exported functions", () => {
  test("no any params: exported functions do not use bare 'object' type", () => {
    const violations: string[] = [];
    for (const file of GATE_FILES) {
      const src = readFileSync(join(GATES_DIR, file), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^export (async )?function/.test(lines[i]) && /:\s*object\b/.test(lines[i])) {
          violations.push(`${file}:${i + 1} uses bare 'object' type`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no any params: exported function signatures do not use 'any' type in params", () => {
    const violations: string[] = [];
    for (const file of GATE_FILES) {
      const src = readFileSync(join(GATES_DIR, file), "utf-8");
      const lines = src.split("\n");

      let inExportFn = false;
      let braceDepth = 0;
      let fnStartLine = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^export (async )?function/.test(line)) {
          inExportFn = true;
          fnStartLine = i;
          braceDepth = 0;
        }
        if (inExportFn) {
          for (const ch of line) {
            if (ch === "(") braceDepth++;
            if (ch === ")") braceDepth--;
          }
          // Check for 'any' in parameter position (before closing paren)
          if (/:\s*any\b/.test(line) && braceDepth > 0) {
            violations.push(`${file}:${i + 1} uses 'any' in param type`);
          }
          // Once we've closed all parens, we're past the params
          if (braceDepth <= 0 && line.includes(")")) {
            inExportFn = false;
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("gate contracts: implicit state checks", () => {
  test("implicit state: orchestrator writeGateResult uses named interface params", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    // writeWorkflowState should NOT use bare 'object'
    expect(src).not.toMatch(/writeWorkflowState\([^)]*:\s*object\b/);
  });

  test("implicit state: brief-assembler assembleBrief uses named Input interface", () => {
    const src = readFileSync(join(GATES_DIR, "brief-assembler.ts"), "utf-8");
    // Should have a named type for the opts param
    expect(src).toMatch(/export (interface|type) AssembleBriefInput/);
    // The function should reference it
    expect(src).toMatch(/assembleBrief\(opts:\s*AssembleBriefInput\)/);
  });

  test("implicit state: self-heal runWithHeal uses named Input interface", () => {
    const src = readFileSync(join(GATES_DIR, "self-heal.ts"), "utf-8");
    expect(src).toMatch(/export (interface|type) HealInput/);
    expect(src).toMatch(/runWithHeal\(opts:\s*HealInput\)/);
  });
});
