/**
 * Bounding review rounds on an open pull request (#1168).
 *
 * Three mechanisms, and one of them is a precondition for another:
 *
 *  - AC-1  a round cap, failing CLOSED on a budget nobody can read
 *  - AC-2  the cap SPEAKS — it is not a silencer
 *  - AC-3  diff-only re-review from round 3, and only over a held PASS
 *  - AC-4  no repeats, keyed on CONTENT and not on a line number
 *  - AC-5  unresolved earlier findings are carried forward
 *  - AC-6  a control: round 1 behaves exactly as it does today
 *
 * The cheapest wrong fix for AC-4 is a `file:line` key, and it is also the
 * obvious one. `AC-4: the wrong fix` applies it and shows the row it fails
 * on, taken from the only repeat this repository can actually demonstrate —
 * see `lib/ai-review-rounds.ts`'s header.
 */

import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND,
  AI_REVIEW_ROUNDS_UNMEASURED,
  AI_REVIEW_ROUND_AT_CAP,
  AI_REVIEW_ROUND_CAP,
  AI_REVIEW_ROUND_OPEN,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  atCapInstruction,
  carryForward,
  carryKey,
  noRepeatsInstruction,
  readRoundNumber,
  reviewScopeForRound,
  roundOutcome,
  suppressRepeats,
  type ReviewFinding,
  AI_REVIEW_CARRY_READ_STATE,
} from "../lib/ai-review-rounds.ts";
// #244's rule, asked where it still governs. Imported from its own module
// rather than through the one above, so the case cannot pass because
// `ai-review-rounds.ts` happens to re-export something.
import { reReviewScope } from "../lib/security-verdict.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("AC-1: the round cap, and a budget nobody can read", () => {
  test("AC-1: rounds inside the budget are open", () => {
    for (let r = 1; r <= AI_REVIEW_ROUND_CAP; r++) {
      const out = roundOutcome(String(r));
      expect(out.decision, `round ${r}`).toBe(AI_REVIEW_ROUND_OPEN);
      expect(out.round).toBe(r);
      expect(out.reason).toBeNull();
    }
  });

  test("AC-1: the first round past the cap is capped, and every one after it", () => {
    for (const r of [AI_REVIEW_ROUND_CAP + 1, AI_REVIEW_ROUND_CAP + 2, 50]) {
      const out = roundOutcome(String(r));
      expect(out.decision, `round ${r}`).toBe(AI_REVIEW_ROUND_AT_CAP);
      expect(out.round).toBe(r);
      expect(out.reason).toBeString();
    }
  });

  test("AC-1: an unreadable counter is UNMEASURED, never round 1", () => {
    // Every one of these is a reading a looser parser turns into a number,
    // and a counter that reads 0 or NaN as "round 1" resets the bound on
    // every run — a cap that can never be reached.
    const unreadable = [
      undefined, null, "", "   ", "0", "-1", "1.5", "2e3", "0x3", "two",
      "3\n4", [], {}, true, Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 2.5,
    ];
    for (const v of unreadable) {
      const out = roundOutcome(v as unknown);
      expect(out.decision, `input ${JSON.stringify(v) ?? String(v)}`).toBe(
        AI_REVIEW_ROUNDS_UNMEASURED,
      );
      expect(out.round).toBeNull();
      expect(out.reason).toBeString();
    }
  });

  test("AC-1: an unreadable CAP is UNMEASURED too — this delegates to reReviewDecision", () => {
    // The cap arithmetic is security-verdict's. Handing it a cap it cannot
    // read must refuse, and this is the case that observes the delegation:
    // a local `round > 3` would pass here.
    //
    // `undefined` is NOT in this list and must not be: it is the default
    // parameter, so it never reaches the budget reader. Putting it here
    // would assert that calling the function normally refuses.
    for (const cap of [null, "3", -1, 1.5, Number.NaN]) {
      const out = roundOutcome("2", cap as unknown);
      expect(out.decision, `cap ${String(cap)}`).toBe(AI_REVIEW_ROUND_AT_CAP);
    }
    // And a cap of zero leaves no round at all, which is the same refusal.
    expect(roundOutcome("1", 0).decision).toBe(AI_REVIEW_ROUND_AT_CAP);
  });

  test("AC-1: readRoundNumber accepts exactly the positive decimal integers", () => {
    expect(readRoundNumber("1")).toBe(1);
    expect(readRoundNumber("12")).toBe(12);
    expect(readRoundNumber(7)).toBe(7);
    expect(readRoundNumber("007")).toBe(7);
    expect(readRoundNumber("1 2")).toBeNull();
    // Surrounding whitespace IS trimmed, and has to be: the value arrives
    // from a `$(...)` in bash, which carries a trailing newline on most
    // readings. Inner whitespace is not — `"1 2"` above is two numbers.
    expect(readRoundNumber(" 7\n")).toBe(7);
    expect(readRoundNumber(" 2 ")).toBe(2);
  });

  test("AC-1: the refusal name is declared exactly once in the source", () => {
    // Same property `SECURITY_REREVIEW_EXHAUSTED` asserts about itself: a
    // second spelling is a second refusal path, reachable by code the first
    // one's tests never visit.
    const src = readFileSync(join(ROOT, "lib/ai-review-rounds.ts"), "utf8");
    const spellings = src.split('"AI_REVIEW_ROUNDS_UNMEASURED"').length - 1;
    expect(
      spellings,
      "AI_REVIEW_ROUNDS_UNMEASURED must appear exactly once as a string literal",
    ).toBe(1);
  });
});

describe("AC-2: the cap speaks", () => {
  test("AC-2: the at-cap instruction asks for an approach assessment, not silence", () => {
    const text = atCapInstruction(4);
    expect(text).toContain("REVIEW ROUND 4");
    expect(text).toContain("APPROACH");
    // The failure mode this is written against: a reviewer that says nothing
    // hands over a green check on a pull request three reviews could not
    // settle.
    expect(text.toLowerCase()).toContain("silent");
    expect(text).toContain("non-blocking severity");
  });

  test("AC-2: it names the cap it was given, not a hardcoded three", () => {
    expect(atCapInstruction(9, 8)).toContain("already had 8 rounds");
  });

  test("AC-2: it never tells the reviewer to stop writing a payload", () => {
    // A cap that suppresses the payload is UNMEASURED dressed as a pass: the
    // adjudicator reads the payload, and no payload is "has not had a review".
    const text = atCapInstruction(4).toLowerCase();
    expect(text).toContain("write one finding");
    expect(text).not.toContain("do not write");
  });
});

describe("AC-3: diff-only re-review, and the fail-open it must not reopen", () => {
  /**
   * **This block's second gate changed in #1600, and the change is the whole
   * of CRC-N2.** It used to hand the held verdict to `reReviewScope`, which
   * refuses to diff-scope anything but a held PASS. That rule is #244's and
   * it is unchanged where it belongs — `reReviewBaseFor` in
   * `lib/security-verdict.ts` still asks it, and
   * `test/security-verdict*.test.ts` still holds it.
   *
   * It was the wrong gate here for a reason that is not "the risk went
   * away": a CI round has no held verdict, so the conjunction could never
   * open and this function answered FULL for every input anybody could
   * supply. What replaced it is the thing #244 said was missing —
   * `carryForward` re-emitting unresolved priors whether or not the diff
   * contains the lines they name, which the spec names as this deviation's
   * own retirement condition and which fired on run `40137812549`.
   *
   * `test/ai-review-diff-scope.test.ts` is where the generated bash is held
   * to this function and where the negative control lives. These cases are
   * the library's own contract.
   */
  // The complete reading, at round 9: the carry was read, nothing was
  // unparseable, nothing was truncated, rounds 1..8 are all recorded, and
  // the changed-file list names two paths. Every row below varies ONE field
  // away from it (#585), so deleting any single gate leaves a row nothing
  // else catches.
  const readingAt = (round: number) => ({
    state: AI_REVIEW_CARRY_READ_STATE,
    unmeasuredRounds: "0",
    changedFileCount: "2",
    truncatedRounds: "0",
    priorRounds: String(round - 1),
    highestPriorRound: String(round - 1),
  });
  // A FUNCTION of the round, not a constant, and that is forced: gate 5 asks
  // for rounds 1..r-1 with no hole, so a fixed `priorRounds` would be a hole
  // at every round but one and the rows would pass for the wrong reason.
  const READ = readingAt(9);

  test("AC-3: the first rounds are full reviews whatever the carry says", () => {
    for (let r = 1; r < AI_REVIEW_DIFF_SCOPE_FROM_ROUND; r++) {
      expect(reviewScopeForRound(String(r), readingAt(r)), `round ${r}`).toBe(REVIEW_SCOPE_FULL);
    }
  });

  test("AC-3: from the floor, a complete carry reading may be diff-scoped", () => {
    const floor = AI_REVIEW_DIFF_SCOPE_FROM_ROUND;
    expect(reviewScopeForRound(String(floor), readingAt(floor))).toBe(REVIEW_SCOPE_DIFF);
    expect(reviewScopeForRound("9", READ)).toBe(REVIEW_SCOPE_DIFF);
  });

  test("AC-3: the history must be COMPLETE, not merely readable — #1601 one level up", () => {
    // Three ways for the history to be incomplete, and the first gate sees
    // only one of them. `unmeasuredRounds` counts recorded rounds that will
    // not PARSE; a truncated ledger's earlier rounds are ABSENT, so every
    // entry still present parses fine and the count reads 0 over a hole.
    //
    // Measured across 144 ledgers on 2026-10-24: of 197 rounds at or past
    // the floor, 83 are refused for truncation or an unknown truncation
    // reading, and 14 more carry a round-number gap that neither truncation
    // nor unreadability can see — #1420 has no round 2, #1391 no round 1.
    // 100 still narrow, so these refuse something real.
    const rows: Array<[string, Record<string, unknown>]> = [
      ["the ledger dropped earlier rounds", { truncatedRounds: "1" }],
      ["whether it dropped any is unknown", { truncatedRounds: "unknown" }],
      ["a pre-#1405 bare array has no truncation key", { truncatedRounds: undefined }],
      ["round 9's history stops at round 7", { highestPriorRound: "7", priorRounds: "7" }],
      ["rounds 1..8 recorded, but only six of them", { priorRounds: "6" }],
      ["how many prior rounds there are is unknown", { priorRounds: "unknown" }],
      ["the highest prior round is unknown", { highestPriorRound: "unknown" }],
    ];
    for (const [why, delta] of rows) {
      expect(reviewScopeForRound("9", { ...READ, ...delta }), why).toBe(REVIEW_SCOPE_FULL);
    }
    // The control: the same reading with nothing varied still narrows, so
    // the rows above are refusals and not a gate that refuses everything.
    expect(reviewScopeForRound("9", READ), "the base row stopped narrowing").toBe(
      REVIEW_SCOPE_DIFF,
    );
  });

  test("AC-3: an INCOMPLETE carry is NEVER diff-scoped — 46034035, by a different door", () => {
    // A diff against the flagged commit does not contain the flagged code,
    // so a narrowed round says nothing about an earlier finding UNLESS the
    // carry hands it over. Each row below is a reading in which it cannot:
    // the history was not read, or was read with blind spots, or the
    // changed-file list the narrowing points at does not exist.
    const rows: Array<[string, unknown]> = [
      ["not an object", undefined],
      ["null", null],
      ["an array", []],
      ["no state at all", {}],
      ["the history could not be read", { ...READ, state: "AI_REVIEW_CARRY_UNMEASURED" }],
      ["no history to read", { ...READ, state: "AI_REVIEW_CARRY_ABSENT" }],
      ["a state nobody declared", { ...READ, state: "PASS" }],
      ["one round's findings unreadable", { ...READ, unmeasuredRounds: "1" }],
      ["the blind-spot count unknown", { ...READ, unmeasuredRounds: "unknown" }],
      ["no changed-file list", { ...READ, changedFileCount: "unknown" }],
      ["a changed-file list naming nothing", { ...READ, changedFileCount: "0" }],
    ];
    for (const [why, carry] of rows) {
      expect(reviewScopeForRound("9", carry), why).toBe(REVIEW_SCOPE_FULL);
    }
  });

  test("AC-3: each gate has an input only it refuses", () => {
    // #420: two deciders that agree are behaviourally one. Four rows, each
    // varying exactly ONE field away from a reading that narrows (#585), so
    // deleting any single gate leaves one row that nothing else catches.
    expect(reviewScopeForRound("9", READ), "the base row does not narrow").toBe(REVIEW_SCOPE_DIFF);
    // `readingAt(2)` and NOT `READ`, and the difference is the whole point of
    // the row. `READ` is the round-9 reading, so handing it to round 2 varies
    // TWO things — the round AND the prior-round history, which then no
    // longer describes round 2. Gate 5 refuses it on the history, gate 1
    // never gets asked, and deleting the floor leaves the row green: measured
    // at 3 red where 4 was predicted, which is #585's pair discipline failing
    // inside a case whose own comment claims to vary exactly one field.
    expect(reviewScopeForRound("2", readingAt(2))).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound("9", { ...READ, state: "AI_REVIEW_CARRY_ABSENT" })).toBe(
      REVIEW_SCOPE_FULL,
    );
    expect(reviewScopeForRound("9", { ...READ, unmeasuredRounds: "2" })).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound("9", { ...READ, changedFileCount: "0" })).toBe(REVIEW_SCOPE_FULL);
  });

  test("AC-3: an unreadable round reads MORE, not less", () => {
    expect(reviewScopeForRound("", READ)).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound(undefined, READ)).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound("0", READ)).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound("nine", READ)).toBe(REVIEW_SCOPE_FULL);
  });

  test("AC-3: #244's rule is unchanged where it still governs", () => {
    // The gate did not disappear from the codebase, it stopped being asked
    // on a path that could never answer it. Asserted rather than claimed,
    // because "the rule still holds elsewhere" is the kind of sentence that
    // outlives the code it describes.
    expect(reReviewScope({ verdict: "PASS" })).toBe(REVIEW_SCOPE_DIFF);
    expect(reReviewScope({ verdict: "FAIL", failures: ["a thing"] })).toBe(REVIEW_SCOPE_FULL);
    expect(reReviewScope(undefined)).toBe(REVIEW_SCOPE_FULL);
  });
});

describe("AC-4: no repeats, keyed on content", () => {
  // The one repeat this repository can demonstrate, verbatim from run
  // 39829586109 → 39830806887 on `rg/1175-protected-files-tree-scope`. The
  // line is byte-identical at both rounds; only its NUMBER moved.
  const LINK_LINE =
    "const LINK_CREATION = /(?:^|[\\s;&|(])ln\\s|\\bsymlinkSync\\b|\\bos\\.symlink\\b|\\bsymlink\\s*\\(/;";
  const round1: ReviewFinding = {
    severity: "high",
    file: "lib/bash-write-guard.ts",
    line: 318,
    summary: "The LINK_CREATION regex does not match cp -s",
    failure_scenario: "cp -s a b && echo x > b",
  };
  const round2: ReviewFinding = { ...round1, line: 375 };

  test("AC-4: the same defect at a moved line is one finding", () => {
    const k1 = carryKey(round1, LINK_LINE);
    const k2 = carryKey(round2, LINK_LINE);
    expect(k1).not.toBeNull();
    expect(k2).toBe(k1!);
  });

  test("AC-4: the wrong fix — a file:line key — lets the measured repeat through", () => {
    // Applied and measured rather than named in prose. This is the key
    // somebody reaches for first, and it is green on every synthetic case
    // where the line number happens not to move.
    const wrong = (f: ReviewFinding) => `${String(f.file)}:${String(f.line)}`;
    expect(wrong(round1)).not.toBe(wrong(round2));

    const underWrongFix = suppressRepeats([round2], [wrong(round1)], () => LINK_LINE);
    // It keeps it. One round of review bought for nothing — the real case.
    expect(underWrongFix.kept).toHaveLength(1);
    expect(underWrongFix.suppressed).toHaveLength(0);

    const underRealFix = suppressRepeats([round2], [carryKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(underRealFix.kept).toHaveLength(0);
    expect(underRealFix.suppressed).toHaveLength(1);
  });

  test("AC-4: a DIFFERENT defect at the same line is still reported", () => {
    // The direction this must not be wrong in. A key that collapses two
    // findings on one line suppresses a real one.
    const other: ReviewFinding = { ...round2, summary: "and it also misses ln -sf" };
    const out = suppressRepeats([other], [carryKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toHaveLength(0);
  });

  test("AC-4: a defect whose line was REWRITTEN is a new finding", () => {
    // Content keying has to cut both ways or it is just a looser line key.
    const out = suppressRepeats(
      [round2],
      [carryKey(round1, LINK_LINE)!],
      () => "const LINK_CREATION = /something else entirely/;",
    );
    expect(out.kept).toHaveLength(1);
  });

  test("AC-4: a repeat inside ONE payload is dropped once, keeping the first", () => {
    const out = suppressRepeats([round1, round2], [], () => LINK_LINE);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]!.line).toBe(318);
    expect(out.suppressed).toHaveLength(1);
  });

  test("AC-4: an unkeyable finding is always kept", () => {
    const blank = { severity: "high" };
    expect(carryKey(blank)).toBeNull();
    const out = suppressRepeats([blank, blank], ["anything"], () => "");
    expect(out.kept).toHaveLength(2);
  });

  test("AC-4: with no line text the key falls back to the number, and says so", () => {
    expect(carryKey(round1)).not.toBe(carryKey(round2));
    expect(carryKey(round1)).toBe(carryKey({ ...round1 }));
  });

  test("AC-4: case and whitespace do not make a new finding", () => {
    const reworded = { ...round2, summary: "  The LINK_CREATION  regex does NOT match cp -s " };
    const out = suppressRepeats([reworded], [carryKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(out.suppressed).toHaveLength(1);
  });

  test("AC-4: every suppression says why", () => {
    const out = suppressRepeats([round2], [carryKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain("lib/bash-write-guard.ts");
    expect(out.reasons[0]).toContain("earlier round");
  });

  test("AC-4: the prompt block lists what was already said and refuses a reword", () => {
    expect(noRepeatsInstruction([])).toBe("");
    const text = noRepeatsInstruction(["a thing", "another thing"]);
    expect(text).toContain("- a thing");
    expect(text).toContain("- another thing");
    expect(text).toContain("does NOT match on the line number");
  });
});

describe("AC-5: unresolved findings are carried forward", () => {
  const f: ReviewFinding = { file: "a.ts", line: 10, summary: "boom" };

  test("AC-5: a finding whose line is unchanged survives a diff-scoped round", () => {
    const out = carryForward([{ finding: f, recordedText: "const x = 1;" }], () => "const x = 1;");
    expect(out).toHaveLength(1);
  });

  test("AC-5: a finding whose line was rewritten is cleared", () => {
    const out = carryForward([{ finding: f, recordedText: "const x = 1;" }], () => "const x = 2;");
    expect(out).toHaveLength(0);
  });

  test("AC-5: a line that cannot be read is UNRESOLVED, not cleared", () => {
    // A finding nobody could check is not a finding anybody cleared.
    const out = carryForward([{ finding: f, recordedText: "const x = 1;" }], () => undefined);
    expect(out).toHaveLength(1);
  });

  test("AC-5: this is what makes a diff-scoped round honest", () => {
    // The composition the fail-open lives in: round 3 is diff-scoped, so the
    // reviewer never reads a.ts, and reports nothing. Without carryForward
    // the check goes green over an unresolved finding.
    const freshFromDiffScopedRound: ReviewFinding[] = [];
    const carried = carryForward([{ finding: f, recordedText: "const x = 1;" }], () => "const x = 1;");
    expect([...freshFromDiffScopedRound, ...carried]).toHaveLength(1);
  });
});

describe("AC-6: the control — a pull request that converges in one round", () => {
  test("AC-6: round 1 is open, full-scoped, suppresses nothing and adds no prompt block", () => {
    const out = roundOutcome("1");
    expect(out.decision).toBe(AI_REVIEW_ROUND_OPEN);
    expect(out.reason).toBeNull();
    expect(reviewScopeForRound("1", { verdict: "PASS" })).toBe(REVIEW_SCOPE_FULL);
    expect(noRepeatsInstruction([])).toBe("");
    const fresh: ReviewFinding[] = [{ file: "a.ts", line: 1, summary: "x" }];
    const s = suppressRepeats(fresh, [], () => "whatever");
    expect(s.kept).toEqual(fresh);
    expect(s.suppressed).toHaveLength(0);
  });
});
