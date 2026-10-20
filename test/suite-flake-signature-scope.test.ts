/**
 * #799 — a `CONSISTENT` verdict reads as "one set of inputs", and it is not.
 *
 * `treeSignatureKey` is HEAD plus `git status --porcelain`. That is the right
 * reading for state inside the repository and says nothing about anything
 * else, so a series can report one tree across every run while the inputs to
 * the suite move underneath it.
 *
 * Not a worry — a measurement. Series `39412289321` reported ten runs over
 * one tree with `reasons: []`, correctly, while `test/phase-0.test.ts`
 * collected its test list from a `/tmp` fixture the PREVIOUS run had left:
 *
 * ```
 * run  1   15194 tests   807 todo   24 skip
 * run  2   15250 tests   863 todo   23 skip   (…through run 10)
 * ```
 *
 * The series was not wrong. It was narrower than the sentence it printed.
 *
 * ## Why this is a field and not a comment
 *
 * `flake.json` is what somebody reads months later, and `.claude/rules/checks-must-be-able-to-fail.md`
 * is explicit that silence is indistinguishable from success. A caveat living
 * only in a console line is a caveat the artefact does not carry, so
 * `signatureScope` is part of `FlakeReading` and the printed line is a
 * projection of it. One binding, so there is one thing to mutate.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Print the caveat once, beside `CONSISTENT`, where the problem showed
 * up.** It is the natural place — that is the verdict that misled — and it
 * is wrong, because a reader who sees the scope only on clean series will
 * reasonably infer the other three verdicts looked harder. They did not: it
 * is the same comparison in all four cases. `AC-1` drives all four and is red
 * under that repair (row R4).
 *
 * ## What this does NOT do
 *
 * It does not widen the signature. Signing `/tmp`, `~/.rungate` and
 * `node_modules` is a different and much larger question — what to hash, how
 * long it takes, and whether a series should refuse on a change it cannot
 * attribute. This states the boundary; moving it is separate work.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file alone (5 tests). Counts predicted in
 * `/tmp/799s-battery/predictions.md` before the battery ran, and **the
 * baseline row read first.**
 *
 * | Row | Predicted | Measured | Which cases | The input on which mutant and original differ |
 * |---|---|---|---|---|
 * | **baseline** — unmutated | read first | **5 pass, 0 fail** | — | — |
 * | R1 `signatureScope` set to `""` at both return sites | 3 | **3 of 5** | AC-1, AC-3, AC-5 | any series: the reading carries no scope and the line reads `Scope: ` |
 * | R2 `SIGNATURE_SCOPE` itself emptied | 4 | **4 of 5** | AC-1, AC-2, AC-3, AC-5 | the same, plus the constant's own case — the row that says the constant is the single declaring position |
 * | R3 the `Scope:` line dropped from `describeFlakeReading` | 2 | **3 of 5** | AC-1, AC-4, AC-5 | any series: the FIELD survives, so AC-3 stays green and only the rendered half goes red |
 * | R4 **the cheapest wrong fix** — scope rendered for `CONSISTENT` only | 2 | **3 of 5** | AC-1, AC-4, AC-5 | a FLAKY, FAILING or UNMEASURED series, which is the half that repair leaves silent |
 *
 * ### R2 came back 2 on the first attempt, and that is the finding
 *
 * Predicted 4, measured **2** — AC-3 and AC-5 stayed green over a constant
 * that said nothing. Both were comparing the subject to `SIGNATURE_SCOPE`
 * itself: `expect(artefact.signatureScope).toBe(SIGNATURE_SCOPE)` is true
 * when both are `""`, and `endsWith("")` is true of every string. That is
 * #530's artifact trap in miniature — *when an artifact is your evidence,
 * ask what it would say if the thing were absent* — and the vacuous-
 * assertion shape at the same time.
 *
 * Both now compare against a LITERAL as well, and the row is 4. Nothing in
 * the diff showed it; only the count disagreeing with the prediction did.
 *
 * ### R1 and R3 are both 3, and that is NOT a collapsed pair
 *
 * The prediction note said R1 must be strictly greater than R3, on the
 * reasoning that the field and the printed line are a value and a
 * projection. They are — R1 reds **AC-3** and R3 reds **AC-4** — and the
 * counts coincide anyway. The note's test was on the number when the
 * property is the MEMBERSHIP, which is #532's lesson arriving in the
 * prediction rather than in the case: *when a row is about a collection,
 * ask whether the defect changes the number or only which names are in it.*
 *
 * R3 and R4 red the same three cases, which is expected: they are two
 * mutations of one decider, not two deciders.
 *
 * None of the four mutations is left in the tree; all were run and reverted
 * from a `cp` backup, never `git checkout --`, and `lib/suite-flake.ts` was
 * confirmed byte-identical by sha256 afterwards — before the battery at
 * `9c04b70b…` and after it at the same hash.
 */
import { describe, expect, test } from "bun:test";

import {
  SIGNATURE_SCOPE,
  describeFlakeReading,
  flakeReading,
  type FlakeRun,
  type FlakeVerdict,
  type TreeSignature,
} from "../lib/suite-flake";
import { readSuiteRun } from "../lib/suite-run-reading";

const TREE: TreeSignature = { head: "0e9b4b3f", dirty: [] };
const CLEAN: FlakeRun["exit"] = { status: 0, signal: null, error: null };

function summary(pass: number, fail: number): string {
  return [
    "bun test v1.3.14 (d1632b29)",
    ` ${pass} pass`,
    ` ${fail} fail`,
    " 9 expect() calls",
    `Ran ${pass + fail} tests across 1 file. [1.00s]`,
  ].join("\n");
}

function run(index: number, pass: number, fail: number, exit = CLEAN): FlakeRun {
  return {
    index,
    signature: TREE,
    run: readSuiteRun(summary(pass, fail)),
    log: `run-${index}.log`,
    seconds: 1,
    exit,
  };
}

/** One series per verdict, so the claim below is about all four and not one. */
const SERIES: Array<[FlakeVerdict, FlakeRun[], number]> = [
  ["CONSISTENT", [run(1, 3, 0), run(2, 3, 0)], 2],
  ["FLAKY", [run(1, 3, 0), run(2, 2, 1)], 2],
  ["FAILING", [run(1, 2, 1), run(2, 2, 1)], 2],
  ["UNMEASURED", [run(1, 3, 0, { status: null, signal: "SIGTERM", error: null }), run(2, 3, 0)], 2],
];

describe("#799: a series says what its tree signature covered", () => {
  test("AC-1: every verdict carries the scope, in the reading and in the sentence", () => {
    for (const [expected, runs, minimum] of SERIES) {
      const reading = flakeReading(runs, minimum);

      // The premise, asserted rather than assumed. A fixture that produced
      // the wrong verdict would still satisfy the scope assertions below
      // while measuring nothing about the verdict it claims to cover.
      expect(reading.verdict, `the ${expected} fixture did not produce ${expected}`).toBe(expected);

      expect(reading.signatureScope, `${expected} carries no scope`).toBe(SIGNATURE_SCOPE);

      const said = describeFlakeReading(reading);
      expect(said, `${expected} prints no scope`).toContain("Scope:");
      expect(said, `${expected} prints an empty scope`).toContain("git status --porcelain");
    }
  });

  test("AC-2: the scope says what the signature IS and names what it misses", () => {
    // The control. An empty string is carried by every case above and
    // satisfies none of the point — `toContain("")` is true of anything,
    // which is the vacuous-assertion shape this repository keeps producing.
    expect(SIGNATURE_SCOPE.length).toBeGreaterThan(80);
    expect(SIGNATURE_SCOPE).toContain("git status --porcelain");
    expect(SIGNATURE_SCOPE, "the scope does not name a location outside the working tree").toContain("/tmp");
    expect(SIGNATURE_SCOPE, "the scope does not cite the series that demonstrated it").toContain("#799");
  });

  test("AC-3: the scope is in the reading, so the artefact carries it", () => {
    // `scripts/suite-flake-run.ts` writes `reading` into flake.json verbatim.
    // A caveat that exists only in the console line is absent from the file
    // anybody reads afterwards, which is the state #323's own logs were in.
    const reading = flakeReading([run(1, 3, 0), run(2, 3, 0)], 2);
    const artefact = JSON.parse(JSON.stringify(reading)) as Record<string, unknown>;
    expect(Object.keys(artefact)).toContain("signatureScope");
    expect(artefact.signatureScope).toBe(SIGNATURE_SCOPE);
    // Compared to a LITERAL as well as to the constant. Comparing only to
    // the constant is the artifact trap (#530) in miniature: emptying
    // SIGNATURE_SCOPE makes both sides agree, and the measured battery row
    // for that mutation came back 2 instead of 4 because of this line.
    expect(String(artefact.signatureScope)).toContain("git status --porcelain");
  });

  test("AC-4: a short series still says what was compared", () => {
    // The verdict a reader is most likely to dismiss, so the one most worth
    // carrying the boundary.
    const reading = flakeReading([run(1, 3, 0)], 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(describeFlakeReading(reading)).toContain("Scope:");
  });

  test("AC-5: the scope does not displace the reasons or the spread", () => {
    // Appending a line is the kind of change that quietly truncates the
    // thing it is appended to, and nothing else in the file would notice.
    const reading = flakeReading([run(1, 3, 0), run(2, 2, 1)], 2);
    const said = describeFlakeReading(reading);
    expect(said).toContain("FLAKY:");
    expect(said).toContain("run 2");
    expect(said).toContain("expect() calls");
    // `endsWith(SIGNATURE_SCOPE)` alone is TRUE of every string when the
    // constant is empty, which is the vacuous-assertion shape. The last line
    // is asserted by its own content, not by the value it is supposed to
    // carry.
    const last = said.trimEnd().split("\n").at(-1) ?? "";
    expect(last.startsWith("Scope: ")).toBe(true);
    expect(last).toContain("git status --porcelain");
    expect(said.trimEnd().endsWith(SIGNATURE_SCOPE)).toBe(true);
  });
});
