/**
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * The single decision site the battery mutates is `roundsTaken`; `M11-12`
 * asserts the summary routes every count through it, so a later caller that
 * reads `rounds.length` itself cannot bypass the truncation refusal and make
 * the metric quietly optimistic.
 *
 * What was broken to prove each case can fail, with predicted membership, is
 * on the pull request for #1437's follow-up.
 */

import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_UNREADABLE,
  AI_REVIEW_TRUNCATION_STATED,
  AI_REVIEW_TRUNCATION_UNKNOWN,
  type LedgerReading,
} from "../lib/ai-review-rounds";
import {
  LONG_REVIEW_ROUNDS,
  formatRoundsToPass,
  roundsTaken,
  summariseRoundsToPass,
  type PullRequestRounds,
} from "../lib/rounds-to-pass";

/** A ledger holding `n` rounds that states it evicted `dropped`. */
function ledger(n: number, dropped = 0): LedgerReading {
  return {
    status: AI_REVIEW_LEDGER_READ,
    rounds: Array.from({ length: n }, (_, i) => ({
      round: i + 1,
      sha: `sha${i}`,
      measured: true,
      keyable: true,
      findings: [],
    })),
    truncation: { status: AI_REVIEW_TRUNCATION_STATED, dropped },
  };
}

/** A ledger that cannot say what it dropped — the legacy bare array. */
function truncatedUnknown(n: number): LedgerReading {
  return {
    status: AI_REVIEW_LEDGER_READ,
    rounds: Array.from({ length: n }, (_, i) => ({
      round: i + 1,
      sha: `sha${i}`,
      measured: true,
      keyable: true,
      findings: [],
    })),
    truncation: { status: AI_REVIEW_TRUNCATION_UNKNOWN, reason: "legacy bare array" },
  };
}

const pr = (number: number, l: LedgerReading, passed: boolean): PullRequestRounds => ({
  number,
  ledger: l,
  passed,
});

describe("CRC-M11: rounds-to-pass, and what it refuses to count", () => {
  test("M11-1: a stated eviction count is ADDED, because that is what #1405 is for", () => {
    expect(roundsTaken(pr(1, ledger(2, 3), true))).toEqual({ rounds: 5 });
    expect(roundsTaken(pr(1, ledger(4, 0), true))).toEqual({ rounds: 4 });
  });

  test("M11-2: a ledger that cannot say what it dropped is UNMEASURED, not its length", () => {
    // The sharp one. A visible length is a LOWER BOUND, and counting it
    // understates exactly the long histories this metric exists to find —
    // the same direction as the survivorship bias, which is why it refuses
    // rather than estimates.
    const r = roundsTaken(pr(1, truncatedUnknown(4), true));
    expect(r).not.toEqual({ rounds: 4 });
    expect(r).toHaveProperty("refusal", "ROUNDS_TRUNCATION_UNKNOWN");
  });

  test("M11-3: absent and unreadable are different refusals, and neither is one round", () => {
    expect(roundsTaken(pr(1, { status: AI_REVIEW_LEDGER_ABSENT }, true))).toHaveProperty(
      "refusal",
      "LEDGER_ABSENT",
    );
    expect(
      roundsTaken(pr(1, { status: AI_REVIEW_LEDGER_UNREADABLE, reason: "bad json" }, true)),
    ).toHaveProperty("refusal", "LEDGER_UNREADABLE");
  });

  test("M11-4: a parsed ledger with no rounds has not had a review, so it is not one round", () => {
    expect(roundsTaken(pr(1, ledger(0, 0), true))).toHaveProperty("refusal", "ROUNDS_EMPTY");
  });

  test("M11-5: a stated eviction count that is not a count refuses", () => {
    for (const dropped of [-1, 1.5, Number.NaN, "3" as never, null as never]) {
      const l = { ...ledger(2), truncation: { status: AI_REVIEW_TRUNCATION_STATED, dropped } };
      expect(roundsTaken(pr(1, l as LedgerReading, true)), String(dropped)).toHaveProperty(
        "refusal",
        "ROUNDS_DROPPED_UNREADABLE",
      );
    }
  });
});

describe("CRC-M11: the summary, and the survivorship it refuses to hide", () => {
  test("M11-6: the mean is over the ones that PASSED, which is what the name means", () => {
    const r = summariseRoundsToPass([
      pr(1, ledger(1), true),
      pr(2, ledger(2), true),
      pr(3, ledger(3), true),
    ]);
    expect(r.meanRoundsToPass).toBe(2);
    expect(r.passedAfterOneRoundRate).toBeCloseTo(1 / 3);
  });

  test("M11-7: a pull request still open NEVER enters the mean, and is counted beside it", () => {
    // The whole analytical point. Adding a 9-round open PR must not move the
    // mean, and must be visible — a mean that silently drops the worst cases
    // is a metric that improves as the process gets worse.
    const passedOnly = summariseRoundsToPass([pr(1, ledger(1), true), pr(2, ledger(2), true)]);
    const withOpen = summariseRoundsToPass([
      pr(1, ledger(1), true),
      pr(2, ledger(2), true),
      pr(3, ledger(9), false),
    ]);
    expect(withOpen.meanRoundsToPass).toBe(passedOnly.meanRoundsToPass);
    expect(withOpen.stillOpenCount).toBe(1);
    expect(withOpen.stillOpenRounds).toEqual([9]);
  });

  test("M11-8: the 5+ rate IS over the whole population, so the open ones DO move it", () => {
    // The control for M11-7, pointed the other way. If both statistics
    // excluded the open pull requests, "exclude them" and "include them"
    // would be indistinguishable and M11-7 would pass vacuously.
    const passedOnly = summariseRoundsToPass([pr(1, ledger(1), true), pr(2, ledger(2), true)]);
    const withOpen = summariseRoundsToPass([
      pr(1, ledger(1), true),
      pr(2, ledger(2), true),
      pr(3, ledger(9), false),
    ]);
    expect(passedOnly.fiveOrMoreRate).toBe(0);
    expect(withOpen.fiveOrMoreRate).toBeCloseTo(1 / 3);
    expect(LONG_REVIEW_ROUNDS).toBe(5);
  });

  test("M11-9: an empty or wholly-unmeasurable population is null, never zero", () => {
    // 0.00 and 0% read as a perfect score on the dashboard this feeds.
    for (const population of [
      [],
      [pr(1, { status: AI_REVIEW_LEDGER_ABSENT }, true)],
      [pr(1, truncatedUnknown(3), true), pr(2, truncatedUnknown(4), false)],
    ]) {
      const r = summariseRoundsToPass(population);
      expect(r.meanRoundsToPass).toBeNull();
      expect(r.passedAfterOneRoundRate).toBeNull();
      expect(r.fiveOrMoreRate).toBeNull();
    }
  });

  test("M11-10: no pull request that passed means no mean, even with open ones measured", () => {
    const r = summariseRoundsToPass([pr(1, ledger(3), false), pr(2, ledger(6), false)]);
    expect(r.meanRoundsToPass).toBeNull();
    expect(r.passedAfterOneRoundRate).toBeNull();
    // But the tail statistic is still readable, because it does not need one.
    expect(r.fiveOrMoreRate).toBeCloseTo(1 / 2);
  });

  test("M11-11: every refused pull request is named with its reason", () => {
    const r = summariseRoundsToPass([
      pr(1, ledger(1), true),
      pr(2, { status: AI_REVIEW_LEDGER_ABSENT }, true),
      pr(3, truncatedUnknown(7), false),
    ]);
    expect(r.unmeasured.map(u => u.number)).toEqual([2, 3]);
    expect(r.unmeasured.map(u => u.refusal)).toEqual([
      "LEDGER_ABSENT",
      "ROUNDS_TRUNCATION_UNKNOWN",
    ]);
    for (const u of r.unmeasured) expect(u.detail.length).toBeGreaterThan(40);
  });

  test("M11-12: the summary counts nothing roundsTaken refused", () => {
    // The binding that stops a later caller reading `rounds.length` itself.
    // Three PRs, two refused: the distribution must hold exactly one entry.
    const r = summariseRoundsToPass([
      pr(1, ledger(2), true),
      pr(2, truncatedUnknown(40), true),
      pr(3, { status: AI_REVIEW_LEDGER_UNREADABLE, reason: "x" }, false),
    ]);
    expect([...r.distribution.entries()]).toEqual([[2, 1]]);
    expect(r.passedCount + r.stillOpenCount).toBe(1);
  });
});

describe("CRC-M11: the report a reader actually sees", () => {
  test("M11-13: the unmeasured count is on the first line, not a footnote", () => {
    const lines = formatRoundsToPass(
      summariseRoundsToPass([
        pr(1, ledger(1), true),
        pr(2, { status: AI_REVIEW_LEDGER_ABSENT }, true),
      ]),
    );
    expect(lines[0]).toContain("measured 1");
    expect(lines[0]).toContain("unmeasured 1");
  });

  test("M11-14: UNMEASURED is printed as a word, never as a number", () => {
    const lines = formatRoundsToPass(summariseRoundsToPass([])).join("\n");
    expect(lines).toContain("UNMEASURED");
    expect(lines).not.toMatch(/\b0\.00\b/);
    expect(lines).not.toMatch(/\b0\.0%/);
  });

  test("M11-15: the open pull requests are named in the report, with why they flatter", () => {
    const lines = formatRoundsToPass(
      summariseRoundsToPass([pr(1, ledger(1), true), pr(2, ledger(8), false)]),
    ).join("\n");
    expect(lines).toContain("still open at rounds: 8");
    expect(lines).toContain("excluded from the mean");
  });

  test("M11-16: every line carries the target it is measured against", () => {
    const lines = formatRoundsToPass(summariseRoundsToPass([pr(1, ledger(1), true)]));
    expect(lines.find(l => l.includes("mean rounds to pass"))).toContain("1.32");
    expect(lines.find(l => l.includes("passed after 1 round"))).toContain("78%");
    expect(lines.find(l => l.includes("+ rounds"))).toContain("1.5%");
  });
});
