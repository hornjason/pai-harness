import { describe, test, expect } from "bun:test";
import {
  checkCompliance,
  forbiddenCommandsIn,
  computeScore,
  formatReport,
  parseToolCalls,
  type ComplianceResult,
} from "../lib/transcript-checker.js";
import type { Directive } from "../lib/directive-extractor.js";
import { readFileSync } from "fs";
import { join } from "path";

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
    category: overrides.category || "quality",
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

/**
 * #343 — the forbidden-command check fired for one consumer only.
 *
 * `checkNeverDirective` carried `if (textLower.includes("make rebuild"))` —
 * one consumer's forbidden command, written into the harness. For every other
 * consumer that arm never matched, the directive fell through to
 * `status: "N/A"`, and `computeScore` excludes N/A from `checkable`. So the
 * rule went unenforced, the compliance score did not drop, and nothing named
 * the directive that had stopped being measured.
 *
 * Found by the sweep in #304, which was looking for hardcoded routes and
 * turned up hardcoded commands next to them.
 *
 * Covers SC-747, SC-748 of GATE-CONTRACTS-SPEC.md.
 */
describe("#343: a NEVER directive names its own forbidden command", () => {
  const never = (text: string) => [makeDirective({ type: "never", text })];
  const ran = (...cmds: string[]) =>
    makeTranscript(cmds.map(c => ({ name: "Bash", input: { command: c } })));
  const statusOf = (text: string, ...cmds: string[]) =>
    checkCompliance(never(text), ran(...cmds))[0].status;

  const DDB = "Never run `make rebuild` from the project root";
  const OTHER = "Never run `npm run deploy:prod`";

  test("the original consumer's command still works — no regression", () => {
    expect(statusOf(DDB, "make rebuild")).toBe("VIOLATED");
  });

  test("and is FOLLOWED when it was not run", () => {
    expect(statusOf(DDB, "bun test")).toBe("FOLLOWED");
  });

  test("a DIFFERENT consumer's command is enforced too — the whole issue", () => {
    // Before #343 this was N/A: unenforced, and invisible in the score
    // because computeScore drops N/A from the denominator.
    expect(statusOf(OTHER, "npm run deploy:prod"), "a non-DDB forbidden command is still unenforced")
      .toBe("VIOLATED");
  });

  test("and is FOLLOWED when that consumer did not run it", () => {
    // Paired control: a check reporting VIOLATED for everything satisfies
    // the case above on its own.
    expect(statusOf(OTHER, "npm test")).toBe("FOLLOWED");
  });

  test("several forbidden commands in one directive are all covered", () => {
    const d = "Never run `podman build` or `docker compose up` directly";
    expect(statusOf(d, "docker compose up -d")).toBe("VIOLATED");
    expect(statusOf(d, "podman build .")).toBe("VIOLATED");
    expect(statusOf(d, "echo hi")).toBe("FOLLOWED");
  });

  test("a backticked PATH is not treated as a command", () => {
    // The opposite failure, and the worse one. Reporting VIOLATED because
    // somebody ran a command containing the name of a file they were told
    // not to edit would make the check untrustworthy in the other direction.
    expect(forbiddenCommandsIn("Never edit `.github/workflows/ci.yml` directly")).toEqual([]);
    expect(forbiddenCommandsIn("Do not modify `CODE-MAP.md`")).toEqual([]);
    expect(forbiddenCommandsIn("Never touch `project-state.json`")).toEqual([]);
  });

  test("a directive naming no command at all stays N/A rather than guessing", () => {
    // `spawn` is caught by an earlier, more specific arm, so this uses a
    // directive no arm claims. Unmeasurable must stay unmeasured.
    expect(statusOf("Never leave a finished branch unpushed", "git status")).toBe("N/A");
  });

  test("the extractor finds nothing in a directive with no backticks", () => {
    expect(forbiddenCommandsIn("Never run the production rebuild")).toEqual([]);
  });

  test("a command containing a DOT is still a command", () => {
    // The first version carried an extra `token.includes(".")` guard in front
    // of COMMANDISH, added for safety. Mutating it away scored 0 red: the
    // regex already rejects every path on its own, so the line never changed
    // a path's verdict once. What it did was drop this — a real command,
    // silently unenforced by a guard that looked careful.
    expect(forbiddenCommandsIn("Never run `npm run deploy.prod`")).toEqual(["npm run deploy.prod"]);
    expect(statusOf("Never run `npm run deploy.prod`", "npm run deploy.prod")).toBe("VIOLATED");
  });

  test("the path rejection is load-bearing on its own", () => {
    // Paired with the case above: narrowing is only safe if the thing left
    // doing the work actually does it.
    for (const p of [".github/workflows/ci.yml", "CODE-MAP.md", "project-state.json", "make -C sub/dir build"]) {
      expect(forbiddenCommandsIn(`Never touch \`${p}\``), `${p} was read as a command`).toEqual([]);
    }
  });

  test("the hardcoded command is gone from the detector", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib", "transcript-checker.ts"), "utf-8");
    // Comments stripped crudely: this file's own explanation names the
    // command it exists to have removed, which would report itself.
    const code = src
      .split("\n")
      .filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code, "one consumer's command is back in the detector").not.toContain('includes("make rebuild")');
  });
});

