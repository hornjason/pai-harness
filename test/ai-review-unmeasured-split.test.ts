/**
 * #1486 — the ledger says UNMEASURED and not WHICH kind of unmeasured.
 *
 * `lib/ai-review-rounds.ts` records a round that produced no review as
 * `findings: null`, which `readLedger` normalises to `measured: false`. That
 * distinction is right and it is not enough: UNMEASURED is several facts that
 * cost the same and are fixed differently.
 *
 *  - a **structural decline** — `anthropics/claude-code-action` refuses to run
 *    when the workflow file differs from the copy on the default branch, logs
 *    its skip line, and exits SUCCESS. Cured by #1455.
 *  - the **no-payload tax** — no skip line, the action runs and writes
 *    nothing. Cured by #1478, no known root cause.
 *
 * 48 of 117 rounds over the 45 most recent pull requests are UNMEASURED
 * (#1485), and which of those two they are is currently unanswerable. Job logs
 * expire, so the answer for every round already taken is gone.
 *
 * ## What these cases hold
 *
 *  - AC-U1  one planted log, one line of difference, BOTH readings asserted.
 *           A case that only checks the decline side passes on a classifier
 *           that answers "decline" for everything.
 *  - AC-U2  a log that could not be READ is its own value, never "no skip
 *           line found". Collapsing those two reproduces, one level down,
 *           exactly the defect this file exists to fix.
 *  - AC-U3  an evidence shape the classifier does not recognise gets its own
 *           named value. A fourth state nobody predicted must not be recorded
 *           as a decline.
 *  - AC-U4  the MUTATION. `classifyUnmeasuredRound` short-circuited to the
 *           decline state, run against the same rows. The no-payload row must
 *           go red; if it does not, these cases are reading something other
 *           than the classifier.
 *  - AC-U5  a round WITH a payload is untouched — no field, `findings`
 *           unchanged — and the recorder never rewrites a round that already
 *           carries a reading.
 *  - AC-U6  the reader's own closed set: an absent field is NOT_RECORDED
 *           (true of every round written before this change), and a recorded
 *           value outside the set is UNRECOGNISED rather than any real state.
 *  - AC-U7  the decline marker is the string GitHub actually emits, and the
 *           module stays import-free so AC-U4's mutant can load.
 *  - AC-U8  the writer SPLICES the fenced block and refuses a body it cannot
 *           locate one in. Replacing a ledger holding seven rounds with one
 *           holding this pass is the worst thing a writer here can do, and it
 *           is indistinguishable from a first round afterwards.
 *
 * ## The marker, measured rather than copied from a docblock
 *
 * Two spellings are in circulation in this repository —
 * `lib/scaffold/ai-review-step.ts` quotes the action as logging
 * `Exiting due to workflow validation skip`, and #1486 quotes
 * `Skipping action due to workflow validation`. Both are real and both are on
 * the same three lines of a declined run. Taken off full job logs on
 * 2026-10-23, `gh run view <id> --log`:
 *
 * | run | duration | `Skipping action due to workflow validation` |
 * |---|---|---|
 * | 40047304108 | 20s | 1 |
 * | 40040333045 | 18s | 1 |
 * | 40044277620 | 27s | 1 |
 * | 40053178587 | 5m32s | 0 |
 * | 40052144053 | 4m53s | 0 |
 * | 40050543084 | 12m40s | 0 |
 * | 40037218206 | 16m41s | 0 |
 *
 * 3 of 3 and 0 of 4 — the negative control matters more than the positive
 * one here, because the generated script is echoed into the job log in full
 * and a marker the script happens to mention would match on every run. The
 * hyphenated `workflow-validation` the script uses is why it does not.
 *
 * **`--log-failed` can never see it.** Measured on the same declined run:
 * `gh run view 40047304108 --log-failed` returns 0 bytes, because the skip
 * line is emitted by the `Run the AI review` step and that step SUCCEEDS.
 * That mistake has produced four wrong public statements in this repository.
 * The duration column is here for the same reason and must not be read as a
 * discriminator: #1485 measured no-payload runs at 4m11s, 4m38s, 5m35s and
 * 5m05s against a real review at 2m16s.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_REVIEW_DECLINE_LOG_LINE,
  AI_REVIEW_JOB_LOG_READ,
  AI_REVIEW_JOB_LOG_UNREADABLE,
  AI_REVIEW_LEDGER_UNMEASURED_KEY,
  AI_REVIEW_UNMEASURED_DECLINED,
  AI_REVIEW_UNMEASURED_LOG_UNREADABLE,
  AI_REVIEW_UNMEASURED_NOT_RECORDED,
  AI_REVIEW_UNMEASURED_NO_PAYLOAD,
  AI_REVIEW_UNMEASURED_UNCLASSIFIED,
  AI_REVIEW_UNMEASURED_UNRECOGNISED,
  annotateUnmeasuredRounds,
  classifyUnmeasuredRound,
  readRecordedUnmeasuredState,
  replaceLedgerJsonBlock,
  type JobLogReading,
  type UnmeasuredState,
} from "../lib/ai-review-unmeasured.ts";
// The reader, imported by the test only — see AC-U5. The point of the
// recorder is that `measured` keeps meaning what `summariseRoundsToPass` and
// `priorFindings` already read it as, and the only honest way to assert that
// is to run the real reader over what the recorder wrote.
import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_READ,
  readLedger,
} from "../lib/ai-review-rounds.ts";

const ROOT = join(import.meta.dir, "..");
const MODULE = join(ROOT, "lib", "ai-review-unmeasured.ts");

/**
 * A job log in the shape `gh run view --log` returns: a tab-separated prefix
 * of job name, step name and timestamp, then the line.
 *
 * It carries the no-payload annotation on BOTH variants, because a real
 * declined run carries it too — run 40047304108 emits "The review action
 * exited successfully WITHOUT writing a findings payload" exactly once. A
 * fixture whose two variants differed in more than the skip line would let
 * the classifier pass by reading the wrong difference.
 */
function jobLog(opts: { declined: boolean }): string {
  const lines = [
    "ai-review\tSet up job\t2026-10-24T00:54:40.0000000Z Current runner version: '2.330.0'",
    "ai-review\tRun the AI review\t2026-10-24T00:55:01.0000000Z Run anthropics/claude-code-action@5eb090f",
  ];
  if (opts.declined) {
    lines.push(
      "ai-review\tRun the AI review\t2026-10-24T00:55:02.7400528Z " +
        `##[warning]${AI_REVIEW_DECLINE_LOG_LINE}: Workflow validation failed. The ` +
        "workflow file must exist and have identical content to the version on the default branch.",
      "ai-review\tRun the AI review\t2026-10-24T00:55:02.7405985Z " +
        "Exiting due to workflow validation skip",
    );
  } else {
    lines.push(
      "ai-review\tRun the AI review\t2026-10-24T00:59:14.0000000Z " +
        "[debug] result subtype=success num_turns=33",
    );
  }
  lines.push(
    "ai-review\tReport whether the AI review ran\t2026-10-24T00:55:05.0000000Z " +
      "##[warning]title=AI review UNMEASURED::The review action exited successfully " +
      "WITHOUT writing a findings payload",
  );
  return `${lines.join("\n")}\n`;
}

const read = (text: string): JobLogReading => ({ status: AI_REVIEW_JOB_LOG_READ, text });

describe("AC-U1 (#1486): one log, one line of difference, two readings", () => {
  test("AC-U1: a full log carrying the skip line records the DECLINE state", () => {
    expect(classifyUnmeasuredRound(read(jobLog({ declined: true })))).toBe(
      AI_REVIEW_UNMEASURED_DECLINED,
    );
  });

  test("AC-U1: the same log with that one line removed records NO_PAYLOAD", () => {
    const declined = jobLog({ declined: true });
    const without = declined
      .split("\n")
      .filter(l => !l.includes(AI_REVIEW_DECLINE_LOG_LINE))
      .join("\n");
    // The premise, asserted rather than assumed: exactly one line went, and
    // the thing that went is the marker. Without this the case could be
    // passing on a fixture that lost its whole second half.
    expect(without.split("\n").length, "more than one line was removed").toBe(
      declined.split("\n").length - 1,
    );
    expect(without).not.toContain(AI_REVIEW_DECLINE_LOG_LINE);
    expect(classifyUnmeasuredRound(read(without))).toBe(AI_REVIEW_UNMEASURED_NO_PAYLOAD);
  });

  test("AC-U1: a log the action never reached at all is NO_PAYLOAD, not a decline", () => {
    expect(classifyUnmeasuredRound(read(""))).toBe(AI_REVIEW_UNMEASURED_NO_PAYLOAD);
  });

  /**
   * The row that binds the marker to reality BEHAVIOURALLY, and it exists
   * because a mutation row came back lower than predicted.
   *
   * `jobLog()` above interpolates `AI_REVIEW_DECLINE_LOG_LINE`, which is
   * right for the one-line-difference property it carries and wrong as the
   * only binding: mutating the constant moves the fixture with it, so a
   * marker off by one character was predicted to redden three rows and
   * reddened one — AC-U7's string equality, the only assertion that was not
   * reading the mutated value on both sides. The fixture and the defect
   * shared a blind spot, which is the seventh shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`.
   *
   * This line is VERBATIM from run 40047304108's full job log, pasted and
   * not composed, so it cannot move when the constant does.
   */
  test("AC-U1: a verbatim line from a real declined run reads as a decline", () => {
    const verbatim =
      "ai-review\tRun the AI review\t2026-10-24T00:55:02.7400528Z " +
      "##[warning]Skipping action due to workflow validation: Workflow validation " +
      "failed. The workflow file must exist and have identical content to the " +
      "version on the default branch.\n";
    expect(classifyUnmeasuredRound(read(verbatim))).toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });
});

describe("AC-U2 (#1486): a log that could not be read is its own value", () => {
  test("AC-U2: an unreadable reading is LOG_UNREADABLE and neither real state", () => {
    const state = classifyUnmeasuredRound({
      status: AI_REVIEW_JOB_LOG_UNREADABLE,
      reason: "the run's logs have expired",
    });
    expect(state).toBe(AI_REVIEW_UNMEASURED_LOG_UNREADABLE);
    expect(state).not.toBe(AI_REVIEW_UNMEASURED_NO_PAYLOAD);
    expect(state).not.toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });
});

describe("AC-U3 (#1486): an unrecognised reading is named, never defaulted", () => {
  /**
   * Every shape here is one the classifier has no rule for. The property is
   * that NONE of them lands on a real state — a reading nobody predicted
   * being recorded as a decline is #1486's first acceptance row, and it is
   * the failure mode a `?? DECLINED` or an `if (!hasLine) NO_PAYLOAD`
   * written one branch too wide produces.
   */
  const unknown: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "READ"],
    ["an array", [AI_REVIEW_JOB_LOG_READ]],
    ["a status nobody declared", { status: "JOB_LOG_PARTIAL", text: "x" }],
    ["READ with no text", { status: AI_REVIEW_JOB_LOG_READ }],
    ["READ whose text is a number", { status: AI_REVIEW_JOB_LOG_READ, text: 5 }],
    ["READ whose text is null", { status: AI_REVIEW_JOB_LOG_READ, text: null }],
    ["an object with no status", { text: "x" }],
  ];

  for (const [name, value] of unknown) {
    test(`AC-U3: ${name} is UNCLASSIFIED`, () => {
      expect(classifyUnmeasuredRound(value)).toBe(AI_REVIEW_UNMEASURED_UNCLASSIFIED);
    });
  }
});

describe("AC-U4 (#1486): the mutation — the classifier short-circuited to DECLINED", () => {
  /**
   * The battery this file is for. `.claude/rules/checks-must-be-able-to-fail.md`:
   * a case that reads something other than the classifier passes whatever the
   * classifier says, and nothing above this line can tell the difference.
   *
   * The membership is predicted, not only the count — the seventh shape. A
   * mutant that failed to LOAD reports the same zero as a guard that held, so
   * the row asserting the UNCLASSIFIED shapes ALSO flip is what proves the
   * mutation applied and the module ran.
   */
  const ANCHOR =
    "export function classifyUnmeasuredRound(reading: unknown): UnmeasuredState {";

  test("AC-U4: the decision site is spelled exactly once, so no path bypasses it", () => {
    const src = readFileSync(MODULE, "utf8");
    expect(
      src.split(ANCHOR).length - 1,
      "the classifier's signature must appear exactly once — a second one is a " +
        "second decider the mutation below cannot reach",
    ).toBe(1);
  });

  test("AC-U4: with it, no-payload and unclassified both become DECLINED", async () => {
    const src = readFileSync(MODULE, "utf8");
    const mutantSrc = src.replace(
      ANCHOR,
      `${ANCHOR}\n  return AI_REVIEW_UNMEASURED_DECLINED;`,
    );
    expect(mutantSrc, "the mutation did not apply").not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "ai-review-unmeasured-mutant-"));
    try {
      const path = join(dir, "mutant.ts");
      writeFileSync(path, mutantSrc);
      const mutant = await import(path);

      // It LOADED and it RAN: the decline row is unchanged, which is the
      // control that separates "the mutant behaves differently" from "the
      // mutant never executed".
      expect(
        mutant.classifyUnmeasuredRound(read(jobLog({ declined: true }))),
        "the mutant did not load or did not run",
      ).toBe(AI_REVIEW_UNMEASURED_DECLINED);

      // Predicted set: every row that is NOT already DECLINED flips to it.
      const observed = {
        noPayload: mutant.classifyUnmeasuredRound(read(jobLog({ declined: false }))),
        unreadable: mutant.classifyUnmeasuredRound({
          status: AI_REVIEW_JOB_LOG_UNREADABLE,
          reason: "expired",
        }),
        unclassified: mutant.classifyUnmeasuredRound(null),
      };
      expect(observed).toEqual({
        noPayload: AI_REVIEW_UNMEASURED_DECLINED,
        unreadable: AI_REVIEW_UNMEASURED_DECLINED,
        unclassified: AI_REVIEW_UNMEASURED_DECLINED,
      });

      // And the real module still disagrees with the mutant on all three.
      // Asserted here rather than left to AC-U1/U2/U3 running elsewhere: a
      // battery whose real and mutant arms are evaluated in different runs
      // cannot report a row that came back lower than predicted.
      expect(classifyUnmeasuredRound(read(jobLog({ declined: false })))).toBe(
        AI_REVIEW_UNMEASURED_NO_PAYLOAD,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AC-U5 (#1486): a measured round is untouched, and `measured` is unchanged", () => {
  const measuredRound = {
    at: "2026-10-24T00:00:00Z",
    sha: "a".repeat(40),
    run: "40053178587",
    attempt: "1",
    round: 1,
    identity: "file+text+summary@v1",
    findings: [{ severity: "high", file: "lib/a.ts", line: 4, summary: "s" }],
  };
  const unmeasuredRound = { ...measuredRound, round: 2, run: "40047304108", findings: null };

  test("AC-U5: a round with a payload gains no field and keeps its findings", () => {
    const out = annotateUnmeasuredRounds([measuredRound], () =>
      read(jobLog({ declined: true })),
    );
    expect(out.recorded).toBe(0);
    const round = out.rounds[0] as Record<string, unknown>;
    expect(
      Object.hasOwn(round, AI_REVIEW_LEDGER_UNMEASURED_KEY),
      "a measured round must not carry a discriminator — there is nothing to discriminate",
    ).toBe(false);
    expect(round.findings).toEqual(measuredRound.findings);
  });

  test("AC-U5: an unmeasured round gains the state the classifier returned", () => {
    const out = annotateUnmeasuredRounds([unmeasuredRound], () =>
      read(jobLog({ declined: true })),
    );
    expect(out.recorded).toBe(1);
    const round = out.rounds[0] as Record<string, unknown>;
    expect(round[AI_REVIEW_LEDGER_UNMEASURED_KEY]).toBe(AI_REVIEW_UNMEASURED_DECLINED);
    // ADDITIVE. `findings: null` is what `readLedger` turns into
    // `measured: false`, and every consumer of that boolean — including
    // `summariseRoundsToPass` — must read exactly what it read before.
    expect(round.findings).toBeNull();
  });

  test("AC-U5: the real reader still calls the annotated round UNMEASURED", () => {
    const out = annotateUnmeasuredRounds([measuredRound, unmeasuredRound], () =>
      read(jobLog({ declined: false })),
    );
    const body = [
      AI_REVIEW_LEDGER_COMMENT_MARKER,
      "",
      "```json",
      JSON.stringify({ rounds: out.rounds, truncated: 0 }),
      "```",
      "",
    ].join("\n");
    const reading = readLedger(body);
    expect(reading.status).toBe(AI_REVIEW_LEDGER_READ);
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(reading.rounds.map(r => r.measured)).toEqual([true, false]);
  });

  test("AC-U5: a round that already carries a reading is not reclassified", () => {
    const already = {
      ...unmeasuredRound,
      [AI_REVIEW_LEDGER_UNMEASURED_KEY]: AI_REVIEW_UNMEASURED_DECLINED,
    };
    let asked = 0;
    const out = annotateUnmeasuredRounds([already], () => {
      asked++;
      return read(jobLog({ declined: false }));
    });
    expect(out.recorded).toBe(0);
    expect(asked, "a recorded round must not cost a log fetch").toBe(0);
    expect((out.rounds[0] as Record<string, unknown>)[AI_REVIEW_LEDGER_UNMEASURED_KEY]).toBe(
      AI_REVIEW_UNMEASURED_DECLINED,
    );
  });

  test("AC-U5: a round entry that is not an object is passed through untouched", () => {
    const out = annotateUnmeasuredRounds(["not a round", 7, null], () =>
      read(jobLog({ declined: true })),
    );
    expect(out.recorded).toBe(0);
    expect(out.rounds).toEqual(["not a round", 7, null]);
  });
});

describe("AC-U8 (#1486): the rewrite splices, and refuses when it cannot", () => {
  const body = [
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    "",
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify({ rounds: [{ round: 1, findings: null }], truncated: 0 }),
    "```",
    "",
    "<sub>written by the AI Review workflow</sub>",
  ].join("\n");

  test("AC-U8: the prose around the fence survives the rewrite", () => {
    const out = replaceLedgerJsonBlock(body, { rounds: [], truncated: 3 });
    expect(out).not.toBeNull();
    expect(out!).toContain("### AI review findings ledger");
    expect(out!).toContain("<sub>written by the AI Review workflow</sub>");
    expect(out!).toContain(AI_REVIEW_LEDGER_COMMENT_MARKER);
  });

  test("AC-U8: the real reader reads the spliced body back", () => {
    // The binding that closes the second-reader risk named in the function's
    // docblock: this module locates the fence itself, and the only thing
    // that makes that safe is running `readLedger` over the result.
    const out = replaceLedgerJsonBlock(body, {
      rounds: [
        { round: 1, findings: null, [AI_REVIEW_LEDGER_UNMEASURED_KEY]: "declined" },
        { round: 2, findings: [] },
      ],
      truncated: 0,
    })!;
    const reading = readLedger(out);
    expect(reading.status).toBe(AI_REVIEW_LEDGER_READ);
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(reading.rounds.map(r => r.measured)).toEqual([false, true]);
  });

  test("AC-U8: the rewrite is COMPACT, because the window is sized in characters", () => {
    // `buildPersistScript` serialises with `jq -c`, and the ledger is a
    // 12-round window against GitHub's 65,536-character body limit. A
    // rewrite with an indent inflates every round and makes the window
    // evict earlier — which reads as ordinary truncation and is not.
    // The first real write on #1470 did exactly this before it was caught.
    const out = replaceLedgerJsonBlock(body, {
      rounds: [{ round: 1, findings: null }],
      truncated: 0,
    })!;
    const fenced = out.split("```json\n")[1]!.split("\n```")[0]!;
    expect(fenced, "the rewritten block was pretty-printed").not.toContain("\n");
    expect(JSON.parse(fenced)).toEqual({ rounds: [{ round: 1, findings: null }], truncated: 0 });
  });

  test("AC-U8: a body with no fence is a refusal, never a fresh ledger", () => {
    expect(replaceLedgerJsonBlock("no fence here", { rounds: [] })).toBeNull();
    expect(replaceLedgerJsonBlock(null, { rounds: [] })).toBeNull();
    // An unterminated fence is a truncated comment. Composing a replacement
    // for it would overwrite every round it still holds with this pass.
    expect(replaceLedgerJsonBlock("```json\n{}", { rounds: [] })).toBeNull();
  });
});

describe("AC-U6 (#1486): the reader's closed set", () => {
  test("AC-U6: a round written before this change reads as NOT_RECORDED", () => {
    expect(readRecordedUnmeasuredState({ findings: null })).toBe(
      AI_REVIEW_UNMEASURED_NOT_RECORDED,
    );
  });

  test("AC-U6: a recorded value outside the set is UNRECOGNISED, not a real state", () => {
    const state = readRecordedUnmeasuredState({
      findings: null,
      [AI_REVIEW_LEDGER_UNMEASURED_KEY]: "declined_probably",
    });
    expect(state).toBe(AI_REVIEW_UNMEASURED_UNRECOGNISED);
    expect(state).not.toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });

  test("AC-U6: each recorded state in the set reads back as itself", () => {
    const states: UnmeasuredState[] = [
      AI_REVIEW_UNMEASURED_DECLINED,
      AI_REVIEW_UNMEASURED_NO_PAYLOAD,
      AI_REVIEW_UNMEASURED_LOG_UNREADABLE,
      AI_REVIEW_UNMEASURED_UNCLASSIFIED,
    ];
    for (const s of states) {
      expect(
        readRecordedUnmeasuredState({ findings: null, [AI_REVIEW_LEDGER_UNMEASURED_KEY]: s }),
      ).toBe(s);
    }
  });
});

describe("AC-U7 (#1486): the marker, and the module's own shape", () => {
  test("AC-U7: the marker is the exact bytes a declined run emits", () => {
    // Quoted from run 40047304108's full log, not paraphrased. A paraphrase
    // matches nothing, and a match that is one character off is a silent
    // reclassification of every declined round to no-payload.
    expect(AI_REVIEW_DECLINE_LOG_LINE).toBe("Skipping action due to workflow validation");
  });

  test("AC-U7: the module has no relative imports, so AC-U4's mutant can load", () => {
    // A mutant copied into a tmpdir dies on module resolution if this module
    // gains one, and a mutant that failed to load reads as a refusal rather
    // than as a guard that held — `.claude/rules/self-referential-tests.md`.
    const src = readFileSync(MODULE, "utf8");
    expect(src.match(/from\s+["']\.{1,2}\//g) ?? []).toEqual([]);
    expect(src.match(/require\(["']\.{1,2}\//g) ?? []).toEqual([]);
  });

  test("AC-U7: every state value is distinct", () => {
    const all = [
      AI_REVIEW_UNMEASURED_DECLINED,
      AI_REVIEW_UNMEASURED_NO_PAYLOAD,
      AI_REVIEW_UNMEASURED_LOG_UNREADABLE,
      AI_REVIEW_UNMEASURED_UNCLASSIFIED,
      AI_REVIEW_UNMEASURED_NOT_RECORDED,
      AI_REVIEW_UNMEASURED_UNRECOGNISED,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
