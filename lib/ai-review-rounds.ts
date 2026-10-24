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
 * actually observe. `carryKey` therefore keys on the file, the normalised
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
 * So for as long as nothing re-emitted them, `reviewScopeForRound` delegated
 * gate 2 to `reReviewScope` and no round was ever narrowed. **`carryForward`
 * is what makes a diff-scoped round honest**: the unresolved earlier findings
 * are re-emitted by the ADJUDICATOR rather than re-discovered by the
 * reviewer, so they are in the payload whether or not the diff contains the
 * lines they name.
 *
 * That is now a production path rather than a plan — the generated
 * `ai-review-carry` step restates this module's walker in bash and reported
 * `2 finding(s) ... unanswered at this commit` on run `40137812549` — so
 * #1600 narrows from the floor below, gated on the carry having actually been
 * READ with no blind spots. See `reviewScopeForRound`.
 */

import {
  RE_REVIEW,
  REVIEW_CURRENT,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  SECURITY_REREVIEW_EXHAUSTED,
  reReviewDecision,
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
 * Anthropic's "after the first few passes". It is a FLOOR and not the
 * decision — `reviewScopeForRound` has a second gate below it.
 *
 * **Three, re-derived against this repository rather than inherited from the
 * cap it happens to equal (#1600).** Measured 2026-10-24 over the ai-review
 * ledgers of the 90 most recent pull requests, all 90 parseable. Counted in
 * DISTINCT ROUNDS and not in ledger entries — an entry is a run ATTEMPT and a
 * re-run appends another at the same round number (#1592). 202 entries
 * collapse to 161 distinct rounds here, 1.25x, which is the same direction and
 * near the 1.32x that measurement reports.
 *
 * | round | distinct rounds | share |
 * |---|---|---|
 * | 1 | 90 | 55.9% |
 * | 2 | 37 | 23.0% |
 * | 3 | 19 | 11.8% |
 * | 4 | 9 | 5.6% |
 * | 5 | 6 | 3.7% |
 *
 * The internal control on that reading: round 1 is 90, which is exactly the
 * number of pull requests, and every pull request that has a ledger has had a
 * first round. A round-1 count below the PR count would have meant the walk
 * was dropping entries.
 *
 * So the floor decides what share of rounds narrows: **>=2 is 44.1%, >=3 is
 * 21.1%, >=4 is 9.3%.** Three is taken because it leaves the first two rounds
 * of every pull request reading the whole branch. Round 2 is the round most
 * likely to reach a part of the branch round 1 never got to — the reviewer is
 * a sampled instrument, not an enumerated one, and two full draws is the
 * cheapest protection against that. A floor of 4 narrows 9.3% of rounds and
 * would be adoption on paper.
 *
 * **The cohort is right-censored**: an open pull request can still gain a
 * round, so the tail shares are a lower bound. That moves the >=3 share UP,
 * which is the direction that argues for this floor rather than against it.
 *
 * It equals `AI_REVIEW_ROUND_CAP` and is deliberately a SEPARATE constant:
 * they answer different questions — one bounds how many rounds an author
 * gets, the other says when a round may read less — and binding them would
 * make lowering the cap silently narrow earlier.
 */
export const AI_REVIEW_DIFF_SCOPE_FROM_ROUND = 3;

/**
 * The carry reading that makes a narrowed round honest.
 *
 * Declared again here and in `lib/scaffold/ai-review-step.ts` as
 * `AI_REVIEW_CARRY_READ`, and bound by an agreement assertion rather than an
 * import, for the reason every other constant in this file is: that module is
 * copied into a `mkdtemp` by the mutation batteries, where a relative
 * specifier does not resolve and the mutant fails to LOAD — which reads as a
 * behavioural difference on every row (`.claude/rules/self-referential-tests.md`,
 * Tier 1).
 */
export const AI_REVIEW_CARRY_READ_STATE = "AI_REVIEW_CARRY_READ";

/**
 * The carry step's reading, reduced to the two fields the scope depends on.
 *
 * Both `unknown`, because they arrive as text off a file written by a bash
 * step on a runner. `unmeasuredRounds` is the carry's own word for "rounds
 * this pull request recorded whose findings list could not be read", and it
 * is `"unknown"` when even that count could not be established.
 */
export interface CarryScopeReading {
  state: unknown;
  unmeasuredRounds: unknown;
  /**
   * How many paths this pull request changed, as the changed-files step
   * recorded them. A narrowed round is an instruction to read THIS list, so
   * a list that could not be read or that is empty is a `diff` scope naming
   * nothing — the one failure in this subsystem strictly worse than reading
   * too much, because a compliant reviewer then reads nothing at all.
   */
  changedFileCount: unknown;
}

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
 * FOUR gates, and all four must open. Anything else is `REVIEW_SCOPE_FULL`.
 *
 *  1. the round number is readable, and is at or past the floor above;
 *  2. the carry reading is `READ` — the earlier rounds were actually read;
 *  3. no recorded round of this pull request had an unreadable findings list;
 *  4. the changed-file list was read and names at least one path.
 *
 * FAILS CLOSED TOWARD READING MORE, in every half. An unreadable round, an
 * unreadable carry, a carry that could not count its own blind spots: all
 * full reviews. A narrowed round is the only outcome that can lose a finding,
 * so it is the one that has to be earned.
 *
 * ## Why the held-verdict gate is gone, and what replaced it (#1600)
 *
 * This function used to delegate gate 2 to `reReviewScope`, which refuses to
 * diff-scope anything but a held PASS. That rule is #244's and it is right in
 * the context it was written for — a ship run, where a held FAIL names code
 * the diff does not contain, so a diff-scoped re-review says nothing about
 * it. `reReviewScope` still governs that path through `reReviewBaseFor` and
 * is unchanged.
 *
 * It is the wrong gate HERE, and not because the risk went away. There is no
 * held verdict on a CI round, so a conjunction including it could never open
 * and this function would be a decider that always answers FULL — a
 * configuration that reads like a decision, which is the shape this
 * repository keeps paying for.
 *
 * What makes a narrowed round honest is the thing #244 said was missing:
 * `carryForward` re-emits every earlier finding whose cited line still reads
 * as it did, **whether or not that line is in the diff**, and the prompt
 * requires the reviewer to check each one against the code. So the finding a
 * diff-scoped round would have lost is in the payload by construction. That
 * is the spec's own declared retirement condition for this deviation —
 * *"an adjudicator re-emits unresolved findings"* — and it fired in
 * production on run `40137812549`, which carried 2.
 *
 * Gate 3 is the part that keeps gate 2 from being a formality. `READ` with
 * `unmeasuredRounds > 0` means the carried set is a LOWER BOUND: some
 * recorded round's findings could not be read, so a live earlier finding may
 * be absent from the list. Narrowing on top of that is exactly the silent
 * loss the deviation existed to prevent, with the carry present and saying so
 * in a warning nobody is required to read. `"unknown"` — the carry could not
 * even count them — is refused with the rest.
 *
 * Gate 4 is the asymmetric one. Gates 1-3 fail toward a reviewer reading MORE
 * than it needed to, which costs turns. Gate 4 is the only one whose absence
 * fails the other way: `diff` is an instruction to read the changed files,
 * and a changed-file list that could not be produced — the step warns
 * `CHANGED_FILES_UNREADABLE` and writes nothing — leaves a compliant reviewer
 * with nothing to read at all. The prompt also tells the reviewer to fall
 * back to `full` in that case, and that is a second line of defence rather
 * than this one: a prompt is a request, and whether the reviewer honours one
 * is the thing this whole criterion cannot yet measure.
 *
 * ## What this function does NOT establish
 *
 * That the reviewer HONOURS the scope. This returns a word; whether a
 * narrowed round's reads were confined is a behaviour, measurable only from a
 * real run, and #1533 measured the reviewer reading whole files under a
 * prompt that told it to. Treat a `diff` here as a request, and see
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` for why the observation is recorded
 * UNMEASURED rather than inferred from this value.
 */
export function reviewScopeForRound(rawRound: unknown, carry: unknown): ReviewScope {
  const round = readRoundNumber(rawRound);
  if (round === null || round < AI_REVIEW_DIFF_SCOPE_FROM_ROUND) return REVIEW_SCOPE_FULL;
  if (typeof carry !== "object" || carry === null || Array.isArray(carry)) return REVIEW_SCOPE_FULL;
  const c = carry as CarryScopeReading;
  if (c.state !== AI_REVIEW_CARRY_READ_STATE) return REVIEW_SCOPE_FULL;
  // Not `!= 0`, and not `Number(...)`: `""`, `" 0 "` and `"0x0"` all read as
  // zero through a coercion, and a blind-spot count nobody wrote is not a
  // count of zero. The carry writes a decimal integer or the word `unknown`.
  if (!isZeroCount(c.unmeasuredRounds)) return REVIEW_SCOPE_FULL;
  if (!isPositiveCount(c.changedFileCount)) return REVIEW_SCOPE_FULL;
  return REVIEW_SCOPE_DIFF;
}

/**
 * Exactly zero, written as a number or as the decimal string a shell emits.
 *
 * Not `== 0` and not `Number(v) === 0`: `""`, `null`, `false`, `[]` and
 * `" 0 "` all read as zero through a coercion, and a count nobody wrote is
 * not a count of none. `"unknown"` — the carry's own word for a blind-spot
 * count it could not establish — fails here, which is the point.
 */
function isZeroCount(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v) && v === 0;
  return v === "0";
}

/** A decimal integer of at least one, as a number or as a shell's string. */
function isPositiveCount(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) return false;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n >= 1;
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
 * @identity file+text+summary — `file`, the TEXT of the cited line (falling
 * back to the line NUMBER when the text is not known), and `summary`.
 * Partial: `null` for a finding it cannot key.
 *
 * **This is the PERSISTENCE key** — "is the thing this round raised the thing
 * the last round raised". It is the one the ledger's anchors are recorded
 * under ({@link AI_REVIEW_LEDGER_IDENTITY}) and the one that can refuse.
 *
 * Its sibling is `advisoryKey` in `lib/scaffold/ai-review-findings.ts`, which
 * is the ADJUDICATION key — "has this advisory already been counted on this
 * run" — over `file`+`summary` only, total, never `null`. The two were both
 * called `findingKey` until #1398 and they are deliberately different: a
 * line anchor here is what makes a re-summary of one file two findings
 * rather than one, and a line anchor THERE would split a single finding in
 * two across a reformat. Neither rule can quietly become the other —
 * measured, and both unification mutants are caught — but a call site could
 * not tell which question it was asking while they shared a name.
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
export function carryKey(finding: unknown, lineText?: unknown): string | null {
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
 * Keyed by `carryKey`, so a finding whose line number moved is still a
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
    const key = carryKey(f, lineTextFor?.(f));
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
    // NOTHING WAS RECORDED, so resolution is UNDECIDABLE — carry it.
    //
    // This branch is the whole of the reading half's first defect. Without
    // it, `normalise(undefined)` is `""`, which differs from any real line,
    // so a finding whose text was never recorded is read as RESOLVED and
    // dropped — silently, every time. Measured against the ledger #1319
    // actually writes, which recorded `{severity, file, line, summary}` and
    // no text: one finding in, zero carried out. An absent reading is not a
    // reading that cleared, and this is the same refusal `roundOutcome`
    // makes about an unreadable budget.
    if (typeof entry.recordedText !== "string") {
      out.push(entry.finding);
      continue;
    }
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

/* ───────────────── reading the ledger a previous round wrote ──────────────
 *
 * `lib/scaffold/ai-review-step.ts` upserts ONE comment per pull request
 * holding one JSON entry per review round (#1319). Everything above this line
 * takes the prior rounds as a parameter, deliberately — a function that
 * fetches its own evidence cannot be given a negative control. This is the
 * part that turns that comment into the parameter.
 *
 * The two properties it exists to hold, both of which are easy to lose:
 *
 *  1. **Identity is stated, not assumed.** The ledger stamps the rule its
 *     anchors were recorded under. A reader that meets a rule it does not
 *     know refuses to form keys rather than keying under its own — because
 *     keying under the wrong rule does not fail, it silently compares two
 *     different things and suppresses live findings.
 *
 *  2. **"Nothing recorded" and "could not read what was recorded" are
 *     different facts.** `lib/config-loader.ts` makes the same distinction
 *     about an absent config versus a corrupt one, for the same reason: both
 *     yield nothing, and only one of them is a reading. Here the type carries
 *     it — an unmeasured reading does not HAVE a `keys` field, so a caller
 *     cannot reach for one without narrowing the status first.
 *
 * These four constants are declared again in `lib/scaffold/ai-review-step.ts`
 * and must agree. They are not imported from there, and that file must not
 * import this one: the mutation batteries build a mutant by copying that file
 * alone into a scratch directory, so a relative import added to it resolves
 * to nothing and the mutant fails to LOAD — which reads as a behavioural
 * difference on every row (`.claude/rules/self-referential-tests.md`, Tier 1).
 * `test/ai-review-ledger-read.test.ts` AC-R6 binds all four instead.
 */

/**
 * The identity rule the ledger's recorded anchors were formed under.
 *
 * Versioned in the string itself. A reader meeting an identity it does not
 * recognise carries the findings and declines to key them, so changing the
 * rule is a safe, one-sided operation: old rounds stop suppressing, and
 * nothing silently compares an old anchor against a new rule.
 */
export const AI_REVIEW_LEDGER_IDENTITY = "file+text+summary@v1";

/** The HTML comment that identifies the ledger comment. */
export const AI_REVIEW_LEDGER_COMMENT_MARKER = "<!-- rungate:ai-review-ledger:v1 -->";

/** The key the per-round findings array is recorded under. */
export const AI_REVIEW_LEDGER_FINDINGS_KEY = "findings";

/**
 * The key the round array hangs off in the windowed ledger shape.
 *
 * The ledger's JSON block was originally the array itself. That shape has no
 * position to say anything ABOUT the array, which is #1405: a ledger holding
 * twelve rounds because twelve is all there have been, and a ledger holding
 * twelve because it evicted eight, are byte-identical. The eviction is
 * announced in a warning annotation that lives in the job log and expires.
 */
export const AI_REVIEW_LEDGER_ROUNDS_KEY = "rounds";

/** The key holding how many rounds the window has dropped off the front. */
export const AI_REVIEW_LEDGER_TRUNCATED_KEY = "truncated";

/** The key holding the text at the cited line when the finding was raised. */
export const AI_REVIEW_LEDGER_FINDING_TEXT = "text";

/**
 * The key holding how many turns the reviewer spent on this round (#1380).
 *
 * #1380 measured 3 of 3 observable same-tree re-runs producing a DIFFERENT
 * verdict, the strongest being merge commit `99d50fc` at round 5 both times,
 * BLOCKED then CLEAN, at 51 turns and 52 against a cap of 80. The turn count
 * is the only candidate mechanism anyone has for that, and it is the one
 * thing about a round that nothing recorded.
 *
 * Mining the history cannot settle it: at the pre-#1198 26% payload rate,
 * n=20 readable same-tree pairs needs ~290 re-runs and 28 exist. So the
 * number has to be captured going forward or not at all, and this is the
 * position that already records `sha`, `run`, `attempt`, `round` and
 * `identity` per entry.
 */
export const AI_REVIEW_LEDGER_TURNS_KEY = "turns";

/**
 * The key holding the commit the reviewer actually read (#1380).
 *
 * NOT the same fact as `sha`, and that is the whole reason it exists. `sha`
 * is `github.event.pull_request.head.sha`; the review ran over whatever
 * `actions/checkout` put in the tree, which on a `pull_request` event is the
 * MERGE commit — head merged into the base as it stood when the run started.
 *
 * So two rounds sharing a `sha` are not two rounds over one tree: the base
 * moves without the head moving, and the reviewer sees different bytes. A
 * same-tree pair is two rounds sharing THIS field, and #1380's whole
 * conditioning caveat — 28 same-tree pairs, 3 readable — was derived from
 * merge commits off the Actions API because the ledger could not answer it.
 */
export const AI_REVIEW_LEDGER_MERGE_KEY = "merge";

/**
 * The key holding the verdict WORD the reviewer wrote beside its findings
 * (#1511).
 *
 * Not an adjudicated outcome and not derivable from `findings`. The payload
 * contract asks the reviewer for a word, `lib/scaffold/ai-review-findings.ts`
 * compares it to what the severities say, and a disagreement is a
 * CONTRADICTION — #1178's shape, measured at roughly a third of runs. A
 * reader handed findings alone can compute what the word SHOULD have been
 * and cannot recover what it WAS, so the contradiction is unobservable
 * through a ledger that does not record it.
 *
 * Which is what the ledger did until #1511, and why
 * `evals/ai-review-control/` could reach `QUIET`, `FIRED` and `MISSED` and
 * never `DETECTED`: every captured round scored `VERDICT_ABSENT`.
 *
 * Declared here and in `lib/scaffold/ai-review-step.ts` as
 * `AI_REVIEW_VERDICT_KEY`, bound by `AC-R6` in
 * `test/ai-review-ledger-read.test.ts` rather than by an import, because
 * that module must stay import-free — the mutation batteries copy it into a
 * temp directory where no relative specifier resolves.
 */
export const AI_REVIEW_LEDGER_VERDICT_KEY = "verdict";

/** The round predates #1511. Nobody tried to record a verdict word. */
export const AI_REVIEW_VERDICT_NOT_RECORDED = "AI_REVIEW_VERDICT_NOT_RECORDED";

/** The round tried to record a verdict word and found none to record. */
export const AI_REVIEW_VERDICT_UNREADABLE = "AI_REVIEW_VERDICT_UNREADABLE";

/** A verdict word was recorded. What it SAYS is the adjudicator's question. */
export const AI_REVIEW_VERDICT_RECORDED = "AI_REVIEW_VERDICT_RECORDED";

/**
 * The verdict word a round recorded, or why there is none.
 *
 * Three states and not two, the same split `turns` carries one key over and
 * for the same reason: a round written before #1511 has no key, and a round
 * written after it always has one. Collapsing them makes a ledger that never
 * recorded a verdict indistinguishable from a reviewer that wrote none.
 *
 * `word` is `unknown` and is **never validated here**. Whether `PASS` and
 * `BLOCK` are the only legal words is
 * `lib/scaffold/ai-review-findings.ts`' decision and it already makes it;
 * a second gate here would be two deciders answering one question, of which
 * a mutation leaves either one holding the case up. A ledger carrying
 * `MAYBE` reports `MAYBE`, and the adjudicator calls it
 * `VERDICT_UNRECOGNISED` — which is the truth about that round.
 */
export type LedgerVerdictReading =
  | { status: typeof AI_REVIEW_VERDICT_NOT_RECORDED }
  | { status: typeof AI_REVIEW_VERDICT_UNREADABLE }
  | { status: typeof AI_REVIEW_VERDICT_RECORDED; word: unknown };

/**
 * Read the verdict word off a ledger round.
 *
 * `undefined` — no key at all — is NOT_RECORDED. A JSON `null` is the
 * writer saying it looked and found nothing, which is UNREADABLE. Anything
 * else is carried through verbatim, including shapes no contract declares.
 */
export function readRoundVerdict(raw: unknown): LedgerVerdictReading {
  if (raw === undefined) return { status: AI_REVIEW_VERDICT_NOT_RECORDED };
  if (raw === null) return { status: AI_REVIEW_VERDICT_UNREADABLE };
  return { status: AI_REVIEW_VERDICT_RECORDED, word: raw };
}

/** The round predates #1380. Nobody tried to read a turn count. */
export const AI_REVIEW_TURNS_NOT_RECORDED = "AI_REVIEW_TURNS_NOT_RECORDED";

/** This round tried to read a turn count and could not. */
export const AI_REVIEW_TURNS_UNREADABLE = "AI_REVIEW_TURNS_UNREADABLE";

/** The turn count was read. */
export const AI_REVIEW_TURNS_READ = "AI_REVIEW_TURNS_READ";

/**
 * How many turns the reviewer spent, or why that is not known.
 *
 * The non-READ arms carry **no count field at all**, the construction
 * `LedgerTruncation` and `PriorState` already use here: a caller cannot
 * reach for a number without narrowing the status first, so "I could not
 * tell" has no way to be read as zero. `0` is the answer that matters —
 * a run whose execution file never arrived and a run that spent no turns
 * are not the same event, and a `?? 0` makes them one.
 *
 * THREE STATES AND NOT TWO. Absent is NOT_RECORDED and `null` is
 * UNREADABLE, which is the same split `findings` already carries one key
 * over: every round written before #1380 has no key, and a round written
 * after it always has one. Collapsing them would make a ledger that
 * measured nothing indistinguishable from a ledger written last week.
 */
export type TurnReading =
  | { status: typeof AI_REVIEW_TURNS_NOT_RECORDED }
  | { status: typeof AI_REVIEW_TURNS_UNREADABLE }
  | { status: typeof AI_REVIEW_TURNS_READ; turns: number };

/**
 * Read the turn count off a ledger round.
 *
 * `undefined` — no key at all — is NOT_RECORDED. Anything that is not a
 * non-negative integer is UNREADABLE rather than the nearest number: a
 * `"51"` the writer never produces, a float, a negative, `null` itself.
 * There is no branch that returns a count it had to repair.
 */
export function readRoundTurns(raw: unknown): TurnReading {
  if (raw === undefined) return { status: AI_REVIEW_TURNS_NOT_RECORDED };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return { status: AI_REVIEW_TURNS_UNREADABLE };
  }
  return { status: AI_REVIEW_TURNS_READ, turns: raw };
}

/** No ledger comment on this pull request. A MEASURED reading of nothing. */
export const AI_REVIEW_LEDGER_ABSENT = "AI_REVIEW_LEDGER_ABSENT";

/** A ledger is there and could not be read. NOT the same as absent. */
export const AI_REVIEW_LEDGER_UNREADABLE = "AI_REVIEW_LEDGER_UNREADABLE";

/** The ledger was read. */
export const AI_REVIEW_LEDGER_READ = "AI_REVIEW_LEDGER_READ";

/** Keyed on the file, the recorded TEXT of the cited line, and the summary. */
export const FINDING_IDENTITY_TEXT = "file+text+summary";

/**
 * Keyed on the file, the cited line NUMBER, and the summary.
 *
 * Weaker, and recorded as such rather than passed off as the above: the one
 * repeat this repository can demonstrate moved `:318` → `:375` between rounds
 * while staying byte-identical, so this key would have missed it.
 */
export const FINDING_IDENTITY_LINE = "file+line+summary";

/** No key could be formed. The finding is carried and suppresses nothing. */
export const FINDING_IDENTITY_NONE = "unclassifiable";

export type FindingIdentity =
  | typeof FINDING_IDENTITY_TEXT
  | typeof FINDING_IDENTITY_LINE
  | typeof FINDING_IDENTITY_NONE;

export interface LedgerRound {
  /** The round number the entry recorded, or null if it recorded none. */
  round: number | null;
  /** The pull request's HEAD commit at the round. NOT the tree reviewed. */
  sha: string;
  /**
   * The commit the reviewer actually read — see `AI_REVIEW_LEDGER_MERGE_KEY`.
   * `""` when the entry recorded none, which is every round before #1380.
   */
  mergeSha: string;
  /** How many turns the reviewer spent, or why that is unknown (#1380). */
  turns: TurnReading;
  /** The verdict word the reviewer wrote, or why there is none (#1511). */
  verdict: LedgerVerdictReading;
  /** False when the entry recorded `findings: null`, or was not an object. */
  measured: boolean;
  /** True when the entry stamped the identity rule this reader knows. */
  keyable: boolean;
  findings: ReviewFinding[];
}

/** How many rounds fell off the front of the window could not be established. */
export const AI_REVIEW_TRUNCATION_UNKNOWN = "AI_REVIEW_TRUNCATION_UNKNOWN";

/** The ledger states how many rounds it has dropped. `0` is a statement. */
export const AI_REVIEW_TRUNCATION_STATED = "AI_REVIEW_TRUNCATION_STATED";

/**
 * The round cap in force when every bare-array ledger in existence was
 * written (#1447).
 *
 * **Deliberately not `AI_REVIEW_LEDGER_MAX_ROUNDS`, and deliberately not
 * imported from it.** Two separate reasons, and they are both load-bearing:
 *
 * The derivation below — *a bare array shorter than its cap was never cut* —
 * is only sound against the cap that was in force when that array was
 * written. Binding it to the live cap would mean lowering the cap tomorrow
 * silently re-reads ledgers written months ago as complete when they were
 * truncated. It cannot do that here: the bare-array shape is CLOSED. #1405's
 * writer migrates every ledger it touches to `{rounds, truncated}`, so no new
 * bare array will ever be written and the population this constant describes
 * is fixed. A fact about history is spelled as a historical constant.
 *
 * The value is 12 because `AI_REVIEW_LEDGER_MAX_ROUNDS` has been 12 since it
 * was introduced in `41f2e93f` (#1168) and has never held another value —
 * checked rather than assumed, because a cap that had once been lower would
 * make every bare array between the old cap and 12 read as a complete history
 * when it had been cut. That is the direction `lib/rounds-to-pass.ts` warns
 * about in its own docblock: this metric's errors all flatter.
 *
 * And this module must gain no import. Mutation batteries copy it into a
 * tmpdir, where a relative import dies on module resolution and the mutant
 * reads as a refusal rather than as a guard that held —
 * `.claude/rules/self-referential-tests.md`, Tier 1.
 */
export const AI_REVIEW_LEGACY_LEDGER_CAP = 12;

/**
 * Whether the rounds in hand are the whole history.
 *
 * UNKNOWN carries **no count field at all**, the same construction
 * `PriorState` uses: a caller cannot reach for a number without narrowing the
 * status first, so "I could not tell" has no way to be read as zero. That is
 * the defect this type exists to make unrepresentable — on #1396 an
 * unreadable eviction count and "nothing was dropped" shared a `case` arm in
 * the shell, and the ledger was written having evicted rounds it did not
 * mention.
 *
 * A legacy ledger — the bare array, written before #1405 — is UNKNOWN and not
 * zero. It may well be complete, and nothing in it says so.
 */
export type LedgerTruncation =
  | { status: typeof AI_REVIEW_TRUNCATION_UNKNOWN; reason: string }
  | { status: typeof AI_REVIEW_TRUNCATION_STATED; dropped: number };

/**
 * The UNREADABLE arm, named so one construction site serves both a READING
 * of a ledger body and a SELECTION among comments. Two literals would be two
 * things to keep in step for one fact.
 */
export type LedgerUnreadable = {
  status: typeof AI_REVIEW_LEDGER_UNREADABLE;
  reason: string;
};

export type LedgerReading =
  | { status: typeof AI_REVIEW_LEDGER_ABSENT }
  | LedgerUnreadable
  | {
      status: typeof AI_REVIEW_LEDGER_READ;
      rounds: LedgerRound[];
      truncation: LedgerTruncation;
    };

/**
 * Say that the ledger could not be read, for a reason only the caller knows.
 *
 * The API call that lists a pull request's comments can fail, and when it
 * does the caller has no body to hand to `readLedger`. Without this it would
 * have to pass `null`, which reads as ABSENT — a failed fetch would then be
 * indistinguishable from a pull request on its first round, and every earlier
 * finding would silently stop being carried.
 */
export function ledgerUnreadable(reason: string): LedgerUnreadable {
  return { status: AI_REVIEW_LEDGER_UNREADABLE, reason };
}

/**
 * The login the ledger comment is written as, and the only one selected.
 *
 * **This clause is the load-bearing one, and the repository's own tracker is
 * the counter-example that makes it so.** The rationale this selection used
 * to carry said the conjunction was safe because *nothing else writes the
 * marker*. Measured against the live API on 2026-10-24, pull requests #1319
 * and #1386 each carry TWO comments containing
 * `AI_REVIEW_LEDGER_COMMENT_MARKER`: the ledger, written by
 * `github-actions[bot]`, and a `type: "User"` comment that quotes the marker
 * while discussing it. The marker is a quotable string and uniqueness of a
 * quotable string is not obtainable — so making the marker more exotic is
 * not the answer, and the login clause is what separates the two today.
 *
 * `lib/scaffold/ai-review-step.ts` declares the same string as
 * `AI_REVIEW_LEDGER_BOT_LOGIN` and `test/ai-review-ledger-selection.test.ts`
 * binds the two, rather than importing: that module is copied into a tmpdir
 * by mutation batteries, where a relative specifier dies on resolution.
 */
export const AI_REVIEW_LEDGER_BOT_LOGIN_NAME = "github-actions[bot]";

/**
 * How many comments on one pull request may be the ledger. **One.**
 *
 * The single site every ambiguity refusal below is routed through, so a test
 * can build a mutant copy of this module with the bound widened and watch
 * the refusal stop happening. Raise it and `selectLedgerComment` returns the
 * first match instead — which is the defect, performed and observed, rather
 * than a sentence claiming the guard works
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const AI_REVIEW_LEDGER_MAX_MATCHES = 1;

/**
 * A pull-request comment, reduced to the four fields the selection reads.
 *
 * Every field is `unknown` because they arrive from an API response that a
 * caller has at best parsed, never validated. A comment whose author block
 * is missing is not a comment this selection may adopt.
 */
export interface LedgerCandidate {
  id: unknown;
  body: unknown;
  login: unknown;
  type: unknown;
}

/** A candidate that passed the selection — every field narrowed. */
export interface LedgerComment {
  id: number;
  body: string;
  login: string;
  type: string;
}

/**
 * Which comment on a pull request IS the ledger, or why that is not knowable.
 *
 * Deliberately the same three statuses `LedgerReading` uses, because they are
 * the same three facts one step earlier: there is no ledger here, there is
 * something here that cannot be read as one, or here it is. A fourth status
 * would be a second vocabulary for a question already answered.
 */
export type LedgerSelection =
  | { status: typeof AI_REVIEW_LEDGER_ABSENT }
  | LedgerUnreadable
  | { status: typeof AI_REVIEW_LEDGER_READ; comment: LedgerComment };

/**
 * Pick the ledger out of a pull request's comments, or REFUSE.
 *
 * **Two matches is not a reading, and the first of them is not an answer.**
 * This is the whole of #1412: a reader handed more than one comment carrying
 * the ledger marker has no way to tell which document it is about, and a
 * wrong comment that parses is byte-indistinguishable from a right one — so
 * every number computed off it (rounds-to-pass, the unmeasured split, the
 * turn counts) would be read off a population nobody can name. Ambiguous and
 * absent are different states and neither one is a ledger.
 *
 * Three readings, and they are kept apart on purpose:
 *
 *   * **ABSENT** — no comment here was written by this bot carrying the
 *     marker. A MEASURED reading of nothing, correct and complete on round
 *     one, and the only one that licenses POSTing a first ledger.
 *   * **UNREADABLE** — more than one did. The reason names every id, because
 *     a refusal that does not say which documents collided is a refusal
 *     nobody can act on.
 *   * **READ** — exactly one, narrowed.
 *
 * A `type: "User"` comment quoting the marker is not a candidate and does
 * not make the reading ambiguous either: it is not a ledger, so it is not
 * one of the things that could be. See `AI_REVIEW_LEDGER_BOT_LOGIN_NAME` for
 * why that clause — and not the marker's supposed uniqueness — is what makes
 * this selection an identity.
 */
export function selectLedgerComment(
  comments: readonly LedgerCandidate[],
): LedgerSelection {
  const matches: LedgerComment[] = [];
  for (const c of comments) {
    if (c.type !== "Bot") continue;
    if (c.login !== AI_REVIEW_LEDGER_BOT_LOGIN_NAME) continue;
    if (typeof c.body !== "string") continue;
    if (!c.body.includes(AI_REVIEW_LEDGER_COMMENT_MARKER)) continue;
    if (typeof c.id !== "number" || !Number.isInteger(c.id)) {
      return ledgerUnreadable(
        `a comment written by ${AI_REVIEW_LEDGER_BOT_LOGIN_NAME} carries the ledger ` +
          `marker and reports ${JSON.stringify(c.id)} as its id, which is not one, so ` +
          "it cannot be addressed and is not being treated as absent",
      );
    }
    matches.push({ id: c.id, body: c.body, login: c.login, type: c.type });
  }
  if (matches.length === 0) return { status: AI_REVIEW_LEDGER_ABSENT };
  if (matches.length > AI_REVIEW_LEDGER_MAX_MATCHES) {
    return ledgerUnreadable(
      `${matches.length} comments on this pull request are written by ` +
        `${AI_REVIEW_LEDGER_BOT_LOGIN_NAME} and carry the ledger marker (ids ` +
        `${matches.map(m => m.id).join(", ")}), so which one is the ledger cannot be ` +
        "established. Refusing to read the first: a wrong ledger that parses is " +
        "indistinguishable from the right one afterwards",
    );
  }
  return { status: AI_REVIEW_LEDGER_READ, comment: matches[0] };
}

/**
 * Parse the ledger comment's body.
 *
 * `null`, `undefined` and a body without the marker are ABSENT: there is no
 * ledger, which is the correct and complete reading on round one. A body that
 * HAS the marker and whose JSON block is missing, truncated, unparseable or
 * neither of the two round shapes is UNREADABLE — never an empty ledger,
 * because treating a damaged ledger as empty discards every round it holds at
 * exactly the moment nothing can tell that it happened.
 *
 * Two round shapes are accepted and the reading says which was found through
 * `truncation`: a bare array, which is every ledger written before #1405 and
 * is still live on open pull requests, and `{rounds, truncated}`, which can
 * say how much of the history fell off the front of the window. Rejecting the
 * bare array would discard the history of every pull request mid-flight at
 * the moment the new writer merged.
 */
export function readLedger(body: unknown): LedgerReading {
  if (typeof body !== "string") return { status: AI_REVIEW_LEDGER_ABSENT };
  const marker = body.indexOf(AI_REVIEW_LEDGER_COMMENT_MARKER);
  if (marker === -1) return { status: AI_REVIEW_LEDGER_ABSENT };

  const fence = body.indexOf("```json", marker);
  if (fence === -1) {
    return ledgerUnreadable(
      "the ledger comment is present and holds no ```json block, so the rounds it " +
        "recorded cannot be read; it is not being treated as an empty ledger",
    );
  }
  const start = body.indexOf("\n", fence);
  const close = start === -1 ? -1 : body.indexOf("\n```", start);
  if (close === -1) {
    return ledgerUnreadable(
      "the ledger comment's ```json block is not closed, so it was truncated in " +
        "transit or in storage and the rounds it recorded cannot be read",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start + 1, close));
  } catch (e) {
    return ledgerUnreadable(
      `the ledger comment's JSON block could not be parsed (${
        e instanceof Error ? e.message : String(e)
      }), so the rounds it recorded cannot be read`,
    );
  }
  // Two shapes, and the older one is still on every open pull request that
  // has a ledger. A bare array is the pre-#1405 ledger: readable, and silent
  // about whether it is the whole history — but not therefore unknowable.
  if (Array.isArray(parsed)) {
    return {
      status: AI_REVIEW_LEDGER_READ,
      rounds: parsed.map(toLedgerRound),
      truncation: legacyTruncation(parsed.length),
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return ledgerUnreadable(
      `the ledger comment's JSON block is ${describe(parsed)} rather than an array of ` +
        "rounds, so the rounds it recorded cannot be read",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const rounds = obj[AI_REVIEW_LEDGER_ROUNDS_KEY];
  if (!Array.isArray(rounds)) {
    return ledgerUnreadable(
      `the ledger comment's JSON block is an object whose \`${AI_REVIEW_LEDGER_ROUNDS_KEY}\` ` +
        `is ${describe(rounds)} rather than an array, so the rounds it recorded cannot be read`,
    );
  }
  return {
    status: AI_REVIEW_LEDGER_READ,
    rounds: rounds.map(toLedgerRound),
    truncation: readTruncation(obj[AI_REVIEW_LEDGER_TRUNCATED_KEY]),
  };
}

/**
 * How deep a legacy bare-array ledger is, derived from its length (#1447).
 *
 * The list grows by exactly one entry per round and is only ever cut when it
 * reaches the cap, so **a length below the cap means the cut never ran** and
 * the array is the whole history. That is a derivation from the writer's
 * behaviour, not an assumption about it, and #1405's writer already makes the
 * identical one when it migrates such a ledger forward — this is the reader
 * catching up to it, for the ledgers no future round will ever touch.
 *
 * At or above the cap the length is a LOWER BOUND and nothing more: this
 * round's eviction is knowable and the ones before it are not, and writing
 * the bound as a count would hand a caller a number it cannot tell from a
 * total.
 *
 * The cheap wrong fix is to call every bare array complete. It passes every
 * case below the cap and is wrong at it, which is why
 * `test/ai-review-ledger-read.test.ts` puts 11 and 12 adjacent.
 */
function legacyTruncation(length: number): LedgerTruncation {
  if (length < AI_REVIEW_LEGACY_LEDGER_CAP) {
    return { status: AI_REVIEW_TRUNCATION_STATED, dropped: 0 };
  }
  return {
    status: AI_REVIEW_TRUNCATION_UNKNOWN,
    reason:
      `the ledger's JSON block is a bare array of ${length} rounds, the shape written ` +
      `before the \`${AI_REVIEW_LEDGER_TRUNCATED_KEY}\` count existed, and it is at or past ` +
      `the ${AI_REVIEW_LEGACY_LEDGER_CAP}-round cap those ledgers were written under. A ` +
      `shorter one could be derived complete — the list only grows by one per round and is ` +
      `only cut at the cap — but at the cap its length is a lower bound on the rounds it ` +
      `held and says nothing about how many fell off the front`,
  };
}

/**
 * Read the dropped-round count off a windowed ledger.
 *
 * A malformed count is UNKNOWN, never zero, and never a reason to refuse the
 * whole ledger: the rounds in hand are still real and still carryable. What
 * the caller must not be able to do is report the history as complete on the
 * strength of a field it could not read — which is exactly what a `?? 0`
 * here would let it do.
 */
function readTruncation(raw: unknown): LedgerTruncation {
  if (raw === undefined) {
    return {
      status: AI_REVIEW_TRUNCATION_UNKNOWN,
      reason:
        `the ledger is an object and carries no \`${AI_REVIEW_LEDGER_TRUNCATED_KEY}\` key, so ` +
        "it states nothing about rounds dropped off the front",
    };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      status: AI_REVIEW_TRUNCATION_UNKNOWN,
      reason:
        `the ledger's \`${AI_REVIEW_LEDGER_TRUNCATED_KEY}\` is ${describe(raw)} rather than a ` +
        "non-negative integer, so how many rounds it dropped cannot be established",
    };
  }
  return { status: AI_REVIEW_TRUNCATION_STATED, dropped: raw };
}

function toLedgerRound(raw: unknown): LedgerRound {
  // An entry that is not an object is a round that was recorded and cannot be
  // read. It is counted, not skipped: a round that vanishes from the count
  // makes a three-round pull request look like a two-round one.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // An unreadable entry has not stated a turn count, and it has not failed
    // to read one either — nobody got as far as asking. NOT_RECORDED, which
    // is also what every pre-#1380 round reads as.
    return {
      round: null,
      sha: "",
      mergeSha: "",
      turns: { status: AI_REVIEW_TURNS_NOT_RECORDED },
      // Nobody got as far as asking, which is NOT_RECORDED for the same
      // reason the turn count above is: an entry that is not an object has
      // not stated a verdict and has not failed to state one.
      verdict: { status: AI_REVIEW_VERDICT_NOT_RECORDED },
      measured: false,
      keyable: false,
      findings: [],
    };
  }
  const e = raw as Record<string, unknown>;
  const list = e[AI_REVIEW_LEDGER_FINDINGS_KEY];
  const measured = Array.isArray(list);
  return {
    round: readRoundNumber(e.round),
    sha: typeof e.sha === "string" ? e.sha : "",
    mergeSha:
      typeof e[AI_REVIEW_LEDGER_MERGE_KEY] === "string"
        ? (e[AI_REVIEW_LEDGER_MERGE_KEY] as string)
        : "",
    turns: readRoundTurns(e[AI_REVIEW_LEDGER_TURNS_KEY]),
    verdict: readRoundVerdict(e[AI_REVIEW_LEDGER_VERDICT_KEY]),
    measured,
    keyable: e.identity === AI_REVIEW_LEDGER_IDENTITY,
    findings: measured
      ? (list as unknown[]).filter(
          (f): f is ReviewFinding => typeof f === "object" && f !== null && !Array.isArray(f),
        )
      : [],
  };
}

/** The prior state could not be established at all. */
export const AI_REVIEW_PRIOR_UNMEASURED = "AI_REVIEW_PRIOR_UNMEASURED";

/** The prior state was established — possibly as nothing. */
export const AI_REVIEW_PRIOR_MEASURED = "AI_REVIEW_PRIOR_MEASURED";

export interface PriorFinding {
  finding: ReviewFinding;
  /**
   * The text at the cited line when the finding was raised. Absent when the
   * ledger did not record one — and absent is UNDECIDABLE in `carryForward`,
   * not resolved.
   */
  recordedText?: string;
  /** Which rule formed this finding's key. Stated, so a caller can weigh it. */
  identity: FindingIdentity;
  /** The key, or null when no identity could be formed. */
  key: string | null;
  /** The round it was raised on, where the ledger recorded one. */
  round: number | null;
}

export type PriorState =
  | { status: typeof AI_REVIEW_PRIOR_UNMEASURED; reason: string }
  | {
      status: typeof AI_REVIEW_PRIOR_MEASURED;
      /** Keys earlier rounds raised, for `suppressRepeats`. */
      keys: string[];
      /** Everything earlier rounds raised, for `carryForward`. */
      prior: PriorFinding[];
      /** Rounds recorded whose findings were never read. */
      unmeasuredRounds: number;
      /** Rounds read under an identity rule this reader does not know. */
      unkeyableRounds: number;
    };

/**
 * Turn a ledger reading into what `suppressRepeats` and `carryForward` take.
 *
 * `PriorFinding` is assignable to `CarriedFinding`, so `prior` goes straight
 * into `carryForward` with no adapter between them — that join is the point
 * of the shape.
 *
 * **An UNREADABLE ledger returns a state with no `keys` and no `prior`.** Not
 * empty ones: absent ones. A caller holding an unmeasured state cannot
 * suppress a finding or resolve one, and the type stops it reaching for the
 * fields that would let it, instead of trusting it to check a boolean nobody
 * has to read.
 */
export function priorFindings(reading: LedgerReading): PriorState {
  if (reading.status === AI_REVIEW_LEDGER_UNREADABLE) {
    return { status: AI_REVIEW_PRIOR_UNMEASURED, reason: reading.reason };
  }
  if (reading.status === AI_REVIEW_LEDGER_ABSENT) {
    return {
      status: AI_REVIEW_PRIOR_MEASURED,
      keys: [],
      prior: [],
      unmeasuredRounds: 0,
      unkeyableRounds: 0,
    };
  }

  const keys: string[] = [];
  const prior: PriorFinding[] = [];
  let unmeasuredRounds = 0;
  let unkeyableRounds = 0;

  for (const round of reading.rounds) {
    if (!round.measured) {
      unmeasuredRounds++;
      continue;
    }
    if (!round.keyable) unkeyableRounds++;
    for (const finding of round.findings) {
      const recorded = finding[AI_REVIEW_LEDGER_FINDING_TEXT];
      const recordedText = typeof recorded === "string" ? recorded : undefined;
      let identity: FindingIdentity = FINDING_IDENTITY_NONE;
      let key: string | null = null;
      // Only a round stamped with the rule this reader knows gets a key. An
      // unrecognised rule is carried, never dropped, and never keyed.
      if (round.keyable) {
        key = carryKey(finding, recordedText);
        if (key !== null) {
          identity = normalise(recordedText) !== "" ? FINDING_IDENTITY_TEXT : FINDING_IDENTITY_LINE;
          keys.push(key);
        }
      }
      prior.push({ finding, recordedText, identity, key, round: round.round });
    }
  }

  return { status: AI_REVIEW_PRIOR_MEASURED, keys, prior, unmeasuredRounds, unkeyableRounds };
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
