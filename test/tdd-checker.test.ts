import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";
import { checkTDD, isSourcePath } from "../lib/transcript-checker.js";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Build a transcript from a compact event string.
 *
 * `T` writes a test file, `S` writes a source file, `R` runs the suite. Every
 * test above hand-writes three or four JSON lines, which is why none of them
 * is longer than four events — and the defect #240 is about only appears at
 * event eleven. A transcript has to be cheap to write before anyone writes a
 * realistic one.
 */
function transcriptOf(events: string): string {
  let t = 0;
  let s = 0;
  return [...events].map((e) => {
    if (e === "T") return `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/f${t++}.test.ts"}}]}}`;
    if (e === "S") return `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"lib/f${s++}.ts"}}]}}`;
    return '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}';
  }).join("\n");
}

describe("TDD sequence checker", () => {
  test("detects TDD pattern (test before source)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("TDD");
    expect(result.testFirst).toBe(true);
    expect(result.redPhase).toBe(true);
    expect(result.greenPhase).toBe(true);
  });

  test("detects TEST_AFTER pattern (source before test)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("TEST_AFTER");
    expect(result.testFirst).toBe(false);
  });

  test("detects NO_TESTS when no test files written", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("NO_TESTS");
  });

  test("detects missing red phase (no test run after test write)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.testFirst).toBe(true);
    expect(result.redPhase).toBe(false);
    expect(result.verdict).toBe("TEST_AFTER");
  });

  /**
   * The sequence below is not invented. It is `marcus-sub-235001` from run
   * `wf_18abb197-f03`, read off its transcript: tests written, run red, source
   * written, one more test file added, then the suite run NINE times.
   *
   * It was graded "no test run after writing source (missing green phase)",
   * which is a BLOCKING violation, and it returned SHIP_FAILED over work that
   * was already collected and committed at 38f861e7. A four-event fixture
   * cannot reach this — the state reset only bites once a test file is written
   * while a source write is still pending its green run.
   */
  test("#240: a test file written after source does not erase the green phase", () => {
    const result = checkTDD(transcriptOf("RTTTRSSSSTRRTRRRRRRR"));

    expect(result.greenPhase, result.evidence).toBe(true);
    expect(result.redPhase).toBe(true);
    expect(result.testFirst).toBe(true);
    expect(result.verdict).toBe("TDD");
  });

  test("#240: green still requires a run after the LAST source write", () => {
    // The fix must not become "any run anywhere after any source write". An
    // agent that runs the suite, then edits source and stops, has not shown a
    // green phase — and this is the case the whole check exists to catch.
    const result = checkTDD(transcriptOf("TRSRS"));

    expect(result.greenPhase).toBe(false);
    expect(result.verdict).toBe("TEST_AFTER");
    expect(result.evidence).toContain("missing green phase");
  });

  test("#240: red still requires a run before the source exists", () => {
    // Guards the other half: loosening red to "any run after any test write"
    // would make the post-source runs satisfy it retroactively.
    const result = checkTDD(transcriptOf("TSRR"));

    expect(result.redPhase).toBe(false);
    expect(result.greenPhase).toBe(true);
    expect(result.verdict).toBe("TEST_AFTER");
  });

  test("#240: gates/ and workflows/ are source", () => {
    // marcus-sub-235003 edited workflows/ship.js twice and graded NO_SOURCE —
    // "No source files written" — because isSource listed only lib, scripts
    // and src. The harness could not grade TDD on the harness.
    expect(isSourcePath("workflows/ship.js")).toBe(true);
    expect(isSourcePath("gates/gate-executor.ts")).toBe(true);
    expect(isSourcePath("hooks/TestSuiteGuard.hook.ts")).toBe(true);
  });

  test("#240: every directory this repo keeps source in is classified as source", () => {
    // Derived from the repo, not restated. A new top-level source directory
    // would otherwise be silently ungraded, which is how workflows/ and
    // gates/ came to be missing in the first place — they did not exist when
    // the list was written.
    const dirs = new Set(
      execSync("git ls-files '*.ts' '*.js'", { cwd: REPO_ROOT, encoding: "utf-8" })
        .split("\n")
        .filter((p) => p.includes("/") && !p.startsWith("test/"))
        .map((p) => p.split("/")[0]),
    );

    expect(dirs.size, "no source directories found — the derivation is broken").toBeGreaterThan(0);
    const unclassified = [...dirs].filter((d) => !isSourcePath(`${d}/file.ts`));
    expect(unclassified).toEqual([]);
  });

  test("sequence captures all events in order", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/bar.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/bar.ts"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.sequence.length).toBe(3);
    expect(result.sequence[0].type).toBe("TEST_RUN");
    expect(result.sequence[1].type).toBe("WRITE_TEST");
    expect(result.sequence[2].type).toBe("WRITE_SOURCE");
  });
});
