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

// ═══ acHash integrity (ADR-009, #43) ═══════════════════════════════════
describe("gate contracts: acHash integrity (#43)", () => {
  test("acHash: diffAcFields function is exported from orchestrator", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    expect(src).toMatch(/export function diffAcFields/);
  });

  test("acHash: writeWorkflowState recomputes acHash (>= 2 hash computation sites)", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    // Site 1: writeGateResult at scope PASS
    const scopeHashMatch = src.match(/createHash\("sha256"\)\.update\(JSON\.stringify\(acDefs\)\)/g);
    expect(scopeHashMatch?.length ?? 0, "Need >= 2 acHash computation sites").toBeGreaterThanOrEqual(2);
  });

  test("acHash: root cause documented in orchestrator code comment", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    expect(src).toMatch(/[Rr]oot cause.*heal/i);
    expect(src).toMatch(/writeWorkflowState.*recompute|recompute.*writeWorkflowState/i);
  });

  test("acHash: ship gate test uses expect assertion, not console.warn", () => {
    const src = readFileSync(join(GATES_DIR, "workflow.test.ts"), "utf-8");
    // Find the acHash-consistency-ship test block
    const shipTestMatch = src.match(/acHash-consistency-ship[\s\S]*?(?=\n  (?:\/\/|test\(|}\);))/);
    expect(shipTestMatch, "acHash-consistency-ship test block not found").toBeTruthy();
    const shipTestBlock = shipTestMatch![0];
    // Must use expect, not just console.warn
    expect(shipTestBlock).toMatch(/expect\(currentHash\)/);
    // Must NOT use console.warn as the primary check
    expect(shipTestBlock).not.toMatch(/console\.warn.*acHash mismatch/);
  });

  test("acHash: heal cycle preserves hash consistency via writeWorkflowState", () => {
    // Import and test the actual functions
    const { writeGateResult, writeWorkflowState } = require(join(GATES_DIR, "orchestrator.ts"));
    const { diffAcFields } = require(join(GATES_DIR, "orchestrator.ts"));
    const { mkdirSync, writeFileSync, readFileSync: readFs, unlinkSync } = require("fs");
    const { createHash } = require("crypto");
    const tmpDir = join("/tmp", `achash-test-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const sf = join(tmpDir, "workflow-state.json");

    // Set up initial state with ACs that match WorkflowStateSchema
    const initialState = {
      schemaVersion: 2,
      issue: 999,
      repo: "test/repo",
      issueRepo: "test/repo",
      projectRoot: tmpDir,
      slug: "test",
      issueGoal: "test acHash integrity across heal cycles",
      phase: "SCOPE",
      acs: [
        { id: "AC-1", type: "CODE", statement: "the system computes acHash at scope gate pass", threshold: { op: ">=", value: 2 }, evidenceMethod: { type: "grep", command: "grep acHash gates/orchestrator.ts" }, verdict: "PENDING", evidence: null },
        { id: "AC-2", type: "CODE", statement: "the system recomputes acHash in writeWorkflowState", threshold: { op: ">=", value: 2 }, evidenceMethod: { type: "grep", command: "grep recompute gates/orchestrator.ts" }, verdict: "PENDING", evidence: null },
      ],
      gates: {},
      changelog: [],
      startTs: new Date().toISOString(),
      updatedTs: new Date().toISOString(),
      sizing: { predicted: "S", ceremonyTier: "LIGHT" },
    };
    writeFileSync(sf, JSON.stringify(initialState, null, 2));

    // Run scope gate to set acHash
    writeGateResult(sf, "scope", 2, 0, 0, [], tmpDir);
    const afterScope = JSON.parse(readFs(sf, "utf-8"));
    const scopeHash = afterScope.gates.scope.acHash;
    expect(scopeHash, "scope gate should set acHash").toBeTruthy();

    // Simulate heal agent modifying verdict and evidence (authorized path via writeWorkflowState)
    afterScope.acs[0].verdict = "PASS";
    afterScope.acs[0].evidence = { type: "grep-output", content: "found" };
    writeWorkflowState(sf, afterScope);

    // Read back and verify hash is still consistent
    const afterHeal = JSON.parse(readFs(sf, "utf-8"));
    const postHealHash = afterHeal.gates.scope.acHash;
    expect(postHealHash, "acHash should be recomputed after writeWorkflowState").toBe(scopeHash);

    // Verify diffAcFields returns empty for definition-only comparison
    const acDefsBefore = initialState.acs.map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const acDefsAfter = afterHeal.acs.map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const diff = diffAcFields(acDefsBefore, acDefsAfter);
    expect(diff, "diffAcFields should return empty array for definition-only match").toEqual([]);

    // Cleanup
    try { unlinkSync(sf); } catch {}
  });
});
