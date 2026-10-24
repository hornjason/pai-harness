/**
 * ai-review-control/capture.ts — lift one round's findings out of the ai-review
 * ledger comment into a payload file, so `run.ts score` has something to read
 * (#1509).
 *
 * ## The step this replaces
 *
 * `README.md` used to say, between `stage` and `score`:
 *
 * ```
 * # …point a reviewer at it, collect the findings payload it writes…
 * ```
 *
 * There was no code behind that line, and the reason is structural rather than
 * lazy: the deployed reviewer is not pointable at a scratch directory. It runs
 * as the `ai-review` job on a pull request, writes its payload to a path under
 * the runner's temp directory, and that path is uploaded nowhere — the advisory
 * annotation says so in its own text. The only durable copy of anything the
 * reviewer wrote is the **ledger comment**, which records one entry per round.
 *
 * So this module is the capture half: ledger comment in, payload file out.
 *
 * ## What the ledger carries, MEASURED rather than assumed
 *
 * #1509 proposed the ledger as the cheapest capture path *because* it already
 * records `findings` per round "in the shape `score` wants". **It did not**,
 * and the gap was in two named fields. The writer's projection in
 * `lib/scaffold/ai-review-step.ts` was
 *
 * ```
 * [ .findings[] | {severity, file, line, summary} ]
 * ```
 *
 * plus a `text` anchor, and the round entry around it was
 * `{at, sha, merge, run, attempt, identity, round, turns, findings}`.
 *
 * | the payload contract wants | the ledger held | consequence for `score` |
 * |---|---|---|
 * | a `verdict` of `PASS` or `BLOCK` | nothing — no round entry had ever carried one | `VERDICT_ABSENT` on EVERY round, planted and clean alike |
 * | `failure_scenario` on every BLOCKING finding | projected away | `BLOCKING_FINDING_INCOMPLETE` on every blocking finding |
 * | `severity`, `file`, `line`, `summary` | all four | — |
 *
 * The second row decided what this instrument could measure. `DETECTED`
 * requires a BLOCKING finding at the declared location, and a blocking
 * finding read out of such a ledger is always incomplete — so a reading
 * captured that way could reach `QUIET`, `FIRED` and `MISSED` and not
 * `DETECTED`. Recall is the half the control exists for.
 *
 * **#1511 fixed the writer.** The projection carries `failure_scenario`, and
 * the round entry carries the `verdict` word the reviewer wrote. This module
 * now emits both into the payload, VERBATIM, which makes `DETECTED` reachable
 * on a round recorded by a current writer.
 *
 * **What it still refuses, and will keep refusing.** Two repairs were
 * available here and both were rejected before #1511 existed; neither becomes
 * acceptable now, and a round written by an OLDER writer still reads
 * UNMEASURED rather than being patched up:
 *
 * - **Synthesise the verdict** from the findings. It makes clean subjects
 *   readable, and it makes `CONTRADICTION` — the #1178 shape, a `BLOCK` over
 *   an all-advisory payload, at roughly a third of runs — structurally
 *   impossible to observe, because the word being compared would be derived
 *   from the thing it is compared against. Two deciders that cannot disagree.
 * - **Synthesise `failure_scenario`.** That is writing the content of a
 *   finding on the reviewer's behalf, which is the one thing a control may
 *   never do.
 *
 * A round whose `verdict` is `AI_REVIEW_VERDICT_NOT_RECORDED` was written
 * before the writer recorded one; a round whose `verdict` is
 * `AI_REVIEW_VERDICT_UNREADABLE` was written by a current writer that found
 * no word in the payload. Both emit a payload with no `verdict` key, which
 * reads `VERDICT_ABSENT` — true of both, and the detail line says which.
 *
 * ## Why the forge query is the caller's job
 *
 * `run.ts` already refuses to invoke a reviewer, and `rounds` already refuses
 * to query a tracker, for the reason stated there: a measurement that can only
 * run against one forge is not one a consumer can take. This takes the comment
 * BODY, in the same `{body}` shape `rounds` reads per entry, so the `gh`
 * invocation lives in the protocol and not in the instrument.
 */
import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_UNREADABLE,
  AI_REVIEW_LEDGER_VERDICT_KEY,
  AI_REVIEW_TRUNCATION_UNKNOWN,
  AI_REVIEW_VERDICT_NOT_RECORDED,
  AI_REVIEW_VERDICT_RECORDED,
  type LedgerReading,
  type LedgerRound,
} from "../../lib/ai-review-rounds";
import {
  AI_REVIEW_FINDINGS_KEY,
  readAiReviewFindings,
  type AiReviewOutcome,
  type AiReviewUnmeasuredReason,
} from "../../lib/scaffold/ai-review-findings";

/** Captured, or refused. There is no third state and no partial payload. */
export type RoundCaptureStatus = "CAPTURED" | "REFUSED";

/** What `score` will make of a captured payload, measured here, not promised. */
export interface CaptureScoreReading {
  outcome: AiReviewOutcome;
  unmeasuredReasons: AiReviewUnmeasuredReason[];
}

export interface RoundCapture {
  status: RoundCaptureStatus;
  /** The exact bytes to write, or `null` when nothing was captured. */
  payload: string | null;
  /** How many entries in the ledger recorded this round number. */
  draws: number;
  /**
   * What `readAiReviewFindings` says about the payload this capture produced —
   * `null` when nothing was produced.
   *
   * Computed HERE and carried, rather than left for the operator to discover
   * after the fact. A capture that hands back an UNMEASURED payload without
   * saying so is a capture that reads exactly like one that worked.
   */
  scoreReading: CaptureScoreReading | null;
  /** The producing code's own sentences. Never re-derived by a caller. */
  detail: string[];
}

function refused(detail: string[], draws = 0): RoundCapture {
  return { status: "REFUSED", payload: null, draws, scoreReading: null, detail };
}

/** `round 7`, or `an entry recording no round number`. */
function describeRound(entry: LedgerRound): string {
  return entry.round === null ? "an entry recording no round number" : `round ${entry.round}`;
}

/**
 * Select one round out of a ledger reading and render its findings as a
 * payload `run.ts score` can read.
 *
 * `draw` is 1-based and is REQUIRED when more than one entry records the same
 * round number. The reviewer is a sampled instrument (#1290, CRC-B3), a re-run
 * of a workflow run is a fresh draw, and the two attempts of one run on #1504
 * disagreed — `findings: null` then `findings: []`. So a ledger holding N
 * entries under one round number is holding N draws, and silently taking the
 * first would report one of them as "the" behaviour. Naming the draw is what
 * makes N visible to whoever records the reading.
 */
export function captureRoundPayload(
  reading: LedgerReading,
  round: number,
  draw: number | null,
): RoundCapture {
  if (reading.status === AI_REVIEW_LEDGER_ABSENT) {
    return refused([
      "no ledger comment was found on this pull request. ABSENT is a complete reading " +
        "of nothing, not an empty ledger, and a round cannot be selected out of it.",
    ]);
  }
  if (reading.status === AI_REVIEW_LEDGER_UNREADABLE) {
    return refused([
      `the ledger could not be read: ${reading.reason}. A ledger that could not be ` +
        "read is not a ledger with no rounds in it.",
    ]);
  }
  if (reading.status !== AI_REVIEW_LEDGER_READ) {
    return refused([`the ledger reading has an unrecognised status: ${String(reading)}`]);
  }

  const present = reading.rounds.map(describeRound).join(", ") || "no rounds at all";
  const matches = reading.rounds.filter(r => r.round === round);

  if (matches.length === 0) {
    return refused([
      `the ledger records no round ${round}. It holds ${present}.`,
      ...(reading.truncation.status === AI_REVIEW_TRUNCATION_UNKNOWN
        ? [
            "How many rounds fell off the front of this window is unknown, so the round " +
              "asked for may have been evicted rather than never written.",
          ]
        : []),
    ]);
  }

  if (matches.length > 1 && draw === null) {
    return refused(
      [
        `round ${round} was recorded ${matches.length} times. Those are ${matches.length} ` +
          "DRAWS of a sampled instrument, not one reading written down twice — a re-run " +
          "of a workflow run writes a fresh entry, and two attempts of one run have been " +
          "measured disagreeing on byte-identical input (#1504). Select one with " +
          `--draw 1..${matches.length}, and record all ${matches.length} outcomes.`,
      ],
      matches.length,
    );
  }

  const index = draw === null ? 1 : draw;
  if (!Number.isInteger(index) || index < 1 || index > matches.length) {
    return refused(
      [
        `--draw ${String(draw)} is not one of the ${matches.length} entr(ies) recording ` +
          `round ${round}. Draws are 1-based and in ledger order.`,
      ],
      matches.length,
    );
  }

  const entry = matches[index - 1]!;

  if (!entry.measured) {
    return refused(
      [
        `round ${round} draw ${index} recorded '${AI_REVIEW_FINDINGS_KEY}: null' — the ` +
          "reviewer's payload was absent or unparseable at the runner, so that round was " +
          "NOT measured. Writing an empty findings list here would turn 'nobody can say " +
          "what the reviewer found' into 'the reviewer found nothing', which are the two " +
          "facts this whole instrument exists to keep apart. Take another draw.",
      ],
      matches.length,
    );
  }

  // Carried VERBATIM. Nothing is added, nothing is renamed, nothing is
  // dropped — including the ledger's own `text` anchor, which the payload
  // reader ignores and which is the only evidence of what the cited line said
  // at the time.
  //
  // The `verdict` key is emitted only when the entry RECORDED one (#1511).
  // Emitting `verdict: null` for a round that recorded none would hand the
  // adjudicator a value nobody wrote, and `VERDICT_UNRECOGNISED` is a
  // different claim about the reviewer from `VERDICT_ABSENT`. Absent in the
  // ledger stays absent in the payload; which of the two absences it was is
  // said in the detail below, where it cannot be mistaken for data.
  const captured: Record<string, unknown> =
    entry.verdict.status === AI_REVIEW_VERDICT_RECORDED
      ? { [AI_REVIEW_LEDGER_VERDICT_KEY]: entry.verdict.word, [AI_REVIEW_FINDINGS_KEY]: entry.findings }
      : { [AI_REVIEW_FINDINGS_KEY]: entry.findings };
  const payload = `${JSON.stringify(captured, null, 2)}\n`;
  const scored = readAiReviewFindings(payload);

  const detail: string[] = [
    `captured round ${round}, draw ${index} of ${matches.length}, ` +
      `head ${entry.sha || "(none recorded)"}, tree ${entry.mergeSha || "(none recorded)"}, ` +
      `${entry.findings.length} finding(s).`,
  ];

  if (entry.verdict.status === AI_REVIEW_VERDICT_NOT_RECORDED) {
    detail.push(
      `this round entry carries no '${AI_REVIEW_LEDGER_VERDICT_KEY}' key at all, so it was ` +
        "written by a ledger writer from before #1511, when the word was never recorded. " +
        "It is not supplied here: deriving it from the findings would make CONTRADICTION " +
        "unobservable, because the word compared would come from the thing it is compared " +
        "against. Take a draw from a round recorded by a current writer.",
    );
  } else if (entry.verdict.status !== AI_REVIEW_VERDICT_RECORDED) {
    detail.push(
      `this round entry recorded '${AI_REVIEW_LEDGER_VERDICT_KEY}: null' — a current writer ` +
        "looked and found no word in the reviewer's payload. That is a reading, and it is " +
        "not repaired here.",
    );
  }

  if (scored.outcome === "UNMEASURED") {
    detail.push(
      `this payload reads UNMEASURED: ${scored.unmeasuredReasons.join(", ")}. The reading is ` +
        "UNMEASURED rather than repaired: deriving the verdict from the findings would make " +
        "CONTRADICTION unobservable, and writing a failure_scenario would be writing the " +
        "reviewer's finding for it. Since #1511 the writer records both, so an UNMEASURED " +
        "capture of a current round is a statement about what that round holds — not, as it " +
        "was before, a statement about what the ledger format can express.",
    );
    detail.push(...scored.detail);
  }

  return {
    status: "CAPTURED",
    payload,
    draws: matches.length,
    scoreReading: { outcome: scored.outcome, unmeasuredReasons: scored.unmeasuredReasons },
    detail,
  };
}
