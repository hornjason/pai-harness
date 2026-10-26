/**
 * Turning a findings reading into inline review comments.
 *
 * Measured 2026-10-25 on `hornjason/asaCommandCenter`: across every merged
 * pull request, ai-review has created **zero** review threads. It emits
 * GitHub Actions annotations, which vanish with the run log. A
 * `required_conversation_resolution` gate was switched on against that, so
 * the gate has no producer and is inert.
 *
 * This file covers only the PURE half — which findings become comments, and
 * what each comment says. No network, no token, no workflow.
 *
 * Two facts from the REST contract shape it, and both were read from
 * GitHub's documentation rather than assumed:
 *
 *  - `path` and `commit_id` are required; `line` is "required unless using
 *    subject_type:file". So a finding whose line cannot be read is a
 *    FILE-LEVEL comment, not a dropped one.
 *  - A `line` outside the diff is refused with 422. Being in the changed
 *    set makes a finding locatable to a FILE; it does not prove the line
 *    sits in a hunk. That is why the caller must be able to demote, and why
 *    `line` is nullable here instead of being asserted.
 */
import { describe, expect, test } from "bun:test";
import {
  reviewThreadRequests,
  type AiReviewFindingsReading,
} from "../lib/scaffold/ai-review-findings";

/** A reading carrying just the fields this function reads. */
function reading(
  reported: unknown[] | null,
  unlocatableReported: unknown[] | null = null,
): AiReviewFindingsReading {
  return { reported, unlocatableReported } as unknown as AiReviewFindingsReading;
}

const located = { file: "src/a.ts", line: 12, summary: "off-by-one", failure_scenario: "n=0 underflows" };
const noLine = { file: "src/b.ts", summary: "no line given" };
const floating = { file: "src/c.ts", line: 3, summary: "not in the diff" };

describe("reviewThreadRequests", () => {
  test("a locatable finding becomes one comment carrying path, line and reason", () => {
    const out = reviewThreadRequests(reading([located]));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/a.ts");
    expect(out[0]!.line).toBe(12);
    expect(out[0]!.body).toContain("off-by-one");
    // The failure scenario is the half a reader acts on; a summary alone is
    // a label. If it is in the payload it has to reach the thread.
    expect(out[0]!.body).toContain("n=0 underflows");
  });

  test("an unlocatable finding is excluded", () => {
    const out = reviewThreadRequests(reading([located, floating], [floating]));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  test("CONTROL: that exclusion is the filter working, not an empty input", () => {
    // The same finding, with nothing marked unlocatable, MUST come through.
    // Without this the previous case passes just as well over a function
    // that returns a constant, or over a payload the reader never parsed.
    const out = reviewThreadRequests(reading([located, floating], []));
    expect(out.map((r) => r.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("a finding with no readable line is a file-level comment, not a dropped one", () => {
    const out = reviewThreadRequests(reading([noLine]));
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBeNull();
  });

  test("no findings produces no comments", () => {
    expect(reviewThreadRequests(reading([]))).toEqual([]);
    expect(reviewThreadRequests(reading(null))).toEqual([]);
  });

  test("the emitted path keeps the case the finding wrote", () => {
    // `normaliseRepoPath` lowercases, by design, because it exists to COMPARE
    // two spellings of one path. The REST API does not compare — it matches
    // the diff byte-for-byte and answers 422. So it is the predicate here and
    // never the value, and this is the case that tells those two apart.
    const out = reviewThreadRequests(reading([{ file: "src/Thing.ts", line: 4, summary: "x" }]));
    expect(out[0]!.path).toBe("src/Thing.ts");
  });

  test("a trailing :line in the path does not reach the API as part of the path", () => {
    const out = reviewThreadRequests(reading([{ file: "src/a.ts:88", summary: "x" }]));
    expect(out[0]!.path).toBe("src/a.ts");
    expect(out[0]!.line).toBe(88);
  });

  test("a finding naming no file is not guessed at", () => {
    const out = reviewThreadRequests(reading([{ summary: "something, somewhere" }]));
    expect(out).toEqual([]);
  });
});
