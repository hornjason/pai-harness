/**
 * A review that produced no output does not conclude success (#732 AC-1/AC-2).
 *
 * Both runs on #732's table concluded SUCCESS having posted nothing, and the
 * job had no way to notice: `claude-code-action` reports success when the CLI
 * exits zero, and a CLI that made no tool calls and posted no comments exits
 * zero. `0`, `{}`, `null` and `SKIP` are indistinguishable from success —
 * `.claude/rules/config-access.md` — and so is a review that produced none.
 *
 * ## The table could not answer AC-2 either, which is the first thing fixed
 *
 * "tool calls of any kind: 0" is not readable from either run's log. The
 * action prints `Running Claude Code via SDK (full output hidden for
 * security)` and the JSON result block carries `num_turns: 7`,
 * `permission_denials_count: 0` and `total_cost_usd` and no per-tool record.
 * `num_turns: 13` with 4 denials in the other run is in fact evidence the
 * agent WAS attempting tool calls — the opposite of what the table argues.
 * So the count has to come from the action's `execution_file`, which nothing
 * was reading. `show_full_output: true` would also expose it and is NOT used:
 * it prints every tool RESULT into a log that is public on this repository,
 * which is the egress sink again by a different route.
 *
 * ## Four states, and the two that are not zero
 *
 * `EXECUTION_FILE_ABSENT` and `EXECUTION_FILE_UNREADABLE` are the instrument
 * failing. `REVIEW_COUNT_UNAVAILABLE` is the caller unable to count. None of
 * those is "no review was posted", and a reading that folded them into zero
 * would report a true-looking fact about a measurement that never happened —
 * `.claude/rules/checks-must-be-able-to-fail.md`'s third kind of zero.
 *
 * ## The cheapest wrong fix, named, and whether these cases survive it
 *
 * **Make the post-step `continue-on-error: true`.** The symptom an operator
 * sees is a red job on a PR that was reviewed fine, and one line makes it stop
 * while leaving the job green for a run that did nothing — #732 restored in
 * full. These cases survive it: nothing here reads the workflow's step
 * options, they read the SCRIPT's exit code, and the exit code is unchanged by
 * that repair. What would NOT survive it is a case asserting "the job fails",
 * which is the case not to write.
 *
 * **And the one that looks like hardening: assert only that the script
 * PRINTS `UNMEASURED`.** It passes under a script that prints and exits zero,
 * which is the whole defect. Every case below that cares reads the exit code.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_UNMEASURED_EXIT,
  reviewExecutionReading,
  reviewReadingReport,
} from "../lib/review-execution-reading";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "read-review-execution.ts");
const LIB = join(REPO, "lib", "review-execution-reading.ts");

/** An execution file holding `calls` tool uses, in the SDK's own shape. */
function executionFile(toolNames: string[]): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          ...toolNames.map((name, i) => ({
            type: "tool_use",
            id: `t${i}`,
            name,
            input: {},
          })),
        ],
      },
    },
    { type: "result", subtype: "success", num_turns: 7 },
  ]);
}

describe("a review that produced no output is UNMEASURED, not success (#732)", () => {
  test("AC-1: zero reviews on the pull request is UNMEASURED and says so by name", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile(["mcp__github__create_pending_pull_request_review"]),
      reviewsPosted: 0,
      diffTruncated: false,
    });
    expect(r.reading).toBe("UNMEASURED");
    expect(r.reasons).toContain("NO_REVIEW_POSTED");
    expect(r.toolCalls).toBe(1);
  });

  test("AC-2: zero tool calls is UNMEASURED even when a review somehow exists", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile([]),
      reviewsPosted: 3,
      diffTruncated: false,
    });
    expect(r.reading).toBe("UNMEASURED");
    expect(r.reasons).toEqual(["NO_TOOL_CALLS"]);
    expect(r.toolCalls).toBe(0);
  });

  /**
   * The two counts are not two deciders answering one question (fourth shape).
   * This is the input only the tool-call reading reaches and AC-1's is the
   * input only the review count reaches — each has a case nothing else can
   * satisfy, so neither can be deleted while the other holds the line.
   */
  test("AC-3: a run that called the posting tool and posted nothing is a DIFFERENT reading", () => {
    const tried = reviewExecutionReading({
      executionFileRaw: executionFile(["mcp__github__submit_pending_pull_request_review"]),
      reviewsPosted: 0,
      diffTruncated: false,
    });
    const neverTried = reviewExecutionReading({
      executionFileRaw: executionFile([]),
      reviewsPosted: 0,
      diffTruncated: false,
    });
    expect(tried.reasons).toEqual(["NO_REVIEW_POSTED"]);
    expect(neverTried.reasons).toEqual(["NO_TOOL_CALLS", "NO_REVIEW_POSTED"]);
    expect(reviewReadingReport(tried)).not.toEqual(reviewReadingReport(neverTried));
  });

  test("AC-4: an absent or unreadable execution file is UNMEASURED, not zero tool calls", () => {
    const absent = reviewExecutionReading({
      executionFileRaw: null,
      reviewsPosted: 2,
      diffTruncated: false,
    });
    expect(absent.reasons).toEqual(["EXECUTION_FILE_ABSENT"]);
    expect(absent.toolCalls).toBeNull();
    expect(absent.reasons).not.toContain("NO_TOOL_CALLS");

    const garbage = reviewExecutionReading({
      executionFileRaw: "Running Claude Code via SDK (full output hidden for security)",
      reviewsPosted: 2,
      diffTruncated: false,
    });
    expect(garbage.reasons).toEqual(["EXECUTION_FILE_UNREADABLE"]);
    expect(garbage.toolCalls).toBeNull();
  });

  test("AC-5: an uncounted review total is UNMEASURED, not zero reviews", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile(["mcp__github__add_comment_to_pending_review"]),
      reviewsPosted: null,
      diffTruncated: false,
    });
    expect(r.reasons).toEqual(["REVIEW_COUNT_UNAVAILABLE"]);
    expect(r.reasons).not.toContain("NO_REVIEW_POSTED");
  });

  test("AC-6: a truncated diff is UNMEASURED — a partial review is not a clean one", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile(["mcp__github__submit_pending_pull_request_review"]),
      reviewsPosted: 1,
      diffTruncated: true,
    });
    expect(r.reasons).toEqual(["DIFF_TRUNCATED"]);
  });

  /**
   * The positive control. Without it every case above is satisfied by a
   * reading that says UNMEASURED unconditionally, which is a refusal nobody
   * can clear and therefore a refusal everyone switches off.
   */
  test("AC-7: a run that called tools and posted a review is MEASURED", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile([
        "mcp__github__create_pending_pull_request_review",
        "mcp__github__add_comment_to_pending_review",
        "mcp__github__submit_pending_pull_request_review",
      ]),
      reviewsPosted: 1,
      diffTruncated: false,
    });
    expect(r.reading).toBe("MEASURED");
    expect(r.reasons).toEqual([]);
    expect(r.toolCalls).toBe(3);
    expect(r.toolCallsByName["mcp__github__add_comment_to_pending_review"]).toBe(1);
  });

  test("AC-8: the report names every reason and every count — a warning nobody can act on is noise", () => {
    const r = reviewExecutionReading({
      executionFileRaw: executionFile([]),
      reviewsPosted: 0,
      diffTruncated: true,
    });
    const report = reviewReadingReport(r);
    for (const reason of r.reasons) expect(report).toContain(reason);
    expect(report).toContain("tool calls: 0");
    expect(report).toContain("reviews posted: 0");
    expect(reviewReadingReport(r).startsWith("UNMEASURED")).toBe(true);
  });
});

/**
 * The script's refusal, mutated.
 *
 * `scripts/rook-review-scope.ts`'s pattern (#129): one exported exit-code
 * constant, a mutant copy with it set to `0`, and each negative case run twice
 * — real refuses, mutant does not. The second assertion is the point. Without
 * it a case that later starts passing for an unrelated reason is
 * indistinguishable from a case that is genuinely caught.
 *
 * The constant lives in `lib/`, not in the script, because the reading needs
 * it too. So the mutant is a copy of BOTH files with the script's relative
 * import rewritten to an absolute path — otherwise the mutant dies on module
 * resolution, which exits non-zero and reads as the mutation having been
 * rejected on the merits.
 */
describe("the script's refusal is load-bearing (#732)", () => {
  const scriptSource = readFileSync(SCRIPT, "utf8");
  const libSource = readFileSync(LIB, "utf8");

  test("AC-9: the exit constant is the script's only non-zero exit", () => {
    const exits = [...scriptSource.matchAll(/process\.exit\(([^)]*)\)/g)].map(m => m[1].trim());
    expect(exits).toEqual(["REVIEW_UNMEASURED_EXIT"]);
    expect(REVIEW_UNMEASURED_EXIT).not.toBe(0);
    // One relative import, and it is the one the mutant rewrites. A second
    // would make the mutant die on module resolution.
    const relatives = [...scriptSource.matchAll(/from "(\.\.?\/[^"]+)"/g)].map(m => m[1]);
    expect(relatives).toEqual(["../lib/review-execution-reading"]);
  });

  function build(zeroed: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "r732-"));
    const lib = join(dir, "reading.ts");
    const declaration = "export const REVIEW_UNMEASURED_EXIT = 1;";
    if (!libSource.includes(declaration)) {
      throw new Error("could not build the mutant: the exit declaration appears 0 times");
    }
    writeFileSync(
      lib,
      zeroed
        ? libSource.replace(declaration, "export const REVIEW_UNMEASURED_EXIT = 0;")
        : libSource,
    );
    writeFileSync(
      join(dir, "script.ts"),
      scriptSource.replace('"../lib/review-execution-reading"', JSON.stringify(lib)),
    );
    return join(dir, "script.ts");
  }

  function run(script: string, args: string[]) {
    const p = Bun.spawnSync(["bun", script, ...args], { cwd: REPO });
    return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) };
  }

  const dir = mkdtempSync(join(tmpdir(), "r732-fixtures-"));
  const emptyRun = join(dir, "empty.json");
  writeFileSync(emptyRun, executionFile([]));
  const workingRun = join(dir, "worked.json");
  writeFileSync(workingRun, executionFile(["mcp__github__submit_pending_pull_request_review"]));

  test("AC-10: a run with zero tool calls refuses, and the mutant does not", () => {
    const real = run(build(false), ["--execution-file", emptyRun, "--reviews-posted", "0"]);
    expect(real.out).toContain("UNMEASURED");
    expect(real.out).toContain("NO_TOOL_CALLS");
    expect(real.code).not.toBe(0);

    const mutant = run(build(true), ["--execution-file", emptyRun, "--reviews-posted", "0"]);
    expect(mutant.out).toContain("UNMEASURED");
    expect(mutant.code).toBe(0);
  });

  test("AC-11: an absent execution file refuses — the state the two green runs were in", () => {
    const real = run(build(false), [
      "--execution-file",
      join(dir, "does-not-exist.json"),
      "--reviews-posted",
      "0",
    ]);
    expect(real.out).toContain("EXECUTION_FILE_ABSENT");
    expect(real.code).not.toBe(0);
  });

  /**
   * The positive control for the harness. A script that refuses everything
   * would pass AC-10 and AC-11 and be useless, and a spawn that failed to
   * resolve its imports exits non-zero and looks exactly like a refusal.
   */
  test("AC-12: a run that worked exits zero and says MEASURED", () => {
    const real = run(build(false), ["--execution-file", workingRun, "--reviews-posted", "1"]);
    expect(real.out).toContain("MEASURED");
    expect(real.out).not.toContain("UNMEASURED");
    expect(real.code).toBe(0);
  });

  test("AC-13: an uncountable review total refuses rather than reading as zero reviews", () => {
    const unknown = run(build(false), [
      "--execution-file",
      workingRun,
      "--reviews-posted",
      "unknown",
    ]);
    expect(unknown.out).toContain("REVIEW_COUNT_UNAVAILABLE");
    expect(unknown.out).not.toContain("NO_REVIEW_POSTED");
    expect(unknown.code).not.toBe(0);
  });
});
