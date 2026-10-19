#!/usr/bin/env bun
/**
 * Read what the Claude review run actually did, and refuse on UNMEASURED.
 *
 * Used by `.github/workflows/claude-review.yml`'s post-step (#732 AC-1/AC-2).
 * Every decision is `reviewExecutionReading`'s; this file reads argv, reads a
 * file, prints, and exits. There is exactly ONE `process.exit` with a non-zero
 * argument in it and that argument is `REVIEW_UNMEASURED_EXIT`, declared once
 * in `lib/review-execution-reading.ts` — so a mutant with the constant set to
 * `0` cannot be bypassed by a second inlined refusal.
 *
 * ```
 * bun scripts/read-review-execution.ts \
 *   --execution-file "$RUNNER_TEMP/claude-execution-output.json" \
 *   --reviews-posted 3 \
 *   --diff-truncated false
 * ```
 *
 * `--reviews-posted` absent, or the string `unknown`, means the caller could
 * not count: that is `REVIEW_COUNT_UNAVAILABLE`, not zero. An absent count and
 * a count of zero are different states and only one of them is a finding about
 * the review.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  REVIEW_UNMEASURED_EXIT,
  reviewExecutionReading,
  reviewReadingReport,
} from "../lib/review-execution-reading";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const executionFile = flag("execution-file");
const executionFileRaw =
  executionFile && existsSync(executionFile) ? readFileSync(executionFile, "utf8") : null;

const rawCount = flag("reviews-posted");
const reviewsPosted =
  rawCount === undefined || rawCount === "" || rawCount === "unknown" || !/^\d+$/.test(rawCount)
    ? null
    : Number(rawCount);

const reading = reviewExecutionReading({
  executionFileRaw,
  reviewsPosted,
  diffTruncated: flag("diff-truncated") === "true",
});

const report = reviewReadingReport(reading);
console.log(report);

if (reading.reading === "UNMEASURED") {
  // A GitHub annotation, so the state is visible on the run page and not only
  // in a log nobody opens. `::error::` collapses newlines, hence the join.
  console.log(`::error title=Claude review UNMEASURED::${report.split("\n").join(" | ")}`);
  process.exit(REVIEW_UNMEASURED_EXIT);
}
