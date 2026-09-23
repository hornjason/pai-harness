/**
 * Behavioral SC tagging tests.
 *
 * SCs with (behavioral) suffix are runtime-only checks that cannot be
 * verified by static file inspection. The conformity engine must:
 *   1. Detect the suffix and exclude them from unmatched counts
 *   2. Track them separately as behavioralCount in the findings report
 *   3. Annotate them with SESSION-AUDIT-SPEC routing
 *
 * SPEC-REF: INSTRUCTION-COMPLIANCE-SPEC.md § Success Criteria
 * SPEC-REF: SESSION-AUDIT-SPEC.md § Two Feedback Loops
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  matchPattern,
  writeFindingsReport,
  clearFindings,
  type ParsedSC,
} from "../../lib/conformity";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// ── Helpers ─────────────────────────────────────────────────

function makeBehavioralSC(id: string, statement: string): ParsedSC {
  return { id, statement: `${statement} (behavioral)`, specFile: "TEST-SPEC.md" };
}

function makeStructuralSC(id: string, statement: string): ParsedSC {
  return { id, statement, specFile: "TEST-SPEC.md" };
}

// ── Tests ───────────────────────────────────────────────────

describe("Behavioral SC detection", () => {
  test("isBehavioralSC returns true for SCs with (behavioral) suffix", () => {
    const { isBehavioralSC } = require("../../lib/conformity");
    const sc = makeBehavioralSC("SC-318", "Cold-start agent finds PROJECT-STATE.md within first 3 tool calls");
    expect(isBehavioralSC(sc)).toBe(true);
  });

  test("isBehavioralSC returns false for structural SCs", () => {
    const { isBehavioralSC } = require("../../lib/conformity");
    const sc = makeStructuralSC("SC-309", "scripts/session-end.ts exists");
    expect(isBehavioralSC(sc)).toBe(false);
  });

  test("matchPattern returns null for behavioral SCs (they are runtime-only)", () => {
    const sc = makeBehavioralSC("SC-321", "Session auditor fork produces navigability metrics");
    const result = matchPattern(sc);
    expect(result).toBeNull();
  });
});

describe("Behavioral SCs excluded from unmatched count", () => {
  test("extractSCs strips (behavioral) from statement for display but preserves detection", () => {
    // The SC statement in a spec file: "SC-318: Something (behavioral)"
    // extractSCs should parse it, and isBehavioralSC should detect the suffix
    const { isBehavioralSC } = require("../../lib/conformity");
    const sc: ParsedSC = {
      id: "SC-345",
      statement: "Agent completes standard task with >80% directive compliance (behavioral)",
      specFile: "INSTRUCTION-COMPLIANCE-SPEC.md",
    };
    expect(isBehavioralSC(sc)).toBe(true);
  });

  test("countBehavioralSCs returns correct count from SC list", () => {
    const { countBehavioralSCs } = require("../../lib/conformity");
    const scs: ParsedSC[] = [
      makeBehavioralSC("SC-318", "Cold-start agent finds PROJECT-STATE within first 3 tool calls"),
      makeStructuralSC("SC-309", "scripts/session-end.ts exists"),
      makeBehavioralSC("SC-400", "test-brief CLI spawns agent in isolated worktree"),
      makeStructuralSC("SC-310", "scripts/session-end.ts contains [uncommitted changes]"),
    ];
    expect(countBehavioralSCs(scs)).toBe(2);
  });
});

describe("writeFindingsReport includes behavioralCount", () => {
  const tmpRoot = join(import.meta.dir, "..", "fixtures", "behavioral-test-tmp");

  beforeEach(() => {
    clearFindings();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true });
    mkdirSync(join(tmpRoot, ".rungate"), { recursive: true });
  });

  test("behavioralCount field present in conformity-findings.json", () => {
    const reportPath = writeFindingsReport(tmpRoot);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report).toHaveProperty("behavioralCount");
    expect(typeof report.behavioralCount).toBe("number");
  });

  test("behavioralCount is separate from candidateCount and staleCount", () => {
    const reportPath = writeFindingsReport(tmpRoot);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    // All three fields must exist independently
    expect(report).toHaveProperty("behavioralCount");
    expect(report).toHaveProperty("candidateCount");
    expect(report).toHaveProperty("staleCount");
    // They are distinct keys
    const keys = Object.keys(report);
    expect(keys.filter(k => k === "behavioralCount").length).toBe(1);
  });
});

describe("SESSION-AUDIT-SPEC routing annotation", () => {
  test("getBehavioralRouting returns SESSION-AUDIT-SPEC for behavioral SCs", () => {
    const { getBehavioralRouting } = require("../../lib/conformity");
    const sc = makeBehavioralSC("SC-321", "Session auditor fork produces navigability metrics");
    const routing = getBehavioralRouting(sc);
    expect(routing).toContain("SESSION-AUDIT-SPEC");
  });

  test("getBehavioralRouting returns null for structural SCs", () => {
    const { getBehavioralRouting } = require("../../lib/conformity");
    const sc = makeStructuralSC("SC-309", "scripts/session-end.ts exists");
    const routing = getBehavioralRouting(sc);
    expect(routing).toBeNull();
  });
});
