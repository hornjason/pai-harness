import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  LOCAL_HISTORY_ABSENT,
  LOCAL_HISTORY_READ,
  LOCAL_HISTORY_UNREADABLE,
  LOCAL_REVIEW_AT_CAP,
  LOCAL_REVIEW_CONTINUE,
  LOCAL_REVIEW_SETTLED,
  LOCAL_REVIEW_UNMEASURED,
  appendRound,
  localHistoryPath,
  localRoundReading,
  parseHistory,
  runAnotherRound,
} from "../lib/local-review-rounds.ts";
import { AI_REVIEW_ROUND_CAP } from "../lib/ai-review-rounds.ts";

/**
 * Covers #1342 — the local review loop runs until a person notices.
 *
 * `lib/ai-review-rounds.ts` already bounds the CI reviewer by COUNTING rounds,
 * and `lib/finding-arbiter.ts` already decides whether two findings describe
 * one measured symptom. Neither answers the question #1342 asks, which is when
 * the LOCAL loop — review, fix, push, review again — has stopped learning
 * anything. This file is about the join.
 *
 * ## Two wrong fixes, and the rows that refuse them
 *
 * The cheapest wrong fix is **a round counter and nothing else**: stop at
 * three. `CONTROL-COUNT` is the row it fails — round 2, every finding a
 * restatement of round 1's class, which a counter calls CONTINUE because 2 is
 * under the cap. The loop on #1304 was exactly that shape four times over.
 *
 * The second wrong fix is **a counter that silences**. `CONTROL-CARRY` is the
 * row it fails — round 5, past the cap, carrying a class no earlier round
 * raised. The loop must end AND the class must survive in the reading, because
 * the issue's whole qualification is that a cap which eats a new class
 * truncates the one case where continuing was right.
 *
 * Both rows also pin the class predicate in both directions. Replace
 * `duplicateOverlap` with `() => false` and `CONTROL-COUNT` goes CONTINUE;
 * replace it with `() => true` and `CONTROL-CARRY` goes SETTLED. Neither
 * mutant has a row it can hide in.
 *
 * ## The fixtures are #1304's shape, not invented text
 *
 * Rounds 2-5 on #1304 returned variants of one class — "the gate reads a
 * different value than `gh`". `classA1`/`classA2` are two spellings of that:
 * different titles, different prose, the same measured symptom underneath
 * (`file:lib/issue-filing-gate.ts`, `qty:38:findings`, `qty:12:allowed`,
 * `sym:resolveFiling`, `sym:headRefOid`). `classB` names a different file
 * and different readings and shares zero keys with either. Those three key
 * sets were read out of the arbiter before this file was written, not
 * asserted from a guess — `AC-LR1` re-reads them here so a later change to
 * the keying shows up as a red row in this file rather than as a silent
 * change of meaning.
 *
 * That is what it did. #1536 made a reading carry what it counted, and the
 * two spellings had said *"38 open findings, 12 were allowed"* against
 * *"38 findings, 12 still allowed"* — the same integers measuring the same
 * thing, described differently, which is now two different readings. The
 * bodies were corrected rather than the assertion: they are meant to be one
 * class, and under the new keying a class agrees on what it counted.
 */

interface Round {
  findings: Array<{ id: string; title: string; body: string }>;
}

/** #1304's class, as round 1 spelled it. */
const classA1 = {
  id: "new",
  title: "The filing gate reads a different value than `gh` for `headRefOid`",
  body:
    "`lib/issue-filing-gate.ts` has `resolveFiling` compare its own reading against what `gh pr view` returns. " +
    "Measured over 38 findings, 12 allowed through.",
};

/** The same class, as a later round spelled it. Nothing in common but the symptom. */
const classA2 = {
  id: "new",
  title: "`resolveFiling` still disagrees with `gh` about `headRefOid`",
  body:
    "In `lib/issue-filing-gate.ts` the `resolveFiling` path still reads a different `headRefOid` than `gh` does. " +
    "Re-measured after the fix: 38 findings, 12 allowed and still wrong.",
};

/** A class no round before it raised. */
const classB = {
  id: "new",
  title: "The ledger evicts its oldest rounds when the comment body overflows",
  body:
    "`lib/ai-review-rounds.ts` `readLedger` parses a comment capped at 65536 bytes, so round 20 silently drops round 1 " +
    "and the suppression set loses 14 keys.",
};

const round = (...findings: Array<{ id: string; title: string; body: string }>): Round => ({ findings });

describe("local review rounds (#1342)", () => {
  test("AC-LR1: the fixtures are one repeated class and one new one, by the shared keying", () => {
    // Not a restatement of the implementation: this reads the arbiter directly,
    // so a change that made every finding look like a duplicate (or none of
    // them) reddens here before it reaches a decision row.
    const { duplicateOverlap } = require("../lib/finding-arbiter.ts");
    expect(duplicateOverlap(classA1, classA2).duplicate).toBe(true);
    expect(duplicateOverlap(classA1, classB).duplicate).toBe(false);
    expect(duplicateOverlap(classA2, classB).duplicate).toBe(false);
  });

  test("AC-LR2: round 1 with a finding is CONTINUE — there is nothing yet to repeat", () => {
    const r = localRoundReading([round(classA1)]);
    expect(r.decision).toBe(LOCAL_REVIEW_CONTINUE);
    expect(r.round).toBe(1);
    expect(r.newClasses).toHaveLength(1);
    expect(r.repeats).toEqual([]);
    expect(runAnotherRound(r)).toBe(true);
  });

  test("AC-LR3: a round that raises nothing at all is SETTLED", () => {
    const r = localRoundReading([round(classA1), round()]);
    expect(r.decision).toBe(LOCAL_REVIEW_SETTLED);
    expect(r.round).toBe(2);
    expect(r.newClasses).toEqual([]);
    expect(runAnotherRound(r)).toBe(false);
  });

  /**
   * CONTROL-COUNT. The row a round-count-only cap fails.
   *
   * Round 2 of a cap of 3. A counter has budget left and says CONTINUE. The
   * reading has to say SETTLED, because the only thing this round produced is
   * a restatement of what round 1 already said — which is information about
   * the reviewer, not about the code.
   */
  test("CONTROL-COUNT: round 2, inside the cap, every finding a repeat — SETTLED, not CONTINUE", () => {
    const r = localRoundReading([round(classA1), round(classA2)], AI_REVIEW_ROUND_CAP);
    expect(r.round).toBe(2);
    expect(r.round).toBeLessThan(AI_REVIEW_ROUND_CAP);
    expect(
      r.decision,
      "a round-count-only cap returns CONTINUE here; that is the loop #1342 is about",
    ).toBe(LOCAL_REVIEW_SETTLED);
    expect(r.newClasses).toEqual([]);
    expect(r.repeats).toHaveLength(1);
    expect(r.repeats[0].keys).toContain("qty:38:findings");
    expect(runAnotherRound(r)).toBe(false);
  });

  test("AC-LR4: a new class inside the cap is CONTINUE and is named", () => {
    const r = localRoundReading([round(classA1), round(classA2, classB)], AI_REVIEW_ROUND_CAP);
    expect(r.decision).toBe(LOCAL_REVIEW_CONTINUE);
    expect(r.newClasses.map(f => f.title)).toEqual([classB.title]);
    expect(r.repeats.map(x => x.finding.title)).toEqual([classA2.title]);
  });

  /**
   * CONTROL-CARRY. The row a cap that silences fails.
   *
   * Round 5 of a cap of 3, and the round carries a class no earlier round
   * raised. The loop ends — five rounds that each found something is evidence
   * about the change, which is `atCapInstruction`'s reading and not disputed
   * here. What must NOT happen is the class disappearing with the loop: the
   * reading carries it out so the caller files it instead of pushing again.
   */
  test("CONTROL-CARRY: past the cap with a new class — AT_CAP, and the class survives the cap", () => {
    const rounds = [round(classA1), round(classA2), round(classA2), round(classA2), round(classB)];
    const r = localRoundReading(rounds, AI_REVIEW_ROUND_CAP);
    expect(r.round).toBe(5);
    expect(
      r.decision,
      "a class-aware rule with no cap returns CONTINUE here, which is the unbounded loop",
    ).toBe(LOCAL_REVIEW_AT_CAP);
    expect(
      r.newClasses.map(f => f.title),
      "a cap that silences returns no classes here, which is the truncation #1342 forbids",
    ).toEqual([classB.title]);
    expect(runAnotherRound(r)).toBe(false);
    expect(r.reason).toMatch(/file/i);
  });

  test("AC-LR5: past the cap with nothing new reads SETTLED, not AT_CAP", () => {
    // Both end the loop, and they mean opposite things: one says the review
    // converged, the other says it was cut off. A reading that collapsed them
    // would report every converged loop as a truncated one.
    const rounds = [round(classA1), round(classA2), round(classA2), round(classA2), round(classA2)];
    const r = localRoundReading(rounds, AI_REVIEW_ROUND_CAP);
    expect(r.round).toBe(5);
    expect(r.decision).toBe(LOCAL_REVIEW_SETTLED);
  });

  test("AC-LR6: the class rule only ever ENDS the loop sooner — it never outlives the cap", () => {
    // The invariant that keeps the two mechanisms from fighting. Every round
    // of a long run carries a brand-new class, which is the most favourable
    // input the class rule has; the cap still stops it.
    const novel = (n: number) => ({
      id: "new",
      title: `Finding ${n}`,
      body: `\`lib/module-${n}.ts\` \`handler${n}Value\` drops ${n * 11 + 17} of ${n * 13 + 23} rows.`,
    });
    for (let n = 1; n <= 8; n++) {
      const rounds = Array.from({ length: n }, (_, i) => round(novel(i + 1)));
      const r = localRoundReading(rounds, AI_REVIEW_ROUND_CAP);
      expect(r.decision, `round ${n}`).toBe(
        n <= AI_REVIEW_ROUND_CAP ? LOCAL_REVIEW_CONTINUE : LOCAL_REVIEW_AT_CAP,
      );
      expect(runAnotherRound(r), `round ${n}`).toBe(n <= AI_REVIEW_ROUND_CAP);
    }
  });

  test("AC-LR7: a finding too thin to key is never a repeat, and is reported", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`'s direction rule, and
    // `suppressRepeats`'s: a finding that cannot be shown to be a repeat is
    // kept. The cap is what stops the loop in that case, not the class rule.
    const thin = { id: "new", title: "it is wrong", body: "it is wrong" };
    const r = localRoundReading([round(thin), round(thin)], AI_REVIEW_ROUND_CAP);
    expect(r.decision).toBe(LOCAL_REVIEW_CONTINUE);
    expect(r.newClasses).toHaveLength(1);
  });

  describe("UNMEASURED — a reading that could not be taken is not a reading that cleared", () => {
    const cases: Array<[string, unknown]> = [
      ["not an array", { findings: [] }],
      ["no rounds at all", []],
      ["a round that is not an object", [null]],
      ["a round whose findings are not an array", [{ findings: "classA1" }]],
      ["a finding that is not an object", [{ findings: [classA1] }, { findings: ["x"] }]],
      ["a finding with no title and no body", [{ findings: [{ id: "new" }] }]],
    ];
    for (const [name, input] of cases) {
      test(`AC-LR8: ${name} is UNMEASURED`, () => {
        const r = localRoundReading(input, AI_REVIEW_ROUND_CAP);
        expect(r.decision).toBe(LOCAL_REVIEW_UNMEASURED);
        expect(r.reason).not.toBe("");
        expect(runAnotherRound(r)).toBe(false);
      });
    }
  });

  test("AC-LR9: an unreadable cap bounds the loop and still carries the class", () => {
    const r = localRoundReading([round(classA1), round(classB)], "three");
    expect(r.decision).toBe(LOCAL_REVIEW_AT_CAP);
    expect(r.newClasses.map(f => f.title)).toEqual([classB.title]);
  });
});

/* ── the history the loop keeps (#1421) ──────────────────────────────────── */

describe("the local-round history (#1421)", () => {
  test("AC-LR14: an absent history is ABSENT; every damaged one is UNREADABLE", () => {
    expect(parseHistory(null).status).toBe(LOCAL_HISTORY_ABSENT);
    expect(parseHistory("[]")).toEqual({ status: LOCAL_HISTORY_READ, rounds: [] });

    // Each of these yields "no rounds I can see" and none of them is a
    // reading.
    for (const damaged of ["", "   ", "not json", '{"rounds":[]}', '[{"at":"x"']) {
      const r = parseHistory(damaged);
      expect(r.status, JSON.stringify(damaged)).toBe(LOCAL_HISTORY_UNREADABLE);
      expect(r.status === LOCAL_HISTORY_UNREADABLE && r.reason.length > 0).toBe(true);
    }

    // THE EMPTY FILE IS ASSERTED ON ITS REASON, NOT ON ITS STATUS, AND THAT IS
    // THE WHOLE OF THIS BLOCK.
    //
    // Measured: a mutant that deletes `parseHistory`'s empty-file arm reddens
    // NOTHING on status alone, because `JSON.parse("")` throws and the catch
    // arm returns UNREADABLE for it anyway. Two deciders agreeing on one
    // input — `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape —
    // so the arm was behaviourally dead and a status assertion certified it
    // vacuously.
    //
    // It is kept rather than deleted because the two causes are different
    // facts for whoever reads the refusal: a file that exists holding nothing
    // is a write that was interrupted, and a syntax error is a file something
    // finished writing badly. That difference lives entirely in the text, so
    // the text is what is asserted — and the mutation is now observable.
    const empty = parseHistory("");
    expect(empty.status).toBe(LOCAL_HISTORY_UNREADABLE);
    expect(
      empty.status === LOCAL_HISTORY_UNREADABLE ? empty.reason : "",
      "the empty-file reading fell through to the JSON parse error, so it no longer says " +
        "which of the two causes it is and the dedicated arm is dead code",
    ).toMatch(/exists and is empty/);
  });

  test("AC-LR15: appendRound extends a read history and refuses an unreadable one", () => {
    const at = "2026-10-23T18:00:00.000Z";
    const onto = appendRound(parseHistory('[{"at":"a","findings":[]}]'), [classA1], at);
    expect("rounds" in onto).toBe(true);
    expect("rounds" in onto && onto.rounds).toHaveLength(2);
    expect("rounds" in onto && (onto.rounds[1] as { at: string }).at).toBe(at);

    const fresh = appendRound(parseHistory(null), [classA1], at);
    expect("rounds" in fresh && fresh.rounds).toHaveLength(1);

    // The refusal, and the direction it protects: replacing an unreadable
    // history with a fresh array destroys the count at the moment nothing can
    // tell that it happened.
    const refused = appendRound(parseHistory("not json"), [classA1], at);
    expect("refusal" in refused).toBe(true);
  });

  test("AC-LR16: localHistoryPath refuses a repo or a number it cannot read", () => {
    const base = mkdtempSync(join(tmpdir(), "rg1421-path-"));
    const prior = process.env.RUNGATE_LOCAL_REVIEW_HISTORY;
    process.env.RUNGATE_LOCAL_REVIEW_HISTORY = base;
    try {
      const ok = localHistoryPath("hornjason/pai-harness", 1414);
      // The control: the function resolves at all. Without it the refusal
      // rows below are satisfied by a function that returns null always.
      expect(ok, "localHistoryPath resolves nothing, so the refusals below say nothing").not.toBeNull();
      expect(ok!.startsWith(base)).toBe(true);
      expect(ok).toContain("pr-1414");
      expect(localHistoryPath("hornjason/pai-harness", "1414")).toBe(ok);

      for (const [repo, pr] of [
        ["", 1414],
        ["not-a-slug", 1414],
        ["hornjason/pai-harness", 0],
        ["hornjason/pai-harness", -3],
        ["hornjason/pai-harness", "0x10"],
        ["hornjason/pai-harness", "nine"],
        ["hornjason/pai-harness", 1.5],
      ] as Array<[string, unknown]>) {
        expect(localHistoryPath(repo, pr), `${repo} #${String(pr)}`).toBeNull();
      }
    } finally {
      if (prior === undefined) delete process.env.RUNGATE_LOCAL_REVIEW_HISTORY;
      else process.env.RUNGATE_LOCAL_REVIEW_HISTORY = prior;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("AC-LR17: two pull requests do not share a history", () => {
    const base = mkdtempSync(join(tmpdir(), "rg1421-two-"));
    const prior = process.env.RUNGATE_LOCAL_REVIEW_HISTORY;
    process.env.RUNGATE_LOCAL_REVIEW_HISTORY = base;
    try {
      expect(localHistoryPath("hornjason/pai-harness", 1)).not.toBe(
        localHistoryPath("hornjason/pai-harness", 2),
      );
      expect(localHistoryPath("a/b", 1)).not.toBe(localHistoryPath("c/d", 1));
    } finally {
      if (prior === undefined) delete process.env.RUNGATE_LOCAL_REVIEW_HISTORY;
      else process.env.RUNGATE_LOCAL_REVIEW_HISTORY = prior;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* ── the CLI, and the removal of its refusal ─────────────────────────────── */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "local-review-round.ts");
const source = readFileSync(SCRIPT, "utf-8");

let SANDBOX = "";
let MUTANT = "";
let REAL = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "rg1342-"));
  // The script imports from lib/, so the mutant cannot run from a bare temp
  // directory the way `scripts/rook-review-scope.ts`'s does — a mutant that
  // dies on module resolution exits non-zero and reads as "the mutation was
  // rejected on the merits" (`.claude/rules/self-referential-tests.md`, the
  // last Tier 1 row). The copier therefore carries lib/ with it, and every
  // case below asserts the mutant PRINTED A DECISION as well as exiting 0 —
  // an exit code alone cannot tell a mutant that ran from one that never
  // loaded.
  cpSync(join(REPO_ROOT, "lib"), join(SANDBOX, "lib"), { recursive: true });
  mkdirSync(join(SANDBOX, "scripts"), { recursive: true });

  REAL = join(SANDBOX, "scripts", "local-review-round.ts");
  writeFileSync(REAL, source);

  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/local-review-round.ts");
  }
  MUTANT = join(SANDBOX, "scripts", "local-review-round.mutant.ts");
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

function run(script: string, rounds: unknown, extra: string[] = []) {
  const file = join(SANDBOX, `rounds-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(rounds));
  // `env` is explicit because this file writes `RUNGATE_LOCAL_REVIEW_HISTORY`
  // and Bun does not pass a late `process.env` write to a child spawned
  // without one (#1096). These cases use `--rounds` and never resolve a
  // history path, so today the child does not read it — which is exactly the
  // reasoning that stops being true the first time someone adds a `--pr`
  // case here, so the env is passed rather than the exemption claimed.
  const r = spawnSync("bun", [script, "--rounds", file, ...extra], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  rmSync(file, { force: true });
  let decision: string | null = null;
  try {
    decision = JSON.parse(r.stdout ?? "").decision ?? null;
  } catch {
    decision = null;
  }
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "", decision };
}

describe("scripts/local-review-round.ts", () => {
  test("AC-LR10: REFUSE_EXIT is declared exactly once, so no refusal can bypass the mutation", () => {
    expect(source.match(/REFUSE_EXIT\s*=\s*1\b/g) ?? []).toHaveLength(1);
    expect(
      source.match(/process\.exit\(\s*\d/g) ?? [],
      "a literal exit code sidesteps the mutant and the case guarding it certifies nothing",
    ).toEqual([]);
  });

  test("AC-LR11: CONTINUE exits 0 and prints the reading", () => {
    const r = run(REAL, [round(classA1)]);
    expect(r.code, r.err).toBe(0);
    expect(r.decision).toBe(LOCAL_REVIEW_CONTINUE);
  });

  const refusals: Array<[string, unknown, string]> = [
    ["a settled loop", [round(classA1), round(classA2)], LOCAL_REVIEW_SETTLED],
    [
      "a loop past its cap",
      [round(classA1), round(classA2), round(classA2), round(classB)],
      LOCAL_REVIEW_AT_CAP,
    ],
    ["an unreadable rounds file", { findings: [] }, LOCAL_REVIEW_UNMEASURED],
  ];

  for (const [name, rounds, expected] of refusals) {
    test(`AC-LR12: ${name} refuses another round, and the refusal is what is observed`, () => {
      const real = run(REAL, rounds);
      expect(real.code, `expected a refusal\n${real.err}`).not.toBe(0);
      expect(real.decision).toBe(expected);

      const mutant = run(MUTANT, rounds);
      expect(
        mutant.code,
        `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} — this case is not ` +
          `being caught by the refusal under test.\n${mutant.err}`,
      ).toBe(0);
      expect(
        mutant.decision,
        "the mutant printed no decision, so it never reached the mechanism — an exit of 0 " +
          "from a mutant that failed to load would otherwise read as the refusal being removed",
      ).toBe(expected);
    });
  }

  test("AC-LR13: a missing --rounds file is UNMEASURED and refuses", () => {
    const r = spawnSync("bun", [REAL, "--rounds", join(SANDBOX, "does-not-exist.json")], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stdout ?? "").decision).toBe(LOCAL_REVIEW_UNMEASURED);
  });
});
