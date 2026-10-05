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

describe("gate contracts: acHash integrity (#43)", () => {
  test("acHash-diff: orchestrator exports diffAcHashFields function", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    expect(src).toMatch(/export function diffAcHashFields/);
  });

  test("acHash-root-cause: orchestrator documents heal agent root cause", () => {
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    // Must have a root cause comment about heal agents and writeWorkflowState
    expect(src).toMatch(/root cause.*heal/i);
    expect(src).toMatch(/writeWorkflowState[\s\S]*authorized/i);
  });

  test("acHash-dual-computation: acHash computed in both writeGateResult and writeWorkflowState", () => {
    // The intent is that BOTH paths hash the ACs. This used to be checked by
    // counting two identical inline createHash calls, which required the
    // duplication to stay — the same duplication that makes an acHash fix
    // (#43) land in one site and not the other. Both now delegate to the
    // shared hashAcDefinitions helper, so assert on the call sites instead.
    const src = readFileSync(join(GATES_DIR, "orchestrator.ts"), "utf-8");
    const callSites = src.match(/=\s*hashAcDefinitions\(/g);
    expect(callSites?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/import \{ computeACHash \} from "\.\.\/lib\/workflow-security"/);
    // And no inline copy has crept back in.
    expect(src).not.toMatch(/createHash\("sha256"\)\.update\(JSON\.stringify\(acDefs\)\)/);
  });

  test("acHash-ship-assert: ship gate acHash check uses expect not console.warn", () => {
    const src = readFileSync(join(GATES_DIR, "workflow.test.ts"), "utf-8");
    // Find the acHash-consistency-ship test block
    const shipTestMatch = src.match(/acHash-consistency-ship[\s\S]*?(?=\n  \/\/|\n  \}\);[\s\S]*?test\()/);
    if (!shipTestMatch) {
      throw new Error("acHash-consistency-ship test not found");
    }
    const shipTest = shipTestMatch[0];
    expect(shipTest).toMatch(/expect\(currentHash\)/);
    expect(shipTest).not.toMatch(/console\.warn/);
  });

  test("acHash heal cycle: writeWorkflowState keeps acHash stable through authorized modifications", () => {
    // Import the actual functions and test them
    const { writeGateResult, writeWorkflowState } = require("../gates/orchestrator");
    const { writeFileSync, mkdirSync, readFileSync, unlinkSync } = require("fs");
    const { join: pathJoin } = require("path");
    const { createHash } = require("crypto");
    const tmpDir = pathJoin("/tmp", `achash-test-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    const sf = pathJoin(tmpDir, "workflow-state.json");

    // Set up initial state with ACs and scope gate
    const initialState = {
      schemaVersion: 2,
      issue: 999,
      repo: "test/repo",
      issueRepo: "test/repo",
      projectRoot: tmpDir,
      slug: "test-achash",
      issueGoal: "Test acHash integrity through heal cycle",
      phase: "SCOPE",
      acs: [
        {
          id: "AC-1",
          type: "CODE",
          statement: "The acHash function recomputes hash from definition fields only",
          evidenceMethod: { type: "grep", command: "grep -c 'createHash.*sha256' gates/orchestrator.ts" },
          threshold: { op: ">=", value: 2 },
          verdict: "PENDING",
          evidence: null,
        },
        {
          id: "AC-2",
          type: "CODE",
          statement: "The writeWorkflowState recomputes acHash when modifying workflow state",
          evidenceMethod: { type: "grep", command: "grep -c 'acHash' gates/orchestrator.ts" },
          threshold: { op: ">=", value: 2 },
          verdict: "PENDING",
          evidence: null,
        },
      ],
      gates: {},
      changelog: [],
      startTs: new Date().toISOString(),
      updatedTs: new Date().toISOString(),
    };
    writeFileSync(sf, JSON.stringify(initialState, null, 2));

    // Run scope gate to set acHash
    writeGateResult(sf, "scope", 2, 0, 0, [], tmpDir);

    const afterScope = JSON.parse(readFileSync(sf, "utf-8"));
    const scopeHash = afterScope.gates.scope.acHash;
    expect(scopeHash).toBeDefined();

    // Simulate heal agent modifying AC verdicts/evidence through writeWorkflowState
    afterScope.acs[0].verdict = "PASS";
    afterScope.acs[0].evidence = { type: "grep-output", content: "found 3 matches" };
    afterScope.acs[1].verdict = "PASS";
    afterScope.acs[1].evidence = { type: "grep-output", content: "found 1 match" };
    writeWorkflowState(sf, afterScope);

    const afterHeal = JSON.parse(readFileSync(sf, "utf-8"));
    // acHash should be identical — only definition fields are hashed, not verdicts/evidence
    expect(afterHeal.gates.scope.acHash).toBe(scopeHash);

    // Clean up
    try { unlinkSync(sf); } catch {}
  });
});
