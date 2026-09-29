import { test, expect, describe } from "bun:test";
import {
  prevalidateEvidence,
  type PrevalidationResult,
  type ACInput,
} from "../lib/evidence-prevalidator";

const PROJECT_ROOT = import.meta.dir + "/..";

describe("evidence-prevalidator: prevalidateEvidence", () => {
  // AC-2: status ok — command succeeds with output
  test("returns status ok when evidence command succeeds with output", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-1",
        evidenceMethod: { type: "command", command: "echo hello" },
        threshold: { op: "contains", value: "hello" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-1");
    expect(results[0].status).toBe("ok");
    expect(results[0].needsRewrite).toBeFalsy();
  });

  // AC-2: status broken — command exits non-zero with no stdout
  test("returns status broken when command exits non-zero with no stdout", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-2",
        evidenceMethod: { type: "command", command: "false" },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-2");
    expect(results[0].status).toBe("broken");
  });

  // AC-2: status empty — command succeeds but returns zero-length output
  test("returns status empty when command succeeds but returns empty output", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-3",
        evidenceMethod: { type: "command", command: "printf ''" },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-3");
    expect(results[0].status).toBe("empty");
  });

  // AC-3: auto-fix grep commands that exit 1 on zero matches
  test("auto-fixes grep exit code 1 by wrapping with || true", async () => {
    // grep for something that won't exist — exits 1
    const acs: ACInput[] = [
      {
        id: "AC-4",
        evidenceMethod: {
          type: "grep",
          command: "grep 'NEVER_MATCH_THIS_xyzzy_12345' /dev/null",
        },
        threshold: { op: ">=", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].autoFixed).toBe(true);
    expect(results[0].fixedCommand).toBeTruthy();
    // The fixed command should handle zero-match gracefully
    expect(results[0].fixedCommand).toContain("|| true");
  });

  // AC-3: auto-fix bun test piped through grep — flagged and rewritten
  test("auto-fixes bun test piped through grep to direct bun test", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-5",
        evidenceMethod: {
          type: "command",
          command: "bun test test/canary.test.ts | grep -c pass",
        },
        threshold: { op: ">=", value: "1" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    // Should flag the pipe pattern and rewrite
    expect(results[0].autoFixed).toBe(true);
    expect(results[0].fixedCommand).toMatch(/bun test/);
    expect(results[0].fixedCommand).not.toContain("|");
  });

  // AC-4: needsRewrite when auto-fix can't repair
  test("returns needsRewrite true when auto-fix cannot repair command", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-6",
        evidenceMethod: {
          type: "command",
          command: "nonexistent-binary-xyz --flag",
        },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("broken");
    expect(results[0].needsRewrite).toBe(true);
    expect(results[0].diagnostic).toBeTruthy();
    expect(typeof results[0].diagnostic).toBe("string");
  });

  // AC-1: function signature — accepts ACs array and projectRoot
  test("handles multiple ACs and returns per-AC results", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-A",
        evidenceMethod: { type: "command", command: "echo foo" },
        threshold: { op: "contains", value: "foo" },
      },
      {
        id: "AC-B",
        evidenceMethod: { type: "command", command: "echo bar" },
        threshold: { op: "contains", value: "bar" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("AC-A");
    expect(results[1].id).toBe("AC-B");
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
  });

  // AC-1: skips ACs without evidenceMethod.command
  test("skips ACs without evidenceMethod.command", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-X",
        evidenceMethod: { type: "manual" },
        threshold: { op: "==", value: "done" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");
  });

  // AC-2: broken — grep on nonexistent file (exit 2, not 1)
  test("marks grep on nonexistent file as broken, not auto-fixable", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-Y",
        evidenceMethod: {
          type: "grep",
          command: "grep 'pattern' /nonexistent/path/file.ts",
        },
        threshold: { op: ">=", value: "1" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("broken");
    expect(results[0].needsRewrite).toBe(true);
    expect(results[0].diagnostic).toContain("nonexistent");
  });
});
