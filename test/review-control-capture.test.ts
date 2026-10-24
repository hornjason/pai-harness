/**
 * #1509 — the capture step between `stage` and `score`, which was an ellipsis
 * in `evals/ai-review-control/README.md` and had no code behind it.
 *
 * ## What this file is really about
 *
 * #1509 proposed the ledger comment as the cheapest capture path, on the
 * grounds that it "already carries `findings` per round in the shape `score`
 * wants". The first thing here measures that claim instead of inheriting it,
 * and it is false in two named fields — so the headline cases are a PAIR:
 * the same finding, captured from a ledger round and then again with the two
 * fields the ledger does not record, scored both ways. One input, one
 * difference, opposite outcomes.
 *
 * ## What was broken to prove it
 *
 * `captureRoundPayload`'s refusal over a round that recorded `findings: null`
 * is the cheapest wrong fix in this module: letting it through writes
 * `{findings: []}`, which converts "nobody can say what the reviewer found"
 * into "the reviewer found nothing". The mutant case below removes exactly
 * that refusal from a copy of the module and requires the copy to capture
 * where the real one refuses, so the case cannot pass over a mutation that was
 * never applied.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  captureRoundPayload,
  type RoundCapture,
} from "../evals/ai-review-control/capture";
import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_IDENTITY,
  ledgerUnreadable,
  readLedger,
} from "../lib/ai-review-rounds";
import {
  loadReviewControlSubjects,
  readReviewControl,
  REVIEW_CONTROL_SUBJECTS_DIR,
} from "../evals/ai-review-control/control";
import { readAiReviewFindings } from "../lib/scaffold/ai-review-findings";

const SUBJECTS = loadReviewControlSubjects(REVIEW_CONTROL_SUBJECTS_DIR);
const PLANTED = SUBJECTS.find(s => s.id === "suite-lock-redirect/planted")!;
const CLEAN = SUBJECTS.find(s => s.id === "suite-lock-redirect/clean")!;

/**
 * Exactly what `lib/scaffold/ai-review-step.ts` records per finding since
 * #1511 — `{severity, file, line, summary, failure_scenario}` from its jq
 * projection, plus the `text` anchor it joins on afterwards. Nothing else.
 *
 * **The projection widening is the whole of #1511**, and this fixture moved
 * with it. `legacyLedgerFinding` below is the shape it used to have, kept
 * because every ledger on an open pull request today still holds it — a
 * fixture describing a shape no writer produces measures nothing, and a
 * fixture describing only the new shape would stop covering the ledgers that
 * exist.
 */
function ledgerFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...legacyLedgerFinding(),
    failure_scenario:
      "a workflow writes `cmd &> out.log`; the matcher does not recognise `&>`, the " +
      "redirect is read as part of the command, and the lock check never runs",
    ...over,
  };
}

/**
 * The PRE-#1511 per-finding shape: four fields and the anchor, no
 * `failure_scenario`.
 *
 * This is what every ledger written before #1511 holds, and it is live on
 * open pull requests. Measured 2026-10-24 over the last 120 pull requests of
 * this repository: 99 ledger comments, 261 round entries, 110 findings, not
 * one of them carrying the field.
 */
function legacyLedgerFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    file: PLANTED.file,
    line: PLANTED.lines![0],
    summary: "the redirect pattern lost its & alternative, so &> is not recognised",
    text: "const REDIRECT = /^>>?$/;",
    ...over,
  };
}

/** A ledger comment body holding the given round entries. */
function ledgerBody(rounds: unknown[], truncated: number | null = 0): string {
  const doc = truncated === null ? { rounds } : { truncated, rounds };
  return [
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    "",
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify(doc),
    "```",
    "",
  ].join("\n");
}

/**
 * One round entry in the shape the generated step assembles since #1511 —
 * the pre-#1511 members plus the `verdict` word the reviewer wrote.
 *
 * `verdict` defaults to `BLOCK` and is overridable, because a capture that
 * is honest about the word has to be able to carry one that DISAGREES with
 * the findings. That disagreement is CONTRADICTION, and it is the reason the
 * word is transcribed rather than derived.
 */
function round(n: number, findings: unknown, over: Record<string, unknown> = {}): unknown {
  return { ...(legacyRound(n, findings) as object), verdict: "BLOCK", ...over };
}

/**
 * The PRE-#1511 round entry: no `verdict` member at all.
 *
 * Kept for the same reason `legacyLedgerFinding` is. Every round entry
 * written before #1511 reads `AI_REVIEW_VERDICT_NOT_RECORDED`, and a capture
 * of one must stay UNMEASURED rather than be repaired — the repair is the
 * one `capture.ts` refuses by name.
 */
function legacyRound(n: number, findings: unknown, over: Record<string, unknown> = {}): unknown {
  return {
    at: "2026-10-24T00:00:00Z",
    sha: "a".repeat(40),
    merge: "b".repeat(40),
    run: "1",
    attempt: "1",
    identity: AI_REVIEW_LEDGER_IDENTITY,
    round: n,
    turns: 40,
    findings,
    ...over,
  };
}

function capture(body: string | null, n: number, draw: number | null = null): RoundCapture {
  return captureRoundPayload(readLedger(body), n, draw);
}

describe("#1509 AC-1 / #1511: the ledger's round shape against the payload contract", () => {
  /**
   * THE PAIR, and it is the point of this file.
   *
   * One input, one difference, opposite outcomes: a round written by the
   * current writer and the SAME round written by the pre-#1511 writer. The
   * difference is two fields and nothing else — `verdict` on the entry and
   * `failure_scenario` on the finding — so the outcomes measure those two
   * fields rather than anything about the fixture.
   *
   * Before #1511 both halves of this pair read UNMEASURED and `DETECTED` was
   * structurally unreachable through the ledger. The legacy half still does,
   * deliberately: it is not repaired, because deriving the verdict makes
   * CONTRADICTION unobservable and writing a `failure_scenario` is writing
   * the reviewer's finding for it.
   */
  test("#1511: a blocking finding captured from a CURRENT round is DETECTED", () => {
    const got = capture(ledgerBody([round(3, [ledgerFinding()])]), 3);

    expect(got.status).toBe("CAPTURED");
    expect(got.scoreReading?.unmeasuredReasons).toEqual([]);
    expect(got.scoreReading?.outcome).toBe("BLOCKED");
    expect(readReviewControl(PLANTED, got.payload!, "probe@0").outcome).toBe("DETECTED");
  });

  test("#1511: the SAME finding from a pre-#1511 round is UNMEASURED, and says why", () => {
    const got = capture(
      ledgerBody([legacyRound(3, [legacyLedgerFinding()])]),
      3,
    );

    expect(got.status).toBe("CAPTURED");
    expect(got.scoreReading?.outcome).toBe("UNMEASURED");
    // Two reasons, two missing fields. Both are asserted by name: a capture
    // that lost only one of them would still be UNMEASURED and the count
    // alone could not tell which gap had closed.
    expect(got.scoreReading?.unmeasuredReasons).toContain("VERDICT_ABSENT");
    expect(got.scoreReading?.unmeasuredReasons).toContain("BLOCKING_FINDING_INCOMPLETE");
    expect(readReviewControl(PLANTED, got.payload!, "probe@0").outcome).toBe("UNMEASURED");
    // And it says which of the two absences it was, in prose, where it
    // cannot be mistaken for data.
    expect(got.detail.join(" ")).toContain("before #1511");
  });

  test("#1511: each missing field alone is enough, so they are varied one at a time", () => {
    // The pair above varies two things at once, which measures neither on
    // its own. These two vary exactly one each.
    const noScenario = capture(ledgerBody([round(3, [legacyLedgerFinding()])]), 3);
    expect(noScenario.scoreReading?.unmeasuredReasons).toEqual(["BLOCKING_FINDING_INCOMPLETE"]);

    const noVerdict = capture(ledgerBody([legacyRound(3, [ledgerFinding()])]), 3);
    expect(noVerdict.scoreReading?.unmeasuredReasons).toEqual(["VERDICT_ABSENT"]);
  });

  test("#1511: the verdict is TRANSCRIBED, so a CONTRADICTION survives the capture", () => {
    // The input that separates transcription from derivation, and the only
    // one that can. A `PASS` over a `high` is #1178's shape — roughly a
    // third of runs — and a capture that derived the word from the findings
    // would hand `score` a `BLOCK` here and report the two deciders
    // agreeing, which they are not.
    const got = capture(ledgerBody([round(3, [ledgerFinding()], { verdict: "PASS" })]), 3);

    expect(JSON.parse(got.payload!).verdict).toBe("PASS");
    expect(got.scoreReading?.outcome).toBe("CONTRADICTION");
    // …and it reaches the control as a CONTRADICTION rather than being
    // scored away. `payloadOutcome` is the per-reading field the summary's
    // `contradictions` count is computed from.
    expect(readReviewControl(PLANTED, got.payload!, "probe@0").payloadOutcome).toBe(
      "CONTRADICTION",
    );
  });

  test("#1511: a clean round reads QUIET, which is the precision half", () => {
    const got = capture(ledgerBody([round(4, [], { verdict: "PASS" })]), 4);

    expect(got.status).toBe("CAPTURED");
    expect(got.scoreReading?.unmeasuredReasons).toEqual([]);
    expect(readReviewControl(CLEAN, got.payload!, "probe@0").outcome).toBe("QUIET");
  });

  test("an advisory finding needs no failure_scenario, and a legacy one proves it", () => {
    // `blockingContractViolations` runs on blocking findings only, so the
    // `failure_scenario` gap is invisible on the advisory tail — which is
    // why the two reasons above had to be asserted separately. A LEGACY
    // finding is used here on purpose: it is the one that lacks the field.
    const got = capture(
      ledgerBody([round(5, [legacyLedgerFinding({ severity: "low" })])]),
      5,
    );

    expect(got.scoreReading?.unmeasuredReasons).toEqual([]);
  });
});

describe("#1509 AC-2: the payload is the round, verbatim", () => {
  test("every field the ledger recorded survives, including the text anchor", () => {
    const finding = ledgerFinding();
    const got = capture(ledgerBody([round(1, [finding])]), 1);
    const parsed = JSON.parse(got.payload!) as {
      verdict: unknown;
      findings: Record<string, unknown>[];
    };

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toEqual(finding);
    // Two keys and no third. The verdict is the one the ENTRY carried, not
    // one this module decided.
    expect(Object.keys(parsed)).toEqual(["verdict", "findings"]);
    expect(parsed.verdict).toBe("BLOCK");
  });

  test("a round that recorded NO verdict gets no verdict key invented for it", () => {
    // The direction that matters. Writing `verdict: null` here would be a
    // value nobody wrote, and `VERDICT_UNRECOGNISED` is a different claim
    // about the reviewer from `VERDICT_ABSENT`.
    const got = capture(ledgerBody([legacyRound(1, [ledgerFinding()])]), 1);
    expect(Object.keys(JSON.parse(got.payload!))).toEqual(["findings"]);
  });

  test("a round that recorded `verdict: null` also writes no key, and says so", () => {
    // The other absence: a CURRENT writer that looked and found no word.
    // Both read `VERDICT_ABSENT` — the one conflation this design carries,
    // and the detail line is where the two are told apart.
    const got = capture(ledgerBody([round(1, [ledgerFinding()], { verdict: null })]), 1);
    expect(Object.keys(JSON.parse(got.payload!))).toEqual(["findings"]);
    expect(got.scoreReading?.unmeasuredReasons).toEqual(["VERDICT_ABSENT"]);
    // Asserted in BOTH directions, and the phrasing is not arbitrary. This
    // read `toContain("a current writer")` until the #1511 battery measured
    // 11 red where 12 was predicted and this was the case that stayed green:
    // the NOT_RECORDED branch ENDS with "Take a draw from a round recorded by
    // a current writer", so the substring was true of the detail the other
    // absence produces and the assertion could not tell the two apart. Both
    // halves are needed — the positive alone goes green under a reader that
    // reports every round UNREADABLE, and the negative alone is satisfied by
    // a detail line that says nothing at all.
    expect(got.detail.join(" ")).toContain("looked and found no word");
    expect(got.detail.join(" ")).not.toContain("from before #1511");
  });

  test("an unrecognised word is carried through rather than filtered", () => {
    // The recorder does not decide which words are legal and neither does
    // this. A capture that dropped `MAYBE` would report VERDICT_ABSENT —
    // "the reviewer wrote nothing" — about a reviewer that wrote something.
    const got = capture(ledgerBody([round(1, [ledgerFinding()], { verdict: "MAYBE" })]), 1);
    expect(JSON.parse(got.payload!).verdict).toBe("MAYBE");
    expect(got.scoreReading?.unmeasuredReasons).toEqual(["VERDICT_UNRECOGNISED"]);
  });
});

describe("#1509 AC-3: a round that cannot be selected is refused, never guessed", () => {
  test("an absent ledger is refused and is not an empty ledger", () => {
    const got = capture(null, 1);
    expect(got.status).toBe("REFUSED");
    expect(got.payload).toBeNull();
    expect(got.detail.join(" ")).toContain("ABSENT is a complete reading of nothing");
  });

  test("an unreadable ledger is refused, carrying the reader's own reason", () => {
    const got = captureRoundPayload(ledgerUnreadable("the API call failed"), 1, null);
    expect(got.status).toBe("REFUSED");
    expect(got.detail.join(" ")).toContain("the API call failed");
  });

  test("a round the ledger does not hold is refused, naming what it does hold", () => {
    const got = capture(ledgerBody([round(1, []), round(2, [])]), 9);
    expect(got.status).toBe("REFUSED");
    expect(got.detail.join(" ")).toContain("round 1, round 2");
  });

  test("a window of unknown depth says the round may have been evicted", () => {
    const got = capture(ledgerBody([round(7, [])], null), 1);
    expect(got.status).toBe("REFUSED");
    expect(got.detail.join(" ")).toContain("evicted");
  });

  test("a round recorded as findings:null is refused, not captured as empty", () => {
    const got = capture(ledgerBody([round(2, null)]), 2);
    expect(got.status).toBe("REFUSED");
    expect(got.payload).toBeNull();
    expect(got.detail.join(" ")).toContain("NOT measured");
  });
});

describe("#1509 AC-4: N draws of one round are N draws", () => {
  const twoDraws = ledgerBody([
    round(6, null, { attempt: "1", verdict: null }),
    round(6, [], { attempt: "2", verdict: "PASS" }),
  ]);

  test("two entries under one round refuse to collapse into one reading", () => {
    const got = capture(twoDraws, 6);
    expect(got.status).toBe("REFUSED");
    expect(got.draws).toBe(2);
    expect(got.detail.join(" ")).toContain("--draw 1..2");
  });

  test("the two draws of #1504's shape disagree, and both are reachable", () => {
    // The exact pair measured on #1504: attempts 1 and 2 of one run on
    // byte-identical input gave `findings: null` then `findings: []`.
    const first = capture(twoDraws, 6, 1);
    const second = capture(twoDraws, 6, 2);

    expect(first.status).toBe("REFUSED");
    expect(second.status).toBe("CAPTURED");
    expect(second.draws).toBe(2);
    expect(JSON.parse(second.payload!)).toEqual({ verdict: "PASS", findings: [] });
  });

  test("a draw outside the range is refused rather than clamped", () => {
    expect(capture(twoDraws, 6, 3).status).toBe("REFUSED");
    expect(capture(twoDraws, 6, 0).status).toBe("REFUSED");
    expect(capture(twoDraws, 6, 3).detail.join(" ")).toContain("1-based");
  });
});

describe("#1509 AC-5: the unmeasured-round refusal is load-bearing", () => {
  /**
   * Build a copy of `capture.ts` with the `!entry.measured` refusal removed —
   * the cheapest wrong fix — and prove the copy captures where the real module
   * refuses. Relative specifiers are rewritten to absolute paths, because a
   * mutant that dies on module resolution throws, which reads exactly like a
   * refusal that held.
   */
  function buildMutant(): string {
    const src = join(import.meta.dir, "..", "evals", "ai-review-control", "capture.ts");
    const source = readFileSync(src, "utf-8");
    const anchor = "  if (!entry.measured) {";
    const occurrences = source.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(`could not build the mutant: the anchor appears ${occurrences} times`);
    }
    const close = source.indexOf("\n  }\n", source.indexOf(anchor));
    if (close === -1) throw new Error("could not build the mutant: the refusal is not closed");

    const libs = join(import.meta.dir, "..", "lib");
    const mutated = (source.slice(0, source.indexOf(anchor)) + source.slice(close + 5))
      .replace(/"\.\.\/\.\.\/lib\//g, `"${libs}/`);

    const dir = mkdtempSync(join(tmpdir(), "rg-1509-mutant-"));
    const path = join(dir, "capture.ts");
    writeFileSync(path, mutated);
    return path;
  }

  test("removing it turns an unmeasured round into a clean one", async () => {
    const mutantPath = buildMutant();
    const mutant = (await import(mutantPath)) as typeof import("../evals/ai-review-control/capture");

    const body = ledgerBody([round(2, null, { verdict: "PASS" })]);
    const real = captureRoundPayload(readLedger(body), 2, null);
    const mutated = mutant.captureRoundPayload(readLedger(body), 2, null);

    // The input on which mutant and original differ, named and run: a round
    // recording `findings: null`.
    //
    // The mutant's payload is the whole of why the refusal exists, and
    // #1511 made it worse rather than better: it now reads
    // `{verdict: "PASS", findings: []}` — "the reviewer looked and was
    // happy" — about a round whose payload was absent or unparseable at the
    // runner. Before #1511 that forgery was at least UNMEASURED for want of
    // a verdict; now it scores clean.
    expect(real.status).toBe("REFUSED");
    expect(mutated.status).toBe("CAPTURED");
    expect(JSON.parse(mutated.payload!)).toEqual({ verdict: "PASS", findings: [] });
    expect(mutated.scoreReading?.outcome).toBe("CLEAN");

    // The mutant is not broken: it still behaves like the original on a round
    // that WAS measured. Without this, a mutant that failed to load would look
    // like the assertion above.
    const measured = ledgerBody([round(2, [])]);
    expect(mutant.captureRoundPayload(readLedger(measured), 2, null).status).toBe("CAPTURED");
  });
});
