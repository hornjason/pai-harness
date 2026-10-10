/**
 * The vocabulary of statuses a finished ship run reports (#222, #224)
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
 * #224 adds the SECOND input. Run `wf_7ac5f614-d21` returned
 * `{"status":"SHIPPED","regressions":0}` for issue #209 while that same branch
 * ran 3984 pass / 1 fail — the failing test being #149's own guard, which had
 * caught the regression and named the file. The prove verdict knew nothing
 * about it, and the prove verdict alone decided the word the run reported. So
 * `shipStatusFor` now takes the suite reading too, and A VERDICT MAY NOT BE
 * MORE AFFIRMATIVE THAN ITS WEAKEST INPUT: a FAIL or UNMEASURED suite caps the
 * terminal status below SHIPPED_AND_PROVEN however PROVEN the prove step was.
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
 * the mutants in the last describe are not prose — they are built here, on
 * every run, from the real block, and each asserts the real map is clean while
 * the mutated one is not. Pointing `PROVEN` at the SKIP status turns the
 * vocabulary property red; restoring the bare `SHIPPED` for SKIP turns it red
 * for the prefix reason instead; making the suite cap return the uncapped
 * status turns the #224 property red. Every mutant builder throws if its
 * substitution changes nothing, so a renamed map aborts this file rather than
 * passing it.
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

/** Both inputs, because the status is a function of both (#224). */
type StatusFor = (verdict: unknown, suiteReading: unknown) => unknown;
/** One input, with the other pinned — what the vocabulary property drives. */
type UnaryStatusFor = (verdict: unknown) => unknown;

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

/** The suite reading that imposes no cap: the tests ran, against this commit, and passed. */
const SUITE_PASS = "PASS";

/**
 * The vocabulary property is about the PROVE half, so it is driven with the
 * suite half held at its one non-capping value. Holding it anywhere else would
 * collapse every verdict onto the cap status and the property would pass
 * vacuously — it would be comparing a constant with itself.
 */
const uncapped = (fn: StatusFor): UnaryStatusFor => (verdict: unknown) => fn(verdict, SUITE_PASS);

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

/**
 * Everything a suite reading can be that is NOT "the tests passed on this
 * commit". The first two are what ship.js produces; the rest are the shapes an
 * unrecognised value arrives as, and every one of them has to cap, because
 * "we could not read it" is not "it passed" (#129, one level out).
 */
const NOT_SUITE_PASS: readonly unknown[] = [
  "FAIL",
  "UNMEASURED",
  "SKIP",
  "",
  "pass",
  "PASS ",
  " PASS",
  "constructor",
  "__proto__",
  "toString",
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
function vocabularyViolations(fn: UnaryStatusFor): string[] {
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

/**
 * #224's property: no suite reading other than PASS may produce the status a
 * clean, proven run produces.
 *
 * Returned as problems for the same reason as above — the mutant below drives
 * this exact routine over a map whose cap has been removed.
 */
function capViolations(fn: StatusFor): string[] {
  const problems: string[] = [];

  const clean = fn(PROVEN, SUITE_PASS);
  if (typeof clean !== "string" || clean.length === 0) {
    return [`a PROVEN verdict with a passing suite produced ${show(clean)}, which is not a status`];
  }

  for (const reading of NOT_SUITE_PASS) {
    for (const verdict of [PROVEN, ...NOT_PROVEN]) {
      const status = fn(verdict, reading);
      if (typeof status !== "string" || status.length === 0) {
        problems.push(
          `verdict ${show(verdict)} with suite ${show(reading)} produced ${show(status)}, ` +
            "which is not a status",
        );
        continue;
      }
      if (status === clean) {
        problems.push(
          `verdict ${show(verdict)} with suite ${show(reading)} produces ${status}, the status a ` +
            "clean proven run produces — the suite reading is not capping anything",
        );
      }
    }
  }

  return problems;
}

/** Every status the map can emit, over both inputs. */
function producedStatuses(fn: StatusFor): string[] {
  const out = new Set<string>();
  for (const reading of [SUITE_PASS, ...NOT_SUITE_PASS]) {
    for (const verdict of [PROVEN, ...NOT_PROVEN]) {
      out.add(String(fn(verdict, reading)));
    }
  }
  return [...out];
}

function strictPrefixes(words: readonly string[]): string[] {
  return words.flatMap(a => words.filter(b => a !== b && b.startsWith(a)).map(b => `${a} < ${b}`));
}

// ── The corpus is real, and the map says more than one thing ────────────────
//
// Without these, `vocabularyViolations` over an empty corpus and a constant
// map would be green and mean nothing.

describe("#222: the property has something to check", () => {
  test("the corpus covers the verdicts ship.js actually produces", () => {
    expect(NOT_PROVEN).toContain("SKIP");
    expect(NOT_PROVEN).toContain("UNPROVEN");
    expect(NOT_PROVEN.length).toBeGreaterThan(5);
  });

  test("the corpus covers the suite readings ship.js actually produces", () => {
    expect(NOT_SUITE_PASS).toContain("FAIL");
    expect(NOT_SUITE_PASS).toContain("UNMEASURED");
    expect(NOT_SUITE_PASS.length).toBeGreaterThan(5);
  });

  test("the map distinguishes at least three outcomes", () => {
    const produced = new Set([PROVEN, ...NOT_PROVEN].map(v => statusFor(v, SUITE_PASS)));
    expect(
      produced.size,
      "a map that answers the same thing for everything satisfies the property vacuously",
    ).toBeGreaterThanOrEqual(3);
  });

  test("the suite reading changes the answer at all", () => {
    expect(
      statusFor(PROVEN, "FAIL"),
      "a map that ignores its second argument satisfies the #224 property vacuously",
    ).not.toBe(statusFor(PROVEN, SUITE_PASS));
  });
});

// ── AC-1 / AC-3: no unproven run reports a proven one's status ──────────────

describe("#222: what each prove verdict reports", () => {
  const forVerdict = uncapped(statusFor);

  test("a PROVEN verdict is the only thing that reports a proven status", () => {
    expect(forVerdict("PROVEN")).toBe("SHIPPED_AND_PROVEN");
  });

  test("a SKIP verdict reports SHIPPED_UNPROVEN", () => {
    // Prove was not run. The run passed its gates; nothing proved it.
    expect(forVerdict("SKIP")).toBe("SHIPPED_UNPROVEN");
  });

  test("an UNPROVEN verdict reports that prove ran and failed", () => {
    // Distinct from SKIP on purpose: "measured and did not pass" is not the
    // same claim as "never measured".
    expect(forVerdict("UNPROVEN")).toBe("SHIP_PASSED_PROVE_FAILED");
  });

  test("an unrecognised verdict is unmeasured, not clean", () => {
    for (const verdict of ["", "banana", undefined, null, "constructor"]) {
      expect(forVerdict(verdict)).toBe("SHIPPED_UNPROVEN");
    }
  });

  test("no SKIP or unmeasured verdict produces a status a PROVEN verdict produces", () => {
    expect(vocabularyViolations(forVerdict)).toEqual([]);
  });
});

// ── #224: the terminal status is capped by the suite reading ────────────────

describe("#224: a FAIL or UNMEASURED suite caps the terminal status", () => {
  test("a failing suite caps a PROVEN run below SHIPPED_AND_PROVEN", () => {
    // The #209 case exactly: every other gate passed and one test was red.
    expect(statusFor("PROVEN", "FAIL")).toBe("SHIP_PASSED_SUITE_FAILED");
  });

  test("an unmeasured suite caps a PROVEN run below SHIPPED_AND_PROVEN", () => {
    // A count with no SHA, or a SHA that could not be read. Not a contradiction
    // the run can name, so not a refusal — but never a clean word either.
    expect(statusFor("PROVEN", "UNMEASURED")).toBe("SHIP_PASSED_SUITE_UNMEASURED");
  });

  test("an unrecognised suite reading is unmeasured, not clean", () => {
    for (const reading of ["", "banana", undefined, null, "constructor", {}, 0]) {
      expect(statusFor("PROVEN", reading)).toBe("SHIP_PASSED_SUITE_UNMEASURED");
    }
  });

  test("a red suite outranks an unmeasured one — the status is the weakest input", () => {
    // FAIL is a measured contradiction; UNMEASURED is an absence. The run
    // reports the worse of the two, not the later one.
    expect(statusFor("UNPROVEN", "FAIL")).toBe("SHIP_PASSED_SUITE_FAILED");
    expect(statusFor("SKIP", "FAIL")).toBe("SHIP_PASSED_SUITE_FAILED");
  });

  test("a weak prove verdict still shows through a passing suite", () => {
    // The cap is a cap, not an override: a clean suite must not upgrade a
    // prove step that failed.
    expect(statusFor("UNPROVEN", SUITE_PASS)).toBe("SHIP_PASSED_PROVE_FAILED");
    expect(statusFor("SKIP", SUITE_PASS)).toBe("SHIPPED_UNPROVEN");
  });

  test("nothing but a passing suite can produce the clean proven status", () => {
    expect(capViolations(statusFor)).toEqual([]);
  });
});

// ── AC-2: the statuses are not prefixes of one another ──────────────────────

describe("#222: the status words cannot be read as each other", () => {
  test("no status the map returns is a strict prefix of another", () => {
    // Covered by vocabularyViolations too; named separately so a failure says
    // which half of the vocabulary broke. Driven over BOTH inputs so the #224
    // cap statuses are in the set rather than only the prove-derived ones.
    expect(strictPrefixes(producedStatuses(statusFor))).toEqual([]);
  });

  test("no status literal anywhere in ship.js is a prefix of another", () => {
    // ALREADY_SHIPPED is the reason this is file-wide rather than map-wide: it
    // is the genuinely-complete status, and the bare SHIPPED it was confusable
    // with was returned 250 lines away. The map's own outputs are unioned in
    // because the #224 cap statuses never appear as a `status: '...'` literal —
    // they are produced by shipStatusFor, so a sweep of literals alone would
    // stop seeing the newest half of the vocabulary.
    const literals = [
      ...new Set([
        ...[...shipSource.matchAll(/status: '([A-Z_]+)'/g)].map(m => m[1]),
        ...producedStatuses(statusFor),
      ]),
    ];
    expect(literals.length, "no status literals found — the sweep is matching nothing").toBeGreaterThan(5);
    expect(strictPrefixes(literals)).toEqual([]);
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
    //
    // The returned value is traced through one binding rather than required to
    // BE the call verbatim. #252 needs the status before the return — the
    // draft-readiness decision reads it — and an assertion that forbids naming
    // it is an assertion about formatting, not about where the value came
    // from. What is still forbidden is the value coming from anywhere else.
    const tail = shipSource.slice(shipSource.indexOf("PHASE 9: PROVE"));
    const CALL = "shipStatusFor(proveVerdict, suiteReading)";
    const returned = tail.match(/\n {2}status: ([A-Za-z0-9_]+|shipStatusFor\([^)]*\)),/);
    expect(returned, "the final return has no `status:` this sweep can read").not.toBeNull();
    const expression = returned![1];
    if (expression !== CALL) {
      expect(
        tail,
        `the final return reports \`${expression}\`, which is not assigned from ${CALL}`,
      ).toContain(`const ${expression} = ${CALL}`);
    }
    expect(
      tail.match(VERDICT_TO_STATUS_TERNARY) || [],
      "the verdict-to-status ternary is back at the return site",
    ).toEqual([]);
  });

  test("the return site passes the suite reading, not a literal (#224)", () => {
    // A hardcoded 'PASS' at the call site would satisfy every test above while
    // restoring the exact defect: a status that cannot see the suite.
    const tail = shipSource.slice(shipSource.indexOf("PHASE 9: PROVE"));
    expect(tail).not.toContain("shipStatusFor(proveVerdict, 'PASS')");
    expect(tail).toContain("suiteReading,");
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

  test("the real map is clean — the control for every mutant below", () => {
    expect(vocabularyViolations(uncapped(statusFor))).toEqual([]);
    expect(capViolations(statusFor)).toEqual([]);
  });

  test("a mutant map where PROVEN returns the SKIP status is caught", () => {
    const skipStatus = String(statusFor("SKIP", SUITE_PASS));
    const mutant = mutate(/^(\s*PROVEN:\s*)'[A-Z_]+'/m, `$1'${skipStatus}'`);

    // The mutation, observed rather than asserted: PROVEN now answers with the
    // status a skipped prove answers with.
    expect(mutant("PROVEN", SUITE_PASS)).toBe(skipStatus);

    const problems = vocabularyViolations(uncapped(mutant));
    expect(problems.length, "the property did not notice PROVEN and SKIP collapsing").toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("'SKIP'");
  });

  test("a mutant map that restores the bare SHIPPED status is caught", () => {
    const mutant = mutate(/^(\s*SKIP:\s*)'[A-Z_]+'/m, "$1'SHIPPED'");

    expect(mutant("SKIP", SUITE_PASS)).toBe("SHIPPED");

    const problems = vocabularyViolations(uncapped(mutant)).join("\n");
    expect(problems, "the property did not notice the bare SHIPPED coming back").toContain(
      "a bare SHIPPED is back",
    );
    expect(problems, "the property did not notice SHIPPED is a prefix again").toContain(
      "is a strict prefix of",
    );
  });
});

describe("#224: mutation — the property refuses an uncapped map", () => {
  function mutate(pattern: RegExp, replacement: string): StatusFor {
    const mutated = BLOCK.replace(pattern, replacement);
    if (mutated === BLOCK) {
      throw new Error(
        `could not build the mutant: ${pattern} matched nothing in the PROVE-STATUS block`,
      );
    }
    return loadStatusFor(mutated);
  }

  test("a mutant that treats a red suite as a passing one is caught", () => {
    // The #209 run, expressed as a code change: the suite reading reaches the
    // map and the map ignores it.
    const mutant = mutate(/^(\s*FAIL:\s*)'[A-Z_]+'/m, "$1'SHIPPED_AND_PROVEN'");

    // The mutation, observed rather than asserted.
    expect(mutant("PROVEN", "FAIL")).toBe("SHIPPED_AND_PROVEN");

    const problems = capViolations(mutant);
    expect(problems.length, "the property did not notice the cap disappearing").toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("'FAIL'");
  });

  test("a mutant whose unreadable-suite fallback is clean is caught", () => {
    // "We could not read the suite" becoming "the suite passed" is the #129
    // fail-open, and it is the half that does not look like a bug.
    const mutant = mutate(
      /^(const SHIP_STATUS_SUITE_UNREADABLE = )'[A-Z_]+'/m,
      "$1'SHIPPED_AND_PROVEN'",
    );

    expect(mutant("PROVEN", "banana")).toBe("SHIPPED_AND_PROVEN");

    const problems = capViolations(mutant).join("\n");
    expect(problems, "the property did not notice the unreadable suite reading as clean").toContain(
      "the suite reading is not capping anything",
    );
  });
});
