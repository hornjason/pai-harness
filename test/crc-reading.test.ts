/**
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * The battery for `lib/crc-reading.ts` and `scripts/crc-reading.ts`. Every
 * case here is a shape the shell recipe this replaces got wrong on live data
 * — not a hypothetical, and each one names the observation it comes from.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  ledgerRawRounds,
  readLedger,
  AI_REVIEW_LEDGER_READ,
} from "../lib/ai-review-rounds.ts";
import {
  CRC_BLOCK_BEGIN,
  CRC_BLOCK_END,
  CRC_PREMISE_DUPLICATE,
  CRC_PREMISE_OUT_OF_RANGE,
  CRC_PREMISE_RANGE_NOT_COVERED,
  CRC_PREMISE_UNRESOLVABLE_ABSENCE,
  CRC_ROUND_MEASURED,
  deltaLines,
  measuredRoundsFor,
  allRoundsFor,
  premiseViolations,
  renderCrcReading,
  scoreColumn,
  splitRoundKinds,
  takeCrcReading,
  type CrcEntry,
} from "../lib/crc-reading.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/crc-reading.ts");

/** A measured round — `findings` an array, and no `unmeasured` key. */
const measured = (round: number, findings: unknown[] = []) => ({
  at: "2026-10-27T00:00:00Z",
  sha: "f".repeat(40),
  round,
  findings,
});

/** An unmeasured round, as `lib/ai-review-unmeasured.ts` writes one. */
const unmeasured = (round: number, state: string) => ({
  at: "2026-10-27T00:00:00Z",
  sha: "f".repeat(40),
  round,
  findings: null,
  unmeasured: state,
});

/**
 * A ledger comment body.
 *
 * `JSON.stringify` with no indent on purpose: that is how the writer emits
 * it, and it is the property the fence rule depends on — a newline inside the
 * payload would put `\n` + three backticks in front of the real close.
 */
function ledgerBody(rounds: unknown[], truncated = 0): string {
  return [
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    "",
    "```json",
    JSON.stringify({ rounds, truncated }),
    "```",
    "",
  ].join("\n");
}

const entry = (over: Partial<CrcEntry> & { number: number }): CrcEntry => ({
  passed: true,
  truncated: false,
  body: null,
  ...over,
});

describe("premise guards — the fetch's own two refusals", () => {
  test("a FULL comment page with no ledger is unresolvable, and with one is fine", () => {
    // The narrow form, and the version this replaced refused the second case
    // too. The ledger is one upserted comment, so its position is fixed when
    // round 1 writes it and no later volume pushes it off the page.
    const bad = premiseViolations(
      [
        entry({ number: 10, truncated: true, body: null }),
        entry({ number: 20, truncated: true, body: ledgerBody([measured(1)]) }),
      ],
      10,
      20,
    );
    expect(bad.map(v => v.kind)).toEqual([CRC_PREMISE_UNRESOLVABLE_ABSENCE]);
    expect(bad[0].detail).toContain("#10");
    expect(bad[0].detail).not.toContain("#20");
  });

  test("a short page with no ledger is a real absence and passes the guard", () => {
    expect(
      premiseViolations([entry({ number: 10, body: null }), entry({ number: 20 })], 10, 20),
    ).toEqual([]);
  });

  test("a page that stops short of the range is refused, naming both spans", () => {
    const v = premiseViolations([entry({ number: 15 }), entry({ number: 20 })], 10, 20);
    expect(v.map(x => x.kind)).toEqual([CRC_PREMISE_RANGE_NOT_COVERED]);
    expect(v[0].detail).toContain("#15–#20");
    expect(v[0].detail).toContain("#10–#20");
  });

  test("an out-of-range entry is NAMED, not just reported as a short page", () => {
    /**
     * #1633 round 3, and the half of it that was already caught.
     *
     * `fetchEntries` filters to `[lo, hi]` and `--from` does not, so a stale
     * entries file reaches the scorer unfiltered. An out-of-range number
     * cannot slip past the min/max check — it necessarily moves one of them
     * — so this was never undetected. What it WAS is misdiagnosed: the only
     * message said the page spans the wrong thing and told the reader to
     * **raise the page size**, which is the opposite of the fix and would
     * have sent someone fetching more rows to cure a file with too many.
     *
     * So both fire, and the second one names the offender.
     */
    const v = premiseViolations(
      [entry({ number: 10 }), entry({ number: 99 }), entry({ number: 20 })],
      10,
      20,
    );
    expect(v.map(x => x.kind)).toEqual([
      CRC_PREMISE_RANGE_NOT_COVERED,
      CRC_PREMISE_OUT_OF_RANGE,
    ]);
    expect(v[1].detail).toContain("#99");
    // The whole opening phrase, not just the number in it. Round 5 found
    // `entr(y|ies)` sitting in this template string, printing verbatim —
    // a case asserting only `toContain("#99")` could not see it, and no
    // other case read a `detail` at all.
    expect(v[1].detail).toStartWith("1 pull request(s) fall outside #10–#20: #99.");
    // The control: the same count of entries, all inside the range, passes —
    // so this is about membership and not about having three of them.
    expect(
      premiseViolations(
        [entry({ number: 10 }), entry({ number: 15 }), entry({ number: 20 })],
        10,
        20,
      ),
    ).toEqual([]);
  });

  test("a duplicated pull request is refused — it is weighted twice", () => {
    const v = premiseViolations(
      [entry({ number: 10 }), entry({ number: 15 }), entry({ number: 15 }), entry({ number: 20 })],
      10,
      20,
    );
    expect(v.map(x => x.kind)).toEqual([CRC_PREMISE_DUPLICATE]);
    expect(v[0].detail).toContain("#15");
    // Named once however many times it repeats, so the message stays readable.
    expect(v[0].detail).toContain("1 pull request(s)");
  });

  test("an EMPTY page is refused rather than scored over nothing", () => {
    // The shape that cleared the jq recipe's first guard: `[]` is a valid
    // JSON array, so only the range check catches it.
    expect(premiseViolations([], 10, 20).map(v => v.kind)).toEqual([
      CRC_PREMISE_RANGE_NOT_COVERED,
    ]);
  });

  test("no message in this module carries an unexpanded alternation", () => {
    // Round 5's finding as a sweep rather than a repair of the one site it
    // named. `entr(y|ies)` is a regex fragment that reached a template
    // string: it has no runtime behaviour at all, so every path through it
    // is green and only a reader sees it. This module writes to a human on
    // every refusal and holds no regexes, so the shape is unambiguous here.
    //
    // Remedy: use the `X(s)` form the rest of these messages use.
    const source = readFileSync(join(ROOT, "lib/crc-reading.ts"), "utf-8");
    const offenders = source
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\([a-z]+\|[a-z]+\)/.test(line));
    expect(offenders.map(([n, line]) => `${n}: ${line.trim()}`)).toEqual([]);
  });
});

describe("the fence rule, against the payload that broke the recipe", () => {
  /**
   * The live 2026-10-27 failure, as a regression case.
   *
   * A reviewer quoted the measurement recipe — which contains a ```json fence
   * — into a finding, and the finding was stored in the ledger. The recipe's
   * own `split("```json")[1] | split("```")[0]` then cut the ledger at the
   * quote: 18,021 characters of a 27,252-character payload.
   */
  const quoting = ledgerBody([
    measured(1, [
      { file: "specs/S.md", summary: "the recipe cuts itself", text: '```json \\") | select(...) ```' },
    ]),
    measured(2),
    measured(3),
  ]);

  test("the naive split loses rounds on it and `indexOf` does not", () => {
    const naive = quoting.split("```json")[1].split("```")[0];
    expect(() => JSON.parse(naive)).toThrow();

    const rounds = ledgerRawRounds(quoting);
    expect(rounds).not.toBeNull();
    expect(rounds?.length).toBe(3);
  });

  test("the scorer reads all three rounds, which is what the recipe could not", () => {
    const read = measuredRoundsFor(entry({ number: 1, body: quoting }));
    expect("refusal" in read).toBe(false);
    expect((read as { rounds: number }).rounds).toBe(3);
  });
});

describe("per-pull-request refusal, which jq structurally cannot do", () => {
  test("one malformed ledger is UNMEASURED and the rest still score", () => {
    // jq aborts the whole filter here and the entire range is lost. The
    // control is the two good pull requests either side of the bad one.
    const broken = `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{"rounds":[`;
    const row = takeCrcReading(
      [
        entry({ number: 1, body: ledgerBody([measured(1)]) }),
        entry({ number: 2, body: broken }),
        entry({ number: 3, body: ledgerBody([measured(1), measured(2)]) }),
      ],
      1,
      3,
      "2026-10-27",
    );
    expect(row.allRounds.measured).toBe(2);
    expect(row.allRounds.refusals.map(r => [r.number, r.refusal])).toEqual([
      [2, "LEDGER_UNREADABLE"],
    ]);
    expect(row.measuredOnly.refusals.map(r => r.number)).toEqual([2]);
  });

  test("a ledger object with no `rounds` key refuses that one pull request", () => {
    // The recipe's other abort: "Cannot iterate over null".
    const noRounds = [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      JSON.stringify({ truncated: 0 }),
      "```",
    ].join("\n");
    const row = takeCrcReading(
      [entry({ number: 1, body: noRounds }), entry({ number: 2, body: ledgerBody([measured(1)]) })],
      1,
      2,
      "2026-10-27",
    );
    expect(row.allRounds.refusals.map(r => r.number)).toEqual([1]);
    expect(row.allRounds.measured).toBe(1);
  });
});

describe("`findings != null`, never `unmeasured == null`", () => {
  /**
   * The input the two predicates must disagree on.
   *
   * A round is written twice — the step emits it with NO `unmeasured` key,
   * and `lib/ai-review-unmeasured.ts` adds one in a second pass. So a round
   * the recorder never reached carries `findings: null` and no key, and
   * `unmeasured == null` scores it as measured.
   */
  const unrecorded = { at: "x", sha: "f", round: 1, findings: null };

  test("a round the recorder never reached is NOT measured", () => {
    const body = ledgerBody([unrecorded, measured(2)]);
    expect(measuredRoundsFor(entry({ number: 1, body }))).toEqual({
      rounds: 1,
      truncation: { status: "AI_REVIEW_TRUNCATION_STATED", dropped: 0 },
    });

    // Name what the other predicate would have said, rather than assert the
    // two agree — the agreement on live data is what made the wrong one look
    // safe for a round of review.
    const raw = ledgerRawRounds(body) as Record<string, unknown>[];
    expect(raw.filter(r => r.unmeasured === undefined).length).toBe(2);
  });

  test("`findings: []` with no `unmeasured` key IS measured — a clean round", () => {
    expect(measuredRoundsFor(entry({ number: 1, body: ledgerBody([measured(1)]) }))).toEqual({
      rounds: 1,
      truncation: { status: "AI_REVIEW_TRUNCATION_STATED", dropped: 0 },
    });
  });
});

describe("zero measured rounds is UNMEASURED, not a one-round pass", () => {
  const entries = [
    // Every round refused by the review system. The twelve of these in the
    // 2026-10-27 range are what made the first published column read 62.8%.
    entry({ number: 1, body: ledgerBody([unmeasured(1, "declined"), unmeasured(2, "declined")]) }),
    entry({ number: 2, body: ledgerBody([measured(1)]) }),
    entry({ number: 3, body: ledgerBody([measured(1), measured(2), measured(3)]) }),
  ];

  test("it is refused by name and listed, not scored as zero", () => {
    const row = takeCrcReading(entries, 1, 3, "2026-10-27");
    expect(row.zeroMeasured).toEqual([1]);
    expect(row.measuredOnly.refusals.map(r => r.refusal)).toEqual(["ZERO_MEASURED_ROUNDS"]);
    expect(row.measuredOnly.passed).toBe(2);
    expect(row.measuredOnly.oneRound).toBe(1);
  });

  test("the all-rounds column still counts its rounds — the loop did go round", () => {
    const row = takeCrcReading(entries, 1, 3, "2026-10-27");
    expect(row.allRounds.measured).toBe(3);
    expect(row.allRounds.passedRounds).toBe(2 + 1 + 3);
  });

  test("scoring it as zero instead moves the one-round rate, and by how much", () => {
    // The thirteen points, performed. One rule refuses the pull request, the
    // other scores it as a zero-round pass; the spread is what that single
    // decision is worth, and quoting two parsers' agreement without this is
    // quoting one decider twice.
    const refusing = takeCrcReading(entries, 1, 3, "2026-10-27").measuredOnly;
    const scoringZero = scoreColumn(
      [
        { passed: true, rounds: 0 },
        { passed: true, rounds: 1 },
        { passed: true, rounds: 3 },
      ],
      [],
    );
    expect(refusing.oneRound! / refusing.passed).toBeCloseTo(0.5, 5);
    expect(scoringZero.oneRound! / scoringZero.passed).toBeCloseTo(1 / 3, 5);
  });
});

describe("denominators", () => {
  const scored = [
    { passed: true, rounds: 1 },
    { passed: true, rounds: 6 },
    { passed: false, rounds: 7 },
  ];

  test("mean and one-round are over PASSED, the tail over ALL measured", () => {
    const c = scoreColumn(scored, []);
    expect(c.passed).toBe(2);
    expect(c.measured).toBe(3);
    expect(c.mean).toBeCloseTo(3.5, 5);
    expect(c.oneRound).toBe(1);
    // 2 of 3, not 1 of 2 — the still-open pull request at 7 rounds is exactly
    // the kind this statistic exists to find.
    expect(c.fiveOrMore).toBe(2);
  });

  test("an all-refused column is null, never zero", () => {
    const c = scoreColumn([], []);
    expect(c.mean).toBeNull();
    expect(c.oneRound).toBeNull();
    expect(c.fiveOrMore).toBeNull();
    // `[] | add` is null and `null / 0` aborts jq at exit 5. The one reading
    // that most needs to be legible was the one the recipe could not print.
    expect(renderCrcReading(takeCrcReading([], 1, 1, "2026-10-27")).join("\n")).toContain(
      "UNMEASURED",
    );
  });
});

describe("the split, and the eviction bound", () => {
  test("rounds are counted by kind over every pull request, merged or not", () => {
    const split = splitRoundKinds([
      entry({ number: 1, body: ledgerBody([measured(1), unmeasured(2, "declined")]) }),
      entry({ number: 2, passed: false, body: ledgerBody([unmeasured(1, "no_payload")]) }),
      entry({ number: 3, body: null }),
    ]);
    expect(split.total).toBe(3);
    expect(split.kinds).toEqual({ measured: 1, declined: 1, no_payload: 1 });
  });

  test("the split's measured total EQUALS the sum of the per-PR measured counts", () => {
    /**
     * The property, not another fixture.
     *
     * #1633 round 1: `splitRoundKinds` restated `Array.isArray(findings)`
     * inline instead of reading `toLedgerRound`'s answer, so tightening that
     * rule would have moved the per-pull-request column and left the split
     * table saying something else — and every case here would have stayed
     * green, because they all feed both paths the same literal fixtures.
     * This asserts the two agree on whatever they are given, which is the
     * only form of the claim a fixture cannot fake.
     */
    const entries = [
      entry({ number: 1, body: ledgerBody([measured(1), unmeasured(2, "declined")]) }),
      entry({ number: 2, passed: false, body: ledgerBody([unmeasured(1, "no_payload")]) }),
      entry({ number: 3, body: ledgerBody([measured(1), measured(2), measured(3)]) }),
      // A refusal on both sides, so neither contributes and they still agree.
      entry({ number: 4, body: `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{"rounds":[` }),
      entry({ number: 5, body: null }),
    ];
    const perPr = entries
      .map(e => measuredRoundsFor(e))
      .reduce((a, r) => a + ("refusal" in r ? 0 : r.rounds), 0);
    expect(splitRoundKinds(entries).kinds[CRC_ROUND_MEASURED] ?? 0).toBe(perPr);

    // The negative control: the assertion above is only worth something if
    // the number it compares is not zero on both sides.
    expect(perPr).toBe(4);
  });

  test("an evicted round makes the measured-only figure a lower bound, and says so", () => {
    const row = takeCrcReading(
      [entry({ number: 1, body: ledgerBody([measured(1), measured(2)], 5) })],
      1,
      1,
      "2026-10-27",
    );
    expect(row.measuredOnlyEvicted).toBe(5);
    expect(row.measuredOnlyEvictionUnknown).toEqual([]);
    expect(renderCrcReading(row).join("\n")).toContain("LOWER BOUND");
    // The all-rounds column adds them, because a round's EXISTENCE survives
    // eviction even though its kind does not.
    expect(row.allRounds.passedRounds).toBe(7);
  });

  test("a ledger that CANNOT say what it evicted still raises the bound banner", () => {
    /**
     * #1633 round 2, and the reviewer proved it with this module's own test.
     *
     * A legacy bare array at the cap: `allRoundsFor` refuses it as
     * `ROUNDS_TRUNCATION_UNKNOWN`, and `measuredRoundsFor` used to answer
     * `evicted: 0` on the same bytes — "verified nothing was evicted",
     * indistinguishable from the real thing. Summed, that suppressed the
     * LOWER BOUND line entirely for a range of open pull requests still on
     * the legacy format, which the reader would have read as exact.
     */
    const legacy = [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      JSON.stringify(Array.from({ length: 12 }, (_, i) => measured(i + 1))),
      "```",
    ].join("\n");
    const row = takeCrcReading([entry({ number: 7, body: legacy })], 7, 7, "2026-10-27");

    expect(row.measuredOnlyEvicted).toBe(0);
    expect(row.measuredOnlyEvictionUnknown).toEqual([7]);

    const rendered = renderCrcReading(row).join("\n");
    expect(rendered).toContain("LOWER BOUND");
    expect(rendered).toContain("#7");
    // The banner must say WHICH of the two it is. A single number could not.
    expect(rendered).toContain("not even a number");

    // The control: a ledger that STATES zero evictions raises no banner at
    // all, so the assertion above is about the unknown reading and not about
    // the banner firing on everything.
    const stated = takeCrcReading(
      [entry({ number: 7, body: ledgerBody([measured(1)]) })],
      7,
      7,
      "2026-10-27",
    );
    expect(stated.measuredOnlyEvictionUnknown).toEqual([]);
    expect(renderCrcReading(stated).join("\n")).not.toContain("LOWER BOUND");
  });
});

describe("the delta names both ranges before it names a number", () => {
  const rowAt = (lo: number, hi: number) =>
    takeCrcReading(
      [entry({ number: lo, body: ledgerBody([measured(1)]) }), entry({ number: hi, body: ledgerBody([measured(1), measured(2)]) })],
      lo,
      hi,
      "2026-10-27",
    );

  test("a first row has no delta and says so", () => {
    expect(deltaLines(null, rowAt(1, 2))[0]).toContain("first row");
  });

  test("two different ranges are called a comparison, not a change", () => {
    const line = deltaLines(rowAt(1, 2), rowAt(10, 11))[0];
    expect(line).toContain("#1–#2");
    expect(line).toContain("#10–#11");
    expect(line).toContain("DISJOINT");
    expect(line).toContain("not a change");
  });

  test("a rate delta carries both numerators, not just the percentage", () => {
    const lines = deltaLines(rowAt(1, 2), rowAt(1, 2)).join("\n");
    expect(lines).toMatch(/passed after one round: .*\(1\/2\) → .*\(1\/2\)/);
  });
});

describe("the script refuses, and the refusal can be removed", () => {
  const SOURCE = readFileSync(SCRIPT, "utf-8");

  test("CRC_READING_REFUSED appears exactly once, so the mutation is total", () => {
    // A later branch inlining `return 1` would bypass the mutant below and
    // the case would go green having witnessed nothing.
    expect(SOURCE.split("CRC_READING_REFUSED").length - 1).toBe(
      SOURCE.split("export const CRC_READING_REFUSED").length - 1 +
        (SOURCE.match(/return CRC_READING_REFUSED;/g) ?? []).length,
    );
    expect(SOURCE).toContain("export const CRC_READING_REFUSED = 1;");
  });

  /**
   * The mutant runs from a tmpdir, so its relative imports are rewritten to
   * absolute. The alternative — a script with no relative imports — is not
   * available here: the whole point of this one is that it calls
   * `readLedger`'s fence rule rather than spelling its own.
   */
  function mutantPath(dir: string): string {
    const src = SOURCE.replace(
      "export const CRC_READING_REFUSED = 1;",
      "export const CRC_READING_REFUSED = 0;",
    ).replace(/from "\.\.\/lib\//g, `from "${join(ROOT, "lib")}/`);
    expect(src).toContain("CRC_READING_REFUSED = 0;");
    expect(src).not.toContain('from "../lib/');
    const at = join(dir, "crc-reading-mutant.ts");
    writeFileSync(at, src);
    return at;
  }

  function run(script: string, args: string[], cwd: string) {
    return spawnSync("bun", [script, ...args], { encoding: "utf8", cwd });
  }

  test("a range the page does not cover refuses, and the mutant does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 15, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      const args = ["--lo", "10", "--hi", "20", "--from", entries, "--store", "none.json"];

      const real = run(SCRIPT, args, dir);
      expect(real.status).toBe(1);
      expect(real.stderr).toContain(CRC_PREMISE_RANGE_NOT_COVERED);

      const mutant = run(mutantPath(dir), args, dir);
      expect(mutant.stderr).toContain(CRC_PREMISE_RANGE_NOT_COVERED);
      // The refusal removed, performed and observed: same input, same
      // message, exit 0. Without this the case cannot tell a guard that held
      // from a run that never reached it.
      expect(mutant.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a --repo that is not owner/name refuses before anything is fetched", () => {
    // `--repo` is interpolated into the GraphQL document as two string
    // literals while every other argument is passed. It was the one argument
    // `parseArgs` did not look at: a `"` closes the literal and the server
    // rejects a document nobody wrote, and a value with no `/` becomes
    // `name:"undefined"` — a GraphQL error about a repository rather than a
    // message about the flag.
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      for (const bad of ['owner"/name', "no-slash", "a/b/c", ""]) {
        const args = ["--lo", "10", "--hi", "20", "--repo", bad];
        const real = run(SCRIPT, args, dir);
        expect(real.status, `--repo ${JSON.stringify(bad)} was accepted`).toBe(1);
        expect(real.stderr).toContain("is not owner/name");
        // And it refused in `parseArgs`, before `gh` ran — otherwise the
        // check is a second message on a failure the network already made.
        expect(real.stderr).not.toContain("gh api graphql");
      }

      const mutant = run(mutantPath(dir), ["--lo", "10", "--hi", "20", "--repo", "no-slash"], dir);
      expect(mutant.stderr).toContain("is not owner/name");
      expect(mutant.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed --repo passes the check — it is not refusing everything", () => {
    // The control. A pattern that rejected its own default would make every
    // assertion above green for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      const real = run(
        SCRIPT,
        ["--lo", "10", "--hi", "10", "--repo", "hornjason/pai-harness", "--from", entries,
          "--store", "none.json"],
        dir,
      );
      expect(real.stderr).not.toContain("is not owner/name");
      expect(real.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale --from file does not reach the store or the spec", () => {
    // Round 3's path, end to end: min and max line up, an extra pull request
    // sits between them, and `--record --write-spec` is asked for. Nothing
    // may be written.
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      const body = ledgerBody([measured(1)]);
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body },
          { number: 99, passed: true, truncated: false, body },
          { number: 20, passed: true, truncated: false, body },
        ]),
      );
      const real = run(
        SCRIPT,
        ["--lo", "10", "--hi", "20", "--from", entries, "--store", "store.json", "--record"],
        dir,
      );
      expect(real.status).toBe(1);
      expect(real.stderr).toContain(CRC_PREMISE_OUT_OF_RANGE);
      expect(existsSync(join(dir, "store.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean range scores, records on --record, and prints the delta", () => {
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
          {
            number: 20,
            passed: true,
            truncated: false,
            body: ledgerBody([unmeasured(1, "declined"), measured(2)]),
          },
        ]),
      );
      const args = [
        "--lo", "10", "--hi", "20",
        "--from", entries,
        "--store", "store.json",
        "--date", "2026-10-27",
      ];

      const first = run(SCRIPT, [...args, "--record"], dir);
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("#10–#20");
      expect(first.stdout).toContain("first row");
      expect(first.stdout).toContain("recorded row 1");

      const stored = JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"));
      expect(stored).toHaveLength(1);
      expect(stored[0].lo).toBe(10);
      expect(stored[0].hi).toBe(20);
      expect(stored[0].split.kinds).toEqual({ measured: 2, declined: 1 });

      const second = run(SCRIPT, args, dir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("pull request numbers in common");
      expect(second.stdout).toContain("not recorded");
      // Without --record the store must not have grown.
      expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * #1633 round 7. `--record --write-spec` is the documented recipe, and the
   * store was written BEFORE the splice was attempted. A spec with no
   * markers exited 1 with the row already recorded — exit 1 reads as
   * "nothing happened", so the honest retry ran the same command again and
   * appended a SECOND row for the same range. The parity suite would have
   * caught the divergence eventually; this script's own exit code did not.
   *
   * Both cases run the real script end to end, then assert on the STORE,
   * because the exit code is exactly what was not telling the truth.
   */
  for (const [name, spec] of [
    ["carries no markers", "# a spec with no crc-reading markers\n"],
    ["does not exist", null],
  ] as const) {
    test(`a --write-spec target that ${name} leaves the store untouched`, () => {
      const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
      try {
        const entries = join(dir, "entries.json");
        writeFileSync(
          entries,
          JSON.stringify([
            { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
            { number: 20, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
          ]),
        );
        const store = join(dir, "store.json");
        writeFileSync(store, "[]\n");
        if (spec !== null) writeFileSync(join(dir, "spec.md"), spec);

        const args = [
          "--lo", "10", "--hi", "20", "--from", entries,
          "--store", "store.json", "--record", "--write-spec", "spec.md",
        ];
        const real = run(SCRIPT, args, dir);
        expect(real.status).toBe(1);
        // The whole point: refused, and the store did NOT grow, so running
        // the same command again cannot double-count the range.
        expect(JSON.parse(readFileSync(store, "utf-8"))).toEqual([]);
        expect(real.stdout).not.toContain("recorded row");

        const again = run(SCRIPT, args, dir);
        expect(again.status).toBe(1);
        expect(JSON.parse(readFileSync(store, "utf-8"))).toEqual([]);

        const mutant = run(mutantPath(dir), args, dir);
        expect(mutant.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("a generator-owned spec is refused, and the store is still untouched", () => {
    /**
     * #1633 round 9, and it is a regression I introduced in round 8.
     *
     * Routing the spec write through `writeSpec` added a refusal — it asks
     * `mayWrite`, which says no to a document declaring itself generated —
     * two steps below a comment that had just claimed no such refusal came
     * after the store write. The claim stopped being true in the commit
     * that wrote it.
     *
     * The fix is ORDER, not a second check: asking `mayWrite` here would
     * be a second decider of the question `lib/write-spec.ts` exists to
     * answer once, so the document is written first and the store after.
     */
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
          { number: 20, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      const store = join(dir, "store.json");
      writeFileSync(store, "[]\n");
      const spec = join(dir, "spec.md");
      const owned = `---\ngenerated-by: some-other-generator.ts\n---\n\n${CRC_BLOCK_BEGIN}\n${CRC_BLOCK_END}\n`;
      writeFileSync(spec, owned);

      const args = [
        "--lo", "10", "--hi", "20", "--from", entries,
        "--store", "store.json", "--record", "--write-spec", "spec.md",
      ];
      const real = run(SCRIPT, args, dir);
      expect(real.status).toBe(1);
      // Both halves. The document was not overwritten — that is the
      // chokepoint doing its job — AND the store did not move, which is
      // the ordering this case exists for.
      expect(readFileSync(spec, "utf-8")).toBe(owned);
      expect(JSON.parse(readFileSync(store, "utf-8"))).toEqual([]);
      expect(real.stdout).not.toContain("recorded row");

      const mutant = run(mutantPath(dir), args, dir);
      expect(mutant.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--write-spec without --record is refused, and --record alone is not", () => {
    /**
     * #1633 round 10. The two flags had no cross-validation, so
     * `--write-spec` alone spliced a freshly computed reading into the
     * document and never appended it to the store. The spec then showed a
     * reading that exists in no store, and
     * `test/crc-reading-spec-parity.test.ts` — which asserts the block
     * equals a render of `store[store.length - 1]` — reddens on the next
     * unrelated pull request, with nothing in that pull request's diff to
     * explain it.
     *
     * THE REFUSAL IS SCOPED, NOT SYMMETRIC, and the control below is why.
     * `--record` alone also leaves the live pair out of step, so
     * both-or-neither reads as the principled rule — and it is the wrong
     * one. `--record` alone is the PRIMARY operation (take a reading,
     * store it); two cases in this file already exercise it, and
     * forbidding it would break the script's main use to fix a different
     * flag's defect. The harms also differ in kind: `--write-spec` alone
     * writes a value backed by nothing into a tracked document, while
     * `--record` alone writes a true value and leaves the document
     * behind. One fabricates, the other lags.
     */
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
          { number: 20, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      const store = join(dir, "store.json");
      writeFileSync(store, "[]\n");
      const spec = join(dir, "spec.md");
      const before = `# Spec\n\n${CRC_BLOCK_BEGIN}\n${CRC_BLOCK_END}\n`;
      writeFileSync(spec, before);

      const base = ["--lo", "10", "--hi", "20", "--from", entries, "--store", "store.json"];
      const args = [...base, "--write-spec", "spec.md"];

      const real = run(SCRIPT, args, dir);
      expect(real.status).toBe(1);
      // Neither side moved. The document is the one the defect corrupted,
      // and the store is the half that made the corruption invisible.
      expect(readFileSync(spec, "utf-8")).toBe(before);
      expect(JSON.parse(readFileSync(store, "utf-8"))).toEqual([]);
      expect(real.stderr).toContain("--write-spec");
      expect(real.stderr).toContain("--record");

      // The removal of the non-zero exit, performed and observed — so a
      // later pass for an unrelated reason is distinguishable from this.
      const mutant = run(mutantPath(dir), args, dir);
      expect(mutant.status).toBe(0);

      // THE CONTROL: the case where the refusal must NOT fire. Without it
      // a blanket both-or-neither rule would satisfy every assertion
      // above while breaking the script's primary use.
      const recordOnly = run(SCRIPT, [...base, "--record"], dir);
      expect(recordOnly.status).toBe(0);
      expect(recordOnly.stdout).toContain("recorded row 1");
      expect(JSON.parse(readFileSync(store, "utf-8"))).toHaveLength(1);
      // And it left the document alone, which is the lag rather than the
      // fabrication — the state the parity suite reports truthfully.
      expect(readFileSync(spec, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--save is the one write before a refusal, and it compounds nothing", () => {
    /**
     * The declared exception to the invariant stated in `main`. `--save`
     * dumps the fetched entries so a premise failure can be re-run with
     * `--from` instead of re-fetching — which is the case it exists for,
     * so moving it after the premise check would remove its only use.
     *
     * It is allowed because of two properties, and they are asserted here
     * rather than claimed in the comment: the refusal still protects the
     * STORE, and running twice writes identical bytes, so repetition
     * compounds nothing. A `--save` that ever became order-dependent
     * would red this.
     */
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      // A cohort that FAILS the premise check: it stops short of --hi.
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      writeFileSync(join(dir, "store.json"), "[]\n");
      const saved = join(dir, "saved.json");

      const args = [
        "--lo", "10", "--hi", "20", "--from", entries,
        "--store", "store.json", "--record", "--save", "saved.json",
      ];
      const first = run(SCRIPT, args, dir);
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(CRC_PREMISE_RANGE_NOT_COVERED);
      // The compounding write is protected.
      expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toEqual([]);
      // The declared one happened, on purpose.
      const once = readFileSync(saved, "utf-8");
      expect(JSON.parse(once)).toHaveLength(1);

      const second = run(SCRIPT, args, dir);
      expect(second.status).toBe(1);
      // Idempotent: identical bytes, so repeating the refused command
      // accumulates nothing.
      expect(readFileSync(saved, "utf-8")).toBe(once);
      expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the control: a spec WITH markers records and renders, both", () => {
    // Without this, a change that refused every --write-spec would make the
    // two cases above green while breaking the documented recipe.
    const dir = mkdtempSync(join(tmpdir(), "crc-reading-"));
    try {
      const entries = join(dir, "entries.json");
      writeFileSync(
        entries,
        JSON.stringify([
          { number: 10, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
          { number: 20, passed: true, truncated: false, body: ledgerBody([measured(1)]) },
        ]),
      );
      writeFileSync(join(dir, "store.json"), "[]\n");
      writeFileSync(join(dir, "spec.md"), `# spec\n\n${CRC_BLOCK_BEGIN}\n${CRC_BLOCK_END}\n`);

      const real = run(
        SCRIPT,
        ["--lo", "10", "--hi", "20", "--from", entries, "--store", "store.json",
          "--record", "--write-spec", "spec.md"],
        dir,
      );
      expect(real.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf-8"))).toHaveLength(1);
      expect(readFileSync(join(dir, "spec.md"), "utf-8")).toContain("#10–#20");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("one fence parser, and it cannot throw into a range read", () => {
  /**
   * #1633 round 6. `readLedger` and `ledgerRawRounds` each computed the three
   * fence offsets themselves and agreed by convention, with nothing enforcing
   * it — *two deciders that agree*, where no behavioural test can tell them
   * apart and a mutation of either leaves the other holding the case up. The
   * reviewer could not show them already diverging and did not need to: the
   * defect is that nothing could have shown it.
   *
   * `ledgerPayloadText` is now the only site, so the question of agreement
   * does not arise. These assert the two properties that fix buys.
   */
  const BODIES: readonly (string | null)[] = [
    null,
    "",
    "not a ledger at all",
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\nno fence here\n`,
    `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{"rounds":[]}`,
    `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{not json}\n\`\`\`\n`,
    `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n"a string"\n\`\`\`\n`,
    `${AI_REVIEW_LEDGER_COMMENT_MARKER}\n\n\`\`\`json\n{"other":[]}\n\`\`\`\n`,
    ledgerBody([]),
    ledgerBody([measured(1), unmeasured(2, "declined")]),
    // The live failure: a finding that quotes a fenced block. The naive
    // split cuts here; the shared rule does not.
    ledgerBody([measured(1, [{ summary: "the recipe was ```json\\n…\\n``` and it cut itself" }])]),
  ];

  test("the fence offsets are computed in exactly ONE place", () => {
    // The structural assertion. Without it the two parsers could come back
    // and nothing behavioural would notice — which is the whole finding.
    const source = readFileSync(join(ROOT, "lib/ai-review-rounds.ts"), "utf-8");
    const code = source
      .split("\n")
      .filter(line => !line.trimStart().startsWith("*"))
      .join("\n");
    expect(
      (code.match(/indexOf\("```json"/g) ?? []).length,
      "A second `indexOf(\"```json\")` is a second fence parser. Call " +
        "ledgerPayloadText instead — see .claude/rules/checks-must-be-able-to-fail.md.",
    ).toBe(1);
  });

  test("ledgerRawRounds never throws, and agrees with readLedger on every body", () => {
    for (const body of BODIES) {
      const reading = readLedger(body);
      // No try/catch here on purpose: a throw fails the case, which is the
      // property. A range reader calls this once per pull request and one
      // exception would lose the other forty-five.
      const raw = ledgerRawRounds(body);
      if (reading.status === AI_REVIEW_LEDGER_READ) {
        expect(raw, `READ body produced no raw rounds: ${String(body).slice(0, 60)}`).not.toBeNull();
        expect(raw).toHaveLength(reading.rounds.length);
      } else {
        expect(raw, `non-READ body produced raw rounds: ${String(body).slice(0, 60)}`).toBeNull();
      }
    }
    // The battery is not vacuous: it reaches both sides of that branch.
    const readable = BODIES.filter(b => readLedger(b).status === AI_REVIEW_LEDGER_READ);
    expect(readable.length).toBeGreaterThan(1);
    expect(readable.length).toBeLessThan(BODIES.length);
  });
});

describe("the cohort guards are a closed set, not four ad hoc checks", () => {
  /**
   * #1633 round 8, which re-emitted round 5's structural finding and said
   * exactly what would settle it: the closed-table pattern the columns got
   * is a one-off unless `premiseViolations`'s four checks get it too, in
   * which case "the next edge case costs another round" stops being true
   * of this file.
   *
   * It is the same instrument as the columns' table — enumerate the cohort
   * shapes, name the violation set each must produce, and refuse any
   * combination the table does not name. A fifth guard, or a change to any
   * of the four, lands here before it reaches a reading.
   *
   * It is NOT a claim that every cohort defect is now anticipated. It is
   * the weaker and checkable one: the guards' JOINT behaviour over the
   * shapes this file can build is written down rather than discovered one
   * round at a time.
   */
  const E = (number: number, over: Partial<CrcEntry> = {}) => entry({ number, ...over });
  const kinds = (es: CrcEntry[], lo: number, hi: number) =>
    premiseViolations(es, lo, hi)
      .map(v => v.kind)
      .sort()
      .join("+");

  /** cohort shape → the EXACT violation set it must produce. */
  const SHAPES: readonly (readonly [string, CrcEntry[], string])[] = [
    ["a clean full range", [E(10), E(15), E(20)], ""],
    ["the two ends only", [E(10), E(20)], ""],
    ["an empty page", [], CRC_PREMISE_RANGE_NOT_COVERED],
    ["a page stopping short", [E(10), E(15)], CRC_PREMISE_RANGE_NOT_COVERED],
    ["a page starting late", [E(15), E(20)], CRC_PREMISE_RANGE_NOT_COVERED],
    [
      "a number outside the range",
      [E(10), E(99), E(20)],
      [CRC_PREMISE_OUT_OF_RANGE, CRC_PREMISE_RANGE_NOT_COVERED].sort().join("+"),
    ],
    ["a duplicate inside the range", [E(10), E(15), E(15), E(20)], CRC_PREMISE_DUPLICATE],
    [
      "a full comment page with no ledger",
      [E(10), E(15, { truncated: true }), E(20)],
      CRC_PREMISE_UNRESOLVABLE_ABSENCE,
    ],
    [
      "a full page AND a duplicate — two independent guards at once",
      [E(10), E(15, { truncated: true }), E(15), E(20)],
      [CRC_PREMISE_UNRESOLVABLE_ABSENCE, CRC_PREMISE_DUPLICATE].sort().join("+"),
    ],
    [
      "a short page with no ledger — a real absence, and no violation",
      [E(10), E(15, { body: null, truncated: false }), E(20)],
      "",
    ],
  ];

  test("every cohort shape produces EXACTLY the violation set the table names", () => {
    for (const [name, entries, expected] of SHAPES) {
      expect(kinds(entries, 10, 20), `${name}: wrong violation set`).toBe(expected);
    }
  });

  test("the table reaches every guard, and every guard can stay silent", () => {
    // Without this the table could name four combinations none of which
    // actually fires a given guard, and the case above would be green
    // having exercised three checks — `.claude/rules/checks-must-be-able-to-fail.md`.
    const produced = new Set(SHAPES.flatMap(([, es]) => premiseViolations(es, 10, 20).map(v => v.kind)));
    expect([...produced].sort().join("+")).toBe(
      [
        CRC_PREMISE_DUPLICATE,
        CRC_PREMISE_OUT_OF_RANGE,
        CRC_PREMISE_RANGE_NOT_COVERED,
        CRC_PREMISE_UNRESOLVABLE_ABSENCE,
      ]
        .sort()
        .join("+"),
    );
    expect(SHAPES.filter(([, , expected]) => expected === "").length).toBeGreaterThan(1);
  });
});

describe("the two columns may disagree in exactly two ways, and they are named", () => {
  /**
   * The closed invariant round 4 asked for, as a property rather than one
   * more fixture.
   *
   * Rounds 1 through 4 each found a shape where this module answered two
   * questions about one ledger and the answers did not line up — the kind
   * decided twice, a zero standing in for an unknown, a range check that
   * only looked at the ends, and an empty ledger excluded from one column
   * while being listed by the other. Four instances of one defect is not
   * four defects, and a fifth fixture would not have found the fifth.
   *
   * So: run both columns over every ledger shape this file knows how to
   * build, and refuse any pair the table below does not name. A new refusal
   * in `rounds-to-pass.ts`, or a new early return here, fails this before it
   * can reach a reading.
   */
  const verdict = (r: { rounds: number } | { refusal: string }): string =>
    "refusal" in r ? r.refusal : "SCORED";

  /** `allRoundsFor` verdict → the ONLY `measuredRoundsFor` verdict allowed. */
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    // Facts about the LEDGER. True in both columns or neither.
    LEDGER_ABSENT: ["LEDGER_ABSENT"],
    LEDGER_UNREADABLE: ["LEDGER_UNREADABLE"],
    ROUNDS_EMPTY: ["ROUNDS_EMPTY"],
    // Divergence one: an unknown eviction count is a refusal for a COUNT and
    // a lower bound for this column, which reports the bound and flags it.
    ROUNDS_TRUNCATION_UNKNOWN: ["SCORED"],
    // Divergence two: rounds happened, none produced a review.
    SCORED: ["SCORED", "ZERO_MEASURED_ROUNDS"],
  };

  const SHAPES: Readonly<Record<string, string | null>> = {
    "no ledger comment at all": null,
    "a ledger whose JSON does not parse": [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      "{not json",
      "```",
      "",
    ].join("\n"),
    "a ledger that parsed and holds NO rounds": ledgerBody([], 0),
    "a legacy bare array at the eviction cap": [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      JSON.stringify(Array.from({ length: 12 }, (_, i) => measured(i + 1))),
      "```",
    ].join("\n"),
    "an eviction count that is not a number": ledgerBody(
      [measured(1)],
      "seven" as unknown as number,
    ),
    "rounds that all declined": ledgerBody([unmeasured(1, "declined"), unmeasured(2, "declined")]),
    "an ordinary two-round history": ledgerBody([unmeasured(1, "declined"), measured(2)]),
    "a stated eviction above zero": ledgerBody([measured(1)], 3),
  };

  test("every ledger shape lands on a pair the table names", () => {
    const seen = new Set<string>();
    for (const [name, body] of Object.entries(SHAPES)) {
      const e = entry({ number: 1, body });
      const all = verdict(allRoundsFor(e));
      const only = verdict(measuredRoundsFor(e));
      expect(
        ALLOWED[all] ?? [],
        `${name}: all-rounds said ${all} and measured-only said ${only}, a pair ` +
          "the table does not name. Add the row deliberately, or make the two " +
          "columns agree — see MEASURED_ONLY_SCORES_ANYWAY in lib/crc-reading.ts.",
      ).toContain(only);
      seen.add(`${all}->${only}`);
    }
    // The table is not allowed to be wider than the battery. A row nothing
    // reaches is a divergence nobody has looked at, written down as if it
    // had been — `.claude/rules/checks-must-be-able-to-fail.md`.
    const named = Object.entries(ALLOWED).flatMap(([a, os]) => os.map(o => `${a}->${o}`));
    expect([...seen].sort()).toEqual(named.sort());
  });

  test("an EMPTY ledger is excluded from BOTH columns, not listed as zero-measured", () => {
    // Round 4's input, verbatim. Before the fix this was ROUNDS_EMPTY in the
    // all-rounds column and ZERO_MEASURED_ROUNDS in the other, so a pull
    // request the reviewer was never even asked about appeared in the
    // rendered `zeroMeasured` list beside ones it was asked about and
    // refused. Those are different facts and the list meant only one.
    const row = takeCrcReading(
      [
        entry({ number: 1, body: ledgerBody([], 0) }),
        entry({ number: 2, body: ledgerBody([unmeasured(1, "declined")]) }),
      ],
      1,
      2,
      "2026-10-27",
    );
    expect(row.zeroMeasured).toEqual([2]);
    expect(row.measuredOnly.measured).toBe(0);
    expect(row.measuredOnly.refusals.map(r => [r.number, r.refusal])).toEqual([
      [1, "ROUNDS_EMPTY"],
      [2, "ZERO_MEASURED_ROUNDS"],
    ]);
  });
});

describe("allRoundsFor delegates rather than restating", () => {
  test("a legacy bare array at the cap refuses as a lower bound", () => {
    // `roundsTaken`'s own refusal, reached through this module — proof the
    // truncation rule is not copied here, where it would drift flatteringly.
    const body = [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      JSON.stringify(Array.from({ length: 12 }, (_, i) => measured(i + 1))),
      "```",
    ].join("\n");
    const taken = allRoundsFor(entry({ number: 1, body }));
    expect("refusal" in taken && taken.refusal).toBe("ROUNDS_TRUNCATION_UNKNOWN");
    // And the measured-only column still reads it, because an evicted round's
    // existence is what is unknown there, not its kind — but it carries the
    // truncation reading WHOLE rather than flattening it to a zero that
    // would read as "verified nothing was evicted" (round 2).
    const only = measuredRoundsFor(entry({ number: 1, body }));
    expect(only).toMatchObject({ rounds: 12 });
    expect((only as { truncation: { status: string } }).truncation.status).toBe(
      "AI_REVIEW_TRUNCATION_UNKNOWN",
    );
  });
});
