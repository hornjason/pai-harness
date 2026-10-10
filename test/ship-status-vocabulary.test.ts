/**
 * The vocabulary of statuses a finished ship run reports (#222)
 *
 * SC-611..SC-614 (HARNESS-STANDARD.md)
 *
 * Two defects in one line. `workflows/ship.js` ended with
 *
 *   status: proveVerdict === 'PROVEN' ? 'SHIPPED_AND_PROVEN'
 *         : proveVerdict === 'SKIP'   ? 'SHIPPED'
 *         : 'SHIP_PASSED_PROVE_FAILED'
 *
 * so (a) `SKIP` — "prove did not run, nothing was proved" — produced the only
 * unqualified success word in the system, and (b) that word was a strict
 * prefix of `SHIPPED_AND_PROVEN`, which matters because every reader of a ship
 * result in this repo is a substring match: `test/ship-and-heal.test.ts`
 * asserts `afterClean` contains `SHIPPED` and does NOT contain `SHIPPED_WITH`,
 * and `lib/promote-outputs.ts` does `["DONE","SHIPPED","PROVEN"].includes(...)`.
 * A status that is a prefix of another is a status that can be read as the
 * other one.
 *
 * The premise underneath both: the harness never merges. The work is pushed to
 * its own branch and a PR is opened (#136 removed the auto-merge outright), so
 * nothing this return value can say means "landed on main".
 *
 * The block is EXTRACTED BY MARKER AND EXECUTED, not grepped. PROJECT-STATE.md
 * records that EVERY mutation surviving a first pass in this repo has been a
 * source-text assertion — "ship.js contains SHIPPED_UNPROVEN" stays true after
 * the map is reduced to `return 'SHIPPED_AND_PROVEN'`, which is the exact
 * failure this file exists to rule out. Same pattern as
 * test/ship-collect-destination.test.ts and test/security-verdict-blocks.test.ts;
 * the mutant harness below is the one from test/rook-review-scope.test.ts.
 *
 * WHAT WAS BROKEN TO PROVE THESE FAIL (.claude/rules/checks-must-be-able-to-fail.md):
 * the two mutants in the last describe are not prose — they are built here, on
 * every run, from the real block, and each asserts the real map is clean while
 * the mutated one is not. Pointing `PROVEN` at the SKIP status turns the
 * property red; restoring the bare `SHIPPED` for SKIP turns it red for the
 * prefix reason instead. Both mutant builders throw if their substitution
 * changes nothing, so a renamed map aborts this file rather than passing it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const START = "// ──── PROVE-STATUS-START ────";
const END = "// ──── PROVE-STATUS-END ────";

/**
 * Module scope on purpose: if the markers go missing, this throws while the
 * file is loading and every test below fails to run. Resolving it lazily and
 * skipping when absent would turn "ship.js lost its status map" into a quiet
 * green run.
 */
const BLOCK: string = (() => {
  const start = shipSource.indexOf(START);
  const end = shipSource.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(
      `workflows/ship.js is missing the ${START} / ${END} markers — ` +
        "there is no status map to execute",
    );
  }
  return shipSource.slice(start, end);
})();

type StatusFor = (verdict: unknown) => unknown;

/**
 * Compile one extracted block and hand back its `shipStatusFor`.
 *
 * `new Function` over this repository's own workflows/ship.js, read at test
 * time — the same trust boundary as importing it, which the Workflow sandbox
 * makes impossible (#69). Never give it a source from elsewhere.
 */
function loadStatusFor(block: string): StatusFor {
  const fn = new Function(`${block}\nreturn shipStatusFor`)();
  if (typeof fn !== "function") {
    throw new Error("the PROVE-STATUS block does not define shipStatusFor");
  }
  return fn as StatusFor;
}

const statusFor = loadStatusFor(BLOCK);

/** The one verdict that means the fix was demonstrated. */
const PROVEN = "PROVEN";

/**
 * Everything else a prove verdict can be by the time it reaches the map.
 *
 * `SKIP` and `UNPROVEN` are the two ship.js produces today. The rest are the
 * shapes a map lookup fails on in interesting ways — object-prototype keys
 * return a truthy non-string from a bare `obj[key]`, and whitespace/case
 * variants are what a future caller gets wrong. None of them is PROVEN, so
 * none of them may answer with PROVEN's status.
 */
const NOT_PROVEN: readonly unknown[] = [
  "SKIP",
  "UNPROVEN",
  "INCONCLUSIVE",
  "",
  "proven",
  "PROVEN ",
  " PROVEN",
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  undefined,
  null,
  0,
  {},
  [],
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
 * The property, as a list of problems rather than an assertion.
 *
 * Returning the violations instead of calling `expect` is what lets the mutant
 * tests run the SAME check against a mutated map and observe it go non-empty.
 * A mutation test with its own private copy of the rule would agree with a map
 * production never uses.
 */
function vocabularyViolations(fn: StatusFor): string[] {
  const problems: string[] = [];

  const proven = fn(PROVEN);
  if (typeof proven !== "string" || proven.length === 0) {
    // Everything below compares against this, so there is nothing to say yet.
    return [`a PROVEN verdict produced ${show(proven)}, which is not a status`];
  }

  const produced = new Set<string>([proven]);
  for (const verdict of NOT_PROVEN) {
    const status = fn(verdict);
    if (typeof status !== "string" || status.length === 0) {
      problems.push(`the verdict ${show(verdict)} produced ${show(status)}, which is not a status`);
      continue;
    }
    if (status === proven) {
      problems.push(
        `the verdict ${show(verdict)} produces ${status}, the same status a PROVEN ` +
          "verdict produces — an unproven run is reporting a proven one's result",
      );
    }
    produced.add(status);
  }

  for (const status of produced) {
    if (status === "SHIPPED") {
      problems.push(
        "a bare SHIPPED is back: this harness merges nothing, so no status may " +
          "claim the unqualified word",
      );
    }
  }

  for (const a of produced) {
    for (const b of produced) {
      if (a !== b && b.startsWith(a)) {
        problems.push(
          `${a} is a strict prefix of ${b} — every reader of a ship status in ` +
            "this repo is a substring match, so one reads as the other",
        );
      }
    }
  }

  return problems;
}

// ── The corpus is real, and the map says more than one thing ────────────────
//
// Without these two, `vocabularyViolations` over an empty corpus and a
// constant map would be green and mean nothing.

describe("#222: the property has something to check", () => {
  test("the corpus covers the verdicts ship.js actually produces", () => {
    expect(NOT_PROVEN).toContain("SKIP");
    expect(NOT_PROVEN).toContain("UNPROVEN");
    expect(NOT_PROVEN.length).toBeGreaterThan(5);
  });

  test("the map distinguishes at least three outcomes", () => {
    const produced = new Set([PROVEN, ...NOT_PROVEN].map(v => statusFor(v)));
    expect(
      produced.size,
      "a map that answers the same thing for everything satisfies the property vacuously",
    ).toBeGreaterThanOrEqual(3);
  });
});

// ── AC-1 / AC-3: no unproven run reports a proven one's status ──────────────

describe("#222: what each prove verdict reports", () => {
  test("a PROVEN verdict is the only thing that reports a proven status", () => {
    expect(statusFor("PROVEN")).toBe("SHIPPED_AND_PROVEN");
  });

  test("a SKIP verdict reports SHIPPED_UNPROVEN", () => {
    // Prove was not run. The run passed its gates; nothing proved it.
    expect(statusFor("SKIP")).toBe("SHIPPED_UNPROVEN");
  });

  test("an UNPROVEN verdict reports that prove ran and failed", () => {
    // Distinct from SKIP on purpose: "measured and did not pass" is not the
    // same claim as "never measured".
    expect(statusFor("UNPROVEN")).toBe("SHIP_PASSED_PROVE_FAILED");
  });

  test("an unrecognised verdict is unmeasured, not clean", () => {
    for (const verdict of ["", "banana", undefined, null, "constructor"]) {
      expect(statusFor(verdict)).toBe("SHIPPED_UNPROVEN");
    }
  });

  test("no SKIP or unmeasured verdict produces a status a PROVEN verdict produces", () => {
    expect(vocabularyViolations(statusFor)).toEqual([]);
  });
});

// ── AC-2: the statuses are not prefixes of one another ──────────────────────

describe("#222: the status words cannot be read as each other", () => {
  test("no status the map returns is a strict prefix of another", () => {
    // Covered by vocabularyViolations too; named separately so a failure says
    // which half of the vocabulary broke.
    const produced = [...new Set([PROVEN, ...NOT_PROVEN].map(v => String(statusFor(v))))];
    const prefixes = produced.flatMap(a =>
      produced.filter(b => a !== b && b.startsWith(a)).map(b => `${a} < ${b}`),
    );
    expect(prefixes).toEqual([]);
  });

  test("no status literal anywhere in ship.js is a prefix of another", () => {
    // ALREADY_SHIPPED is the reason this is file-wide rather than map-wide: it
    // is the genuinely-complete status, and the bare SHIPPED it was confusable
    // with was returned 250 lines away.
    const literals = [...new Set([...shipSource.matchAll(/status: '([A-Z_]+)'/g)].map(m => m[1]))];
    expect(literals.length, "no status literals found — the sweep is matching nothing").toBeGreaterThan(5);
    const prefixes = literals.flatMap(a =>
      literals.filter(b => a !== b && b.startsWith(a)).map(b => `${a} < ${b}`),
    );
    expect(prefixes).toEqual([]);
  });

  test("the bare SHIPPED literal is gone from ship.js", () => {
    expect(shipSource.match(/'SHIPPED'/g) || []).toEqual([]);
  });
});

// ── The return site uses the map ────────────────────────────────────────────

describe("#222: the final return goes through the block under test", () => {
  /**
   * A ternary that turns a verdict straight into a status literal — the exact
   * shape that shipped. Deliberately NOT `proveVerdict === 'PROVEN' ?` on its
   * own: the telemetry step legitimately branches on the verdict to decide
   * whether to label and close the issue, and a sweep that cannot tell that
   * apart from a status map would be satisfied by deleting the close step.
   */
  const VERDICT_TO_STATUS_TERNARY = /proveVerdict === '[A-Z]+'\s*\?\s*'[A-Z_]+'/g;

  test("the sweep matches the line that shipped — otherwise it is matching nothing", () => {
    const asItShipped =
      "  status: proveVerdict === 'PROVEN' ? 'SHIPPED_AND_PROVEN' : " +
      "proveVerdict === 'SKIP' ? 'SHIPPED' : 'SHIP_PASSED_PROVE_FAILED',";
    expect(asItShipped.match(VERDICT_TO_STATUS_TERNARY) || []).not.toEqual([]);
  });

  test("the status is computed by shipStatusFor, not by an inline ternary", () => {
    // Without this the block above could be correct, unused, and the shipped
    // behaviour unchanged — a test of a function production does not call.
    const tail = shipSource.slice(shipSource.indexOf("PHASE 9: PROVE"));
    expect(tail).toContain("status: shipStatusFor(proveVerdict),");
    expect(
      tail.match(VERDICT_TO_STATUS_TERNARY) || [],
      "the verdict-to-status ternary is back at the return site",
    ).toEqual([]);
  });

  test("the map and its fallback both name the unproven status", () => {
    expect((shipSource.match(/SHIPPED_UNPROVEN/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

// ── AC-4: the property is proven to be able to fail ─────────────────────────

describe("#222: mutation — the property refuses a broken map", () => {
  /**
   * Build a mutant copy of the block and compile it.
   *
   * Throws when the substitution changes nothing, the way
   * test/rook-review-scope.test.ts does: a mutation harness that silently
   * no-ops when its target is renamed is the decorative check
   * .claude/rules/checks-must-be-able-to-fail.md is about.
   */
  function mutate(pattern: RegExp, replacement: string): StatusFor {
    const mutated = BLOCK.replace(pattern, replacement);
    if (mutated === BLOCK) {
      throw new Error(
        `could not build the mutant: ${pattern} matched nothing in the PROVE-STATUS block`,
      );
    }
    return loadStatusFor(mutated);
  }

  test("the real map is clean — the control for both mutants below", () => {
    expect(vocabularyViolations(statusFor)).toEqual([]);
  });

  test("a mutant map where PROVEN returns the SKIP status is caught", () => {
    const skipStatus = String(statusFor("SKIP"));
    const mutant = mutate(/^(\s*PROVEN:\s*)'[A-Z_]+'/m, `$1'${skipStatus}'`);

    // The mutation, observed rather than asserted: PROVEN now answers with the
    // status a skipped prove answers with.
    expect(mutant("PROVEN")).toBe(skipStatus);

    const problems = vocabularyViolations(mutant);
    expect(problems.length, "the property did not notice PROVEN and SKIP collapsing").toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("'SKIP'");
  });

  test("a mutant map that restores the bare SHIPPED status is caught", () => {
    const mutant = mutate(/^(\s*SKIP:\s*)'[A-Z_]+'/m, "$1'SHIPPED'");

    expect(mutant("SKIP")).toBe("SHIPPED");

    const problems = vocabularyViolations(mutant).join("\n");
    expect(problems, "the property did not notice the bare SHIPPED coming back").toContain(
      "a bare SHIPPED is back",
    );
    expect(problems, "the property did not notice SHIPPED is a prefix again").toContain(
      "is a strict prefix of",
    );
  });
});
