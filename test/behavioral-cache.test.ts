/**
 * Tests for behavioral-cache.ts — cached behavioral results system
 *
 * Verifies readCache/writeCache, behavioralPattern integration,
 * staleness handling, and lookup table structure.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "behavioral-cache-fixture");
const CACHE_PATH = join(FIXTURE_ROOT, "behavioral-results.json");

function setupFixture() {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
}

function teardownFixture() {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}

describe("behavioral-cache: readCache and writeCache", () => {
  beforeEach(setupFixture);
  afterEach(teardownFixture);

  test("AC-1: writeCache produces file with correct schema", () => {
    const { writeCache, readCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const now = new Date().toISOString();
    const data = {
      "SC-999": { passed: true, evidence: "test evidence", timestamp: now },
    };
    writeCache(CACHE_PATH, data);
    expect(existsSync(CACHE_PATH)).toBe(true);

    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    expect(raw["SC-999"]).toBeDefined();
    expect(raw["SC-999"].passed).toBe(true);
    expect(raw["SC-999"].evidence).toBe("test evidence");
    expect(raw["SC-999"].timestamp).toBe(now);
  });

  test("AC-1: readCache returns empty object for missing file", () => {
    const { readCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const result = readCache(join(FIXTURE_ROOT, "nonexistent.json"));
    expect(result).toEqual({});
  });

  test("AC-1: readCache round-trips with writeCache", () => {
    const { writeCache, readCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const now = new Date().toISOString();
    const data = {
      "SC-999": { passed: true, evidence: "round-trip test", timestamp: now },
      "SC-100": { passed: false, evidence: "failed check", timestamp: now },
    };
    writeCache(CACHE_PATH, data);
    const result = readCache(CACHE_PATH);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["SC-999"].passed).toBe(true);
    expect(result["SC-100"].passed).toBe(false);
  });

  test("AC-1: writeCache merges with existing cache entries", () => {
    const { writeCache, readCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const now = new Date().toISOString();
    writeCache(CACHE_PATH, {
      "SC-100": { passed: true, evidence: "first", timestamp: now },
    });
    writeCache(CACHE_PATH, {
      "SC-200": { passed: false, evidence: "second", timestamp: now },
    });
    const result = readCache(CACHE_PATH);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["SC-100"].passed).toBe(true);
    expect(result["SC-200"].passed).toBe(false);
  });
});

describe("behavioral-cache: staleness handling", () => {
  beforeEach(setupFixture);
  afterEach(teardownFixture);

  test("AC-5: stale entries older than 7 days are excluded by isStale", () => {
    const { isStale } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(eightDaysAgo)).toBe(true);
  });

  test("AC-5: fresh entries within 7 days are not stale", () => {
    const { isStale } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const now = new Date().toISOString();
    expect(isStale(now)).toBe(false);
  });

  test("AC-5: entry exactly 7 days old is stale", () => {
    const { isStale } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(sevenDaysAgo)).toBe(true);
  });

  test("AC-5: readFreshCache excludes stale entries", () => {
    const { writeCache, readFreshCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeCache(CACHE_PATH, {
      "SC-100": { passed: true, evidence: "fresh", timestamp: now },
      "SC-200": { passed: true, evidence: "stale", timestamp: stale },
    });
    const result = readFreshCache(CACHE_PATH);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["SC-100"]).toBeDefined();
    expect(result["SC-200"]).toBeUndefined();
  });
});

describe("behavioral-cache: behavioralPattern integration", () => {
  beforeEach(setupFixture);
  afterEach(teardownFixture);

  test("AC-2: behavioralPattern returns assertion when cached result exists", () => {
    const { writeCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const { behavioralPattern } = require("../lib/conformity") as typeof import("../lib/conformity");
    const now = new Date().toISOString();
    writeCache(CACHE_PATH, {
      "SC-999": { passed: true, evidence: "test pass", timestamp: now },
    });
    const sc = { id: "SC-999", statement: "Test statement (behavioral)", specFile: "TEST-SPEC.md" };
    const assertion = behavioralPattern(sc, CACHE_PATH);
    expect(assertion).not.toBeNull();
    // Assertion should not throw for passing cached result
    expect(() => assertion!("/tmp")).not.toThrow();
  });

  test("AC-2: behavioralPattern returns assertion that throws for failed cached result", () => {
    const { writeCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const { behavioralPattern } = require("../lib/conformity") as typeof import("../lib/conformity");
    const now = new Date().toISOString();
    writeCache(CACHE_PATH, {
      "SC-999": { passed: false, evidence: "test fail", timestamp: now },
    });
    const sc = { id: "SC-999", statement: "Test statement (behavioral)", specFile: "TEST-SPEC.md" };
    const assertion = behavioralPattern(sc, CACHE_PATH);
    expect(assertion).not.toBeNull();
    expect(() => assertion!("/tmp")).toThrow();
  });

  test("AC-2: behavioralPattern returns null when no cached result exists", () => {
    const { behavioralPattern } = require("../lib/conformity") as typeof import("../lib/conformity");
    const sc = { id: "SC-999", statement: "Test statement (behavioral)", specFile: "TEST-SPEC.md" };
    const assertion = behavioralPattern(sc, join(FIXTURE_ROOT, "nonexistent.json"));
    expect(assertion).toBeNull();
  });

  test("AC-5: behavioralPattern returns null for stale cached result", () => {
    const { writeCache } = require("../lib/behavioral-cache") as typeof import("../lib/behavioral-cache");
    const { behavioralPattern } = require("../lib/conformity") as typeof import("../lib/conformity");
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeCache(CACHE_PATH, {
      "SC-999": { passed: true, evidence: "stale pass", timestamp: stale },
    });
    const sc = { id: "SC-999", statement: "Test statement (behavioral)", specFile: "TEST-SPEC.md" };
    const assertion = behavioralPattern(sc, CACHE_PATH);
    expect(assertion).toBeNull();
  });
});

describe("behavioral-cache: lookup table structure", () => {
  test("AC-3/AC-6: behavioral-sc-map.json has at least 20 entries", () => {
    const map = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config", "behavioral-sc-map.json"), "utf-8")
    );
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(20);
  });

  test("AC-6: lookup entries use only existing eval-criteria IDs", () => {
    const map = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config", "behavioral-sc-map.json"), "utf-8")
    );
    const validIds = new Set([
      "SHARED-01", "SHARED-02", "SHARED-03", "SHARED-04",
      "DA-01", "DA-02", "DA-03", "DA-04", "DA-05",
      "M-01", "M-02", "M-03", "M-04", "M-05", "M-06",
      "Q-01", "Q-02", "Q-03", "Q-04", "Q-05",
    ]);
    for (const [scId, entry] of Object.entries(map)) {
      const criterionId = (entry as any).criterionId;
      expect(validIds.has(criterionId)).toBe(true);
    }
  });

  test("AC-3: lookup table maps SC IDs to eval-criteria IDs without per-SC code", () => {
    const map = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config", "behavioral-sc-map.json"), "utf-8")
    );
    // Each entry should have criterionId and description, no code
    for (const [scId, entry] of Object.entries(map)) {
      expect((entry as any).criterionId).toBeDefined();
      expect((entry as any).description).toBeDefined();
      expect(typeof (entry as any).criterionId).toBe("string");
    }
  });

  test("AC-7: at least 30 behavioral SCs are verifiable", () => {
    const map = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config", "behavioral-sc-map.json"), "utf-8")
    );
    const verifiable = Object.values(map).filter((v: any) => v.verifiable !== false).length;
    expect(verifiable).toBeGreaterThanOrEqual(30);
  });

  test("AC-8: between 10 and 15 behavioral SCs are untestable", () => {
    const { execSync } = require("child_process");
    const allBehavioral = execSync(
      'grep -c "(behavioral)" specs/*.md 2>/dev/null || true',
      { encoding: "utf8", cwd: join(import.meta.dir, "..") }
    );
    const total = allBehavioral.trim().split("\n").reduce(
      (s: number, l: string) => s + parseInt(l.split(":")[1] || "0"), 0
    );
    const map = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config", "behavioral-sc-map.json"), "utf-8")
    );
    const mappable = Object.keys(map).length;
    const untestable = total - mappable;
    expect(untestable).toBeGreaterThanOrEqual(10);
    expect(untestable).toBeLessThanOrEqual(15);
  });
});

describe("behavioral-cache: integration with test-brief and sync-sc-status", () => {
  test("AC-4: test-brief.ts references writeCache or behavioral-results", () => {
    const content = readFileSync(
      join(import.meta.dir, "..", "scripts", "test-brief.ts"), "utf-8"
    );
    const hasWriteRef = content.includes("writeCache") ||
      content.includes("behavioral-results") ||
      content.includes("behavioralCache");
    expect(hasWriteRef).toBe(true);
  });

  test("AC-4: sync-sc-status.ts references readCache or behavioral cache", () => {
    const content = readFileSync(
      join(import.meta.dir, "..", "scripts", "sync-sc-status.ts"), "utf-8"
    );
    const hasReadRef = content.includes("readCache") ||
      content.includes("behavioral-results") ||
      content.includes("behavioralCache") ||
      content.includes("behavioral-cache");
    expect(hasReadRef).toBe(true);
  });

  test("AC-4: AgentVerdictCapture.hook.ts references writeCache or behavioral cache", () => {
    const content = readFileSync(
      join(import.meta.dir, "..", "hooks", "AgentVerdictCapture.hook.ts"), "utf-8"
    );
    const hasWriteRef = content.includes("writeCache") ||
      content.includes("behavioral-results") ||
      content.includes("behavioralCache") ||
      content.includes("behavioral-cache");
    expect(hasWriteRef).toBe(true);
  });
});
