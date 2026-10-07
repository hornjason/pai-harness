import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { AgentSchema, WorkflowStateSchema } from "./schema";
import { writeWorkflowState } from "./orchestrator";

const TEST_BASE = `/tmp/rook-state-test-${process.pid}`;
const TEST_SLUG = `rook-state-${process.pid}`;
const WORK_DIR = join(TEST_BASE, TEST_SLUG);
const SF = join(WORK_DIR, "workflow-state.json");

function minimalState(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    issue: 129,
    repo: "hornjason/pai-harness",
    issueRepo: "hornjason/pai-harness",
    projectRoot: "/tmp/test-project",
    slug: TEST_SLUG,
    phase: "VERIFY",
    issueGoal: "Record rook spawned, verdict and failures in workflow state",
    acs: [],
    gates: {},
    changelog: [],
    ...overrides,
  };
}

describe("agents.rook state shape", () => {
  beforeEach(() => {
    mkdirSync(WORK_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch {}
  });

  test("AgentSchema accepts an optional string-array failures alongside spawned and verdict", () => {
    const parsed = AgentSchema.parse({
      spawned: true,
      verdict: "FAIL",
      failures: ["hardcoded secret in lib/github.ts", "unvalidated path join in gates/run-gate.ts"],
    });

    expect(parsed).toBeDefined();
    expect(parsed!.spawned).toBe(true);
    expect(parsed!.verdict).toBe("FAIL");
    // Must survive parsing — an undeclared key is stripped by Zod, which would
    // silently drop the failure list every gate writes through the schema.
    expect(parsed!.failures).toEqual([
      "hardcoded secret in lib/github.ts",
      "unvalidated path join in gates/run-gate.ts",
    ]);
  });

  test("AgentSchema still accepts spawned/verdict with no failures key", () => {
    const parsed = AgentSchema.parse({ spawned: true, verdict: "PASS" });
    expect(parsed!.failures).toBeUndefined();
  });

  test("AgentSchema rejects a non-array failures value", () => {
    expect(() => AgentSchema.parse({ spawned: true, verdict: "FAIL", failures: "one big string" })).toThrow();
    expect(() => AgentSchema.parse({ spawned: true, verdict: "FAIL", failures: 3 })).toThrow();
    expect(() => AgentSchema.parse({ spawned: true, verdict: "FAIL", failures: { a: "b" } })).toThrow();
  });

  test("AgentSchema rejects non-string entries inside failures", () => {
    expect(() => AgentSchema.parse({ spawned: true, verdict: "FAIL", failures: [1, 2] })).toThrow();
  });

  test("writeWorkflowState round-trips agents.rook {spawned, verdict, failures} to disk", () => {
    const rook = {
      spawned: true,
      verdict: "FAIL" as const,
      failures: ["command injection in scripts/scaffold-project.ts", "secret logged at gates/run-gate.ts:120"],
    };

    writeWorkflowState(SF, minimalState({ agents: { rook } }));

    const onDisk = JSON.parse(readFileSync(SF, "utf-8"));
    expect(onDisk.agents.rook).toEqual(rook);

    // And the schema itself must preserve all three fields, not just the raw file.
    const validated = WorkflowStateSchema.parse(onDisk);
    expect(validated.agents!.rook).toEqual(rook);
  });

  test("writeWorkflowState rejects a non-array agents.rook.failures", () => {
    expect(() =>
      writeWorkflowState(SF, minimalState({ agents: { rook: { spawned: true, verdict: "FAIL", failures: "not an array" } } })),
    ).toThrow(/failures/);
  });
});

describe("SCHEMA-GUIDE documents agents.rook", () => {
  const guide = readFileSync(join(import.meta.dir, "SCHEMA-GUIDE.md"), "utf-8");

  test("documents all three agents.rook fields", () => {
    expect(guide).toContain("agents.rook");
    expect(guide).toMatch(/`spawned`/);
    expect(guide).toMatch(/`verdict`/);
    expect(guide).toMatch(/`failures`/);
  });

  test("states that a FAIL verdict must carry a non-empty failures list", () => {
    expect(guide).toMatch(/FAIL[\s\S]{0,160}non-empty[\s\S]{0,80}failures/i);
  });
});
