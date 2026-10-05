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

describe("gate contracts: acHash integrity (#43)", () => {
  test("acHash heal cycle: writeWorkflowState keeps acHash stable through authorized modifications", () => {
    // Setup: simulate scope PASS setting acHash, then heal agent modifying ACs through writeWorkflowState
    const { writeWorkflowState, writeGateResult } = require("../gates/orchestrator");
    const { createHash } = require("crypto");
    const { writeFileSync, mkdirSync, unlinkSync } = require("fs");
    const { join } = require("path");
    const os = require("os");

    const tmpDir = join(os.tmpdir(), `achash-heal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sf = join(tmpDir, "workflow-state.json");

    // Create initial state with ACs
    const initialState = {
      schemaVersion: 2,
      issue: 999,
      repo: "test/repo",
      issueRepo: "test/repo",
      projectRoot: tmpDir,
      slug: "test-slug",
      issueGoal: "test goal",
      phase: "SCOPE",
      acs: [
        { id: "AC-1", type: "CODE", statement: "first acceptance criterion for the feature implementation", threshold: { op: ">=", value: 2, unit: "functions" }, evidenceMethod: { type: "command", command: "echo ok" }, evidence: null, verdict: "PENDING" },
        { id: "AC-2", type: "CODE", statement: "second acceptance criterion for the feature implementation", threshold: { op: ">=", value: 2, unit: "functions" }, evidenceMethod: { type: "command", command: "echo ok" }, evidence: null, verdict: "PENDING" },
      ],
      gates: {},
      changelog: [],
      sizing: { predicted: "S", ceremonyTier: "LIGHT" },
      startTs: new Date().toISOString(),
      updatedTs: new Date().toISOString(),
    };
    writeFileSync(sf, JSON.stringify(initialState, null, 2));

    // Run scope gate PASS to set acHash
    writeGateResult(sf, "scope", 5, 0, 0, []);

    const stateAfterScope = JSON.parse(require("fs").readFileSync(sf, "utf-8"));
    const scopeHash = stateAfterScope.gates.scope.acHash;
    expect(scopeHash).toBeTruthy();

    // Heal agent modifies ACs through writeWorkflowState (authorized path)
    // Change verdict and evidence (mutable fields) — should NOT change hash
    stateAfterScope.acs[0].verdict = "PASS";
    stateAfterScope.acs[0].evidence = { type: "command-output", content: "test passed" };
    writeWorkflowState(sf, stateAfterScope);

    const stateAfterHeal = JSON.parse(require("fs").readFileSync(sf, "utf-8"));
    const hashAfterHeal = stateAfterHeal.gates.scope.acHash;

    // acHash should remain the same — only definition fields are hashed, not verdict/evidence
    expect(hashAfterHeal).toBe(scopeHash);

    // Cleanup
    try { unlinkSync(sf); } catch {}
  });

  test("diffAcFields: returns field-level diff when AC definitions change", () => {
    const { diffAcFields } = require("../gates/orchestrator");
    const original = [
      { id: "AC-1", type: "CODE", statement: "original statement", specElement: null, threshold: null, evidenceMethod: { type: "command", command: "echo ok" } },
    ];
    const modified = [
      { id: "AC-1", type: "CODE", statement: "modified statement", specElement: null, threshold: null, evidenceMethod: { type: "command", command: "echo ok" } },
    ];
    const diff = diffAcFields(original, modified);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff[0]).toContain("AC-1");
    expect(diff[0]).toContain("statement");
  });

  test("diffAcFields: returns empty array when AC definitions are identical", () => {
    const { diffAcFields } = require("../gates/orchestrator");
    const defs = [
      { id: "AC-1", type: "CODE", statement: "test", specElement: null, threshold: null, evidenceMethod: { type: "command", command: "echo ok" } },
    ];
    const diff = diffAcFields(defs, defs);
    expect(diff).toEqual([]);
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
