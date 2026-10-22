/**
 * Bounding review rounds on an open pull request (#1168).
 *
 * `lib/security-verdict.ts` already decides all of this for rook inside a
 * ship run: `reReviewDecision` caps rounds and fails closed on an unreadable
 * budget, `reReviewScope` works out that a stale FAIL and a stale PASS need
 * different re-review scopes, and `reviewIsCurrent` clears a finding when a
 * later commit replaced the code it was about. None of it is reachable from
 * CI, because it governs a ship run and the swarm bypasses ship.js.
 *
 * **This module does not reimplement any of it.** Every decision below
 * delegates to that file. What is added here is the part that file has no
 * opinion about: where a round NUMBER comes from on a pull request, and what
 * the reviewer should be told once the budget is spent.
 *
 * ## The measurement this was built from
 *
 * Anthropic report that `git blame` over what their reviewer kept flagging on
 * later rounds showed ~59% of it was code already present at the first pass —
 * the reviewer was finding a few more OLD bugs each round, not new ones.
 *
 * Measured here on 2026-10-22 over all 524 `AI Review` runs this repository
 * has ever had: the findings adjudicator has only existed since #1013, so the
 * whole population of blocking findings is 8, across 6 branches, and exactly
 * **2** of them are round-2-or-later. Both cite a line that was present at
 * round 1:
 *
 *   * `rg/1175`, round 2 flagged `lib/bash-write-guard.ts:375`
 *     (`LINK_CREATION`). The byte-identical line was at `:318` at round 1.
 *   * `fix/1129`, round 2 flagged `lib/launch-base.ts:184`
 *     (`canonical === given`). `git diff` between the two reviewed commits
 *     reports the file UNCHANGED.
 *
 * 2 of 2 is 100% on a denominator of 2. It is consistent with their 59% and
 * it is not a replication of it, and this module does not claim one.
 *
 * ## What that measurement changed in the design
 *
 * **A finding fingerprint may not be keyed on a line number.** The first case
 * above moved 318 → 375 between rounds while staying byte-identical, so a
 * `file:line` key would have failed to suppress the one repeat we can
 * actually observe. `findingKey` therefore keys on the file, the normalised
 * TEXT of the cited line, and the normalised summary.
 *
 * **`git blame` is the wrong instrument for this question.** It attributed
 * the first case to a commit that is not an ancestor of the round-1 head (the
 * branch was rebased between rounds) and the second to the round-2 commit
 * itself (the round-2 commit is an amend of the round-1 one). Blame would
 * have scored BOTH of our stale findings as fresh. Content presence is the
 * reading; authorship is not.
 *
 * ## Why diff-scoping a later round is not safe on its own
 *
 * Anthropic ship diff-only re-review after the first few passes. Applied
 * directly here that is `46034035` — the `fail-open-security-gate` this
 * repository found and reverted — because a diff against the flagged commit
 * does not contain the flagged code, so a later round that reads only the
 * diff says nothing about a finding raised earlier. Theirs is safe because
 * their findings are inline comments that PERSIST on the pull request and
 * block merge until they are answered; ours is a check-run annotation that
 * the next run replaces wholesale, so a finding not re-raised simply
 * disappears and the check goes green.
 *
 * So `reviewScopeForRound` delegates to `reReviewScope`, which refuses to
 * diff-scope anything but a held PASS, and `carryForward` is what makes a
 * diff-scoped round honest: the unresolved earlier findings are re-emitted by
 * the ADJUDICATOR rather than re-discovered by the reviewer.
 */

import {
  RE_REVIEW,
  REVIEW_CURRENT,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  SECURITY_REREVIEW_EXHAUSTED,
  reReviewDecision,
  reReviewScope,
  type ReviewScope,
} from "./security-verdict.ts";

export { REVIEW_SCOPE_DIFF, REVIEW_SCOPE_FULL, type ReviewScope };

/**
 * How many review rounds a pull request gets before the reviewer is told to
 * stop listing defects and assess the approach instead.
 *
 * Three, which is the number Anthropic shipped. Re-derived against this
 * repository rather than adopted: over 294 merged pull requests that had an
 * `AI Review` run, 22 (7.5%) went past three rounds, 13 (4.4%) reached five
 * or more, and the mean was 1.738. So a cap of three leaves 92.5% of pull
 * requests untouched and still reaches every run that has actually gone long.
 */
export const AI_REVIEW_ROUND_CAP = 3;

/**
 * The round from which a re-review may be scoped to the diff.
 *
 * Anthropic's "after the first few passes". Here it is the round AFTER the
 * first, and it is a floor rather than the decision: `reviewScopeForRound`
 * still refuses to diff-scope a round whose held verdict is not a PASS, which
 * is `reReviewScope`'s rule and the whole of #244.
 */
export const AI_REVIEW_DIFF_SCOPE_FROM_ROUND = 3;

/**
 * The round budget could not be read, so this job does not know which round
 * it is on.
 *
 * DECLARED ONCE, as an exported constant, for the reason
 * `SECURITY_REREVIEW_EXHAUSTED` is: a second spelling is a second refusal
 * path, reachable by code the first one's tests never visit.
 *
 * This is a REFUSAL and not a warning, and the reasoning is
 * `reReviewDecision`'s own — a budget nobody can read is not a budget with
 * room left in it. The specific fail-open it closes: an unreadable counter
 * makes round 12 indistinguishable from round 1, and reading it as round 1
 * resets the bound on every run, which is a cap that can never be reached.
 */
export const AI_REVIEW_ROUNDS_UNMEASURED = "AI_REVIEW_ROUNDS_UNMEASURED";

/** The review is within budget and reviews normally. */
export const AI_REVIEW_ROUND_OPEN = "AI_REVIEW_ROUND_OPEN";
/**
 * The budget is spent. The reviewer still speaks — see `atCapInstruction` —
 * it just stops enumerating defects and says something about the approach.
 */
export const AI_REVIEW_ROUND_AT_CAP = "AI_REVIEW_ROUND_AT_CAP";

export type RoundDecision =
  | typeof AI_REVIEW_ROUND_OPEN
  | typeof AI_REVIEW_ROUND_AT_CAP
  | typeof AI_REVIEW_ROUNDS_UNMEASURED;

export interface RoundOutcome {
  /** Exactly one of the three verdicts above. */
  decision: RoundDecision;
  /** The round this run is, or null when it could not be read. */
  round: number | null;
  /** Why the run is not in the ordinary state. Null — and only null — when it is. */
  reason: string | null;
}

/**
 * A round number as it arrives from the workflow: a decimal string on stdout,
 * or nothing.
 *
 * FAILS CLOSED. Anything that is not a positive decimal integer is null, and
 * null is the refusal above. `Number()` is not used: it reads `""` as 0,
 * `" 2 "` as 2 and `0x3` as 3, and a counter that accepts three spellings of
 * a number accepts inputs nobody has decided about.
 *
 * Zero is refused along with the rest. A run that is happening is at least
 * round 1, so a counter reporting 0 has not counted this run — which is a
 * different defect from an unreadable one and not one to paper over by
 * adding one to it.
 */
export function readRoundNumber(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isInteger(v) && v >= 1 ? v : null;
  }
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Which state is this round in?
 *
 * The cap arithmetic is NOT done here. It is handed to `reReviewDecision`,
 * which already answers "is there a round left in this budget" and already
 * fails closed on an unreadable one — so the two cannot be changed apart, and
 * a mutation of its `spent < cap` is observable through this function. The
 * currency argument is the stale shape on purpose: a run that is reviewing is
 * by definition reviewing something a previous round did not clear, so the
 * only question left for that function is the budget one.
 *
 * `roundsSpent` is `round - 1` — the rounds that are already over. At round
 * 4 with a cap of 3 that is 3 of 3 and the budget is gone, which is what
 * makes round 4 the first capped round and rounds 1-3 the three the author
 * gets.
 */
export function roundOutcome(raw: unknown, cap: unknown = AI_REVIEW_ROUND_CAP): RoundOutcome {
  const round = readRoundNumber(raw);
  if (round === null) {
    return {
      decision: AI_REVIEW_ROUNDS_UNMEASURED,
      round: null,
      reason:
        `the review-round counter read ${describe(raw)}, which is not a round number — ` +
        `this job cannot tell a first review from a twelfth, so the round budget is ` +
        `unreadable and refusing is the only reading that is not a guess`,
    };
  }

  const stale = {
    current: false,
    reason: `this is review round ${round} on this pull request`,
  };
  const outcome = reReviewDecision(stale, round - 1, cap);

  if (outcome.decision === RE_REVIEW) {
    return { decision: AI_REVIEW_ROUND_OPEN, round, reason: null };
  }
  // REVIEW_CURRENT cannot be reached: the currency handed in is always stale.
  // Checked anyway rather than folded into the exhaustion branch, because the
  // two mean opposite things and a later change to the currency above would
  // otherwise report "nothing to review" as "out of rounds".
  if (outcome.decision === REVIEW_CURRENT) {
    return { decision: AI_REVIEW_ROUND_OPEN, round, reason: null };
  }
  return {
    decision: AI_REVIEW_ROUND_AT_CAP,
    round,
    reason: outcome.reason,
  };
}

/**
 * The scope the reviewer should read on this round.
 *
 * Two gates, and BOTH must open. The round floor is Anthropic's "after the
 * first few passes"; `reReviewScope` is #244's refusal to diff-scope anything
 * but a held PASS. The second is the one that matters, and it is delegated
 * rather than restated: a diff against the flagged commit does not contain
 * the flagged code.
 *
 * FAILS CLOSED TOWARD READING MORE, in both halves. An unreadable round is a
 * full review, not a skipped one.
 */
export function reviewScopeForRound(rawRound: unknown, heldVerdict: unknown): ReviewScope {
  const round = readRoundNumber(rawRound);
  if (round === null || round < AI_REVIEW_DIFF_SCOPE_FROM_ROUND) return REVIEW_SCOPE_FULL;
  return reReviewScope(heldVerdict);
}

/** A finding as the payload contract spells it (`AI_REVIEW_FINDING_FIELDS`). */
export interface ReviewFinding {
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  summary?: unknown;
  failure_scenario?: unknown;
  [k: string]: unknown;
}

/**
 * Collapse the incidental differences between two spellings of one sentence.
 *
 * Case and whitespace only. Not punctuation, and not stemming: two findings
 * that differ in a word are two findings, and a key that erases the
 * difference suppresses a real one.
 */
function normalise(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

/**
 * The identity of a finding, for deciding whether it has already been raised.
 *
 * `file` + the TEXT of the cited line + `summary`. **Not the line number**,
 * and that is the measured part rather than a preference: the one repeat this
 * repository can actually show moved from `:318` to `:375` between rounds
 * while staying byte-identical, so a `file:line` key would have let it
 * through. See this module's header.
 *
 * `lineText` is the content at the cited line, supplied by the caller because
 * only the caller has the checkout. Absent or empty, the key falls back to
 * the line NUMBER — which is weaker, and is the honest answer when the line
 * cannot be read: a key that pretends to content it never saw would suppress
 * on a collision of empty strings, and that suppresses everything.
 *
 * Returns null for a finding with no `file` and no `summary`. There is
 * nothing to compare such a finding against, and giving it a key would make
 * every one of them a repeat of the first.
 */
export function findingKey(finding: unknown, lineText?: unknown): string | null {
  if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return null;
  const f = finding as ReviewFinding;
  const file = normalise(f.file);
  const summary = normalise(f.summary);
  if (!file && !summary) return null;
  const text = normalise(lineText);
  const anchor = text !== ""
    ? `t:${text}`
    : `n:${typeof f.line === "number" && Number.isInteger(f.line) ? f.line : ""}`;
  return `${file}\u0000${anchor}\u0000${summary}`;
}

export interface SuppressionReading {
  /** Findings this round may report. */
  kept: ReviewFinding[];
  /** Findings dropped because an earlier round already raised them. */
  suppressed: ReviewFinding[];
  /** One line per suppressed finding, for the annotation. */
  reasons: string[];
}

/**
 * Drop findings an earlier round already raised.
 *
 * Keyed by `findingKey`, so a finding whose line number moved is still a
 * repeat and a finding whose summary changed is not.
 *
 * **Within this round too.** A reviewer that lists the same defect twice in
 * one payload is the same waste as one that lists it on two rounds, and the
 * first occurrence is kept. An unkeyable finding (no file, no summary) is
 * always kept: it cannot be shown to be a repeat, and the direction this is
 * allowed to be wrong in is toward reporting.
 *
 * `priorKeys` is what earlier rounds raised. It is a parameter rather than
 * something read here, because only the caller can reach the pull request's
 * history, and a function that fetches its own evidence cannot be given a
 * negative control.
 */
export function suppressRepeats(
  fresh: unknown,
  priorKeys: Iterable<string>,
  lineTextFor?: (f: ReviewFinding) => string | undefined,
): SuppressionReading {
  const seen = new Set<string>(priorKeys);
  const kept: ReviewFinding[] = [];
  const suppressed: ReviewFinding[] = [];
  const reasons: string[] = [];
  const list = Array.isArray(fresh) ? fresh : [];

  for (const raw of list) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      kept.push(raw as ReviewFinding);
      continue;
    }
    const f = raw as ReviewFinding;
    const key = findingKey(f, lineTextFor?.(f));
    if (key === null || !seen.has(key)) {
      if (key !== null) seen.add(key);
      kept.push(f);
      continue;
    }
    suppressed.push(f);
    reasons.push(
      `${String(f.file ?? "(no file)")}: ${String(f.summary ?? "(no summary)")} — already ` +
        `raised on an earlier round of this pull request, so it is not raised again`,
    );
  }

  return { kept, suppressed, reasons };
}

/**
 * Which of an earlier round's findings are still unresolved at this commit?
 *
 * This is what makes a diff-scoped round honest. A diff-scoped reviewer never
 * reads the code an earlier finding was about, so if the adjudicator does not
 * re-emit the unresolved ones the finding vanishes and the check goes green —
 * `46034035` arriving by a different door.
 *
 * A finding is RESOLVED when the line it names is no longer the line it named:
 * `currentLineText` differs from the text recorded with the finding. It is
 * UNRESOLVED when the text is unchanged. When the text cannot be read at all
 * it is UNRESOLVED, because a finding nobody could check is not a finding
 * anybody cleared — the direction `reviewIsCurrent` also fails in.
 *
 * **It is a CONTENT comparison and not `reviewIsCurrent`, deliberately.**
 * That function compares two commit SHAs, which is the right reading for "is
 * this whole review still about this branch" and the wrong one for "is this
 * one finding still true". Measured on this repository's own two multi-round
 * cases: on `rg/1175` the branch was rebased between rounds, so the commit
 * that introduced the flagged line is not an ancestor of the round-1 head
 * even though the line is byte-identical in it; on `fix/1129` the round-2
 * commit is an amend of the round-1 one, so blame attributes a line to it
 * that it did not touch. Both findings were stale and a SHA or ancestry
 * reading calls both of them fresh. Content is the only reading that was
 * right on both.
 */
export interface CarriedFinding {
  finding: ReviewFinding;
  /** The text at the cited line when the finding was raised. */
  recordedText?: string;
}

export function carryForward(
  prior: readonly CarriedFinding[],
  currentLineText: (f: ReviewFinding) => string | undefined,
): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const entry of prior) {
    const now = currentLineText(entry.finding);
    if (typeof now !== "string") {
      out.push(entry.finding);
      continue;
    }
    if (normalise(now) !== normalise(entry.recordedText)) continue;
    out.push(entry.finding);
  }
  return out;
}

/**
 * What the reviewer is told once the budget is spent.
 *
 * **A cap is not a silencer.** A reviewer that goes quiet at round 4 has
 * handed the author a green check on a pull request three reviews have failed
 * to settle, which is the outcome the cap exists to prevent, not the one it
 * is for. So the reviewer still runs and still writes a payload; what changes
 * is the question it is answering.
 *
 * Emitted at a NON-blocking severity by contract — the text says so — because
 * "this approach is not converging" is not a defect at a line and the payload
 * contract refuses a blocking finding that cannot name one. The round that
 * blocks is the one that found the bug; this one is advice.
 */
export function atCapInstruction(round: number, cap: number = AI_REVIEW_ROUND_CAP): string {
  return (
    `THIS IS REVIEW ROUND ${round}. This pull request has already had ${cap} rounds of ` +
    `review and has not settled, so do not spend this round listing more defects.\n` +
    `\n` +
    `Step back and say something about the APPROACH instead. Three rounds that each ` +
    `found something is evidence about the change, not about the reviewer: the usual ` +
    `causes are a change that is doing more than one thing, a defect class being fixed ` +
    `one line at a time, or a design that makes the defect easy to reintroduce. Say ` +
    `which of those you think this is and what you would do instead.\n` +
    `\n` +
    `Write ONE finding, at a non-blocking severity, whose summary is that assessment. ` +
    `Do not raise it to a blocking severity: the budget being spent is not itself a ` +
    `defect at a line, and a blocking finding that cannot name one makes the whole ` +
    `review unreadable. Stay silent and the author gets a green check on a pull ` +
    `request three reviews could not settle, which is worse than either.`
  );
}

/**
 * The block appended to the prompt listing what has already been said.
 *
 * Handed to the reviewer as well as enforced by the adjudicator, and both on
 * purpose: the instruction saves the round, and the adjudicator makes the
 * saving checkable. An instruction nobody enforces is a request.
 */
export function noRepeatsInstruction(priorSummaries: readonly string[]): string {
  if (priorSummaries.length === 0) return "";
  const list = priorSummaries.map(s => `  - ${s}`).join("\n");
  return (
    `ALREADY RAISED ON AN EARLIER ROUND OF THIS PULL REQUEST. Do not report any of ` +
    `these again, at any severity, however you would word it:\n` +
    `${list}\n` +
    `\n` +
    `A later step drops a finding that matches one of these on the file, the text of ` +
    `the cited line and the summary — it does NOT match on the line number, so moving ` +
    `the same defect to a new line does not make it a new finding. Report what is new ` +
    `on this round, or report nothing.`
  );
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return "an object";
  return JSON.stringify(v);
}

export { SECURITY_REREVIEW_EXHAUSTED };
