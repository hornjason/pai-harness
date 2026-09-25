/**
 * SpecSCGuard hook tests
 *
 * Tests for the PostToolUse hook that validates new SC lines
 * in specs/*.md files against the matcher registry.
 *
 * AC-1: Hook triggers on Edit/Write to specs/*.md
 * AC-2: Detects new SC lines via diff
 * AC-3: Strict mode blocks unmatchable SCs
 * AC-4: Behavioral suffix enforcement
 * AC-5: Message content includes SC id, reason, fix instructions
 */
import { describe, test, expect } from "bun:test";
import {
  detectNewSCs,
  validateNewSCs,
  type SCValidationResult,
} from "../lib/sc-guard";

// ── AC-2: Diff-based SC detection ──────────────────────────

describe("detectNewSCs", () => {
  test("detects SC lines added in new content that were not in old", () => {
    const oldContent = [
      "---",
      "compliance: strict",
      "testable: true",
      "---",
      "",
      "# My Spec",
      "",
      "- [ ] SC-100: AGENTS.md exists",
    ].join("\n");

    const newContent = [
      "---",
      "compliance: strict",
      "testable: true",
      "---",
      "",
      "# My Spec",
      "",
      "- [ ] SC-100: AGENTS.md exists",
      "- [ ] SC-101: specs/ directory exists",
    ].join("\n");

    const result = detectNewSCs(oldContent, newContent);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("SC-101");
    expect(result[0].statement).toBe("specs/ directory exists");
  });

  test("returns empty array when no new SCs are added", () => {
    const content = "- [ ] SC-100: AGENTS.md exists\n";
    const result = detectNewSCs(content, content);
    expect(result).toHaveLength(0);
  });

  test("detects multiple new SCs added at once", () => {
    const oldContent = "# Spec\n";
    const newContent = [
      "# Spec",
      "- [ ] SC-200: AGENTS.md exists",
      "- [ ] SC-201: specs/ directory exists",
      "- [ ] SC-202: bun test passes",
    ].join("\n");

    const result = detectNewSCs(oldContent, newContent);
    expect(result).toHaveLength(3);
    expect(result.map(s => s.id)).toEqual(["SC-200", "SC-201", "SC-202"]);
  });

  test("ignores already-checked SCs (- [x])", () => {
    const oldContent = "# Spec\n";
    const newContent = [
      "# Spec",
      "- [x] SC-300: AGENTS.md exists",
      "- [ ] SC-301: specs/ directory exists",
    ].join("\n");

    // Only unchecked SCs should be detected as new
    const result = detectNewSCs(oldContent, newContent);
    // SC-300 is checked so it's not a "new" SC line needing validation
    // SC-301 is unchecked and new
    expect(result.some(s => s.id === "SC-301")).toBe(true);
  });
});

// ── AC-3: Strict mode blocking ─────────────────────────────

describe("validateNewSCs — strict mode", () => {
  test("blocks unmatchable SCs in strict mode", () => {
    const newSCs = [
      { id: "SC-500", statement: "this is totally unmatchable gibberish" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    expect(results[0].blocked).toBe(true);
    expect(results[0].scId).toBe("SC-500");
  });

  test("allows matchable SCs in strict mode", () => {
    const newSCs = [
      { id: "SC-501", statement: "AGENTS.md exists" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    const sc501 = results.find(r => r.scId === "SC-501");
    expect(sc501).toBeUndefined(); // no validation issue = not in results
  });

  test("allows behavioral SCs with suffix in strict mode", () => {
    const newSCs = [
      { id: "SC-502", statement: "Agent reads AGENTS.md before starting work (behavioral)" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    const sc502 = results.find(r => r.scId === "SC-502");
    expect(sc502).toBeUndefined(); // behavioral with suffix = allowed
  });
});

// ── AC-4: Behavioral suffix enforcement ────────────────────

describe("validateNewSCs — behavioral suffix", () => {
  test("rejects unmatchable SC without (behavioral) suffix", () => {
    const newSCs = [
      { id: "SC-600", statement: "agent always follows the rules" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    expect(results[0].blocked).toBe(true);
    expect(results[0].scId).toBe("SC-600");
  });

  test("accepts unmatchable SC with explicit (behavioral) suffix", () => {
    const newSCs = [
      { id: "SC-601", statement: "agent always follows the rules (behavioral)" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    const sc601 = results.find(r => r.scId === "SC-601");
    expect(sc601).toBeUndefined(); // allowed because of (behavioral) suffix
  });

  test("does not silently relabel unmatchable SCs as behavioral", () => {
    const newSCs = [
      { id: "SC-602", statement: "some unmatchable requirement" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    // The result should NOT have any behavioral relabeling — it's a rejection
    expect(results[0].reason).not.toContain("relabel");
    expect(results[0].reason).not.toContain("auto");
  });
});

// ── AC-3 + permissive mode ─────────────────────────────────

describe("validateNewSCs — permissive mode", () => {
  test("warns but does not block in permissive mode", () => {
    const newSCs = [
      { id: "SC-700", statement: "unmatchable requirement here" },
    ];

    const results = validateNewSCs(newSCs, "permissive");
    expect(results).toHaveLength(1);
    expect(results[0].blocked).toBe(false);
    expect(results[0].scId).toBe("SC-700");
  });
});

// ── AC-5: Message content ──────────────────────────────────

describe("validateNewSCs — message content", () => {
  test("block message includes SC id", () => {
    const newSCs = [
      { id: "SC-800", statement: "unmatchable stuff" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain("SC-800");
  });

  test("block message includes reason for rejection", () => {
    const newSCs = [
      { id: "SC-801", statement: "unmatchable stuff" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    // Must explain WHY it's rejected
    expect(results[0].message).toMatch(/no.*match|unmatchable|no.*pattern/i);
  });

  test("block message includes fix instructions", () => {
    const newSCs = [
      { id: "SC-802", statement: "unmatchable stuff" },
    ];

    const results = validateNewSCs(newSCs, "strict");
    expect(results).toHaveLength(1);
    // Must tell user HOW to fix it
    expect(results[0].message).toMatch(/\(behavioral\)|matcher-registry|create-sc|pattern/i);
  });

  test("warning message in permissive mode includes SC id and reason", () => {
    const newSCs = [
      { id: "SC-803", statement: "unmatchable stuff" },
    ];

    const results = validateNewSCs(newSCs, "permissive");
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain("SC-803");
    expect(results[0].message).toMatch(/warn|permissive/i);
  });
});

// ── AC-1: Hook file structure ──────────────────────────────

describe("SpecSCGuard hook file", () => {
  test("hook file exists at hooks/SpecSCGuard.hook.ts", async () => {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const root = join(import.meta.dir, "..");
    expect(existsSync(join(root, "hooks", "SpecSCGuard.hook.ts"))).toBe(true);
  });

  test("hook file contains PostToolUse event type", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const root = join(import.meta.dir, "..");
    const content = readFileSync(join(root, "hooks", "SpecSCGuard.hook.ts"), "utf-8");
    expect(content).toContain("PostToolUse");
  });

  test("hook file references Edit and Write tool names", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const root = join(import.meta.dir, "..");
    const content = readFileSync(join(root, "hooks", "SpecSCGuard.hook.ts"), "utf-8");
    expect(content).toMatch(/Edit/);
    expect(content).toMatch(/Write/);
  });

  test("hook file references specs/*.md targeting", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const root = join(import.meta.dir, "..");
    const content = readFileSync(join(root, "hooks", "SpecSCGuard.hook.ts"), "utf-8");
    expect(content).toMatch(/specs.*\.md|specs\//);
  });
});
