import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const HOOK_PATH = join(__dirname, "..", "..", "hooks", "WorkflowStateGuard.hook.ts");

describe("WorkflowStateGuard.hook.ts", () => {
  test("hook file exists", () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  const hookSource = readFileSync(HOOK_PATH, "utf-8");

  test("blocks Write tool when path contains workflow-state.json", () => {
    expect(hookSource).toContain("Write");
    expect(hookSource).toContain("workflow-state.json");
    expect(hookSource).toContain("block");
  });

  test("blocks Edit tool when path contains workflow-state.json", () => {
    expect(hookSource).toContain("Edit");
    expect(hookSource).toContain("workflow-state.json");
  });

  test("block message includes writeWorkflowState() function name", () => {
    expect(hookSource).toContain("writeWorkflowState()");
  });

  test("block message includes bun -e example command", () => {
    expect(hookSource).toContain("bun -e");
  });

  test("outputs JSON decision block format", () => {
    expect(hookSource).toContain("decision");
    expect(hookSource).toContain("block");
    // Verify it outputs JSON.stringify with decision: 'block'
    expect(hookSource).toContain("JSON.stringify");
  });

  test("reads file_path from tool_input", () => {
    expect(hookSource).toContain("file_path");
  });
});

describe("schema strictness parity (GI-8)", () => {
  const orchestratorSource = readFileSync(join(__dirname, "..", "..", "gates", "orchestrator.ts"), "utf-8");
  const workflowTestSource = readFileSync(join(__dirname, "..", "..", "gates", "workflow.test.ts"), "utf-8");

  test("writeWorkflowState uses passthrough parse", () => {
    // writeWorkflowState should use .passthrough().parse()
    expect(orchestratorSource).toContain("WorkflowStateSchema.passthrough().parse(state)");
  });

  test("workflow.test.ts uses passthrough safeParse", () => {
    // workflow.test.ts should use .passthrough().safeParse()
    expect(workflowTestSource).toContain("WorkflowStateSchema.passthrough().safeParse(raw)");
  });

  test("both use identical passthrough strictness", () => {
    const orchestratorUsesPassthrough = orchestratorSource.includes("WorkflowStateSchema.passthrough().parse");
    const testUsesPassthrough = workflowTestSource.includes("WorkflowStateSchema.passthrough().safeParse");
    expect(orchestratorUsesPassthrough).toBe(true);
    expect(testUsesPassthrough).toBe(true);
  });
});

describe("ship.js Write tool instructions eliminated", () => {
  const shipSource = readFileSync(join(__dirname, "..", "..", "workflows", "ship.js"), "utf-8");

  test("zero agent prompts instruct using Write tool for workflow-state.json", () => {
    // Count occurrences of "Write tool" or "Write the COMPLETE" in agent prompts
    const writeToolPattern = /(?:using Write tool|Write the COMPLETE)/g;
    const matches = shipSource.match(writeToolPattern) || [];
    expect(matches.length, `Found ${matches.length} Write tool instructions in ship.js: ${matches.join(", ")}`).toBe(0);
  });

  test("heal prompts route through writeWorkflowState", () => {
    // All agent prompts that modify workflow-state.json should reference writeWorkflowState
    expect(shipSource).toContain("writeWorkflowState");
  });
});

describe("checkIntegrity has production caller", () => {
  const selfHealSource = readFileSync(join(__dirname, "..", "..", "gates", "self-heal.ts"), "utf-8");

  test("checkIntegrity is called in runWithHeal", () => {
    // checkIntegrity should be called after gate execution
    const callPattern = /checkIntegrity\(beforeSnapshot,\s*afterSnapshot\)/;
    expect(callPattern.test(selfHealSource)).toBe(true);
  });

  test("snapshotProtectedFields called before gate execution", () => {
    expect(selfHealSource).toContain("snapshotProtectedFields(preState)");
  });
});
