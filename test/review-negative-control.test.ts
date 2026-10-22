/**
 * review-negative-control.test.ts — #1169.
 *
 * Two halves, and the second is the one that makes the first worth anything.
 *
 * The subjects must prove their own premise. A planted subject that does not
 * actually behave differently from its baseline is not a defect, and a clean
 * subject that does is not clean — in either case the control measures
 * nothing while reporting a number. So the behavioural difference is RUN here,
 * over a table of commands, rather than asserted in a manifest.
 *
 * And the control must be shown able to fail. A reviewer that returns CLEAN
 * unconditionally is exactly the failure #1169 says we cannot currently see,
 * so it is built — as a payload, which is all a reviewer is to this
 * instrument — and the planted subject is required to go red against it. The
 * second mutant blocks on a file nobody planted anything in, and both
 * subjects are required to go red: one for missing the plant, one for firing
 * on a clean diff.
 *
 * The cheapest wrong fix is named and measured rather than dismissed in
 * prose. It is "assert the payload is non-empty" — it is one line, it reads
 * as a detection check, and `the cheapest wrong fix is green over a payload
 * that found nothing` runs it against a payload that names the wrong file
 * entirely and watches it pass.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

import {
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_VERDICT_KEY,
} from "../lib/scaffold/ai-review-findings";

import {
  REVIEW_CONTROL_SUBJECTS_DIR,
  loadReviewControlSubjects,
  readReviewControl,
  summariseReviewControl,
  type ReviewControlSubject,
} from "../evals/ai-review-control/control";

import { isFullSuite as baseline } from "../evals/ai-review-control/subjects/suite-lock-redirect/baseline";
import { isFullSuite as planted } from "../evals/ai-review-control/subjects/suite-lock-redirect/planted";
import { isFullSuite as clean } from "../evals/ai-review-control/subjects/suite-lock-redirect/clean";

/** A reviewer identifier, since a reading that names none is UNMEASURED. */
const REVIEWER = "tree@test";

const SUBJECTS = loadReviewControlSubjects(REVIEW_CONTROL_SUBJECTS_DIR);

/**
 * Throws rather than returning undefined. A helper that yields `undefined`
 * for a renamed subject turns every case below into a test of `undefined`,
 * and those pass in ways nobody reads.
 */
function subject(id: string): ReviewControlSubject {
  const found = SUBJECTS.find(s => s.id === id);
  if (found === undefined) {
    throw new Error(`no control subject ${id} — loaded: ${SUBJECTS.map(s => s.id).join(", ")}`);
  }
  return found;
}

const PLANTED = subject("suite-lock-redirect/planted");
const CLEAN = subject("suite-lock-redirect/clean");

/** Build a payload in the contract's own spelling, never a second one. */
function payload(findings: Record<string, unknown>[], verdict: string): string {
  return JSON.stringify({ [AI_REVIEW_FINDINGS_KEY]: findings, [AI_REVIEW_VERDICT_KEY]: verdict });
}

/** A finding that lands on the plant, unless a field is overridden. */
function onThePlant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    file: PLANTED.file,
    line: PLANTED.lines?.[1],
    summary: "the redirect pattern no longer matches `&>`",
    failure_scenario: "`bun test &>/tmp/out` is read as a targeted run",
    ...over,
  };
}

/** The reviewer this issue is about: CLEAN on everything, always. */
const MUTANT_ALWAYS_CLEAN = payload([], AI_REVIEW_PASS_VERDICT);

/** The other direction: blocks, but on something nobody planted. */
const MUTANT_WRONG_FILE = payload(
  [onThePlant({ file: "lib/somewhere-else.ts", line: 1 })],
  AI_REVIEW_BLOCK_VERDICT,
);

/**
 * Commands chosen so the table separates the three candidates.
 *
 * `&>>log.txt` is in deliberately and is NOT expected to separate anything:
 * the planted pattern fails to match it, but the leftover token carries no
 * `/` and no test extension, so the operand scan reaches the same answer by
 * a different route. A fixture row that looks like it should diverge and
 * does not is worth keeping — it is the difference between measuring the
 * defect and measuring the regex.
 */
const COMMANDS = [
  "bun test",
  "bun test test/foo.test.ts",
  "bun test --bail",
  "bun test > /tmp/out",
  "bun test 2>/dev/null",
  "bun test 2>&1",
  "bun test &>/tmp/out",
  "bun test &>>/tmp/run.log",
  "bun test &>>log.txt",
  "bun run build",
];

function disagreements(a: (c: string) => boolean, b: (c: string) => boolean): string[] {
  return COMMANDS.filter(c => a(c) !== b(c));
}

describe("#1169: the control subjects prove their own premise", () => {
  test("the planted candidate really does behave differently from its baseline", () => {
    // Predicted before running: exactly 2 rows, both `&>` forms carrying a
    // path. Asserting the list and not just the count — a count agrees with
    // itself for the wrong reasons.
    expect(disagreements(baseline, planted)).toEqual([
      "bun test &>/tmp/out",
      "bun test &>>/tmp/run.log",
    ]);
  });

  test("and it fails in the permissive direction, which is what makes it a defect", () => {
    // The caller is a guard that refuses a full suite, so `false` lets the
    // run through. A planted defect that failed CLOSED would be an annoyance,
    // not a bug, and the failure scenario in the manifest would be false.
    expect(baseline("bun test &>/tmp/out")).toBe(true);
    expect(planted("bun test &>/tmp/out")).toBe(false);
  });

  test("the clean candidate changes no behaviour at all", () => {
    expect(disagreements(baseline, clean)).toEqual([]);
  });

  test("the planted candidate is ONE line away from the baseline", () => {
    const a = readFileSync(PLANTED.baselinePath, "utf-8").split("\n");
    const b = readFileSync(PLANTED.candidatePath, "utf-8").split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((line, i) => line !== b[i])).toHaveLength(1);
  });

  test("the declared line range actually contains the defect", () => {
    // Without this, an edit above the regex shifts it out of the range and
    // every future reading becomes MISSED for a reason that has nothing to
    // do with the reviewer.
    const lines = readFileSync(PLANTED.candidatePath, "utf-8").split("\n");
    const [from, to] = PLANTED.lines ?? [0, 0];
    expect(lines.slice(from - 1, to).join("\n")).toContain(PLANTED.marker ?? "\u0000");
  });

  test("the subjects dir yields one planted and one clean subject, at least", () => {
    expect(SUBJECTS.filter(s => s.kind === "planted").length).toBeGreaterThanOrEqual(1);
    expect(SUBJECTS.filter(s => s.kind === "clean").length).toBeGreaterThanOrEqual(1);
  });
});

describe("#1169: the control reads a working reviewer as working", () => {
  test("a finding on the plant is DETECTED, and a quiet clean subject is QUIET", () => {
    const hit = readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    const quiet = readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER);

    expect(hit.outcome).toBe("DETECTED");
    expect(quiet.outcome).toBe("QUIET");

    const run = summariseReviewControl([hit, quiet]);
    expect(run.passed).toBe(true);
    expect(run.recall).toBe(1);
    expect(run.precision).toBe(1);
  });

  test("a finding anywhere in the declared range counts, not only on the nose", () => {
    const [from] = PLANTED.lines ?? [0, 0];
    const r = readReviewControl(PLANTED, payload([onThePlant({ line: from })], AI_REVIEW_BLOCK_VERDICT), REVIEWER);
    expect(r.outcome).toBe("DETECTED");
  });

  test("advisory findings on a clean subject are counted and are not a failure", () => {
    const r = readReviewControl(
      CLEAN,
      payload([onThePlant({ severity: "low", file: CLEAN.file })], AI_REVIEW_PASS_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("QUIET");
    expect(r.advisoryCount).toBe(1);
    expect(r.passed).toBe(true);
  });
});

describe("#1169: the control can fail — the mutant reviewers", () => {
  test("a reviewer that returns CLEAN unconditionally makes the planted subject RED", () => {
    // THE proof. This is the reviewer #1169 says is indistinguishable from a
    // working one today. Predicted before running: 1 red reading of 2.
    const missed = readReviewControl(PLANTED, MUTANT_ALWAYS_CLEAN, REVIEWER);
    const quiet = readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER);

    expect(missed.outcome).toBe("MISSED");
    expect(missed.passed).toBe(false);
    expect(quiet.outcome).toBe("QUIET");

    const run = summariseReviewControl([missed, quiet]);
    expect(run.readings.filter(r => !r.passed)).toHaveLength(1);
    expect(run.passed).toBe(false);
    expect(run.recall).toBe(0);
    // Not 1. A reviewer that wrote no blocking finding has undefined
    // precision, and a withheld ratio must not read as a perfect one.
    expect(run.precision).toBeNull();
  });

  test("a reviewer that blocks on an unplanted file makes BOTH subjects RED", () => {
    // Predicted before running: 2 red readings of 2 — MISSED and FIRED.
    const missed = readReviewControl(PLANTED, MUTANT_WRONG_FILE, REVIEWER);
    const fired = readReviewControl(CLEAN, MUTANT_WRONG_FILE, REVIEWER);

    expect(missed.outcome).toBe("MISSED");
    expect(fired.outcome).toBe("FIRED");

    const run = summariseReviewControl([missed, fired]);
    expect(run.readings.filter(r => !r.passed)).toHaveLength(2);
    expect(run.passed).toBe(false);
    expect(run.precision).toBe(0);
  });

  test("the cheapest wrong fix is green over a payload that found nothing", () => {
    // Named and measured, not dismissed. "The reviewer wrote some findings"
    // is one line, reads as a detection check, and cannot tell a reviewer
    // that located the defect from one that blocked an unrelated file.
    const cheapest = (raw: string) =>
      (JSON.parse(raw)[AI_REVIEW_FINDINGS_KEY] as unknown[]).length > 0;

    expect(cheapest(MUTANT_WRONG_FILE)).toBe(true);
    expect(readReviewControl(PLANTED, MUTANT_WRONG_FILE, REVIEWER).outcome).toBe("MISSED");
  });

  test("the right file at the wrong line is MISSED, and the near miss is named", () => {
    const [from] = PLANTED.lines ?? [0, 0];
    const r = readReviewControl(
      PLANTED,
      payload([onThePlant({ line: from + 40 })], AI_REVIEW_BLOCK_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("MISSED");
    expect(r.detail.join("\n")).toContain("near miss");
  });

  test("the right line called advisory is MISSED — it stopped nothing", () => {
    const r = readReviewControl(
      PLANTED,
      payload([onThePlant({ severity: "low" })], AI_REVIEW_PASS_VERDICT),
      REVIEWER,
    );
    expect(r.outcome).toBe("MISSED");
    expect(r.detail.join("\n")).toContain("must block");
  });
});

describe("#1169: UNMEASURED is a distinct outcome from CLEAN, and it fails", () => {
  test("a reviewer that wrote no payload at all is UNMEASURED, not QUIET", () => {
    // The #1180 shape: ai-review passed a real PR in 14 seconds having
    // written nothing. Against a CLEAN subject, where "found nothing" would
    // otherwise be the right answer — which is exactly why it has to differ.
    const r = readReviewControl(CLEAN, null, REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.passed).toBe(false);
    expect(r.payloadReasons).toContain("FINDINGS_FILE_ABSENT");
  });

  test("an unreadable payload carries the reader's own reasons, not a re-derived one", () => {
    const r = readReviewControl(PLANTED, "{not json", REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.payloadReasons).toEqual(["FINDINGS_UNPARSEABLE"]);
  });

  test("a payload with no findings key is UNMEASURED, not an empty review", () => {
    const r = readReviewControl(CLEAN, JSON.stringify({ [AI_REVIEW_VERDICT_KEY]: "PASS" }), REVIEWER);
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.payloadReasons).toContain("FINDINGS_KEY_ABSENT");
  });

  test("a reading that cannot name its reviewer is UNMEASURED, perfect payload or not", () => {
    // The acceptance criterion made able to fail. CI adjudicates with a
    // pinned published package while the tree runs ahead of it, so an
    // unattributed number is a number about nothing.
    const r = readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), "  ");
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toEqual(["REVIEWER_UNIDENTIFIED"]);
    expect(r.reviewer).toBeNull();
  });

  test("an UNMEASURED reading fails the run rather than being skipped over", () => {
    const run = summariseReviewControl([
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
      readReviewControl(CLEAN, null, REVIEWER),
    ]);
    expect(run.unmeasured).toBe(1);
    expect(run.passed).toBe(false);
    // And it is not counted as coverage: the clean half was never measured.
    expect(run.cleanMeasured).toBe(0);
  });
});

describe("#1169: a run that measured nothing is not a pass", () => {
  test("an empty run is red", () => {
    const run = summariseReviewControl([]);
    expect(run.passed).toBe(false);
    expect(run.detail.join("\n")).toContain("0 planted and 0 clean");
  });

  test("a run with no clean subject is red even when every plant was found", () => {
    // The half the source post says most teams skip. Dropping it leaves a
    // recall eval that a reviewer blocking everything scores perfectly on.
    const run = summariseReviewControl([
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
    ]);
    expect(run.detected).toBe(1);
    expect(run.missed).toBe(0);
    expect(run.fired).toBe(0);
    expect(run.passed).toBe(false);
  });

  test("a run with no planted subject is red even when nothing fired", () => {
    const run = summariseReviewControl([readReviewControl(CLEAN, MUTANT_ALWAYS_CLEAN, REVIEWER)]);
    expect(run.quiet).toBe(1);
    expect(run.passed).toBe(false);
    expect(run.recall).toBeNull();
  });
});

describe("#1169: a contradictory payload is scored, not discarded", () => {
  test("BLOCK over findings that do not block is counted and still readable", () => {
    // #1178's shape, at roughly a third of runs. Refusing to score it would
    // blind the instrument over exactly the band it most needs to watch, so
    // the findings are read and the contradiction is reported beside them.
    const r = readReviewControl(
      CLEAN,
      payload([onThePlant({ severity: "low", file: CLEAN.file })], AI_REVIEW_BLOCK_VERDICT),
      REVIEWER,
    );
    expect(r.payloadOutcome).toBe("CONTRADICTION");
    expect(r.outcome).toBe("QUIET");

    const run = summariseReviewControl([
      r,
      readReviewControl(PLANTED, payload([onThePlant()], AI_REVIEW_BLOCK_VERDICT), REVIEWER),
    ]);
    expect(run.contradictions).toBe(1);
  });
});
