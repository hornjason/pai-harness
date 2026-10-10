/**
 * ship.js's inlined suite-currency copy and lib/suite-measurement.ts agree (#224)
 *
 * Run `wf_7ac5f614-d21` reported `{"status":"SHIPPED","regressions":0}` for
 * issue #209. The same branch, checked out and run, gave 3984 pass / 1 fail —
 * and the failing test was #149's own guard, which had caught the regression,
 * named it and pointed at the file. Detection was never the gap. The number
 * the run reported did not come from the tree the run was shipping.
 *
 * The fix binds the suite result to the commit it was measured against, which
 * means a currency comparison, which means the #69 problem: `workflows/ship.js`
 * runs in a sandbox with no module loading, so it cannot import the library it
 * is supposed to share behaviour with. It carries an INLINED COPY inside
 * `SUITE-CURRENCY` markers instead.
 *
 * Two copies of a refusal rule is a defect waiting for one of them to drift,
 * and the drift is silent: the library has tests, the copy ship.js actually
 * runs has none, and the first anyone learns of a divergence is a run that
 * shipped. This file is the thing that makes the duplication safe — it
 * EXTRACTS THE COPY BY MARKER, EXECUTES IT, and runs both over one input
 * matrix. Same technique as test/security-verdict-blocks.test.ts, for the same
 * reason: PROJECT-STATE.md records that every mutation surviving a first pass
 * in this repo has been a source-text assertion, and "ship.js contains the word
 * STALE" stays true after the comparison is deleted.
 *
 * WHAT WAS BROKEN TO PROVE THIS FAILS (.claude/rules/checks-must-be-able-to-fail.md):
 * the last describe builds a mutant of the real block on every run — the STALE
 * branch's comparison is forced true, so a measurement from another commit
 * reads as CURRENT — and asserts the matrix catches it while the real block
 * passes. The mutant builder throws when its substitution changes nothing, so a
 * renamed or restructured block aborts this file rather than passing it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const LIB_PATH = join(REPO_ROOT, "lib", "suite-measurement.ts");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const START = "// ──── SUITE-CURRENCY-START ────";
const END = "// ──── SUITE-CURRENCY-END ────";

type Currency = { state: string; reason: string | null };
type CurrencyFn = (measuredSha: unknown, headSha: unknown) => Currency;

/**
 * Module scope on purpose. If the markers go missing, this throws while the
 * file is loading and every test below fails to run. Resolving it lazily and
 * skipping when absent would turn "ship.js lost its suite-currency check" into
 * a quiet green run.
 */
const BLOCK: string = (() => {
  const start = shipSource.indexOf(START);
  const end = shipSource.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(
      `workflows/ship.js is missing the ${START} / ${END} markers — ` +
        "there is no inlined suite-currency copy to compare against the library",
    );
  }
  return shipSource.slice(start, end);
})();

/**
 * Compile one extracted block and hand back its `suiteCurrency`.
 *
 * `new Function` over this repository's own workflows/ship.js, read at test
 * time — the same trust boundary as importing it, which the Workflow sandbox
 * makes impossible (#69). Never give it a source from elsewhere.
 *
 * Compiling is itself an assertion: the copy has to be self-contained. A
 * reference to any name declared outside the markers throws here, which is the
 * property that keeps the block extractable at all.
 */
function loadCurrency(block: string): CurrencyFn {
  const fn = new Function(`${block}\nreturn suiteCurrency`)();
  if (typeof fn !== "function") {
    throw new Error("the SUITE-CURRENCY block does not define suiteCurrency");
  }
  return fn as CurrencyFn;
}

const inlined = loadCurrency(BLOCK);

const SHA = "3192a75c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f7";
const SHORT = "3192a75";
/** A different real commit — the #164 branch tip. */
const OTHER = "ef998b73c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f";

/**
 * The matrix both copies are driven over.
 *
 * Every branch of the rule appears, plus the shapes a value crossing an agent
 * boundary actually arrives as. `measuredSha` is read out of workflow-state.json
 * by an agent and `headSha` comes from `git rev-parse`, so either may be short,
 * upper-cased, padded, empty, absent, or not a string at all.
 */
const MATRIX: ReadonlyArray<readonly [unknown, unknown, string]> = [
  [SHA, SHA, "CURRENT"],
  [SHORT, SHA, "CURRENT"],
  [SHA, SHORT, "CURRENT"],
  [SHA.toUpperCase(), SHA, "CURRENT"],
  [`  ${SHA}  `, SHA, "CURRENT"],
  [SHA, `${SHA}\n`, "CURRENT"],

  [SHA, OTHER, "STALE"],
  [SHORT, OTHER, "STALE"],
  [OTHER, SHA, "STALE"],
  [SHA, "ef998b7", "STALE"],

  [undefined, SHA, "UNRECORDED"],
  [null, SHA, "UNRECORDED"],
  ["", SHA, "UNRECORDED"],
  ["not-a-sha", SHA, "UNRECORDED"],
  ["123456", SHA, "UNRECORDED"],
  ["g".repeat(40), SHA, "UNRECORDED"],
  [`${SHA}f`, SHA, "UNRECORDED"],
  [42, SHA, "UNRECORDED"],
  [{}, SHA, "UNRECORDED"],
  [[], SHA, "UNRECORDED"],
  [["a"], SHA, "UNRECORDED"],
  [true, SHA, "UNRECORDED"],

  [SHA, undefined, "UNRECORDED"],
  [SHA, null, "UNRECORDED"],
  [SHA, "", "UNRECORDED"],
  [SHA, "HEAD", "UNRECORDED"],
  [SHA, {}, "UNRECORDED"],
  [undefined, undefined, "UNRECORDED"],
] as const;

function show(v: unknown): string {
  if (typeof v === "string") return `'${v}'`;
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Run one implementation over the matrix and return a comparable transcript.
 *
 * A transcript rather than a pile of `expect`s so the mutation tests below can
 * drive the SAME routine over a mutated block and observe it diverge. A
 * mutation test with its own private copy of the rule would be agreeing with
 * something production never runs.
 */
function transcript(fn: CurrencyFn): string[] {
  return MATRIX.map(([measured, head]) => {
    let out: Currency;
    try {
      out = fn(measured, head);
    } catch (e) {
      // Recorded, not rethrown. A throw is itself a divergence worth seeing in
      // the diff: this decides whether a run may ship, and a throw is a
      // refusal the caller's error handling could turn back into a ship.
      return `${show(measured)} vs ${show(head)} => THREW ${e instanceof Error ? e.message : String(e)}`;
    }
    return `${show(measured)} vs ${show(head)} => ${out?.state} | ${out?.reason ?? "null"}`;
  });
}

// ── The matrix is real, and the copy ship.js runs obeys the rule ────────────

describe("#224: the inlined suite-currency copy", () => {
  test("the matrix exercises every state — otherwise agreement is vacuous", () => {
    const states = new Set(MATRIX.map(([, , expected]) => expected));
    expect([...states].sort()).toEqual(["CURRENT", "STALE", "UNRECORDED"]);
    expect(MATRIX.length).toBeGreaterThan(20);
  });

  test("each matrix row reaches the state it names", () => {
    const wrong = MATRIX.filter(([measured, head, expected]) => {
      const got = inlined(measured, head);
      return got?.state !== expected;
    }).map(([measured, head, expected]) =>
      `${show(measured)} vs ${show(head)}: expected ${expected}, got ${inlined(measured, head)?.state}`);
    expect(wrong).toEqual([]);
  });

  test("a CURRENT reading carries no reason, and every other reading carries one", () => {
    // `reason` is read by the refusal path. A truthiness check on it must not
    // be able to refuse a good run, and a refusal must never be reasonless.
    for (const [measured, head] of MATRIX) {
      const got = inlined(measured, head);
      if (got.state === "CURRENT") {
        expect(got.reason, `${show(measured)} vs ${show(head)} is CURRENT with a reason`).toBeNull();
      } else {
        expect(
          typeof got.reason === "string" && got.reason.length > 0,
          `${show(measured)} vs ${show(head)} is ${got.state} with no reason`,
        ).toBe(true);
      }
    }
  });

  test("a STALE refusal names both commits (AC: the message names both)", () => {
    const { state, reason } = inlined(SHA, OTHER);
    expect(state).toBe("STALE");
    expect(reason).toContain(SHA);
    expect(reason).toContain(OTHER);
  });

  test("nothing in the matrix throws — this decides whether a run may ship", () => {
    expect(transcript(inlined).filter(line => line.includes("=> THREW"))).toEqual([]);
  });
});

// ── The agreement itself ────────────────────────────────────────────────────

describe("#224: ship.js's copy and lib/suite-measurement.ts agree", () => {
  test("the library exists — the copy has a source of truth to agree with", () => {
    expect(
      existsSync(LIB_PATH),
      `lib/suite-measurement.ts is missing. ship.js carries an inlined copy of it ` +
        `inside ${START}, and with no library there is nothing holding that copy to ` +
        `a tested rule.`,
    ).toBe(true);
  });

  test("both copies produce an identical transcript over the matrix", async () => {
    const mod = (await import(LIB_PATH)) as { suiteCurrency?: unknown };
    expect(
      typeof mod.suiteCurrency,
      "lib/suite-measurement.ts does not export suiteCurrency — the copy in " +
        "ship.js has nothing to be compared against",
    ).toBe("function");

    const library = mod.suiteCurrency as CurrencyFn;
    expect(transcript(inlined)).toEqual(transcript(library));
  });
});

// ── The copy is actually the thing ship.js runs ─────────────────────────────

describe("#224: the refusal path uses the extracted block", () => {
  test("ship.js calls suiteCurrency rather than comparing SHAs inline", () => {
    // Without this the block could be correct, unused, and the shipped
    // behaviour unchanged — a test of a function production does not call.
    const afterBlock = shipSource.slice(shipSource.indexOf(END));
    expect(afterBlock).toContain("suiteCurrency(");
  });

  test("the library is not imported — the sandbox has no module loading (#69)", () => {
    // A top-level require() here killed every ship run before it spawned an
    // agent. The inlined copy exists because of that, so an import creeping
    // back in is a regression even though it would make this file greener.
    //
    // Naming the library in a comment is the opposite — it is how a reader
    // finds the source of truth — so this matches the loading forms only.
    const loads = [
      /require\(\s*['"][^'"]*suite-measurement/,
      /from\s+['"][^'"]*suite-measurement/,
      /import\(\s*['"][^'"]*suite-measurement/,
    ].filter(re => re.test(shipSource)).map(String);
    expect(loads).toEqual([]);
  });
});

// ── The measurement is written by the recorder, not by an agent ────────────

describe("#224: the suite result reaches state through the recorder", () => {
  /** The tests-pass remediation text, which is where the suite gets run. */
  const testsPassStep = (() => {
    const at = shipSource.indexOf("For tests-pass:");
    expect(at, "ship.js has no tests-pass remediation step").toBeGreaterThan(-1);
    return shipSource.slice(at, at + 1200);
  })();

  test("the step runs scripts/record-suite-measurement.ts", () => {
    expect(testsPassStep).toContain("scripts/record-suite-measurement.ts");
  });

  test("the step does not tell an agent to write environments.local.tests", () => {
    // The whole reason a recorder exists. A hand-written verdict has no commit
    // beside it, and gates/SCHEMA-GUIDE.md forbids writing workflow-state.json
    // with anything that skips Zod — an invalid value has to fail at the write
    // rather than as an opaque gate failure later.
    expect(testsPassStep).not.toContain("write result to environments.local.tests");
    expect(testsPassStep).not.toContain("environments.local.tests =");
  });

  test("the recorder is not handed a SHA the prompt chose", () => {
    // The measured commit has to come from the tree, not from a value an agent
    // typed — a SHA an agent supplies can agree with HEAD by construction,
    // which is the comparison quietly answering itself.
    expect(testsPassStep).not.toMatch(/record-suite-measurement\.ts[\s\S]{0,400}--sha/);
  });

  test("the suite reading is read back beside the security review", () => {
    // Both halves of "is this evidence about this commit" are decided at the
    // same point, from values re-read there rather than carried.
    const probe = shipSource.slice(
      shipSource.indexOf("// ──── REVIEW-CURRENCY-PROBE-START ────"),
      shipSource.indexOf("// ──── REVIEW-CURRENCY-PROBE-END ────"),
    );
    expect(probe, "ship.js has no review-currency probe").not.toBe("");
    expect(probe).toContain("environments.local.tests");
    expect(probe).toContain("suiteMeasuredSha");
  });

  test("a stale measurement is a refusal, not a log line", () => {
    const decision = shipSource.slice(
      shipSource.indexOf("// ──── SUITE-DECISION-START ────"),
      shipSource.indexOf("// ──── SUITE-DECISION-END ────"),
    );
    expect(decision, "ship.js has no suite decision block").not.toBe("");
    expect(decision).toContain("SUITE_MEASUREMENT_STALE");
    // `shipFailed` is the only producer of a SHIP_FAILED status in ship.js
    // (#252) — the count is asserted in test/ship-failure-report.test.ts — so
    // a `return shipFailed(` here is a refusal and nothing else is.
    expect(decision).toContain("return shipFailed(");
  });

  test("the refusal happens before the PR step", () => {
    // Same structural guard the #169 staleness check uses: the PR step is far
    // below and cannot be stubbed into an extracted block, so assert the
    // refusal comes first in the file.
    const refusal = shipSource.indexOf("SUITE_MEASUREMENT_STALE");
    const prStep = shipSource.indexOf("record-env-and-pr");
    expect(refusal, "ship.js has no SUITE_MEASUREMENT_STALE refusal").toBeGreaterThan(-1);
    expect(prStep).toBeGreaterThan(-1);
    expect(refusal, "the suite staleness check happens after the PR is opened").toBeLessThan(prStep);
  });
});

// ── The agreement is proven to be able to fail ──────────────────────────────

describe("#224: mutation — the matrix refuses a drifted copy", () => {
  /**
   * Build a mutant copy of the block and compile it.
   *
   * Throws when the substitution changes nothing, the way
   * test/rook-review-scope.test.ts and test/ship-status-vocabulary.test.ts do:
   * a mutation harness that silently no-ops when its target is renamed is the
   * decorative check .claude/rules/checks-must-be-able-to-fail.md is about.
   */
  function mutate(pattern: RegExp, replacement: string): CurrencyFn {
    const mutated = BLOCK.replace(pattern, replacement);
    if (mutated === BLOCK) {
      throw new Error(
        `could not build the mutant: ${pattern} matched nothing in the SUITE-CURRENCY block`,
      );
    }
    return loadCurrency(mutated);
  }

  test("the real block is the control", () => {
    expect(inlined(SHA, OTHER).state).toBe("STALE");
    expect(inlined(SHA, SHA).state).toBe("CURRENT");
  });

  test("a mutant that stops comparing the two SHAs is caught", () => {
    // The exact #224 defect expressed as a code change: the count is accepted
    // whatever commit it was measured against.
    const mutant = mutate(/measured\.startsWith\(head\)/, "true");

    // The mutation, observed rather than asserted.
    expect(mutant(SHA, OTHER).state).toBe("CURRENT");
    expect(transcript(mutant)).not.toEqual(transcript(inlined));
  });

  test("a mutant that treats a missing SHA as current is caught", () => {
    // "We could not measure it" becoming "it passed" is the #129 fail-open,
    // and it is the half of this rule that does not look like a bug.
    // The FIRST UNRECORDED is the no-measured-SHA branch — the count-with-no-
    // SHA case the issue names in those words.
    const mutant = mutate(/state: 'UNRECORDED',/, "state: 'CURRENT',");

    expect(mutant(undefined, SHA).state).toBe("CURRENT");
    expect(transcript(mutant)).not.toEqual(transcript(inlined));
  });
});
