/**
 * CRC-N4 "no repeats", in the deployed adjudication path (#1586).
 *
 * `lib/ai-review-rounds.ts` has exported `carryKey`, `suppressRepeats`,
 * `priorFindings` and four siblings since #1351 and **nothing in production
 * called any of them**. This file binds the half that was missing: a gate
 * built in `lib/ai-review-suppression.ts`, handed to the reader by
 * `scripts/ai-review-findings.ts`, in the path `bunx rungate
 * ai-review-findings` runs.
 *
 * ## The acceptance, as amended on the issue
 *
 * Two cases, and the second one is the reason the first is safe:
 *
 * - **AS-1** a planted prior **ADVISORY** that still applies is not
 *   re-emitted, and a mutant that removes the subtraction turns that case
 *   red.
 * - **AS-2** a planted prior **BLOCKING** finding is still re-emitted and
 *   **still blocks**, and a mutant that removes the EXEMPTION proves the
 *   exemption is what did it — asserting on the resulting `blocked` and the
 *   surviving severities, not on a count. A count can stay right while the
 *   verdict moves, and the verdict is the thing that gates.
 *
 * The original wording asked only for the first. Built as written it
 * specifies a GREEN CHECK OVER A LIVE DEFECT, which was measured on the real
 * functions before any of this was written: a round-1 blocking finding,
 * re-reported on round 2 exactly as `buildReviewPrompt` instructs, run
 * through `suppressRepeats` with the ledger's keys, gives
 * `kept: 0, suppressed: 1, severity of what survives: []` → `blocked: false`
 * → `CLEAN`. `AS-6` below is that measurement, executed.
 *
 * ## Two halves that had to land together
 *
 * Supplying `lineTextFor` makes this round's keys SYMMETRIC with the
 * ledger's — before it, every key the adjudicator formed was `n:<line>` and
 * every key the ledger held was `t:<text>`, so the dedupe silently matched
 * nothing (`AS-5`). The blocking exemption is what stops that symmetry from
 * dropping a live finding. A tree carrying the first without the second is a
 * tree where a blocking repeat greens, so they are in one commit and `AS-6`
 * is the measurement that says why.
 *
 * ## The ordering guard
 *
 * The deployed job runs `ai-review-carry` → the reviewer →
 * `ai-review-persist`, **which writes this round into the ledger** →
 * `ai-review-run`. A gate fetching the ledger itself would read this round's
 * own findings as prior and report CLEAN forever. The snapshot is taken at
 * the carry step and carries `taken_before_round=<N>`; `AS-4` plants a
 * snapshot taken at PERSIST instead and asserts it is refused, with a mutant
 * that removes the guard suppressing this round against itself.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import {
  AI_REVIEW_PRIOR_MEASURED,
  carryKey,
  priorFindings,
  readLedger,
  suppressRepeats,
  type ReviewFinding,
} from "../lib/ai-review-rounds";
import {
  aiReviewSuppressionGate,
  carryStateOf,
  checkoutLineText,
  priorKeysFrom,
  readOrNull,
  readSnapshot,
} from "../lib/ai-review-suppression";
import {
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_SUPPRESSED_TITLE,
  AI_REVIEW_SUPPRESSED_UNMEASURED_TITLE,
  aiReviewExitCode,
  findingMustAlwaysBeReported,
  readAiReviewFindings,
  severityBlocks,
  type AiReviewSuppressionGate,
} from "../lib/scaffold/ai-review-findings";
import {
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_PATH_VAR,
  AI_REVIEW_CARRY_READ,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR,
  AI_REVIEW_LEDGER_TEXT_FIELD,
  AI_REVIEW_SNAPSHOT_ROUND_KEY,
  AI_REVIEW_VERDICT_KEY,
} from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const LIB = join(ROOT, "lib");

let SCRATCH: string;

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-suppression-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────

/**
 * The text at the cited line, in the checkout AND in the ledger's record of
 * it. One constant, because the entire mechanism is those two agreeing: if
 * the fixture let them drift, every case below would pass by suppressing
 * nothing and `AS-5` would have nothing to be a control for.
 */
const CITED_LINE = "  await symlink(target, path);";
const CITED_FILE = "lib/example.ts";
const CITED_AT = 4;

function checkout(name: string): string {
  const dir = join(SCRATCH, `checkout-${name}`);
  mkdirSync(join(dir, dirname(CITED_FILE)), { recursive: true });
  const lines = Array.from({ length: 10 }, (_, i) => `// filler ${i}`);
  lines[CITED_AT - 1] = CITED_LINE;
  writeFileSync(join(dir, CITED_FILE), lines.join("\n"));
  return dir;
}

function advisory(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "low",
    file: CITED_FILE,
    line: CITED_AT,
    summary: "the variable could be named better",
    ...over,
  };
}

function blocking(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    file: CITED_FILE,
    line: CITED_AT,
    summary: "unsafe link creation",
    failure_scenario: "a caller follows the link out of the checkout",
    ...over,
  };
}

/** A ledger comment body in exactly the shape the persist step writes. */
function ledgerBody(entries: unknown): string {
  return [
    AI_REVIEW_LEDGER_MARKER,
    "",
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify(entries, null, 2),
    "```",
    "",
  ].join("\n");
}

function round(n: number, findings: Record<string, unknown>[]): Record<string, unknown> {
  return {
    at: "2026-10-24T12:00:00Z",
    sha: "a".repeat(40),
    run: "1",
    attempt: "1",
    round: n,
    identity: AI_REVIEW_LEDGER_IDENTITY_V1,
    [AI_REVIEW_FINDINGS_KEY]: findings.map(f => ({
      ...f,
      [AI_REVIEW_LEDGER_TEXT_FIELD]: CITED_LINE,
    })),
  };
}

/** The snapshot exactly as `buildCarryScript` writes it: header, then body. */
function snapshotOf(takenBeforeRound: number, body: string): string {
  return `${AI_REVIEW_SNAPSHOT_ROUND_KEY}=${takenBeforeRound}\n${body}`;
}

function carryFile(state: string): string {
  return `${AI_REVIEW_CARRY_STATE_KEY}=${state}\n`;
}

function payloadOf(verdict: string, findings: Record<string, unknown>[]): string {
  return JSON.stringify({
    [AI_REVIEW_VERDICT_KEY]: verdict,
    [AI_REVIEW_FINDINGS_KEY]: findings,
  });
}

/** The gate as the wrapper builds it, over an in-memory carry and snapshot. */
function gate(opts: {
  carry?: string | null;
  snapshot?: string | null;
  root?: string;
  withLineText?: boolean;
}): AiReviewSuppressionGate {
  const root = opts.root ?? checkout("default");
  return aiReviewSuppressionGate({
    carry: opts.carry === undefined ? carryFile(AI_REVIEW_CARRY_READ) : opts.carry,
    snapshot: opts.snapshot === undefined ? null : opts.snapshot,
    lineTextFor:
      opts.withLineText === false ? () => undefined : checkoutLineText(root),
  });
}

// ── AS-0: the mutation bindings exist exactly once ───────────────────────
//
// Asserted before any battery runs, because a `String.replace` that matched
// nothing produces a mutant identical to the real source, and a battery over
// two identical modules reports a clean row having witnessed nothing.

const SUBTRACTION_BINDING = "const kept = list.filter((_, i) => repeatOf[i] === null);";
const SUBTRACTION_MUTANT = "const kept = list;";

const EXEMPTION_BINDING = "return severityBlocks(severity) !== false;";
const EXEMPTION_MUTANT = "return false;";

const ORDERING_BINDING =
  "const stale = reading.prior.filter(p => typeof p.round === \"number\" && p.round >= round);";
const ORDERING_MUTANT = "const stale: typeof reading.prior = [];";

describe("AS-0: each mutated binding is the only one of its kind", () => {
  test("AS-0a: the subtraction and the exemption appear exactly once each", () => {
    const source = readFileSync(join(LIB, "scaffold", "ai-review-findings.ts"), "utf-8");
    expect(source.split(SUBTRACTION_BINDING).length - 1).toBe(1);
    expect(source.split(EXEMPTION_BINDING).length - 1).toBe(1);
  });

  test("AS-0b: the ordering guard appears exactly once", () => {
    const source = readFileSync(join(LIB, "ai-review-suppression.ts"), "utf-8");
    expect(source.split(ORDERING_BINDING).length - 1).toBe(1);
  });

  test("AS-0c: the exemption is the only place the reader decides what to offer", () => {
    const source = readFileSync(join(LIB, "scaffold", "ai-review-findings.ts"), "utf-8");
    // A second site deciding the same question would hold every case up
    // under a mutation of the first — two deciders that agree
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
    expect(source.split("findingMustAlwaysBeReported(").length - 1).toBe(2);
  });
});

/**
 * A copy of the reader whose own source is `mutate(source)` and whose one
 * relative import is redirected at the real module in this tree.
 *
 * `lib/scaffold/ai-review-findings.ts` has exactly one sibling specifier,
 * `./ai-review-step`, and three OTHER mutation batteries already copy it into
 * scratch directories carrying only that. Rewriting rather than copying keeps
 * this battery from being the one that has to be taught about a new
 * dependency — and a mutant that died on module resolution reports zero
 * findings, which reads exactly like a guard behaving differently.
 */
async function mutantReader(
  name: string,
  mutate: (source: string) => string,
): Promise<typeof import("../lib/scaffold/ai-review-findings")> {
  const dir = join(SCRATCH, `mutant-${name}`);
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(join(LIB, "scaffold", "ai-review-findings.ts"), "utf-8");
  const mutated = mutate(source);
  expect(mutated, `the mutation for ${name} did not change the reader`).not.toBe(source);
  const rewritten = mutated.replace(
    /from "\.\/ai-review-step"/g,
    `from "${join(LIB, "scaffold", "ai-review-step")}"`,
  );
  expect(rewritten, `the ${name} mutant kept a relative sibling import`).not.toBe(mutated);
  const path = join(dir, "ai-review-findings.ts");
  writeFileSync(path, rewritten);
  return (await import(path)) as typeof import("../lib/scaffold/ai-review-findings");
}

/** The same, for the gate module. Its siblings are rewritten the same way. */
async function mutantGate(
  name: string,
  mutate: (source: string) => string,
): Promise<typeof import("../lib/ai-review-suppression")> {
  const dir = join(SCRATCH, `mutant-gate-${name}`);
  mkdirSync(dir, { recursive: true });
  const source = readFileSync(join(LIB, "ai-review-suppression.ts"), "utf-8");
  const mutated = mutate(source);
  expect(mutated, `the mutation for ${name} did not change the gate`).not.toBe(source);
  const rewritten = mutated
    .replace(/from "\.\/scaffold\//g, `from "${join(LIB, "scaffold")}/`)
    .replace(/from "\.\/(?!scaffold)/g, `from "${LIB}/`);
  expect(rewritten, `the ${name} gate mutant kept a relative sibling import`).not.toBe(mutated);
  const path = join(dir, "ai-review-suppression.ts");
  writeFileSync(path, rewritten);
  return (await import(path)) as typeof import("../lib/ai-review-suppression");
}

// ── AS-1: a prior ADVISORY that still applies is not re-emitted ──────────

describe("AS-1: the planted prior advisory is suppressed, and the subtraction is what did it", () => {
  const prior = ledgerBody([round(1, [advisory()])]);
  const snapshot = snapshotOf(2, prior);
  const payload = payloadOf("PASS", [advisory()]);

  test("AS-1a: it is named in the suppressed set and absent from the report", () => {
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot }));

    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.suppressedReported).toHaveLength(1);
    expect(reading.suppressedReported[0]).toMatchObject({ summary: advisory().summary });
    expect(reading.suppressionReasons).toHaveLength(1);
    expect(reading.suppressionReasons[0]).toContain(CITED_FILE);
    // Dropped EVERYWHERE, not filtered out of one projection.
    expect(reading.reported).toEqual([]);
    expect(reading.blockingReported).toEqual([]);
    expect(reading.outcome).toBe("CLEAN");
  });

  test("AS-1b: removing the subtraction turns AS-1a red", async () => {
    const mutant = await mutantReader("subtraction", s =>
      s.replace(SUBTRACTION_BINDING, SUBTRACTION_MUTANT),
    );
    const forged = mutant.readAiReviewFindings(payload, undefined, gate({ snapshot }));

    // Same input, opposite reading: the finding is back in the report.
    expect(forged.reported).toHaveLength(1);
    expect(readAiReviewFindings(payload, undefined, gate({ snapshot })).reported).toEqual([]);
  });

  test("AS-1c: a prior round raising something ELSE suppresses nothing", () => {
    // The vacuity control. Every assertion above would also hold if the gate
    // suppressed unconditionally, and this is the input that tells them
    // apart — same rig, same carry state, a key that does not match.
    const other = ledgerBody([round(1, [advisory({ summary: "a different complaint" })])]);
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot: snapshotOf(2, other) }));

    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
  });
});

// ── AS-2: a prior BLOCKING finding still blocks ──────────────────────────

describe("AS-2: the planted prior blocking finding is re-emitted and still blocks", () => {
  const prior = ledgerBody([round(1, [blocking()])]);
  const snapshot = snapshotOf(2, prior);
  const payload = payloadOf("BLOCK", [blocking()]);

  test("AS-2a: it survives the gate, blocks, and is not in the suppressed set", () => {
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot }));

    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
    expect(reading.blockingReported).toHaveLength(1);
    expect(reading.blocked).toBe(true);
    expect(reading.outcome).toBe("BLOCKED");
    expect(aiReviewExitCode(reading)).not.toBe(0);
  });

  test("AS-2b: removing the EXEMPTION drops the blocking finding and un-blocks", async () => {
    const mutant = await mutantReader("exemption", s =>
      s.replace(EXEMPTION_BINDING, EXEMPTION_MUTANT),
    );
    const forged = mutant.readAiReviewFindings(payload, undefined, gate({ snapshot }));

    // The assertion is `blocked` and the surviving SEVERITIES, not a count.
    // A count can stay right while the thing that gates moves.
    expect(forged.blocked).toBe(false);
    expect(forged.blockingReported).toEqual([]);
    expect(
      (forged.reported ?? []).map(f => (f as ReviewFinding).severity),
      "the mutant's surviving severities — the measurement in the predicate's docblock",
    ).toEqual([]);

    // And the real reader, over the same bytes, blocks.
    const real = readAiReviewFindings(payload, undefined, gate({ snapshot }));
    expect(real.blocked).toBe(true);
    expect(real.outcome).toBe("BLOCKED");
  });

  test("AS-2c: under a BLOCK verdict the mutant lands on CONTRADICTION, not CLEAN", async () => {
    // PREDICTED `CLEAN`; MEASURED `CONTRADICTION`. Worth keeping as a case
    // rather than correcting silently, because it names a SECOND guard
    // standing where the exemption stands.
    //
    // `agreed` compares the reviewer's word against the post-suppression
    // blocking count, so `BLOCK` over a payload the mutant emptied is
    // #1178's contradiction and still exits non-zero. The exemption is
    // therefore not the only thing holding this particular input up — which
    // is exactly what a battery is for, and it does not survive the input in
    // `AS-2d`.
    const mutant = await mutantReader("exemption", s =>
      s.replace(EXEMPTION_BINDING, EXEMPTION_MUTANT),
    );
    const forged = mutant.readAiReviewFindings(payload, undefined, gate({ snapshot }));
    expect(forged.outcome).toBe("CONTRADICTION");
    expect(mutant.aiReviewExitCode(forged)).not.toBe(0);
  });

  test("AS-2d: with a PASS verdict the mutant turns a refusal into a GREEN check", async () => {
    // The input `AS-2c` showed was missing, and the one the exemption is
    // actually load-bearing for. A reviewer that re-reports a carried
    // `high` finding while writing `PASS` — it believes the issue is minor
    // or settled — disagrees with the severity table. Today that is a
    // CONTRADICTION and the check is red. Under the mutant the finding is
    // suppressed, nothing blocks, the word and the payload agree, and the
    // run exits 0 over a defect an earlier round blocked on.
    //
    // The disagreement is not hypothetical: the `agreed` computation's own
    // docblock records it at roughly 6 of 20 runs.
    const disagreeing = payloadOf("PASS", [blocking()]);
    const mutant = await mutantReader("exemption", s =>
      s.replace(EXEMPTION_BINDING, EXEMPTION_MUTANT),
    );

    const real = readAiReviewFindings(disagreeing, undefined, gate({ snapshot }));
    const forged = mutant.readAiReviewFindings(disagreeing, undefined, gate({ snapshot }));

    expect(real.blocked).toBe(true);
    expect(aiReviewExitCode(real)).not.toBe(0);

    expect(forged.blocked).toBe(false);
    expect(forged.outcome).toBe("CLEAN");
    expect(mutant.aiReviewExitCode(forged)).toBe(0);
  });

  test("AS-2e: an UNRECOGNISED severity is protected too", () => {
    // `severityBlocks` answers true / false / null, and only an explicit
    // `false` is offered. `null` is "nobody classified this", which must not
    // become the way round the exemption.
    const odd = blocking({ severity: "spicy" });
    expect(severityBlocks("spicy")).toBeNull();
    expect(findingMustAlwaysBeReported(odd)).toBe(true);

    const reading = readAiReviewFindings(
      payloadOf("BLOCK", [odd]),
      undefined,
      gate({ snapshot: snapshotOf(2, ledgerBody([round(1, [odd])])) }),
    );
    expect(reading.suppressedReported).toEqual([]);
  });
});

// ── AS-3: an unreadable or absent history suppresses NOTHING ─────────────

describe("AS-3: every refusal reports everything, and says a different thing", () => {
  const payload = payloadOf("PASS", [advisory()]);
  const prior = ledgerBody([round(1, [advisory()])]);

  /**
   * Eight inputs, and the third column is the FACT each one establishes.
   *
   * Two pairs share a fact on purpose and the grouping says which: a carry
   * file that could not be read and one whose first line is not the state
   * line are both "the carry step's own reading could not be read", and a
   * snapshot with no header and one whose header is not an integer are both
   * "it does not say which round it precedes". Asserting eight distinct
   * sentences would have been asserting that two identical facts print
   * differently, which is a worse report, not a better one.
   */
  const refusals: Array<[string, { carry: string | null; snapshot: string | null }, string]> = [
    ["an unreadable carry file", { carry: null, snapshot: snapshotOf(2, prior) }, "carry-unread"],
    [
      "a carry file with no state line",
      { carry: "something else entirely\n", snapshot: snapshotOf(2, prior) },
      "carry-unread",
    ],
    [
      "the carry step reporting UNMEASURED",
      { carry: carryFile(AI_REVIEW_CARRY_UNMEASURED), snapshot: snapshotOf(2, prior) },
      "carry-unmeasured",
    ],
    [
      "a state this reader does not know",
      { carry: carryFile("AI_REVIEW_CARRY_SOMETHING_NEW"), snapshot: snapshotOf(2, prior) },
      "carry-unknown-state",
    ],
    [
      "a READ state with no snapshot",
      { carry: carryFile(AI_REVIEW_CARRY_READ), snapshot: null },
      "snapshot-unread",
    ],
    [
      "a snapshot with no provenance header",
      { carry: carryFile(AI_REVIEW_CARRY_READ), snapshot: prior },
      "snapshot-no-provenance",
    ],
    [
      "a snapshot whose round is not an integer",
      {
        carry: carryFile(AI_REVIEW_CARRY_READ),
        snapshot: `${AI_REVIEW_SNAPSHOT_ROUND_KEY}=later\n${prior}`,
      },
      "snapshot-no-provenance",
    ],
    [
      "a ledger that will not parse",
      {
        carry: carryFile(AI_REVIEW_CARRY_READ),
        snapshot: snapshotOf(2, `${AI_REVIEW_LEDGER_MARKER}\n\n\`\`\`json\n{ nope\n\`\`\`\n`),
      },
      "ledger-unreadable",
    ],
  ];

  for (const [what, inputs] of refusals) {
    test(`AS-3: ${what} suppresses nothing and names itself`, () => {
      const reading = readAiReviewFindings(payload, undefined, gate(inputs));
      expect(reading.suppressedReported).toEqual([]);
      expect(reading.reported).toHaveLength(1);
      expect(reading.suppressionUnmeasured, what).not.toBeNull();
    });
  }

  test("AS-3i: one sentence per FACT, and no two facts share one", () => {
    // "Could not parse" and "there was nothing to carry" becoming one
    // observation is #1568. Six distinct refusals printing one sentence is
    // the same defect with a larger population, so the distinctness is
    // asserted rather than hoped for — and so is the agreement inside each
    // group, which is what stops a later edit from making one of them
    // unique by accident.
    const byGroup = new Map<string, Set<string | null>>();
    for (const [, inputs, group] of refusals) {
      const said = readAiReviewFindings(payload, undefined, gate(inputs)).suppressionUnmeasured;
      byGroup.set(group, (byGroup.get(group) ?? new Set()).add(said));
    }
    for (const [group, said] of byGroup) {
      expect(said.size, `${group} printed more than one sentence`).toBe(1);
    }
    const sentences = [...byGroup.values()].map(s => [...s][0]);
    expect(new Set(sentences).size).toBe(byGroup.size);
    expect(byGroup.size).toBe(6);
  });

  test("AS-3j: ABSENT is MEASURED-with-no-keys, not a refusal", () => {
    // The one state that is a complete reading whose answer is "nothing".
    // It must NOT print the unmeasured warning — a pull request on its first
    // round would carry one on every run, and a warning that fires always is
    // a warning nobody reads.
    const reading = readAiReviewFindings(
      payload,
      undefined,
      gate({ carry: carryFile(AI_REVIEW_CARRY_ABSENT), snapshot: null }),
    );
    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
  });

  test("AS-3k: a gate that throws reports everything", () => {
    const reading = readAiReviewFindings(payload, undefined, () => {
      throw new Error("the history is on fire");
    });
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
    expect(reading.suppressionUnmeasured).toContain("the history is on fire");
  });

  test("AS-3l: a gate answering about the wrong number of findings is refused whole", () => {
    const reading = readAiReviewFindings(payloadOf("PASS", [advisory(), advisory()]), undefined, () => ({
      repeat: ["only one answer"],
      unmeasured: null,
    }));
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(2);
    expect(reading.suppressionUnmeasured).toContain("could be matched");
  });

  test("AS-3m: no gate at all is the pre-#1586 reading", () => {
    const reading = readAiReviewFindings(payload);
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.reported).toHaveLength(1);
  });
});

// ── AS-4: the ordering guard — a snapshot taken at PERSIST is refused ────

describe("AS-4: a snapshot taken after the persist step cannot suppress", () => {
  // The whole trap, as bytes. The persist step upserts THIS round into the
  // ledger before the adjudicator runs, so a snapshot taken there is the
  // same comment fetched the same way and is shaped exactly like a correct
  // one. The only tell is that it already holds round 2.
  const afterPersist = ledgerBody([round(1, [advisory()]), round(2, [advisory()])]);
  const snapshot = snapshotOf(2, afterPersist);
  const payload = payloadOf("PASS", [advisory()]);

  test("AS-4a: it is refused, by name, and nothing is suppressed", () => {
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot }));
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
    expect(reading.suppressionUnmeasured).toContain("AFTER this round was recorded");
  });

  test("AS-4b: removing the guard makes this round suppress ITSELF", async () => {
    const mutant = await mutantGate("ordering", s => s.replace(ORDERING_BINDING, ORDERING_MUTANT));
    const forged = readAiReviewFindings(
      payload,
      undefined,
      mutant.aiReviewSuppressionGate({
        carry: carryFile(AI_REVIEW_CARRY_READ),
        snapshot,
        lineTextFor: mutant.checkoutLineText(checkout("ordering")),
      }),
    );

    // Same bytes, opposite reading — and the mutant's reading is the one
    // where a pull request reports CLEAN because the persist step ran first.
    expect(forged.suppressedReported).toHaveLength(1);
    expect(forged.reported).toEqual([]);
    expect(forged.suppressionUnmeasured).toBeNull();
  });

  test("AS-4c: the SAME ledger, snapshotted at carry, suppresses normally", () => {
    // The control that makes AS-4a about the ORDERING rather than about the
    // ledger's contents: one variable differs, which round the header names.
    const reading = readAiReviewFindings(
      payload,
      undefined,
      gate({ snapshot: snapshotOf(3, afterPersist) }),
    );
    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.suppressedReported).toHaveLength(1);
  });
});

// ── AS-5: key symmetry — the half that made the dedupe inert ─────────────

describe("AS-5: without the checkout's line text the keys never meet", () => {
  const prior = ledgerBody([round(1, [advisory()])]);
  const snapshot = snapshotOf(2, prior);
  const payload = payloadOf("PASS", [advisory()]);

  test("AS-5a: a gate with no lineTextFor suppresses nothing, on an exact repeat", () => {
    const reading = readAiReviewFindings(
      payload,
      undefined,
      gate({ snapshot, withLineText: false }),
    );
    // Not a refusal — a MEASURED reading that found no repeat, which is the
    // dangerous shape: it prints nothing and looks like a round with no
    // repeats. This is what `suppressRepeats` did for the seven months it
    // had no caller.
    expect(reading.suppressionUnmeasured).toBeNull();
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
  });

  test("AS-5b: the two keys are in different namespaces, and that is why", () => {
    const f = advisory();
    expect(carryKey(f, undefined)).toContain("\u0000n:");
    expect(carryKey(f, CITED_LINE)).toContain("\u0000t:");
    expect(carryKey(f, undefined)).not.toBe(carryKey(f, CITED_LINE));
  });

  test("AS-5c: the same rig WITH lineTextFor suppresses it", () => {
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot }));
    expect(reading.suppressedReported).toHaveLength(1);
  });

  test("AS-5d: an unreadable line falls back to the number anchor and is reported", () => {
    const empty = mkdtempSync(join(SCRATCH, "empty-"));
    const reading = readAiReviewFindings(payload, undefined, gate({ snapshot, root: empty }));
    expect(reading.suppressedReported).toEqual([]);
    expect(reading.reported).toHaveLength(1);
  });
});

// ── AS-6: the measurement that made the exemption structural ─────────────

describe("AS-6: the unexempted design, executed", () => {
  test("AS-6: suppressRepeats over a re-reported blocking finding keeps nothing", () => {
    // Not an argument in a docblock. The real `suppressRepeats`, the real
    // `priorFindings`, a round-1 blocking finding and the round-2 payload
    // the deployed prompt asks the reviewer to produce.
    const prior = priorFindings(readLedger(ledgerBody([round(1, [blocking()])])));
    expect(prior.status).toBe(AI_REVIEW_PRIOR_MEASURED);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");

    const reading = suppressRepeats([blocking()], prior.keys, () => CITED_LINE);

    expect(reading.kept).toEqual([]);
    expect(reading.suppressed).toHaveLength(1);
    expect(reading.kept.map(f => (f as ReviewFinding).severity)).toEqual([]);

    // And the consequence: an adjudicator reading that `kept` sees nothing
    // that blocks. `blocked: false`, `CLEAN`, over a defect round 1 blocked
    // on — which is why the exemption filters BEFORE the gate is handed
    // anything, rather than being a rule the gate is trusted to follow.
    const asIfKept = readAiReviewFindings(payloadOf("PASS", []));
    expect(asIfKept.blocked).toBe(false);
    expect(asIfKept.outcome).toBe("CLEAN");
  });
});

// ── AS-7: within-round repeats, and the first occurrence is kept ─────────

describe("AS-7: the same finding twice in one payload", () => {
  test("AS-7: the second is suppressed and the first is reported", () => {
    const reading = readAiReviewFindings(
      payloadOf("PASS", [advisory(), advisory()]),
      undefined,
      gate({ carry: carryFile(AI_REVIEW_CARRY_ABSENT), snapshot: null }),
    );
    expect(reading.reported).toHaveLength(1);
    expect(reading.suppressedReported).toHaveLength(1);
    expect(reading.suppressionUnmeasured).toBeNull();
  });

  test("AS-7b: a blocking finding twice in one payload is reported twice", () => {
    // It never reaches the gate, so the within-round half does not apply to
    // it either. Reporting a blocking finding twice is noise; dropping one
    // is a decision about a merge gate.
    const reading = readAiReviewFindings(
      payloadOf("BLOCK", [blocking(), blocking()]),
      undefined,
      gate({ carry: carryFile(AI_REVIEW_CARRY_ABSENT), snapshot: null }),
    );
    expect(reading.reported).toHaveLength(2);
    expect(reading.blocked).toBe(true);
  });
});

// ── AS-8: the readers under the gate ─────────────────────────────────────

describe("AS-8: the files are read as the carry step writes them", () => {
  test("AS-8a: carryStateOf reads the first line's value", () => {
    expect(carryStateOf(carryFile(AI_REVIEW_CARRY_READ))).toBe(AI_REVIEW_CARRY_READ);
    expect(carryStateOf(`${carryFile(AI_REVIEW_CARRY_ABSENT)}trailing\n`)).toBe(
      AI_REVIEW_CARRY_ABSENT,
    );
    expect(carryStateOf("")).toBeNull();
    expect(carryStateOf(null)).toBeNull();
  });

  test("AS-8b: readSnapshot splits the header from the body", () => {
    const body = ledgerBody([round(1, [advisory()])]);
    expect(readSnapshot(snapshotOf(7, body))).toEqual({ round: 7, body });
    expect(readSnapshot(body).round).toBeNull();
    expect(readSnapshot(`${AI_REVIEW_SNAPSHOT_ROUND_KEY}=2.5\nx`).round).toBeNull();
  });

  test("AS-8c: readOrNull is the only place absent and unreadable collapse", () => {
    expect(readOrNull(undefined)).toBeNull();
    expect(readOrNull("")).toBeNull();
    expect(readOrNull(join(SCRATCH, "nothing-here"))).toBeNull();
    const path = join(SCRATCH, "something-here");
    writeFileSync(path, "contents");
    expect(readOrNull(path)).toBe("contents");
  });

  test("AS-8d: checkoutLineText refuses a path that escapes the root", () => {
    const root = checkout("escape");
    const read = checkoutLineText(root);
    expect(read(advisory() as ReviewFinding)).toBe(CITED_LINE);
    // `resolve` normalises the `..` away, so the containment test is on the
    // resolved path. A payload names its own paths and is written by the
    // reviewer, so this is an input rather than a hypothetical.
    expect(read({ file: "../../etc/passwd", line: 1 })).toBeUndefined();
    expect(read({ file: "/etc/passwd", line: 1 })).toBeUndefined();
    expect(read({ file: CITED_FILE, line: 9999 })).toBeUndefined();
    expect(read({ file: CITED_FILE, line: 0 })).toBeUndefined();
    expect(read({ file: CITED_FILE })).toBeUndefined();
  });

  test("AS-8e: priorKeysFrom is pure and is the one place the states are decided", () => {
    const body = ledgerBody([round(1, [advisory()])]);
    const measured = priorKeysFrom(carryFile(AI_REVIEW_CARRY_READ), snapshotOf(2, body));
    expect(measured.status).toBe("MEASURED");
    if (measured.status !== "MEASURED") throw new Error("unreachable");
    expect(measured.keys).toHaveLength(1);
    const expected = carryKey(advisory(), CITED_LINE);
    expect(expected, "the fixture itself produced no key").not.toBeNull();
    expect(measured.keys[0]).toBe(expected!);
  });

  test("AS-8f: the gate's sentence is the one `suppressRepeats` writes", () => {
    // The gate restates the identity rule rather than calling
    // `suppressRepeats`, because the adjudicator's contract is positional
    // and that function returns partitioned lists. Restating a rule is how
    // two deciders start to disagree, so the agreement is asserted instead
    // of trusted: one input, both sentences, byte-identical.
    const body = ledgerBody([round(1, [advisory()])]);
    const prior = priorFindings(readLedger(body));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");

    const viaRounds = suppressRepeats([advisory()], prior.keys, () => CITED_LINE);
    const viaGate = gate({ snapshot: snapshotOf(2, body) })([advisory()]);

    expect(viaRounds.suppressed).toHaveLength(1);
    expect(viaGate.repeat).toEqual(viaRounds.reasons);
  });
});

// ── AS-9: the deployed path, end to end ──────────────────────────────────

describe("AS-9: `rungate ai-review-findings` suppresses a repeat", () => {
  // The point of the whole issue is a PRODUCTION caller, so one case runs
  // the command the generated workflow runs, with the environment the
  // generated step sets, in a checkout. Everything above it tests the
  // reader; only this tests that anything reaches it.
  function run(env: Record<string, string>, findings: Record<string, unknown>[]) {
    const root = checkout(`e2e-${Object.keys(env).length}-${findings.length}`);
    const payload = join(root, "findings.json");
    writeFileSync(payload, payloadOf(findings.some(f => f.severity === "high") ? "BLOCK" : "PASS", findings));
    return spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "ai-review-findings", payload], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
  }

  const prior = ledgerBody([round(1, [advisory()])]);

  function plant(name: string, state: string, snapshot: string | null): Record<string, string> {
    const dir = mkdtempSync(join(SCRATCH, `e2e-${name}-`));
    const carry = join(dir, "carry.txt");
    writeFileSync(carry, carryFile(state));
    const env: Record<string, string> = { [AI_REVIEW_CARRY_PATH_VAR]: carry };
    if (snapshot !== null) {
      const snap = join(dir, "snapshot.txt");
      writeFileSync(snap, snapshot);
      env[AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR] = snap;
    }
    return env;
  }

  test("AS-9a: the advisory repeat is dropped and the notice names it", () => {
    const r = run(plant("hit", AI_REVIEW_CARRY_READ, snapshotOf(2, prior)), [advisory()]);
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toContain(`${AI_REVIEW_OUTCOME_LINE} CLEAN`);
    expect(out).toContain(AI_REVIEW_SUPPRESSED_TITLE);
    expect(out).toContain(advisory().summary as string);
    expect(r.status).toBe(0);
  });

  test("AS-9b: the blocking repeat still blocks, through the same wiring", () => {
    const withPrior = ledgerBody([round(1, [blocking()])]);
    const r = run(plant("block", AI_REVIEW_CARRY_READ, snapshotOf(2, withPrior)), [blocking()]);
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toContain(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`);
    expect(out).not.toContain(AI_REVIEW_SUPPRESSED_TITLE);
    expect(r.status).not.toBe(0);
  });

  test("AS-9c: an unreadable history warns and reports everything", () => {
    const r = run(plant("unmeasured", AI_REVIEW_CARRY_UNMEASURED, null), [advisory()]);
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toContain(AI_REVIEW_SUPPRESSED_UNMEASURED_TITLE);
    expect(out).not.toContain(AI_REVIEW_SUPPRESSED_TITLE);
    expect(r.status).toBe(0);
  });

  test("AS-9d: with no carry path set, the command behaves exactly as before", () => {
    const root = checkout("e2e-unwired");
    const payload = join(root, "findings.json");
    writeFileSync(payload, payloadOf("PASS", [advisory()]));
    const env = { ...process.env };
    delete env[AI_REVIEW_CARRY_PATH_VAR];
    delete env[AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR];
    const r = spawnSync(
      "bun",
      [join(ROOT, "bin", "rungate.ts"), "ai-review-findings", payload],
      { cwd: root, encoding: "utf-8", env },
    );
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toContain(`${AI_REVIEW_OUTCOME_LINE} CLEAN`);
    expect(out).not.toContain(AI_REVIEW_SUPPRESSED_TITLE);
    expect(out).not.toContain(AI_REVIEW_SUPPRESSED_UNMEASURED_TITLE);
  });
});
