/**
 * Rounds-to-pass, reported beside recall (CRC-M11).
 *
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md). The audit entry it
 * answers reads: *"The round number is computed per run and retained nowhere.
 * Nothing tracks rounds-to-pass beside recall."* The first half stopped being
 * true when the ledger landed — `readLedger` returns a `LedgerRound[]` and
 * #1405 taught it to state how many rounds it evicted. This module is the
 * second half: turning those per-pull-request histories into the three
 * numbers the spec's target is written in.
 *
 * Those numbers, from the source the spec is drawn from:
 *
 * | | before | after |
 * |---|---|---|
 * | passed after one round | 65% | 78% |
 * | five or more rounds | 8.9% | 1.5% |
 * | **mean rounds to pass** | **2.08** | **1.32** |
 *
 * ## The reason this is not a one-line average
 *
 * **Averaging over pull requests that passed is survivorship, and it biases
 * the number in the flattering direction.** Every pull request still open at
 * round 6 is precisely the kind this metric exists to find, and it is exactly
 * the kind an average over merged pull requests drops. A review process that
 * got worse — more rounds, more abandonment — can therefore show a FALLING
 * mean rounds-to-pass, because the slow ones leave the population instead of
 * raising the number.
 *
 * So the mean is reported over the ones that passed, because that is what
 * "rounds to pass" means, and it is reported **beside the count that did not
 * pass and the rounds they have spent**. A mean with no `stillOpen` beside it
 * is not this metric, and `summariseRoundsToPass` has no way to emit one.
 *
 * `fiveOrMoreRate` is deliberately computed over the WHOLE measured
 * population, passed or not. It is the tail statistic, and a tail measured
 * only on survivors has had its tail cut off.
 *
 * ## What is UNMEASURED here, and why truncation is the sharp one
 *
 * A ledger that cannot say how many rounds it dropped gives a round count
 * that is a **lower bound, not a number**. Counting it at its visible length
 * silently understates every long history — the same direction as the
 * survivorship bias above, which is why it is refused rather than estimated.
 * `AI_REVIEW_TRUNCATION_STATED` with a `dropped` count IS measurable:
 * `rounds.length + dropped` is the total, and that is what #1405 was for.
 *
 * An absent ledger and an unreadable one are different facts and neither is
 * "one round" — `.claude/rules/config-access.md`'s *Silent Default
 * Substitution*, in a metric where the default is the most common value.
 *
 * A round whose entry recorded `findings: null` (`measured: false`) still
 * COUNTS as a round. The reviewer ran; what is unreadable is what it found,
 * which is a question about recall and not about how many times round the
 * loop went.
 */

import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_UNREADABLE,
  AI_REVIEW_TRUNCATION_STATED,
  type LedgerReading,
} from "./ai-review-rounds";

/** The tail bucket the spec's target names. */
export const LONG_REVIEW_ROUNDS = 5;

export type RoundsRefusal =
  /** No ledger comment on the pull request at all. */
  | "LEDGER_ABSENT"
  /** A ledger was found and could not be parsed. */
  | "LEDGER_UNREADABLE"
  /** The ledger cannot say how many rounds it evicted, so its length is a floor. */
  | "ROUNDS_TRUNCATION_UNKNOWN"
  /** The ledger parsed and holds no rounds, which is not a pull request reviewed once. */
  | "ROUNDS_EMPTY"
  /** A stated eviction count that is not a count. */
  | "ROUNDS_DROPPED_UNREADABLE";

/** One pull request's history, as the caller read it. */
export interface PullRequestRounds {
  readonly number: number;
  readonly ledger: LedgerReading;
  /**
   * Did this pull request PASS — merge, or otherwise reach the state the
   * rounds were spent getting to?
   *
   * Deliberately not `merged`: a consumer whose definition of passing is not
   * "merged" should be able to say so without this module having an opinion
   * about its workflow.
   */
  readonly passed: boolean;
}

export interface UnmeasuredPullRequest {
  readonly number: number;
  readonly refusal: RoundsRefusal;
  readonly detail: string;
}

export interface RoundsToPassReading {
  /**
   * Mean rounds taken by the pull requests that PASSED. `null` when none did,
   * or none was measurable — never 0, which is a real and different value.
   */
  readonly meanRoundsToPass: number | null;
  /** Share of PASSED pull requests that took exactly one round. `null` if none. */
  readonly passedAfterOneRoundRate: number | null;
  /**
   * Share of ALL measured pull requests at or over `LONG_REVIEW_ROUNDS`,
   * passed or not. Over the whole population on purpose — see the docblock.
   */
  readonly fiveOrMoreRate: number | null;
  /** How many measured pull requests passed, and how many have not. */
  readonly passedCount: number;
  readonly stillOpenCount: number;
  /** Rounds spent so far by the measured pull requests that have NOT passed. */
  readonly stillOpenRounds: readonly number[];
  /** Round count -> how many measured pull requests took it, passed or not. */
  readonly distribution: ReadonlyMap<number, number>;
  /** Every pull request that could not be counted, and why. */
  readonly unmeasured: readonly UnmeasuredPullRequest[];
}

/**
 * How many rounds this pull request has had, or a refusal.
 *
 * Exported because it is the single decision site this module's battery
 * mutates: every count in the summary comes through here, so a mutation of it
 * is a mutation of the whole metric. A later caller that counts
 * `rounds.length` itself bypasses the truncation refusal and the measurement
 * goes quietly optimistic — `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function roundsTaken(
  pr: PullRequestRounds,
): { rounds: number } | { refusal: RoundsRefusal; detail: string } {
  const { ledger } = pr;

  if (ledger.status === AI_REVIEW_LEDGER_ABSENT) {
    return {
      refusal: "LEDGER_ABSENT",
      detail:
        "No ledger comment on this pull request. That is not a pull request " +
        "reviewed once — it is one nothing recorded, and the two differ by " +
        "exactly the value this metric is most often wrong by.",
    };
  }
  if (ledger.status === AI_REVIEW_LEDGER_UNREADABLE) {
    return {
      refusal: "LEDGER_UNREADABLE",
      detail: `The ledger was found and could not be read: ${ledger.reason}`,
    };
  }

  if (ledger.truncation.status !== AI_REVIEW_TRUNCATION_STATED) {
    return {
      refusal: "ROUNDS_TRUNCATION_UNKNOWN",
      detail:
        `The ledger holds ${ledger.rounds.length} round(s) and cannot say how ` +
        `many it evicted (${ledger.truncation.reason}), so that figure is a ` +
        `LOWER BOUND and not a count. Counting it would understate exactly ` +
        `the long histories this metric exists to surface.`,
    };
  }

  const { dropped } = ledger.truncation;
  if (!Number.isInteger(dropped) || dropped < 0) {
    return {
      refusal: "ROUNDS_DROPPED_UNREADABLE",
      detail:
        `The ledger states an eviction count of ${JSON.stringify(dropped)}, ` +
        `which is not a number of rounds.`,
    };
  }

  const total = ledger.rounds.length + dropped;
  if (total === 0) {
    return {
      refusal: "ROUNDS_EMPTY",
      detail:
        "The ledger parsed, states nothing was evicted, and holds no rounds. " +
        "A pull request with no rounds has not passed review in one; it has " +
        "not had one.",
    };
  }
  return { rounds: total };
}

/**
 * The three numbers the spec's target is written in, plus what it took to
 * refuse the rest.
 *
 * An empty or wholly-unmeasurable population returns nulls, not zeros. A mean
 * of nothing is not 0, and a rate over nothing is not 0% — both of those read
 * as "perfect" on the dashboard this feeds.
 */
export function summariseRoundsToPass(
  prs: readonly PullRequestRounds[],
): RoundsToPassReading {
  const unmeasured: UnmeasuredPullRequest[] = [];
  const distribution = new Map<number, number>();
  const passedRounds: number[] = [];
  const stillOpenRounds: number[] = [];

  for (const pr of prs) {
    const taken = roundsTaken(pr);
    if ("refusal" in taken) {
      unmeasured.push({ number: pr.number, refusal: taken.refusal, detail: taken.detail });
      continue;
    }
    distribution.set(taken.rounds, (distribution.get(taken.rounds) ?? 0) + 1);
    (pr.passed ? passedRounds : stillOpenRounds).push(taken.rounds);
  }

  const measured = passedRounds.length + stillOpenRounds.length;
  const mean =
    passedRounds.length === 0
      ? null
      : passedRounds.reduce((a, b) => a + b, 0) / passedRounds.length;

  return {
    meanRoundsToPass: mean,
    passedAfterOneRoundRate:
      passedRounds.length === 0
        ? null
        : passedRounds.filter(r => r === 1).length / passedRounds.length,
    // Whole population, passed or not. A tail measured on survivors only has
    // had its tail cut off — the one line of this module worth re-reading.
    fiveOrMoreRate:
      measured === 0
        ? null
        : [...passedRounds, ...stillOpenRounds].filter(r => r >= LONG_REVIEW_ROUNDS)
            .length / measured,
    passedCount: passedRounds.length,
    stillOpenCount: stillOpenRounds.length,
    stillOpenRounds,
    distribution,
    unmeasured,
  };
}

/**
 * The reading as lines, for the eval runner to print beside recall.
 *
 * The unmeasured count is on the FIRST line, not a footnote. A rounds-to-pass
 * of 1.32 over four pull requests out of sixty is a different claim from the
 * same number over sixty, and a reader who has to scroll to learn which will
 * quote the one they saw first.
 */
export function formatRoundsToPass(reading: RoundsToPassReading): string[] {
  const pct = (v: number | null) => (v === null ? "UNMEASURED" : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null) => (v === null ? "UNMEASURED" : v.toFixed(2));
  const measured = reading.passedCount + reading.stillOpenCount;

  const lines = [
    `rounds-to-pass: measured ${measured}, unmeasured ${reading.unmeasured.length}` +
      ` (passed ${reading.passedCount}, still open ${reading.stillOpenCount})`,
    `  mean rounds to pass   ${num(reading.meanRoundsToPass)}   (target 1.32, from 2.08)`,
    `  passed after 1 round  ${pct(reading.passedAfterOneRoundRate)}   (target 78%, from 65%)`,
    `  ${LONG_REVIEW_ROUNDS}+ rounds            ${pct(reading.fiveOrMoreRate)}   ` +
      `(target 1.5%, from 8.9%; over ALL measured, not only those that passed)`,
  ];
  if (reading.stillOpenCount > 0) {
    lines.push(
      `  still open at rounds: ${[...reading.stillOpenRounds].sort((a, b) => b - a).join(", ")}` +
        ` — these are excluded from the mean BY DEFINITION and are why it flatters`,
    );
  }
  for (const u of reading.unmeasured) {
    lines.push(`  #${u.number} UNMEASURED ${u.refusal}: ${u.detail}`);
  }
  return lines;
}
