/**
 * What did the review run actually DO? (#732 AC-1, AC-2)
 *
 * Both runs on #732's table concluded **success** having posted nothing. The
 * job had no way to notice: `claude-code-action` sets `conclusion: success`
 * when the CLI exits zero, and a CLI that produced no tool calls and no
 * comments exits zero. `0`, `{}`, `null` and `SKIP` are indistinguishable from
 * success — `.claude/rules/config-access.md` — and so is a review that
 * produced no output. `UNMEASURED` is the only reading that is not.
 *
 * Two facts, deliberately separate, because they can disagree and the
 * disagreement is the interesting case:
 *
 * - **tool calls** — what the agent did, read from the action's
 *   `execution_file` (`claude-execution-output.json`, a JSON array of SDK
 *   messages; a tool call is a `tool_use` content block on an assistant
 *   message). Zero is AC-2: the agent executed nothing, so whatever it
 *   concluded it concluded from nothing.
 * - **reviews THIS RUN added** — what GitHub holds after, minus what it held
 *   before, counted by the caller against the API. Zero is AC-1: nobody can
 *   read this run's review.
 *
 * **A DELTA, and not a total, and that is not a refinement.** The first live
 * dispatch of the fixed workflow posted one review on PR #746. A total would
 * then have read `1` for every subsequent run of that PR forever — including
 * a run that posted nothing, which is the exact state #732 is about. A
 * cumulative count makes the second run of any reviewed PR unfalsifiable, so
 * the before-count is taken before the agent starts and the reading is the
 * difference.
 *
 * These are not two deciders answering one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). An agent
 * that called the posting tool and had the API reject it has a non-zero tool
 * count and a zero review count, and that run is a different defect from one
 * that never tried. Folding them into one boolean would lose exactly that.
 *
 * ## The run's own table could not answer AC-2, which is why this exists
 *
 * #732's "tool calls of any kind: 0" is not readable from either run's log.
 * The action prints `Running Claude Code via SDK (full output hidden for
 * security)` and the JSON result block carries `num_turns`,
 * `permission_denials_count` and `total_cost_usd` and no per-tool record.
 * `num_turns: 13` with 4 denials is in fact evidence the agent WAS attempting
 * tool calls. The execution file is where the answer lives, and nothing was
 * reading it.
 *
 * ## One exit constant
 *
 * `scripts/read-review-execution.ts` routes its only refusal through
 * `REVIEW_UNMEASURED_EXIT`, declared once here, so a test can build a mutant
 * with it set to `0` and watch the refusal stop happening. A later branch that
 * inlines `process.exit(1)` would bypass the mutation and the case would go
 * green having witnessed nothing.
 */

/** The single non-zero exit a review reading refuses with. */
export const REVIEW_UNMEASURED_EXIT = 1;

export type ReviewUnmeasuredReason =
  | "EXECUTION_FILE_ABSENT"
  | "EXECUTION_FILE_UNREADABLE"
  | "NO_TOOL_CALLS"
  | "NO_REVIEW_POSTED"
  | "REVIEW_COUNT_UNAVAILABLE"
  | "DIFF_TRUNCATED";

export type ReviewExecutionReading = {
  reading: "MEASURED" | "UNMEASURED";
  /** `null` when the execution file could not be read at all. */
  toolCalls: number | null;
  /** Tool calls by tool name, for the annotation — "which door" needs names. */
  toolCallsByName: Record<string, number>;
  /** Reviews this run ADDED — after minus before. `null` when either
   * count could not be taken. */
  reviewsPosted: number | null;
  reasons: ReviewUnmeasuredReason[];
  /** One sentence per reason, in the same order. */
  detail: string[];
};

export type ReviewExecutionInput = {
  /** The contents of `claude-execution-output.json`, or `null` if absent. */
  executionFileRaw: string | null;
  /** Reviews this run ADDED — the PR's review count after the run minus its
   * count before it, or `null` when either could not be taken. A TOTAL would
   * make the second run of any reviewed PR unfalsifiable. */
  reviewsPosted: number | null;
  /** Whether the diff handed to the agent was cut short of the real one. */
  diffTruncated: boolean;
};

function countToolUses(raw: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const byName: Record<string, number> = {};
  for (const message of parsed) {
    const content = (message as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; name?: unknown };
      if (b?.type !== "tool_use") continue;
      const name = typeof b.name === "string" ? b.name : "<unnamed>";
      byName[name] = (byName[name] ?? 0) + 1;
    }
  }
  return byName;
}

/**
 * The one decider. `reading` and `reasons` are both projections of the same
 * list computed here and nowhere else, so they cannot disagree.
 */
export function reviewExecutionReading(input: ReviewExecutionInput): ReviewExecutionReading {
  const reasons: ReviewUnmeasuredReason[] = [];
  const detail: string[] = [];
  const add = (reason: ReviewUnmeasuredReason, why: string) => {
    reasons.push(reason);
    detail.push(why);
  };

  let toolCallsByName: Record<string, number> = {};
  let toolCalls: number | null = null;

  if (input.executionFileRaw === null) {
    add(
      "EXECUTION_FILE_ABSENT",
      "the action produced no execution_file, so nothing can say what the run did",
    );
  } else {
    const byName = countToolUses(input.executionFileRaw);
    if (byName === null) {
      add(
        "EXECUTION_FILE_UNREADABLE",
        "the execution file is not a JSON array of SDK messages — a reading that could not be " +
          "taken is not a reading that passed",
      );
    } else {
      toolCallsByName = byName;
      toolCalls = Object.values(byName).reduce((a, b) => a + b, 0);
      if (toolCalls === 0) {
        add(
          "NO_TOOL_CALLS",
          "the agent made zero tool calls of any kind: it executed nothing, so whatever it " +
            "concluded it concluded from nothing (AC-2)",
        );
      }
    }
  }

  if (input.reviewsPosted === null) {
    add(
      "REVIEW_COUNT_UNAVAILABLE",
      "the pull request's review count could not be taken before or after the run, so 'this " +
        "run posted a review' is unestablished rather than false",
    );
  } else if (input.reviewsPosted === 0) {
    add(
      "NO_REVIEW_POSTED",
      "this run added no review to the pull request: a review nobody can read is " +
        "indistinguishable from one that found nothing (AC-1)",
    );
  }

  if (input.diffTruncated) {
    add(
      "DIFF_TRUNCATED",
      "the diff handed to the agent was cut short, so part of the pull request was never looked " +
        "at — a partial review reported as a clean one is the same defect in miniature",
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    toolCalls,
    toolCallsByName,
    reviewsPosted: input.reviewsPosted,
    reasons,
    detail,
  };
}

/** The annotation body. Named reasons, named counts — a warning that does not
 * say what was missing is a warning nobody can act on. */
export function reviewReadingReport(r: ReviewExecutionReading): string {
  const calls =
    r.toolCalls === null
      ? "tool calls: UNREADABLE"
      : `tool calls: ${r.toolCalls}` +
        (r.toolCalls > 0
          ? ` (${Object.entries(r.toolCallsByName)
              .map(([n, c]) => `${n}×${c}`)
              .join(", ")})`
          : "");
  const reviews =
    r.reviewsPosted === null
      ? "reviews added by this run: UNCOUNTED"
      : `reviews added by this run: ${r.reviewsPosted}`;
  const head = `${r.reading} — ${calls}; ${reviews}`;
  if (r.reading === "MEASURED") return head;
  return [head, ...r.reasons.map((reason, i) => `  ${reason}: ${r.detail[i]}`)].join("\n");
}
