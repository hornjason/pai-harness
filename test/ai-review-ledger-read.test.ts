/**
 * Reading the findings ledger back (#1168, the carry-forward half).
 *
 * #1319 shipped the WRITER: a step that upserts one comment per pull request
 * holding one JSON entry per review round. This is the reader, and the two
 * constraints it was given are the whole design:
 *
 *  - AC-R1  **identity is stated, not assumed.** The ledger stamps the rule
 *           its anchors were recorded under. A reader that does not recognise
 *           that rule refuses to form keys rather than keying under its own.
 *  - AC-R2  **"not seen before" and "could not read the prior round" are
 *           different facts**, and the type makes a caller branch on which.
 *  - AC-R3  a round recorded as `findings: null` is an UNMEASURED round, not
 *           a clean one — the distinction the writer went to trouble to keep.
 *  - AC-R4  a finding that cannot be keyed is carried, never dropped.
 *  - AC-R5  `carryForward` may not treat "no text was recorded" as "the text
 *           changed". That is a silent drop of every finding, and it is what
 *           the merged writer's output actually produced — measured below.
 *  - AC-R6  the writer and the reader agree on the identity string and on the
 *           field names, with no import between them.
 *  - AC-R7  a control: a well-formed two-round ledger reads back exactly.
 *  - AC-R8  (#1405) the ledger is a WINDOW. It must be able to say how many
 *           rounds fell off the front, and "it did not say" must not read as
 *           zero. Both shapes are accepted, because the bare array is live on
 *           every open pull request that has a ledger.
 */

import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_FINDINGS_KEY,
  AI_REVIEW_LEDGER_FINDING_TEXT,
  AI_REVIEW_LEDGER_IDENTITY,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_ROUNDS_KEY,
  AI_REVIEW_LEDGER_TRUNCATED_KEY,
  AI_REVIEW_LEDGER_UNREADABLE,
  AI_REVIEW_PRIOR_MEASURED,
  AI_REVIEW_PRIOR_UNMEASURED,
  AI_REVIEW_TRUNCATION_STATED,
  AI_REVIEW_TRUNCATION_UNKNOWN,
  FINDING_IDENTITY_LINE,
  FINDING_IDENTITY_NONE,
  FINDING_IDENTITY_TEXT,
  carryForward,
  findingKey,
  ledgerUnreadable,
  priorFindings,
  readLedger,
  suppressRepeats,
  type ReviewFinding,
} from "../lib/ai-review-rounds.ts";
import {
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_TEXT_FIELD,
  buildPersistScript,
} from "../lib/scaffold/ai-review-step.ts";

/** A ledger comment body in exactly the shape the persist step writes. */
function ledgerBody(entries: unknown): string {
  return [
    AI_REVIEW_LEDGER_MARKER,
    "",
    "### AI review findings ledger",
    "",
    "Written by the AI Review workflow, one entry per round.",
    "",
    "```json",
    JSON.stringify(entries, null, 2),
    "```",
    "",
  ].join("\n");
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: "2026-10-23T12:00:00Z",
    sha: "a".repeat(40),
    run: "1",
    attempt: "1",
    round: 1,
    identity: AI_REVIEW_LEDGER_IDENTITY_V1,
    [AI_REVIEW_FINDINGS_KEY]: [],
    ...over,
  };
}

const UNSAFE = {
  severity: "HIGH",
  file: "lib/a.ts",
  line: 318,
  summary: "unsafe link creation",
  [AI_REVIEW_LEDGER_TEXT_FIELD]: "  await symlink(target, path);",
};

describe("AC-R1: identity is stated, not assumed", () => {
  test("AC-R1: the reader keys findings recorded under the identity it knows", () => {
    const reading = readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] })]));
    expect(reading.status).toBe(AI_REVIEW_LEDGER_READ);
    const prior = priorFindings(reading);
    expect(prior.status).toBe(AI_REVIEW_PRIOR_MEASURED);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.prior).toHaveLength(1);
    expect(prior.prior[0]!.identity).toBe(FINDING_IDENTITY_TEXT);
    // The key is the one findingKey forms from the RECORDED text, which is
    // what makes a line that moved still a repeat.
    expect(prior.keys).toEqual([findingKey(UNSAFE, UNSAFE[AI_REVIEW_LEDGER_TEXT_FIELD])!]);
  });

  test("AC-R1: an identity the reader does not recognise refuses to key, and carries", () => {
    // A future writer stamps a rule this reader has never heard of. Keying
    // under our own rule would silently compare two different things.
    const reading = readLedger(
      ledgerBody([entry({ identity: "file+ast-node+summary@v9", [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] })]),
    );
    const prior = priorFindings(reading);
    expect(prior.status).toBe(AI_REVIEW_PRIOR_MEASURED);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    // Not keyed — so nothing is suppressed against it…
    expect(prior.keys).toEqual([]);
    // …and not dropped either. It is still carried.
    expect(prior.prior).toHaveLength(1);
    expect(prior.prior[0]!.identity).toBe(FINDING_IDENTITY_NONE);
    // Counted apart from an unmeasured round. "the findings were never read"
    // and "the findings were read under a rule I do not know" are different
    // facts, and one counter for both would lose the difference the whole
    // reading exists to keep.
    expect(prior.unkeyableRounds).toBe(1);
    expect(prior.unmeasuredRounds).toBe(0);
  });

  test("AC-R1: an entry with no identity at all is the same refusal", () => {
    const e = entry({ [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] });
    delete e.identity;
    const prior = priorFindings(readLedger(ledgerBody([e])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.keys).toEqual([]);
    expect(prior.prior).toHaveLength(1);
  });

  test("AC-R1: a finding recorded with no text is keyed on the LINE, and says so", () => {
    const noText = { severity: "HIGH", file: "lib/a.ts", line: 318, summary: "unsafe" };
    const prior = priorFindings(readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [noText] })])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.prior[0]!.identity).toBe(FINDING_IDENTITY_LINE);
    expect(prior.keys).toEqual([findingKey(noText)!]);
  });
});

describe("AC-R2: absent and unreadable are different facts", () => {
  test("AC-R2: no ledger comment is ABSENT — a measured reading of nothing", () => {
    for (const body of [null, undefined, "", "a PR comment that is not the ledger"]) {
      const reading = readLedger(body);
      expect(reading.status, JSON.stringify(body)).toBe(AI_REVIEW_LEDGER_ABSENT);
      const prior = priorFindings(reading);
      expect(prior.status).toBe(AI_REVIEW_PRIOR_MEASURED);
      if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
      expect(prior.keys).toEqual([]);
      expect(prior.prior).toEqual([]);
    }
  });

  test("AC-R2: a ledger present and unparseable is UNREADABLE, never empty", () => {
    const cases: Array<[string, string]> = [
      ["no fence", `${AI_REVIEW_LEDGER_MARKER}\n\n### ledger\n\nno json here\n`],
      ["bad json", `${AI_REVIEW_LEDGER_MARKER}\n\n\`\`\`json\n[{,}]\n\`\`\`\n`],
      ["not an array", `${AI_REVIEW_LEDGER_MARKER}\n\n\`\`\`json\n{"round":1}\n\`\`\`\n`],
      ["unterminated fence", `${AI_REVIEW_LEDGER_MARKER}\n\n\`\`\`json\n[]\n`],
    ];
    for (const [name, body] of cases) {
      const reading = readLedger(body);
      expect(reading.status, name).toBe(AI_REVIEW_LEDGER_UNREADABLE);
      const prior = priorFindings(reading);
      expect(prior.status, name).toBe(AI_REVIEW_PRIOR_UNMEASURED);
      if (prior.status !== AI_REVIEW_PRIOR_UNMEASURED) throw new Error("unreachable");
      expect(prior.reason, name).toBeString();
      expect(prior.reason.length, name).toBeGreaterThan(20);
    }
  });

  test("AC-R2: the caller's own failed read is expressible, and is UNMEASURED", () => {
    // The API call that fetches the comments can fail. Only the caller knows
    // that happened, so the caller must be able to say it — otherwise it has
    // to pass `null`, which reads as ABSENT and suppresses nothing forever.
    const prior = priorFindings(ledgerUnreadable("the pull request's comments could not be fetched"));
    expect(prior.status).toBe(AI_REVIEW_PRIOR_UNMEASURED);
  });

  test("AC-R2: the two states are not tellable apart by a count, so the TYPE separates them", () => {
    // Both carry zero prior findings. A caller that branches on `keys.length`
    // cannot distinguish them — which is why neither reading exposes `keys`
    // until the caller has narrowed the status.
    const absent = priorFindings(readLedger(null));
    const unreadable = priorFindings(ledgerUnreadable("boom"));
    expect(absent.status).not.toBe(unreadable.status);
    expect(Object.hasOwn(unreadable, "keys")).toBe(false);
    expect(Object.hasOwn(unreadable, "prior")).toBe(false);
  });
});

describe("AC-R3: an unmeasured round is not a clean round", () => {
  test("AC-R3: findings null is counted as unmeasured; findings [] is not", () => {
    const nulled = priorFindings(
      readLedger(ledgerBody([entry({ round: 1, [AI_REVIEW_FINDINGS_KEY]: null })])),
    );
    if (nulled.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(nulled.unmeasuredRounds).toBe(1);

    const clean = priorFindings(readLedger(ledgerBody([entry({ round: 1, [AI_REVIEW_FINDINGS_KEY]: [] })])));
    if (clean.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(clean.unmeasuredRounds).toBe(0);
  });

  test("AC-R3: a round entry that is not an object counts as unmeasured rather than vanishing", () => {
    const prior = priorFindings(readLedger(ledgerBody([entry(), "nonsense", 7, null])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.unmeasuredRounds).toBe(3);
  });
});

describe("AC-R4: an unkeyable finding is carried, never dropped", () => {
  test("AC-R4: no file and no summary cannot be keyed, and is still carried", () => {
    const blank = { severity: "HIGH", line: 4 };
    const prior = priorFindings(readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [blank] })])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(findingKey(blank)).toBeNull();
    expect(prior.keys).toEqual([]);
    expect(prior.prior).toHaveLength(1);
    expect(prior.prior[0]!.identity).toBe(FINDING_IDENTITY_NONE);
    expect(prior.prior[0]!.key).toBeNull();
  });

  test("AC-R4: a carried-but-unkeyable finding suppresses nothing in a later round", () => {
    const blank = { severity: "HIGH", line: 4 };
    const prior = priorFindings(readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [blank] })])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    const fresh: ReviewFinding[] = [{ severity: "HIGH", file: "lib/b.ts", line: 9, summary: "real" }];
    expect(suppressRepeats(fresh, prior.keys, () => "x").kept).toHaveLength(1);
  });
});

describe("AC-R5: carryForward may not read 'nothing recorded' as 'the text changed'", () => {
  test("AC-R5: a finding with no recorded text is UNDECIDABLE, so it is carried", () => {
    const f: ReviewFinding = { severity: "HIGH", file: "lib/a.ts", line: 10, summary: "unsafe" };
    // This is exactly what the merged writer produced: no text field at all.
    // Before this change the comparison was `normalise(undefined)` === "",
    // which never equals a real line, so every such finding was DROPPED.
    const out = carryForward([{ finding: f }], () => "const x = unsafe(y);");
    expect(out, "a finding whose text was never recorded cannot be shown resolved").toHaveLength(1);
  });

  test("AC-R5: the wrong fix — defaulting the recorded text to the empty string", () => {
    // The cheapest repair is to keep comparing and let `undefined` mean "".
    // It passes the row above only when the current line is ALSO empty, so
    // this row is the one that separates the real fix from the cheap one.
    const f: ReviewFinding = { severity: "HIGH", file: "lib/a.ts", line: 10, summary: "unsafe" };
    const underRealFix = carryForward([{ finding: f }], () => "   ");
    expect(underRealFix).toHaveLength(1);
    // And a recorded text that genuinely differs is still resolved and dropped.
    const resolved = carryForward([{ finding: f, recordedText: "old line" }], () => "new line");
    expect(resolved, "a recorded text that changed is still a resolved finding").toHaveLength(0);
  });

  test("AC-R5: an empty recorded text is a real reading and still resolves", () => {
    const f: ReviewFinding = { severity: "HIGH", file: "lib/a.ts", line: 10, summary: "blank line" };
    expect(carryForward([{ finding: f, recordedText: "" }], () => "")).toHaveLength(1);
    expect(carryForward([{ finding: f, recordedText: "" }], () => "now has code")).toHaveLength(0);
  });

  test("AC-R5: the reading feeds carryForward directly, and the ledger round survives it", () => {
    const prior = priorFindings(readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] })])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    // Unchanged line: the finding is unresolved and is re-emitted.
    expect(carryForward(prior.prior, () => UNSAFE[AI_REVIEW_LEDGER_TEXT_FIELD])).toHaveLength(1);
    // Changed line: resolved, dropped.
    expect(carryForward(prior.prior, () => "  await safeSymlink(target, path);")).toHaveLength(0);
  });
});

describe("AC-R6: the writer and the reader agree, with no import between them", () => {
  test("AC-R6: every constant the two sides share is bound here", () => {
    // `lib/scaffold/ai-review-step.ts` may not import `ai-review-rounds.ts`
    // (the mutation batteries copy it into a scratch directory alone), so
    // each constant is declared twice and bound HERE. Change one and this is
    // red. All four, not just the identity: a reader looking for the wrong
    // marker reports ABSENT, which is the one wrong answer that looks
    // exactly like a correct one on a pull request that has had no rounds.
    expect(AI_REVIEW_LEDGER_IDENTITY).toBe(AI_REVIEW_LEDGER_IDENTITY_V1);
    expect(AI_REVIEW_LEDGER_COMMENT_MARKER).toBe(AI_REVIEW_LEDGER_MARKER);
    expect(AI_REVIEW_LEDGER_FINDINGS_KEY).toBe(AI_REVIEW_FINDINGS_KEY);
    expect(AI_REVIEW_LEDGER_FINDING_TEXT).toBe(AI_REVIEW_LEDGER_TEXT_FIELD);
  });

  test("AC-R6: the generated script stamps that identity and records the text field", () => {
    const script = buildPersistScript();
    expect(script).toContain(AI_REVIEW_LEDGER_IDENTITY_V1);
    expect(script).toContain(AI_REVIEW_LEDGER_TEXT_FIELD);
    // The guard against a finding naming a path outside the checkout. A
    // reviewer picks `file`, and this step reads that file and puts a line of
    // it in a public comment.
    expect(script, "an absolute or escaping path must not be read").toContain("..*");
  });

  test("AC-R6: the reader parses an entry the generated script's own jq shape produces", () => {
    // The field set the script projects, spelled from the script's constants
    // rather than from this test's idea of them.
    const projected = {
      severity: "HIGH",
      file: "lib/a.ts",
      line: 7,
      summary: "s",
      [AI_REVIEW_LEDGER_TEXT_FIELD]: "code",
    };
    const prior = priorFindings(readLedger(ledgerBody([entry({ [AI_REVIEW_FINDINGS_KEY]: [projected] })])));
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.prior[0]!.recordedText).toBe("code");
    expect(prior.prior[0]!.identity).toBe(FINDING_IDENTITY_TEXT);
  });
});

describe("AC-R7: the control — a well-formed two-round ledger reads back exactly", () => {
  test("AC-R7: two rounds, four findings, both rounds measured", () => {
    const r1 = { ...UNSAFE };
    const r2 = {
      severity: "MEDIUM",
      file: "lib/b.ts",
      line: 12,
      summary: "missing await",
      [AI_REVIEW_LEDGER_TEXT_FIELD]: "doThing();",
    };
    const reading = readLedger(
      ledgerBody([
        entry({ round: 1, [AI_REVIEW_FINDINGS_KEY]: [r1] }),
        entry({ round: 2, sha: "b".repeat(40), [AI_REVIEW_FINDINGS_KEY]: [r2] }),
      ]),
    );
    expect(reading.status).toBe(AI_REVIEW_LEDGER_READ);
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(reading.rounds).toHaveLength(2);
    expect(reading.rounds.map(r => r.round)).toEqual([1, 2]);
    expect(reading.rounds.every(r => r.measured)).toBe(true);

    const prior = priorFindings(reading);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.keys).toHaveLength(2);
    expect(prior.unmeasuredRounds).toBe(0);
    expect(prior.prior.map(p => p.round)).toEqual([1, 2]);
    // A round-3 reviewer that re-reports round 1's finding is suppressed.
    const repeat = { ...r1, line: 375 };
    const s = suppressRepeats([repeat], prior.keys, () => UNSAFE[AI_REVIEW_LEDGER_TEXT_FIELD]);
    expect(s.kept, "a repeat whose line moved is still a repeat").toHaveLength(0);
    expect(s.suppressed).toHaveLength(1);
  });
});

/**
 * AC-R8 (#1405) — the ledger is a window and must say so.
 *
 * The round cap drops the oldest rounds, and the only notice is a warning
 * annotation in a job log that expires. So a twelve-round ledger that evicted
 * eight and a twelve-round ledger that is the whole history read identically
 * to anyone arriving afterwards. That is the #1168 distinction — gone is not
 * empty — re-created one level up, about the ledger rather than about a round.
 *
 * The cheapest wrong fix is `truncated ?? 0`, and it is wrong in the same way
 * `""|0)` was wrong in the shell on #1396: it turns "I could not establish
 * this" into "nothing happened". Two rows below exist to fail under it.
 */
describe("AC-R8: a window states how much it dropped, and zero is a statement", () => {
  /** The windowed shape: the rounds hang off a key, beside the count. */
  function windowBody(rounds: unknown[], over: Record<string, unknown> = {}): string {
    return ledgerBody({ [AI_REVIEW_LEDGER_ROUNDS_KEY]: rounds, ...over });
  }

  test("AC-R8: a stated count is read, and the rounds come back with it", () => {
    const reading = readLedger(
      windowBody([entry({ round: 9 }), entry({ round: 10 })], {
        [AI_REVIEW_LEDGER_TRUNCATED_KEY]: 8,
      }),
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error(JSON.stringify(reading));
    expect(reading.rounds.map(r => r.round)).toEqual([9, 10]);
    expect(reading.truncation.status).toBe(AI_REVIEW_TRUNCATION_STATED);
    if (reading.truncation.status !== AI_REVIEW_TRUNCATION_STATED) throw new Error("unreachable");
    expect(reading.truncation.dropped).toBe(8);
  });

  test("AC-R8: a stated ZERO is not the same reading as a ledger that says nothing", () => {
    // The row `truncated ?? 0` fails on. A complete history and a ledger with
    // no opinion are different facts, and only one of them licenses a caller
    // to report "nothing was raised before" rather than "nothing I can see".
    const stated = readLedger(windowBody([entry()], { [AI_REVIEW_LEDGER_TRUNCATED_KEY]: 0 }));
    const silent = readLedger(ledgerBody([entry()]));
    if (stated.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    if (silent.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(stated.truncation.status).toBe(AI_REVIEW_TRUNCATION_STATED);
    expect(silent.truncation.status).toBe(AI_REVIEW_TRUNCATION_UNKNOWN);
    expect(stated.truncation.status).not.toBe(silent.truncation.status);
    // Both ledgers hold one round, so no count tells them apart — the same
    // construction AC-R2 uses, and the reason it is the TYPE that separates.
    expect(stated.rounds).toHaveLength(silent.rounds.length);
  });

  test("AC-R8: an UNKNOWN truncation carries no count field for a caller to read", () => {
    const silent = readLedger(ledgerBody([entry()]));
    if (silent.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(Object.hasOwn(silent.truncation, "dropped")).toBe(false);
    expect(silent.truncation.status).toBe(AI_REVIEW_TRUNCATION_UNKNOWN);
    if (silent.truncation.status !== AI_REVIEW_TRUNCATION_UNKNOWN) throw new Error("unreachable");
    // The reason has to name the shape, or a report of it says only "unknown".
    expect(silent.truncation.reason).toContain("bare array");
  });

  test("AC-R8: a legacy bare-array ledger still reads, rounds and all", () => {
    // Every open pull request with a ledger carries this shape. Refusing it
    // would discard the history of all of them the moment the writer changed.
    const reading = readLedger(
      ledgerBody([entry({ round: 1 }), entry({ round: 2, [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] })]),
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(reading.rounds.map(r => r.round)).toEqual([1, 2]);
    const prior = priorFindings(reading);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.keys).toHaveLength(1);
  });

  test.each([
    ["a string", "8"],
    ["null", null],
    ["a negative", -1],
    ["a fraction", 1.5],
    ["an object", { n: 8 }],
  ])("AC-R8: a %s count is UNKNOWN, not zero, and the rounds survive it", (_label, bad) => {
    const reading = readLedger(
      windowBody([entry({ round: 4 })], { [AI_REVIEW_LEDGER_TRUNCATED_KEY]: bad }),
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error(JSON.stringify(reading));
    expect(reading.rounds, "a bad count discarded the rounds").toHaveLength(1);
    expect(reading.truncation.status).toBe(AI_REVIEW_TRUNCATION_UNKNOWN);
    expect(Object.hasOwn(reading.truncation, "dropped")).toBe(false);
  });

  test("AC-R8: an object with no rounds array is UNREADABLE, never an empty ledger", () => {
    const reading = readLedger(ledgerBody({ [AI_REVIEW_LEDGER_TRUNCATED_KEY]: 3 }));
    expect(reading.status).toBe(AI_REVIEW_LEDGER_UNREADABLE);
    if (reading.status !== AI_REVIEW_LEDGER_UNREADABLE) throw new Error("unreachable");
    // The key, quoted — the pre-#1405 refusal message also contains the word
    // "rounds", so a bare substring check passes against the shape that has
    // no object branch at all and witnesses nothing.
    expect(reading.reason).toContain(`\`${AI_REVIEW_LEDGER_ROUNDS_KEY}\``);
  });

  test("AC-R8: the control — a windowed ledger round-trips exactly", () => {
    const reading = readLedger(
      windowBody(
        [
          entry({ round: 11, [AI_REVIEW_FINDINGS_KEY]: [UNSAFE] }),
          entry({ round: 12, sha: "c".repeat(40), [AI_REVIEW_FINDINGS_KEY]: null }),
        ],
        { [AI_REVIEW_LEDGER_TRUNCATED_KEY]: 4 },
      ),
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(reading.rounds.map(r => r.round)).toEqual([11, 12]);
    expect(reading.rounds.map(r => r.measured)).toEqual([true, false]);
    if (reading.truncation.status !== AI_REVIEW_TRUNCATION_STATED) throw new Error("unreachable");
    expect(reading.truncation.dropped).toBe(4);
    const prior = priorFindings(reading);
    if (prior.status !== AI_REVIEW_PRIOR_MEASURED) throw new Error("unreachable");
    expect(prior.keys).toHaveLength(1);
    expect(prior.unmeasuredRounds, "the null round is still counted").toBe(1);
  });
});
