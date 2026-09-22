import { describe, test, expect } from "bun:test";
import {
  checkCompliance,
  computeScore,
  formatReport,
  parseToolCalls,
  type ComplianceResult,
} from "../lib/transcript-checker.js";
import type { Directive } from "../lib/directive-extractor.js";

// ── Test helpers ─────────────────────────────────────────

function makeTranscript(toolCalls: Array<{ name: string; input: Record<string, any> }>): string {
  return toolCalls
    .map((tc) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: tc.name, input: tc.input }],
        },
      })
    )
    .join("\n");
}

function makeDirective(overrides: Partial<Directive> & { type: Directive["type"] }): Directive {
  return {
    text: overrides.text || "test directive",
    type: overrides.type,
    line: overrides.line || 1,
    section: overrides.section || "Test",
    target: overrides.target,
  };
}

describe("transcript-checker", () => {
  test("parseToolCalls extracts tool calls from JSONL transcript", () => {
    const transcript = makeTranscript([
      { name: "Read", input: { file_path: "/project/AGENTS.md" } },
      { name: "Bash", input: { command: "bun test" } },
    ]);
    const calls = parseToolCalls(transcript);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("Read");
    expect(calls[1].name).toBe("Bash");
  });

  test("checkCompliance returns FOLLOWED for read directive when file was read (AC-3)", () => {
    const directives: Directive[] = [
      makeDirective({ type: "read", target: "AGENTS.md", text: "Read AGENTS.md" }),
    ];
    const transcript = makeTranscript([
      { name: "Read", input: { file_path: "/project/AGENTS.md" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("FOLLOWED");
    expect(results[0].evidence).toContain("AGENTS.md");
  });

  test("checkCompliance returns IGNORED for read directive when file was NOT read", () => {
    const directives: Directive[] = [
      makeDirective({ type: "read", target: "AGENTS.md", text: "Read AGENTS.md" }),
    ];
    const transcript = makeTranscript([
      { name: "Read", input: { file_path: "/project/package.json" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("IGNORED");
  });

  test("checkCompliance returns FOLLOWED for run directive when command was run", () => {
    const directives: Directive[] = [
      makeDirective({ type: "run", target: "bun test", text: "Run bun test" }),
    ];
    const transcript = makeTranscript([
      { name: "Bash", input: { command: "bun test" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("FOLLOWED");
  });

  test("checkCompliance returns FOLLOWED for never-cat directive when no cat used", () => {
    const directives: Directive[] = [
      makeDirective({ type: "never", text: "Use cat via Bash -- use Read tool instead" }),
    ];
    const transcript = makeTranscript([
      { name: "Read", input: { file_path: "/project/file.ts" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("FOLLOWED");
  });

  test("checkCompliance returns VIOLATED for never-cat directive when cat used", () => {
    const directives: Directive[] = [
      makeDirective({ type: "never", text: "Use cat via Bash -- use Read tool instead" }),
    ];
    const transcript = makeTranscript([
      { name: "Bash", input: { command: "cat /project/file.ts" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("VIOLATED");
  });

  test("checkCompliance handles always-type directives", () => {
    const directives: Directive[] = [
      makeDirective({ type: "always", text: "Read AGENTS.md before starting work" }),
    ];
    const transcript = makeTranscript([
      { name: "Read", input: { file_path: "/project/AGENTS.md" } },
      { name: "Edit", input: { file_path: "/project/lib/foo.ts" } },
    ]);
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("FOLLOWED");
  });

  test("computeScore calculates percentage correctly", () => {
    const results: ComplianceResult[] = [
      { directive: makeDirective({ type: "read" }), status: "FOLLOWED", evidence: "" },
      { directive: makeDirective({ type: "read" }), status: "FOLLOWED", evidence: "" },
      { directive: makeDirective({ type: "read" }), status: "IGNORED", evidence: "" },
      { directive: makeDirective({ type: "never" }), status: "N/A", evidence: "" },
    ];
    const { score, grade, followed, ignored, checkable } = computeScore(results);

    expect(followed).toBe(2);
    expect(ignored).toBe(1);
    expect(checkable).toBe(3); // N/A excluded
    expect(score).toBe(67); // 2/3 = 66.7 -> 67
    expect(grade).toBe("C");
  });

  test("formatReport contains FOLLOWED verdict enum (AC-3)", () => {
    const results: ComplianceResult[] = [
      { directive: makeDirective({ type: "read", text: "Read AGENTS.md" }), status: "FOLLOWED", evidence: "Found" },
    ];
    const report = formatReport("marcus", results, 0);

    expect(report).toContain("FOLLOWED");
  });

  test("formatReport contains LINE report column header (AC-4)", () => {
    const results: ComplianceResult[] = [
      { directive: makeDirective({ type: "read", text: "Read AGENTS.md", line: 5 }), status: "FOLLOWED", evidence: "Found" },
    ];
    const report = formatReport("marcus", results, 0);

    expect(report).toContain("LINE");
    expect(report).toContain("SECTION");
    expect(report).toContain("STATUS");
  });

  test("formatReport contains RepoRails count", () => {
    const results: ComplianceResult[] = [
      { directive: makeDirective({ type: "read", text: "Read AGENTS.md" }), status: "FOLLOWED", evidence: "Found" },
    ];
    const report = formatReport("marcus", results, 5);

    expect(report).toContain("RepoRails");
    expect(report).toContain("5");
  });

  test("handles malformed transcript gracefully", () => {
    const directives: Directive[] = [
      makeDirective({ type: "read", target: "AGENTS.md", text: "Read AGENTS.md" }),
    ];
    const transcript = "not valid json\nalso bad\n";
    const results = checkCompliance(directives, transcript);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("IGNORED");
  });

  test("empty transcript yields all IGNORED for read directives", () => {
    const directives: Directive[] = [
      makeDirective({ type: "read", target: "AGENTS.md", text: "Read AGENTS.md" }),
      makeDirective({ type: "read", target: "PROJECT-STATE.md", text: "Read PROJECT-STATE.md" }),
    ];
    const results = checkCompliance(directives, "");

    for (const r of results) {
      expect(r.status).toBe("IGNORED");
    }
  });
});
