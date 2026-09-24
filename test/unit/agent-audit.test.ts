/**
 * agent-audit.test.ts — Unit tests for lib/agent-audit.ts
 *
 * Tests transcript auditing logic extracted from AgentVerdictCapture hook
 * per Hook Architecture Spec D-2 (hook logic in lib/ with unit tests).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { runAgentAudit, mapRoleToAuditRole } from "../../lib/agent-audit";

const TEST_DIR = `/tmp/agent-audit-test-${process.pid}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// ── Role mapping tests ──────────────────────────────────────────────────

describe("mapRoleToAuditRole", () => {
  test("maps quinn to quinn", () => {
    expect(mapRoleToAuditRole("quinn")).toBe("quinn");
  });

  test("maps marcus to marcus", () => {
    expect(mapRoleToAuditRole("marcus")).toBe("marcus");
  });

  test("maps rook to da", () => {
    expect(mapRoleToAuditRole("rook")).toBe("da");
  });

  test("maps unknown roles to da", () => {
    expect(mapRoleToAuditRole("unknown")).toBe("da");
    expect(mapRoleToAuditRole("custom")).toBe("da");
  });
});

// ── Audit execution tests ───────────────────────────────────────────────

describe("runAgentAudit", () => {
  test("returns null when transcript_path is undefined", () => {
    const result = runAgentAudit(undefined, "marcus");
    expect(result).toBeNull();
  });

  test("returns null when transcript file doesn't exist", () => {
    const result = runAgentAudit("/nonexistent/path.jsonl", "marcus");
    expect(result).toBeNull();
  });

  test("returns audit result for valid Marcus transcript", () => {
    const transcriptPath = join(TEST_DIR, "agent-marcus.jsonl");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/test/AGENTS.md" } },
            { type: "tool_use", name: "Read", input: { file_path: "/test/PROJECT-STATE.md" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/test/lib/foo.ts", old_string: "a", new_string: "b" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, transcript);

    const metaPath = join(TEST_DIR, "agent-marcus.meta.json");
    writeFileSync(metaPath, JSON.stringify({
      agentType: "marcus",
      description: "Test Marcus",
      workflowPhase: "BUILD",
    }));

    const result = runAgentAudit(transcriptPath, "marcus");

    expect(result).not.toBeNull();
    expect(result!.role).toBe("marcus");
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(100);
    expect(result!.grade).toMatch(/[A-F]/);
    expect(result!.totalCalls).toBe(3);
    expect(result!.rules).toBeInstanceOf(Array);
    expect(result!.rules.length).toBeGreaterThan(0);
    expect(result!.timestamp).toBeDefined();
  });

  test("returns audit result for valid Quinn transcript", () => {
    const transcriptPath = join(TEST_DIR, "agent-quinn.jsonl");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/test/AGENTS.md" } },
            { type: "tool_use", name: "Bash", input: { command: "bun test" } },
            { type: "tool_use", name: "Bash", input: { command: "bunx tsc --noEmit" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, transcript);

    const metaPath = join(TEST_DIR, "agent-quinn.meta.json");
    writeFileSync(metaPath, JSON.stringify({
      agentType: "quinn",
      description: "Test Quinn",
      workflowPhase: "VERIFY",
    }));

    const result = runAgentAudit(transcriptPath, "quinn");

    expect(result).not.toBeNull();
    expect(result!.role).toBe("quinn");
    expect(result!.totalCalls).toBe(3);
  });

  test("includes rule results with required fields", () => {
    const transcriptPath = join(TEST_DIR, "agent-marcus.jsonl");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/test/AGENTS.md" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, transcript);

    const metaPath = join(TEST_DIR, "agent-marcus.meta.json");
    writeFileSync(metaPath, JSON.stringify({
      agentType: "marcus",
      description: "Test",
      workflowPhase: "BUILD",
    }));

    const result = runAgentAudit(transcriptPath, "marcus");

    expect(result).not.toBeNull();
    expect(result!.rules.length).toBeGreaterThan(0);

    const rule = result!.rules[0];
    expect(rule.id).toBeDefined();
    expect(rule.rule).toBeDefined();
    expect(rule.verdict).toMatch(/FOLLOWED|IGNORED/);
    expect(rule.evidence).toBeDefined();
    expect(rule.weight).toBeGreaterThan(0);
  });

  test("handles malformed transcript gracefully (empty tool calls)", () => {
    const transcriptPath = join(TEST_DIR, "bad.jsonl");
    writeFileSync(transcriptPath, "this is not valid JSON");

    const metaPath = join(TEST_DIR, "bad.meta.json");
    writeFileSync(metaPath, JSON.stringify({
      agentType: "marcus",
      description: "Test",
      workflowPhase: "BUILD",
    }));

    const result = runAgentAudit(transcriptPath, "marcus");

    // Malformed JSON is skipped by parser, results in 0 tool calls
    expect(result).not.toBeNull();
    expect(result!.totalCalls).toBe(0);
    // Utility agent exemption applies (0 calls)
    expect(result!.score).toBe(100);
  });

  test("timestamp is in ISO format", () => {
    const transcriptPath = join(TEST_DIR, "agent-marcus.jsonl");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/test/AGENTS.md" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, transcript);

    const metaPath = join(TEST_DIR, "agent-marcus.meta.json");
    writeFileSync(metaPath, JSON.stringify({
      agentType: "marcus",
      description: "Test",
      workflowPhase: "BUILD",
    }));

    const result = runAgentAudit(transcriptPath, "marcus");

    expect(result).not.toBeNull();
    expect(result!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
