/**
 * verdict-capture.test.ts — Unit tests for lib/verdict-capture.ts
 *
 * Tests verdict capture logic extracted from AgentVerdictCapture.hook.ts
 * per Hook Architecture Spec D-2 (hook logic in lib/ with unit tests).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = `/tmp/verdict-capture-test-${process.pid}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// -- extractVerdict tests --

describe("extractVerdict", () => {
  test("extracts verdict from well-formed output", () => {
    const { extractVerdict } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const text = [
      "Some text before",
      "## Verdict",
      '{"verdict": "PASS", "testedSha": "abc123"',
      "}",
      "More text",
    ].join("\n");
    const result = extractVerdict(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("PASS");
    expect(result!.testedSha).toBe("abc123");
  });

  test("returns null when no verdict block present", () => {
    const { extractVerdict } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const text = "No verdict block here\nJust regular text";
    const result = extractVerdict(text);
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON in verdict block", () => {
    const { extractVerdict } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const text = "## Verdict\n{not valid json\n}";
    const result = extractVerdict(text);
    expect(result).toBeNull();
  });

  test("extracts verdict with blockers", () => {
    const { extractVerdict } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const text = [
      "## Verdict",
      '{"verdict": "FAIL", "blockers": [{"id": "b1", "description": "test blocker"}]',
      "}",
      "End",
    ].join("\n");
    const result = extractVerdict(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("FAIL");
    expect(result!.blockers).toHaveLength(1);
  });

  test("extracts verdict with testedPaths", () => {
    const { extractVerdict } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const text = [
      "## Verdict",
      '{"verdict": "PASS", "testedPaths": ["lib/foo.ts", "lib/bar.ts"]',
      "}",
      "End",
    ].join("\n");
    const result = extractVerdict(text);
    expect(result).not.toBeNull();
    expect(result!.testedPaths).toEqual(["lib/foo.ts", "lib/bar.ts"]);
  });
});

// -- findActiveWorkflow tests --

describe("findActiveWorkflow", () => {
  test("returns null when workDir does not exist", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const result = findActiveWorkflow("/nonexistent/path");
    expect(result).toBeNull();
  });

  test("returns null when no workflow-state.json files exist", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    mkdirSync(join(TEST_DIR, "empty"), { recursive: true });
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).toBeNull();
  });

  test("finds BUILD phase workflow", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const issueDir = join(TEST_DIR, "issue-1");
    mkdirSync(issueDir, { recursive: true });
    const wfPath = join(issueDir, "workflow-state.json");
    writeFileSync(wfPath, JSON.stringify({ phase: "BUILD", issue: 10 }));
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.data.phase).toBe("BUILD");
    expect(result!.path).toBe(wfPath);
  });

  test("finds VERIFY phase workflow", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const issueDir = join(TEST_DIR, "issue-2");
    mkdirSync(issueDir, { recursive: true });
    const wfPath = join(issueDir, "workflow-state.json");
    writeFileSync(wfPath, JSON.stringify({ phase: "VERIFY", issue: 20 }));
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.data.phase).toBe("VERIFY");
  });

  test("finds SHIP phase workflow", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const issueDir = join(TEST_DIR, "issue-3");
    mkdirSync(issueDir, { recursive: true });
    const wfPath = join(issueDir, "workflow-state.json");
    writeFileSync(wfPath, JSON.stringify({ phase: "SHIP", issue: 30 }));
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.data.phase).toBe("SHIP");
  });

  test("ignores DONE phase workflows", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const issueDir = join(TEST_DIR, "issue-4");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), JSON.stringify({ phase: "DONE", issue: 40 }));
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).toBeNull();
  });

  test("handles malformed workflow-state.json gracefully", () => {
    const { findActiveWorkflow } = require("../../lib/verdict-capture") as typeof import("../../lib/verdict-capture");
    const issueDir = join(TEST_DIR, "issue-5");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "workflow-state.json"), "invalid json");
    const result = findActiveWorkflow(TEST_DIR);
    expect(result).toBeNull();
  });
});
