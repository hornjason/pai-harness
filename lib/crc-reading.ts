/**
 * CRC-M11's convergence reading, as a program rather than a shell recipe.
 *
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md). The spec's
 * measurement section was four hand-run commands and a hand-typed table, and
 * the reviewer named that as the structural cause three rounds running on
 * #1632. This module is the reading those commands were approximating; the
 * table in the spec is rendered from a stored row rather than retyped.
 *
 * ## What the jq recipe could not do, and why that is the reason this exists
 *
 * **Per-pull-request refusal.** `jq` walks a list with one filter: a ledger
 * whose JSON is truncated, or whose object has no `rounds` key, aborts the
 * whole pipeline and **the entire range is lost**, not the one pull request.
 * That is the same *Silent Default Substitution* shape the rest of this
 * measurement is careful about, arriving as a stack trace instead of a
 * number. Here a bad ledger is one `UNMEASURED LEDGER_UNREADABLE` line and
 * the other forty-five still score.
 *
 * **A fence rule that survives its own payload.** The recipe cut the ledger
 * with `split("```json")[1] | split("```")[0]`. On 2026-10-27 that cut a
 * 27,252-character ledger at 18,021 characters, and the text at the cut was a
 * reviewer quoting the recipe itself into a finding. **The recipe cut itself
 * in half on any pull request whose review quoted it.** `ledgerRawRounds` and
 * `readLedger` use `indexOf`, which does not.
 *
 * ## Two columns, and they answer different questions
 *
 * ALL-ROUNDS counts every round the ledger recorded, whether or not a review
 * came out of it. MEASURED-ONLY counts only rounds whose `findings` is an
 * array. The gap between them is the share of rounds in which no review
 * happened, which on the readings so far is the larger half of the problem.
 *
 * **`findings != null` is the predicate, never `unmeasured == null`.** A
 * ledger round is written twice: `lib/scaffold/ai-review-step.ts` emits it
 * with no `unmeasured` key at all, and `lib/ai-review-unmeasured.ts` adds one
 * in a second pass. So `unmeasured == null` asks whether the second pass ran,
 * and a round the recorder never reached would score as measured.
 *
 * ## Both columns use the same denominators, and that is a change
 *
 * `lib/rounds-to-pass.ts` puts the mean and the one-round rate over the pull
 * requests that PASSED, and the five-or-more tail over ALL measured ones,
 * because *"a tail measured on survivors only has had its tail cut off"*. The
 * hand-run measured-only column put all three over merged pull requests. This
 * module applies the `rounds-to-pass` convention to both columns, so the
 * measured-only tail now carries still-open pull requests that have at least
 * one measured round. That moves the published 2026-10-27 figure and the
 * numerators are printed so a reader can see which way.
 */

import {
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_TRUNCATION_STATED,
  ledgerRawRounds,
  readLedger,
  type LedgerTruncation,
} from "./ai-review-rounds";
import {
  AI_REVIEW_UNMEASURED_NOT_RECORDED,
  readRecordedUnmeasuredState,
} from "./ai-review-unmeasured";
import { LONG_REVIEW_ROUNDS, roundsTaken } from "./rounds-to-pass";

/**
 * One pull request as the fetch produced it.
 *
 * `truncated` is the comment page's own statement that it did not carry every
 * comment — it is a property of the FETCH and nothing downstream can
 * reconstruct it, which is why it rides along rather than being inferred.
 */
export interface CrcEntry {
  readonly number: number;
  /** Merged. Named `passed` because `rounds-to-pass` is deliberately agnostic. */
  readonly passed: boolean;
  readonly truncated: boolean;
  readonly body: string | null;
}

/** A fetched page that cannot answer whether a ledger exists. */
export const CRC_PREMISE_UNRESOLVABLE_ABSENCE = "UNRESOLVABLE_ABSENCE";

/** The page did not reach both ends of the range that was asked for. */
export const CRC_PREMISE_RANGE_NOT_COVERED = "RANGE_NOT_COVERED";

/** An entry is outside `[lo, hi]`, so the cohort is not the one named. */
export const CRC_PREMISE_OUT_OF_RANGE = "ENTRY_OUT_OF_RANGE";

/** The same pull request appears twice, which doubles its weight. */
export const CRC_PREMISE_DUPLICATE = "DUPLICATE_ENTRY";

export interface PremiseViolation {
  readonly kind:
    | typeof CRC_PREMISE_UNRESOLVABLE_ABSENCE
    | typeof CRC_PREMISE_RANGE_NOT_COVERED
    | typeof CRC_PREMISE_OUT_OF_RANGE
    | typeof CRC_PREMISE_DUPLICATE;
  readonly detail: string;
}

/**
 * THE SINGLE DECISION SITE for whether the fetched page can be scored at all.
 *
 * Both guards are about the FETCH, not the ledgers, and neither can be
 * recovered downstream — which is why they refuse rather than warn.
 *
 * The first is narrow on purpose. The ledger is one upserted comment, so its
 * position in a creation-ordered connection is fixed when round 1 writes it
 * and no later volume pushes it past the hundredth. A full page WITH a ledger
 * is therefore fine, and a short page with no ledger is a real absence. The
 * only unresolvable reading is a full page with no ledger found, where absent
 * and not-fetched are the same bytes.
 *
 * The second catches an under-sized `first:N`, which silently returns a
 * PREFIX of the range and whose figures are internally consistent and about
 * the wrong cohort. An empty list fails it too: there is no `min` to equal
 * `lo`, and a reading over nothing must not pass a range check.
 *
 * **The third and fourth exist because a min and a max do not describe a
 * set.** #1633 round 3: `fetchEntries` filters to `[lo, hi]` and the
 * `--from` loader does not, so a stale or hand-edited entries file reaches
 * the scorer unfiltered and inflates the pull-request count, the round
 * total and both columns' denominators — which `--record --write-spec` then
 * lands in the store and in the spec.
 *
 * **They are not equally severe and the difference is worth stating.** An
 * out-of-range number cannot evade the min/max check; it necessarily moves
 * one of them. What it could do was arrive MISDIAGNOSED, because the only
 * message said the page spans the wrong thing and told the reader to *raise
 * the page size* — the opposite of the fix, for a file carrying too many
 * rows. A **duplicate** is the one that was genuinely invisible: it changes
 * neither min nor max, and it weights one pull request twice in the round
 * total and in both columns.
 *
 * Both are checked HERE rather than fixed in the loader, deliberately.
 * Filtering the file down to `[lo, hi]` would silently trim a stale input,
 * which is the same class of problem one layer along: a file that disagrees
 * with the range it was handed is a file nobody should score.
 */
export function premiseViolations(
  entries: readonly CrcEntry[],
  lo: number,
  hi: number,
): PremiseViolation[] {
  const out: PremiseViolation[] = [];

  const unresolvable = entries.filter(e => e.body === null && e.truncated).map(e => e.number);
  if (unresolvable.length > 0) {
    out.push({
      kind: CRC_PREMISE_UNRESOLVABLE_ABSENCE,
      detail:
        `${unresolvable.length} pull request(s) returned a FULL comment page and no ledger: ` +
        `${unresolvable.map(n => `#${n}`).join(", ")}. On those, "no ledger" and "the page ` +
        `did not reach it" are the same bytes, so the absence cannot be scored either way.`,
    });
  }

  const numbers = entries.map(e => e.number);
  const min = numbers.length === 0 ? null : Math.min(...numbers);
  const max = numbers.length === 0 ? null : Math.max(...numbers);
  if (min !== lo || max !== hi) {
    out.push({
      kind: CRC_PREMISE_RANGE_NOT_COVERED,
      detail:
        `the fetched page spans ${min === null ? "nothing" : `#${min}–#${max}`} and the range ` +
        `asked for is #${lo}–#${hi}. An under-sized page returns a PREFIX of the range, whose ` +
        `figures are internally consistent and about a different cohort — raise the page size.`,
    });
  }

  const outside = numbers.filter(n => n < lo || n > hi);
  if (outside.length > 0) {
    out.push({
      kind: CRC_PREMISE_OUT_OF_RANGE,
      detail:
        `${outside.length} entr(y|ies) fall outside #${lo}–#${hi}: ` +
        `${outside.map(n => `#${n}`).join(", ")}. A min and a max that line up do not make the ` +
        `set the range it is labelled with, and every one of these inflates a denominator.`,
    });
  }

  const seen = new Set<number>();
  const duplicates = [...new Set(numbers.filter(n => (seen.has(n) ? true : (seen.add(n), false))))];
  if (duplicates.length > 0) {
    out.push({
      kind: CRC_PREMISE_DUPLICATE,
      detail:
        `${duplicates.length} pull request(s) appear more than once: ` +
        `${duplicates.map(n => `#${n}`).join(", ")}. A repeated entry is counted twice in the ` +
        `round total and in both columns, which is a weighting nobody chose.`,
    });
  }
  return out;
}

/** Why one pull request could not be scored in a column. */
export interface CrcRefusal {
  readonly number: number;
  readonly refusal: string;
  readonly detail: string;
}

/** One pull request's round count in one column, or its refusal. */
export type CrcRoundCount = { readonly rounds: number } | CrcRefusal;

/**
 * How many rounds this pull request had, counting every round.
 *
 * Delegates to `roundsTaken`, which is `lib/rounds-to-pass.ts`'s own single
 * decision site, so the truncation refusal and the `rounds.length + dropped`
 * arithmetic are not restated here. A second copy of that rule is a second
 * decider that would drift, and the drift direction is flattering.
 */
export function allRoundsFor(entry: CrcEntry): CrcRoundCount {
  const taken = roundsTaken({
    number: entry.number,
    passed: entry.passed,
    ledger: readLedger(entry.body),
  });
  if ("refusal" in taken) {
    return { number: entry.number, refusal: taken.refusal, detail: taken.detail };
  }
  return taken;
}

/**
 * How many of this pull request's rounds produced a review.
 *
 * A pull request whose every round was refused by the review system has no
 * rounds-to-pass in this column and is UNMEASURED, not zero. That single
 * decision is worth thirteen points: the first published measured-only column
 * scored twelve never-reviewed pull requests as one-round passes and reported
 * 62.8% where the refusing rule reports 48.4%.
 *
 * Truncation is NOT refused here and the difference from `allRoundsFor` is
 * deliberate. An evicted round's kind is unrecoverable — it may have been
 * measured or not — so a ledger that evicted rounds yields a **lower bound**
 * on its measured count. Refusing it would drop the longest histories, which
 * is the direction this metric is already biased in; the bound is reported
 * instead.
 *
 * **The reading is returned whole, as `LedgerTruncation`, not flattened to a
 * number.** #1633 round 2: it used to return `evicted: 0` for both a ledger
 * STATING zero evictions and a legacy bare-array ledger whose eviction count
 * is unknowable — and the module's own test demonstrated it, with
 * `allRoundsFor` refusing that input as `ROUNDS_TRUNCATION_UNKNOWN` while
 * this one answered `evicted: 0` on the same bytes. A range of open pull
 * requests on the legacy format would then have suppressed the LOWER BOUND
 * banner entirely. `LedgerTruncation` has no number to reach for without
 * narrowing the status first, which is why it is that type upstream.
 */
export function measuredRoundsFor(
  entry: CrcEntry,
): ({ readonly rounds: number; readonly truncation: LedgerTruncation } | CrcRefusal) {
  const reading = readLedger(entry.body);
  if (reading.status !== AI_REVIEW_LEDGER_READ) {
    const taken = roundsTaken({ number: entry.number, passed: entry.passed, ledger: reading });
    if ("refusal" in taken) {
      return { number: entry.number, refusal: taken.refusal, detail: taken.detail };
    }
    /* c8 ignore next */
    return { number: entry.number, refusal: "LEDGER_UNREADABLE", detail: "unreachable" };
  }
  const measured = reading.rounds.filter(r => r.measured).length;
  if (measured === 0) {
    return {
      number: entry.number,
      refusal: "ZERO_MEASURED_ROUNDS",
      detail:
        `${reading.rounds.length} round(s) recorded and not one produced a review. A pull ` +
        `request the reviewer never read once has no rounds-to-pass; scoring it as a ` +
        `one-round pass is the most favourable thing this reading could say about a pull ` +
        `request the review system refused.`,
    };
  }
  return { rounds: measured, truncation: reading.truncation };
}

/** One scored column — the three figures, each with its own numerator. */
export interface CrcColumn {
  /** Pull requests that scored, passed or not. The tail's denominator. */
  readonly measured: number;
  /** Of those, the ones that passed. The mean's and one-round's denominator. */
  readonly passed: number;
  /** Rounds spent by the ones that passed. The mean's numerator. */
  readonly passedRounds: number;
  readonly mean: number | null;
  readonly oneRound: number | null;
  readonly fiveOrMore: number | null;
  readonly refusals: readonly CrcRefusal[];
}

interface Scored {
  readonly passed: boolean;
  readonly rounds: number;
}

/**
 * The three figures over one column's scored pull requests.
 *
 * Null, never zero, when there is nothing to average. A mean of nothing is
 * not 0 and a rate over nothing is not 0%, and both of those read as perfect
 * on the table this feeds.
 */
export function scoreColumn(scored: readonly Scored[], refusals: readonly CrcRefusal[]): CrcColumn {
  const passed = scored.filter(s => s.passed);
  const passedRounds = passed.reduce((a, s) => a + s.rounds, 0);
  return {
    measured: scored.length,
    passed: passed.length,
    passedRounds,
    mean: passed.length === 0 ? null : passedRounds / passed.length,
    oneRound: passed.length === 0 ? null : passed.filter(s => s.rounds === 1).length,
    // Whole measured population, passed or not — `lib/rounds-to-pass.ts`'s
    // choice, applied to both columns so the two are read the same way.
    fiveOrMore:
      scored.length === 0 ? null : scored.filter(s => s.rounds >= LONG_REVIEW_ROUNDS).length,
    refusals,
  };
}

/** Rounds by what came out of them, over every pull request in the range. */
export interface CrcSplit {
  readonly total: number;
  /** State name -> rounds. `measured` plus whatever the recorder wrote. */
  readonly kinds: Readonly<Record<string, number>>;
}

/** The split's name for a round that produced a review. */
export const CRC_ROUND_MEASURED = "measured";

/**
 * The round-kind split, over ALL pull requests in the range, merged or not.
 *
 * This reading needs BOTH views of each round and takes each from its own
 * owner. **Whether the round was measured comes from `readLedger`** —
 * `toLedgerRound` already computes `Array.isArray(findings)` and that is the
 * only place in the tree allowed to decide it, so the split's `measured`
 * total and `measuredRoundsFor`'s per-pull-request counts cannot drift.
 * **Which KIND of unmeasured comes from the raw entry**, because
 * `LedgerRound` has no slot for the `unmeasured` discriminator.
 *
 * The first draft restated the measured predicate inline, hardcoding the
 * string `"findings"` beside a docblock arguing against exactly that. A
 * reviewer caught it on #1633 and was right: tightening `toLedgerRound`'s
 * rule would have moved one column and not the other, silently.
 *
 * The two views are `readLedger(body).rounds` and `ledgerRawRounds(body)`,
 * which are the same array — one mapped, one not — so they align by index.
 * That is asserted rather than assumed: a length mismatch means one of the
 * two parsers changed and the pull request is skipped rather than zipped
 * against the wrong entries.
 *
 * A ledger that refuses contributes nothing and is not counted as zero
 * rounds. Its pull request is already named in both columns' refusals.
 */
export function splitRoundKinds(entries: readonly CrcEntry[]): CrcSplit {
  const kinds: Record<string, number> = {};
  let total = 0;
  for (const entry of entries) {
    const reading = readLedger(entry.body);
    const raw = ledgerRawRounds(entry.body);
    if (reading.status !== AI_REVIEW_LEDGER_READ || raw === null) continue;
    if (raw.length !== reading.rounds.length) continue;
    for (let i = 0; i < raw.length; i++) {
      total++;
      const kind = reading.rounds[i].measured
        ? CRC_ROUND_MEASURED
        : readRecordedUnmeasuredState(raw[i]);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
  }
  return { total, kinds };
}

/** One dated reading, as it is stored and as the spec renders it. */
export interface CrcReadingRow {
  /** ISO day the reading was taken. */
  readonly date: string;
  readonly lo: number;
  readonly hi: number;
  readonly pullRequests: number;
  readonly allRounds: CrcColumn;
  readonly measuredOnly: CrcColumn;
  /**
   * Rounds the scored ledgers STATED they evicted. Above zero means the
   * measured-only figures are a LOWER BOUND by at least this much.
   */
  readonly measuredOnlyEvicted: number;
  /**
   * Scored pull requests whose eviction count could not be established at
   * all — a different fact from zero, and the one a single number hid.
   * Non-empty also means LOWER BOUND, by an amount nobody can state.
   */
  readonly measuredOnlyEvictionUnknown: readonly number[];
  readonly split: CrcSplit;
  /** Pull requests whose every round was refused by the review system. */
  readonly zeroMeasured: readonly number[];
}

/** Take the whole reading. Premises are the caller's to check first. */
export function takeCrcReading(
  entries: readonly CrcEntry[],
  lo: number,
  hi: number,
  date: string,
): CrcReadingRow {
  const allScored: Scored[] = [];
  const allRefusals: CrcRefusal[] = [];
  const measuredScored: Scored[] = [];
  const measuredRefusals: CrcRefusal[] = [];
  const zeroMeasured: number[] = [];
  const measuredOnlyEvictionUnknown: number[] = [];
  let measuredOnlyEvicted = 0;

  for (const entry of entries) {
    const all = allRoundsFor(entry);
    if ("refusal" in all) allRefusals.push(all);
    else allScored.push({ passed: entry.passed, rounds: all.rounds });

    const only = measuredRoundsFor(entry);
    if ("refusal" in only) {
      measuredRefusals.push(only);
      if (only.refusal === "ZERO_MEASURED_ROUNDS") zeroMeasured.push(entry.number);
    } else {
      measuredScored.push({ passed: entry.passed, rounds: only.rounds });
      // Narrowed, not defaulted. An unknown eviction count has no number to
      // add and is recorded as its own fact instead of folded into zero.
      if (only.truncation.status === AI_REVIEW_TRUNCATION_STATED) {
        measuredOnlyEvicted += only.truncation.dropped;
      } else {
        measuredOnlyEvictionUnknown.push(entry.number);
      }
    }
  }

  return {
    date,
    lo,
    hi,
    pullRequests: entries.length,
    allRounds: scoreColumn(allScored, allRefusals),
    measuredOnly: scoreColumn(measuredScored, measuredRefusals),
    measuredOnlyEvicted,
    measuredOnlyEvictionUnknown: measuredOnlyEvictionUnknown.sort((a, b) => a - b),
    split: splitRoundKinds(entries),
    zeroMeasured: zeroMeasured.sort((a, b) => a - b),
  };
}

const pct = (n: number | null, d: number): string =>
  n === null || d === 0 ? "UNMEASURED" : `${((n / d) * 100).toFixed(1)}%`;
const num = (v: number | null): string => (v === null ? "UNMEASURED" : v.toFixed(2));

/** `12 / 43`, or `UNMEASURED` — the numerator belongs in the table. */
const over = (n: number | null, d: number): string => (n === null ? "—" : `${n} / ${d}`);

/**
 * The reading as the markdown the spec carries.
 *
 * Every denominator is printed beside its numerator, because two cells in one
 * row can have different ones and a reader who cannot reproduce a percentage
 * from the counts beside it has to rerun the whole thing to check it.
 */
export function renderCrcReading(row: CrcReadingRow): string[] {
  const a = row.allRounds;
  const m = row.measuredOnly;
  const lines = [
    `Read over **#${row.lo}–#${row.hi}** on ${row.date} — ${row.pullRequests} pull requests, ` +
      `${row.split.total} rounds.`,
    "",
    "| | all rounds | numerator | measured rounds only | numerator |",
    "|---|---|---|---|---|",
    `| mean rounds to pass | ${num(a.mean)} | ${a.passedRounds} / ${a.passed} | ` +
      `${num(m.mean)} | ${m.passedRounds} / ${m.passed} |`,
    `| passed after one round | ${pct(a.oneRound, a.passed)} | ${over(a.oneRound, a.passed)} | ` +
      `${pct(m.oneRound, m.passed)} | ${over(m.oneRound, m.passed)} |`,
    `| ${LONG_REVIEW_ROUNDS} or more rounds | ${pct(a.fiveOrMore, a.measured)} | ` +
      `${over(a.fiveOrMore, a.measured)} | ${pct(m.fiveOrMore, m.measured)} | ` +
      `${over(m.fiveOrMore, m.measured)} |`,
    "",
    "The five-or-more row's denominator is ALL measured pull requests and the two above it " +
      "are over the ones that PASSED, in both columns — a tail measured on survivors only " +
      "has had its tail cut off.",
    "",
    "| round outcome | rounds | share |",
    "|---|---|---|",
  ];
  for (const [kind, n] of Object.entries(row.split.kinds).sort((x, y) => y[1] - x[1])) {
    lines.push(`| \`${kind}\` | ${n} | ${pct(n, row.split.total)} |`);
  }
  lines.push("");
  const unknown = row.measuredOnlyEvictionUnknown;
  if (row.measuredOnlyEvicted > 0 || unknown.length > 0) {
    const stated =
      row.measuredOnlyEvicted > 0
        ? `${row.measuredOnlyEvicted} round(s) were evicted from ledgers that scored in it, and ` +
          "an evicted round's kind is unrecoverable"
        : null;
    const unknowable =
      unknown.length > 0
        ? `${unknown.length} scored pull request(s) cannot say how many rounds they evicted ` +
          `(${unknown.map(n => `#${n}`).join(", ")}), so the shortfall there is not even a ` +
          "number — which is a different fact from zero and is why this line exists"
        : null;
    lines.push(
      `**The measured-only column is a LOWER BOUND.** ${[stated, unknowable]
        .filter(Boolean)
        .join(". ")}.`,
      "",
    );
  }
  lines.push(
    row.zeroMeasured.length === 0
      ? "**Every pull request in the range had at least one measured round.**"
      : `**${row.zeroMeasured.length} pull request(s) had zero measured rounds in their ` +
          `entire lives** and are UNMEASURED in the measured-only column rather than scored ` +
          `as one-round passes: ${row.zeroMeasured.map(n => `#${n}`).join(", ")}.`,
  );
  return lines;
}

const signed = (v: number, digits: number): string =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

function deltaRow(label: string, before: number | null, after: number | null): string {
  if (before === null || after === null) return `  ${label}: UNMEASURED on one side`;
  return `  ${label}: ${before.toFixed(2)} → ${after.toFixed(2)} (${signed(after - before, 2)})`;
}

function rateRow(
  label: string,
  before: CrcColumn,
  after: CrcColumn,
  pick: (c: CrcColumn) => { n: number | null; d: number },
): string {
  const b = pick(before);
  const c = pick(after);
  if (b.n === null || c.n === null || b.d === 0 || c.d === 0) {
    return `  ${label}: UNMEASURED on one side`;
  }
  const bp = (b.n / b.d) * 100;
  const cp = (c.n / c.d) * 100;
  return (
    `  ${label}: ${bp.toFixed(1)}% (${b.n}/${b.d}) → ${cp.toFixed(1)}% (${c.n}/${c.d})` +
    ` (${signed(cp - bp, 1)}pt)`
  );
}

/**
 * The delta against the previous row — and it names BOTH ranges first.
 *
 * A delta between two differently-ranged readings is a comparison of two
 * cohorts, not a measurement of change, and the only honest form of it says
 * so in the same breath as the numbers. The ranges are on the first line for
 * the reason the unmeasured count is on `formatRoundsToPass`'s first line: a
 * reader quotes what they saw first.
 */
export function deltaLines(previous: CrcReadingRow | null, row: CrcReadingRow): string[] {
  if (previous === null) {
    return [
      `delta: NONE — #${row.lo}–#${row.hi} on ${row.date} is the first row in the store.`,
    ];
  }
  const shared =
    Math.min(previous.hi, row.hi) - Math.max(previous.lo, row.lo) + 1;
  const lines = [
    `delta: #${previous.lo}–#${previous.hi} (${previous.date}) → #${row.lo}–#${row.hi} ` +
      `(${row.date}) — ${shared > 0 ? `${shared} pull request numbers in common` : "DISJOINT ranges"}.` +
      (previous.lo === row.lo && previous.hi === row.hi
        ? ""
        : " These are different cohorts; the figures below are a comparison, not a change."),
  ];
  for (const [name, b, a] of [
    ["all rounds", previous.allRounds, row.allRounds],
    ["measured only", previous.measuredOnly, row.measuredOnly],
  ] as const) {
    lines.push(`${name}:`);
    lines.push(deltaRow("mean rounds to pass  ", b.mean, a.mean));
    lines.push(rateRow("passed after one round", b, a, c => ({ n: c.oneRound, d: c.passed })));
    lines.push(
      rateRow(`${LONG_REVIEW_ROUNDS} or more rounds    `, b, a, c => ({
        n: c.fiveOrMore,
        d: c.measured,
      })),
    );
  }
  const un = (s: CrcSplit) => s.total - (s.kinds[CRC_ROUND_MEASURED] ?? 0);
  lines.push(
    `unmeasured rounds: ${pct(un(previous.split), previous.split.total)} ` +
      `(${un(previous.split)}/${previous.split.total}) → ${pct(un(row.split), row.split.total)} ` +
      `(${un(row.split)}/${row.split.total})`,
  );
  return lines;
}

/** Rounds nothing classified — present only on ledgers older than #1486. */
export function notRecordedRounds(split: CrcSplit): number {
  return split.kinds[AI_REVIEW_UNMEASURED_NOT_RECORDED] ?? 0;
}

/** Where the rendered block starts in the spec. */
export const CRC_BLOCK_BEGIN =
  "<!-- crc-reading:begin — generated by `bun scripts/crc-reading.ts`; do not edit by hand -->";

/** Where it ends. */
export const CRC_BLOCK_END = "<!-- crc-reading:end -->";

/**
 * Put the rendered reading between the markers.
 *
 * THE SINGLE SITE for the splice, so the script that writes the block and
 * the test that checks it cannot disagree about where the block is. Two
 * implementations of "find the markers" is the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` calls *two deciders*: the
 * check would go green against its own idea of the boundary.
 *
 * `null` when either marker is missing or they are the wrong way round — a
 * document that cannot say where its generated block goes must refuse, not
 * get one appended somewhere plausible.
 */
export function spliceCrcBlock(document: string, row: CrcReadingRow): string | null {
  const begin = document.indexOf(CRC_BLOCK_BEGIN);
  const end = document.indexOf(CRC_BLOCK_END, begin);
  if (begin === -1 || end === -1) return null;
  return (
    document.slice(0, begin + CRC_BLOCK_BEGIN.length) +
    `\n\n${renderCrcReading(row).join("\n")}\n\n` +
    document.slice(end)
  );
}
