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
 * Exactly what `lib/scaffold/ai-review-step.ts` records per finding —
 * `{severity, file, line, summary}` from its jq projection, plus the `text`
 * anchor it joins on afterwards. Nothing else. If that projection widens, this
 * fixture is the thing that has to be updated, and the pair below goes green
 * on its own without the synthetic half, which is the signal to re-read it.
 */
function ledgerFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
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

/** One round entry in the shape the generated step assembles. */
function round(n: number, findings: unknown, over: Record<string, unknown> = {}): unknown {
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

describe("#1509 AC-1: the ledger's round shape against the payload contract", () => {
  test("a blocking finding captured from a ledger round is UNMEASURED, and says why", () => {
    const got = capture(ledgerBody([round(3, [ledgerFinding()])]), 3);

    expect(got.status).toBe("CAPTURED");
    expect(got.scoreReading?.outcome).toBe("UNMEASURED");
    // Two reasons, two missing fields. Both are asserted by name: a capture
    // that lost only one of them would still be UNMEASURED and the count alone
    // could not tell which gap had closed.
    expect(got.scoreReading?.unmeasuredReasons).toContain("VERDICT_ABSENT");
    expect(got.scoreReading?.unmeasuredReasons).toContain("BLOCKING_FINDING_INCOMPLETE");
  });

  test("the SAME finding with a verdict and a failure_scenario is DETECTED", () => {
    // The control half of the pair, and the thing that makes the case above a
    // measurement of the two fields rather than of the fixture. One input, one
    // difference: the payload below is the captured one plus `verdict` and
    // `failure_scenario`, and nothing else.
    const got = capture(ledgerBody([round(3, [ledgerFinding()])]), 3);
    const captured = JSON.parse(got.payload!) as { findings: Record<string, unknown>[] };

    const repaired = JSON.stringify({
      verdict: "BLOCK",
      findings: captured.findings.map(f => ({ ...f, failure_scenario: "an unscoped suite runs" })),
    });

    expect(readAiReviewFindings(repaired).outcome).toBe("BLOCKED");
    expect(readReviewControl(PLANTED, repaired, "probe@0").outcome).toBe("DETECTED");
    // …and the captured bytes, unrepaired, score UNMEASURED against the same
    // subject. DETECTED is not reachable through this capture path.
    expect(readReviewControl(PLANTED, got.payload!, "probe@0").outcome).toBe("UNMEASURED");
  });

  test("a clean round still cannot be read, because no round carries a verdict", () => {
    // The precision half is NOT rescued by the absence of blocking findings:
    // `VERDICT_ABSENT` fires on every round the ledger has ever written.
    const got = capture(ledgerBody([round(4, [])]), 4);

    expect(got.status).toBe("CAPTURED");
    expect(got.scoreReading?.unmeasuredReasons).toEqual(["VERDICT_ABSENT"]);
    expect(readReviewControl(CLEAN, got.payload!, "probe@0").outcome).toBe("UNMEASURED");
  });

  test("an advisory finding is carried and does not add a contract reason", () => {
    // `blockingContractViolations` runs on blocking findings only, so the
    // `failure_scenario` gap is invisible on the advisory tail — which is why
    // the two reasons above had to be asserted separately.
    const got = capture(ledgerBody([round(5, [ledgerFinding({ severity: "low" })])]), 5);

    expect(got.scoreReading?.unmeasuredReasons).toEqual(["VERDICT_ABSENT"]);
  });
});

describe("#1509 AC-2: the payload is the round, verbatim", () => {
  test("every field the ledger recorded survives, including the text anchor", () => {
    const finding = ledgerFinding();
    const got = capture(ledgerBody([round(1, [finding])]), 1);
    const parsed = JSON.parse(got.payload!) as { findings: Record<string, unknown>[] };

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toEqual(finding);
    // No key is invented. A capture that wrote a verdict would make every
    // reading MEASURED and every CONTRADICTION unobservable.
    expect(Object.keys(parsed)).toEqual(["findings"]);
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
    round(6, null, { attempt: "1" }),
    round(6, [], { attempt: "2" }),
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
    expect(JSON.parse(second.payload!)).toEqual({ findings: [] });
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

    const body = ledgerBody([round(2, null)]);
    const real = captureRoundPayload(readLedger(body), 2, null);
    const mutated = mutant.captureRoundPayload(readLedger(body), 2, null);

    // The input on which mutant and original differ, named and run: a round
    // recording `findings: null`.
    expect(real.status).toBe("REFUSED");
    expect(mutated.status).toBe("CAPTURED");
    expect(JSON.parse(mutated.payload!)).toEqual({ findings: [] });

    // The mutant is not broken: it still behaves like the original on a round
    // that WAS measured. Without this, a mutant that failed to load would look
    // like the assertion above.
    const measured = ledgerBody([round(2, [])]);
    expect(mutant.captureRoundPayload(readLedger(measured), 2, null).status).toBe("CAPTURED");
  });
});
