/**
 * spec-issue-sync tests — verifies GitHub issue-to-spec sync module
 * AC-2: A lib module reads GitHub issues with spec-update label
 *        and appends extracted mechanical claims as SC lines to the governing spec file
 *
 * Issue: #508
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  extractMechanicalClaims,
  appendClaimsToSpec,
} from "../lib/spec-issue-sync";

describe("spec-issue-sync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-issue-sync-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("AC-2: module has >= 2 exported functions", () => {
    test("extractMechanicalClaims is an exported function", () => {
      expect(typeof extractMechanicalClaims).toBe("function");
    });

    test("appendClaimsToSpec is an exported function", () => {
      expect(typeof appendClaimsToSpec).toBe("function");
    });
  });

  describe("extractMechanicalClaims", () => {
    test("extracts GATE claims from issue body text", () => {
      const body = `## Changes\n\nAdd a new gate:\n**GATE: All tests pass before merge**\n\nDetails here.`;
      const claims = extractMechanicalClaims(body);
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.some(c => c.claim.toLowerCase().includes("gate"))).toBe(true);
    });

    test("extracts make command claims from issue body", () => {
      const body = "We need to run `make test-up` before validation.";
      const claims = extractMechanicalClaims(body);
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.some(c => c.claim.includes("make"))).toBe(true);
    });

    test("extracts Quinn action claims from issue body", () => {
      const body = "Quinn validates the UI state after deploy.";
      const claims = extractMechanicalClaims(body);
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.some(c => c.claim.toLowerCase().includes("quinn"))).toBe(true);
    });

    test("returns empty array when no mechanical claims found", () => {
      const body = "This is a simple text with no mechanical claims.";
      const claims = extractMechanicalClaims(body);
      expect(claims).toEqual([]);
    });

    test("deduplicates repeated claims", () => {
      const body = "**GATE: tests pass**\n\n**GATE: tests pass**";
      const claims = extractMechanicalClaims(body);
      // Should deduplicate
      const gateCount = claims.filter(c => c.claim.toLowerCase().includes("tests pass")).length;
      expect(gateCount).toBe(1);
    });
  });

  describe("appendClaimsToSpec", () => {
    test("appends SC lines to end of spec file", () => {
      const specPath = join(tmpDir, "test-spec.md");
      writeFileSync(specPath, "---\ndoc-type: spec\ntestable: true\n---\n# Test Spec\n\nExisting content.\n");

      const claims = [
        { id: "ISSUE-CLAIM-1", claim: "Gate: All tests pass", source_line: 5, context: "**GATE: All tests pass**" },
      ];

      const result = appendClaimsToSpec(specPath, claims, 42);
      expect(result.appended).toBe(true);
      expect(result.claimsAdded).toBe(1);

      const content = readFileSync(specPath, "utf-8");
      expect(content).toContain("SC-");
      expect(content).toContain("#42");
    });

    test("does not duplicate claims already present in spec", () => {
      const specPath = join(tmpDir, "dedup-spec.md");
      writeFileSync(
        specPath,
        "---\ndoc-type: spec\n---\n# Spec\n\n- [ ] SC-500: Gate: All tests pass (#42)\n"
      );

      const claims = [
        { id: "ISSUE-CLAIM-1", claim: "Gate: All tests pass", source_line: 5, context: "**GATE: All tests pass**" },
      ];

      const result = appendClaimsToSpec(specPath, claims, 42);
      expect(result.appended).toBe(false);
      expect(result.claimsAdded).toBe(0);
    });

    test("handles empty claims array gracefully", () => {
      const specPath = join(tmpDir, "empty-spec.md");
      writeFileSync(specPath, "---\ndoc-type: spec\n---\n# Spec\n");

      const result = appendClaimsToSpec(specPath, [], 10);
      expect(result.appended).toBe(false);
      expect(result.claimsAdded).toBe(0);
    });

    test("skips when spec file does not exist", () => {
      const specPath = join(tmpDir, "nonexistent.md");
      const claims = [
        { id: "ISSUE-CLAIM-1", claim: "Gate: check", source_line: 1, context: "" },
      ];

      const result = appendClaimsToSpec(specPath, claims, 1);
      expect(result.appended).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });
});
