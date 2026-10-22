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
  findingKey,
  noRepeatsInstruction,
  readRoundNumber,
  reviewScopeForRound,
  roundOutcome,
  suppressRepeats,
  type ReviewFinding,
} from "../lib/ai-review-rounds.ts";
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
  const PASS = { verdict: "PASS" };
  const FAIL = { verdict: "FAIL", failures: ["a thing"] };

  test("AC-3: the first rounds are full reviews whatever the held verdict", () => {
    for (let r = 1; r < AI_REVIEW_DIFF_SCOPE_FROM_ROUND; r++) {
      expect(reviewScopeForRound(String(r), PASS), `round ${r}`).toBe(REVIEW_SCOPE_FULL);
      expect(reviewScopeForRound(String(r), FAIL), `round ${r}`).toBe(REVIEW_SCOPE_FULL);
    }
  });

  test("AC-3: from the floor, a held PASS may be diff-scoped", () => {
    expect(reviewScopeForRound(String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND), PASS)).toBe(
      REVIEW_SCOPE_DIFF,
    );
    expect(reviewScopeForRound("9", PASS)).toBe(REVIEW_SCOPE_DIFF);
  });

  test("AC-3: a held FAIL is NEVER diff-scoped — 46034035, by a different door", () => {
    // A diff against the flagged commit does not contain the flagged code,
    // so a diff-scoped PASS says nothing about the finding it would clear.
    // This is `reReviewScope`'s rule and the case exists to prove the
    // delegation is real: dropping the second gate turns it red.
    for (const held of [FAIL, undefined, null, {}, "PASS", { verdict: "pass" }, []]) {
      expect(
        reviewScopeForRound("9", held),
        `held ${JSON.stringify(held) ?? String(held)}`,
      ).toBe(REVIEW_SCOPE_FULL);
    }
  });

  test("AC-3: an unreadable round reads MORE, not less", () => {
    expect(reviewScopeForRound("", PASS)).toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound(undefined, PASS)).toBe(REVIEW_SCOPE_FULL);
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
    const k1 = findingKey(round1, LINK_LINE);
    const k2 = findingKey(round2, LINK_LINE);
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

    const underRealFix = suppressRepeats([round2], [findingKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(underRealFix.kept).toHaveLength(0);
    expect(underRealFix.suppressed).toHaveLength(1);
  });

  test("AC-4: a DIFFERENT defect at the same line is still reported", () => {
    // The direction this must not be wrong in. A key that collapses two
    // findings on one line suppresses a real one.
    const other: ReviewFinding = { ...round2, summary: "and it also misses ln -sf" };
    const out = suppressRepeats([other], [findingKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(out.kept).toHaveLength(1);
    expect(out.suppressed).toHaveLength(0);
  });

  test("AC-4: a defect whose line was REWRITTEN is a new finding", () => {
    // Content keying has to cut both ways or it is just a looser line key.
    const out = suppressRepeats(
      [round2],
      [findingKey(round1, LINK_LINE)!],
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
    expect(findingKey(blank)).toBeNull();
    const out = suppressRepeats([blank, blank], ["anything"], () => "");
    expect(out.kept).toHaveLength(2);
  });

  test("AC-4: with no line text the key falls back to the number, and says so", () => {
    expect(findingKey(round1)).not.toBe(findingKey(round2));
    expect(findingKey(round1)).toBe(findingKey({ ...round1 }));
  });

  test("AC-4: case and whitespace do not make a new finding", () => {
    const reworded = { ...round2, summary: "  The LINK_CREATION  regex does NOT match cp -s " };
    const out = suppressRepeats([reworded], [findingKey(round1, LINK_LINE)!], () => LINK_LINE);
    expect(out.suppressed).toHaveLength(1);
  });

  test("AC-4: every suppression says why", () => {
    const out = suppressRepeats([round2], [findingKey(round1, LINK_LINE)!], () => LINK_LINE);
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
