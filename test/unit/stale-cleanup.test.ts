/**
 * stale-cleanup.test.ts — Unit tests for lib/stale-cleanup.ts
 *
 * Tests stale file cleanup logic extracted from StaleTTLCleanup.hook.ts
 * per Hook Architecture Spec D-2 (hook logic in lib/ with unit tests).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "fs";
import { join } from "path";

const TEST_DIR = `/tmp/stale-cleanup-test-${process.pid}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// -- findFiles tests --

describe("findFiles", () => {
  test("finds files by name recursively", () => {
    const { findFiles } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(TEST_DIR, "target.json"), "{}");
    writeFileSync(join(sub, "target.json"), "{}");
    writeFileSync(join(sub, "other.json"), "{}");
    const results = findFiles(TEST_DIR, "target.json");
    expect(results).toHaveLength(2);
  });

  test("returns empty array when dir does not exist", () => {
    const { findFiles } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const results = findFiles("/nonexistent/dir", "target.json");
    expect(results).toEqual([]);
  });

  test("returns empty array when no files match", () => {
    const { findFiles } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    writeFileSync(join(TEST_DIR, "other.json"), "{}");
    const results = findFiles(TEST_DIR, "target.json");
    expect(results).toEqual([]);
  });
});

// -- cleanupShipActive tests --

describe("cleanupShipActive", () => {
  test("deletes .ship-active files older than 4 hours", () => {
    const { cleanupShipActive } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-1");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, ".ship-active");
    writeFileSync(filePath, "");
    // Set mtime to 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, fiveHoursAgo, fiveHoursAgo);

    const result = cleanupShipActive(TEST_DIR);
    expect(result.deletedCount).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  test("preserves .ship-active files younger than 4 hours", () => {
    const { cleanupShipActive } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-2");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, ".ship-active");
    writeFileSync(filePath, "");
    // Recent file — default mtime is now

    const result = cleanupShipActive(TEST_DIR);
    expect(result.deletedCount).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });
});

// -- cleanupWorkflowState tests --

describe("cleanupWorkflowState", () => {
  test("deletes non-active phase workflow-state.json older than 4 hours", () => {
    const { cleanupWorkflowState } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-3");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, "workflow-state.json");
    writeFileSync(filePath, JSON.stringify({ phase: "DONE" }));
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, fiveHoursAgo, fiveHoursAgo);

    const result = cleanupWorkflowState(TEST_DIR);
    expect(result.deletedCount).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  test("preserves BUILD phase workflow-state.json within 7 days", () => {
    const { cleanupWorkflowState } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-4");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, "workflow-state.json");
    writeFileSync(filePath, JSON.stringify({ phase: "BUILD" }));
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, fiveHoursAgo, fiveHoursAgo);

    const result = cleanupWorkflowState(TEST_DIR);
    expect(result.deletedCount).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  test("deletes BUILD phase workflow-state.json older than 7 days (zombie)", () => {
    const { cleanupWorkflowState } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-5");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, "workflow-state.json");
    writeFileSync(filePath, JSON.stringify({ phase: "BUILD" }));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, eightDaysAgo, eightDaysAgo);

    const result = cleanupWorkflowState(TEST_DIR);
    expect(result.deletedCount).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  test("exempts files with goal-record.json sibling", () => {
    const { cleanupWorkflowState } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const sub = join(TEST_DIR, "issue-6");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, "workflow-state.json");
    writeFileSync(filePath, JSON.stringify({ phase: "DONE" }));
    writeFileSync(join(sub, "goal-record.json"), "{}");
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, fiveHoursAgo, fiveHoursAgo);

    const result = cleanupWorkflowState(TEST_DIR);
    expect(result.deletedCount).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });
});

// -- cleanupEmptyDirs tests --

describe("cleanupEmptyDirs", () => {
  test("removes empty subdirectories", () => {
    const { cleanupEmptyDirs } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const emptyDir = join(TEST_DIR, "empty-dir");
    mkdirSync(emptyDir, { recursive: true });

    cleanupEmptyDirs(TEST_DIR);
    expect(existsSync(emptyDir)).toBe(false);
  });

  test("preserves non-empty subdirectories", () => {
    const { cleanupEmptyDirs } = require("../../lib/stale-cleanup") as typeof import("../../lib/stale-cleanup");
    const nonEmpty = join(TEST_DIR, "non-empty");
    mkdirSync(nonEmpty, { recursive: true });
    writeFileSync(join(nonEmpty, "file.txt"), "content");

    cleanupEmptyDirs(TEST_DIR);
    expect(existsSync(nonEmpty)).toBe(true);
  });
});
