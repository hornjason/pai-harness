/**
 * lib/ai-review-threads.ts — posting a review's findings onto the diff.
 *
 * #1612. Measured 2026-10-25 across every merged pull request on the
 * consumer that runs the generated `ai-review` job: zero review threads,
 * ever. The job's only output has been a GitHub Actions annotation, which
 * lives as long as the run log. A repository that switches
 * `required_conversation_resolution` on against that gets a gate whose
 * population is always empty — satisfied by construction.
 *
 * This module owns the half `reviewThreadRequests` does not: what happened
 * when the comments were sent. That matters because **zero comments posted
 * is the same observation in four different situations** — the review found
 * nothing, the review could not run, the token could not write, or this code
 * is broken. One channel, four mechanisms, which is the sixth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Collapsing them into a
 * boolean is how a producer stays dead without anybody noticing, which is
 * precisely the history being fixed here.
 *
 * So the outcome is NAMED, and exactly one of the names is a refusal.
 *
 * The HTTP call is injected rather than performed. Every decision below is
 * therefore reachable from a test over a recorded response, including the
 * two that only a live fork or a line outside a hunk would otherwise produce.
 */
import { reviewThreadRequests, type AiReviewFindingsReading } from "./scaffold/ai-review-findings";
import type { AiReviewThreadRequest } from "./scaffold/ai-review-findings";

/**
 * The single non-zero exit. Declared once, so a mutant can set it to `0` and
 * a case can observe the refusal disappearing — `.claude/rules/checks-must-be-able-to-fail.md`,
 * *For a script whose job is to exit non-zero*. A `process.exit(1)` or a
 * second literal anywhere in this module would bypass that mutation and the
 * case would go green over a refusal it never witnessed.
 */
export const AI_REVIEW_THREADS_REFUSAL = 1;

/**
 * What a posting round was, in the words that distinguish the four ways it
 * can produce no comments.
 *
 * | Outcome | Comments | Refusal | What it means |
 * |---|---|---|---|
 * | `POSTED` | ≥ 1 | no | the producer works |
 * | `NOTHING_TO_POST` | 0 | no | the review located nothing to anchor |
 * | `UNMEASURED` | 0 | no | there was no reading to post FROM |
 * | `DEGRADED_NO_WRITE` | 0 | no | the token cannot write; see below |
 * | `FAILED` | any | **yes** | the producer is broken |
 *
 * `UNMEASURED` is not a quieter `NOTHING_TO_POST`. A review that did not run
 * has not found zero findings, and a tree that cannot tell those apart is the
 * *Silent Default Substitution* anti-pattern in `.claude/rules/config-access.md`.
 */
export type AiReviewThreadOutcome =
  | "POSTED"
  | "NOTHING_TO_POST"
  | "UNMEASURED"
  | "DEGRADED_NO_WRITE"
  | "FAILED";

/** What the API said. `status` is `null` for a failure that never got one. */
export type AiReviewThreadResponse =
  | { ok: true }
  | { ok: false; status: number | null; message: string };

/** Sends one comment. The only thing in this module that touches a network. */
export type AiReviewThreadPoster = (
  request: AiReviewThreadRequest,
) => Promise<AiReviewThreadResponse>;

export interface AiReviewThreadsResult {
  outcome: AiReviewThreadOutcome;
  /** Comments this round meant to create. */
  attempted: number;
  /** Comments the API accepted. */
  posted: number;
  /** Of those, how many only succeeded after dropping to file level. */
  demoted: number;
  /** One sentence per thing worth reading, in the order it happened. */
  detail: string[];
}

/** HTTP 422 — the documented answer to a `line` outside a diff hunk. */
const UNPROCESSABLE = 422;
/** HTTP 403 — the documented answer to a token without `pull-requests: write`. */
const FORBIDDEN = 403;

/**
 * Post every comment a reading calls for, and say which of the four
 * no-comment states this was if none appeared.
 *
 * Three behaviours are worth stating because each has a cheaper wrong answer:
 *
 * **An UNMEASURED reading posts nothing and attempts nothing.** Not because
 * posting would fail, but because there is no reading to post from, and a
 * round that posted a guess would put the reviewer's absence on the diff as
 * though it were a finding.
 *
 * **A 422 demotes before it fails.** `line` is documented as "Required
 * unless using subject_type:file", and a line outside a hunk is refused with
 * 422. Being in the changed-file set locates a finding to a FILE and never
 * to a hunk, so this response is EXPECTED on a correct request and the
 * retry is part of the contract rather than error recovery. Only a 422 that
 * survives the demotion is a defect.
 *
 * **A 403 degrades and does not refuse — but only when it is the whole
 * story.** For a `pull_request` from a forked repository GitHub downgrades
 * write permissions to read regardless of what the workflow declares, unless
 * an admin enabled *Send write tokens to workflows from pull requests*. So on
 * a fork this producer cannot run, the adjudicator's annotation is still
 * produced, and failing here would red every fork pull request for something
 * the contributor cannot fix. What that must NOT do is become a blanket
 * excuse: a round that saw a 403 AND some other failure is `FAILED`, because
 * a broken producer hiding behind a fork is the fail-open this whole module
 * exists to prevent.
 */
export async function postReviewThreads(
  reading: AiReviewFindingsReading,
  post: AiReviewThreadPoster,
): Promise<AiReviewThreadsResult> {
  const detail: string[] = [];

  if (reading.outcome === "UNMEASURED") {
    detail.push(
      "the review produced no usable reading, so there was nothing to post — this is not a review that found nothing",
    );
    return { outcome: "UNMEASURED", attempted: 0, posted: 0, demoted: 0, detail };
  }

  const requests = reviewThreadRequests(reading);
  if (requests.length === 0) {
    detail.push("the reading located no finding that could be anchored to a path in this diff");
    return { outcome: "NOTHING_TO_POST", attempted: 0, posted: 0, demoted: 0, detail };
  }

  let posted = 0;
  let demoted = 0;
  let forbidden = 0;
  let failed = 0;

  for (const request of requests) {
    const where = request.line === null ? request.path : `${request.path}:${request.line}`;
    let answer = await post(request);

    // The demotion, and only from a line. A file-level request that is
    // refused has nothing left to drop.
    if (!answer.ok && answer.status === UNPROCESSABLE && request.line !== null) {
      detail.push(`${where}: line refused (422), retrying as a file-level comment`);
      answer = await post({ ...request, line: null });
      if (answer.ok) demoted += 1;
    }

    if (answer.ok) {
      posted += 1;
      continue;
    }
    if (answer.status === FORBIDDEN) {
      forbidden += 1;
      detail.push(
        `${where}: 403 — this token cannot write pull-request comments. A pull_request run from a ` +
          `fork is handed a read-only token whatever the workflow declares.`,
      );
      continue;
    }
    failed += 1;
    detail.push(`${where}: ${answer.status ?? "no status"} — ${answer.message}`);
  }

  // Order matters. A real failure outranks the fork excuse, and both outrank
  // a partial success — a round that posted three of four comments has lost
  // a finding and must say so.
  if (failed > 0) {
    return { outcome: "FAILED", attempted: requests.length, posted, demoted, detail };
  }
  if (forbidden > 0) {
    return { outcome: "DEGRADED_NO_WRITE", attempted: requests.length, posted, demoted, detail };
  }
  detail.push(
    `posted ${posted} review ${posted === 1 ? "comment" : "comments"}` +
      (demoted === 0 ? "" : `, ${demoted} at file level after a line was refused`),
  );
  return { outcome: "POSTED", attempted: requests.length, posted, demoted, detail };
}

/** The exit code a round's outcome earns. Only `FAILED` refuses. */
export function aiReviewThreadsExitCode(result: AiReviewThreadsResult): number {
  return result.outcome === "FAILED" ? AI_REVIEW_THREADS_REFUSAL : 0;
}
