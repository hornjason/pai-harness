/**
 * #590 — proving `scripts/check-state-record-closes.ts` can refuse.
 *
 * Every negative case runs TWICE: once against the real script, and once
 * against a mutant copy whose single exported exit-code constant is set to 0.
 * The second run is the evidence. A test that only asserts "exit code != 0"
 * cannot tell a refusal from a crash, a typo, or a module-resolution failure
 * — and `.claude/rules/checks-must-be-able-to-fail.md` counts five shipped
 * bugs of exactly that shape in one day.
 *
 * The mutant also has to be observed RUNNING, not merely exiting 0: a script
 * that died before reaching the comparison exits 0 under no circumstances,
 * but a script whose import failed looks identical to one that found nothing.
 * So each case asserts the mutant still printed the refusal it declined to
 * act on.
 *
 * `test/rook-review-scope.test.ts` is the worked example this copies.
 *
 * ## What was broken to prove it — #590
 *
 * Run and counted rather than asserted, over this file plus
 * `test/closing-keywords.test.ts` (59 tests at the time). Every count was
 * predicted before the battery ran, as
 * `.claude/rules/checks-must-be-able-to-fail.md` requires, and each mutant
 * was checked against an input on which it and the original differ.
 *
 * | Mutation | Predicted | Red |
 * |---|---|---|
 * | `stateRecordCloseViolations` short-circuited to `return []` | 12 | **13** |
 * | the colon separator removed — `fixed: #586` stops matching | 7 | 7 |
 * | the `\b` in front of the keyword stem removed | 1 | 1 |
 * | the declared-but-unclosed loop short-circuited | 3 | 3 |
 * | `BANKED` in the live-record case emptied | 1 | 1 |
 *
 * The first row came back one HIGH, and the extra red is "the same issue
 * closed twice in two texts is one finding" — a case that genuinely depends
 * on the mutated behaviour and that the prediction simply failed to
 * enumerate, not a crashing mutant. Every other case touching the comparison
 * went red, which is the discriminator that section prescribes.
 *
 * The colon row does NOT include the live-record case. The live record is
 * the only fixture nobody wrote, and it is blind to a narrowing of the
 * detector — it can only witness a close the detector still sees. The form
 * table is the thing holding that line.
 *
 * **The last two rows are history, not current readings.** #605 deleted the
 * declared-but-unclosed loop, and `BANKED` is `[]` on this tree, so neither
 * mutation exists to apply any more. They are kept because a row that was
 * true of a tree somebody can check out is evidence about how the file got
 * here; see the #605 table below for what holds those lines now.
 *
 * ## What was broken to prove it — #605
 *
 * Re-measured on this tree over this file plus `test/closing-keywords.test.ts`
 * (78 tests). Every count was predicted before the battery ran, the BASELINE
 * row was read before any mutation row, and before each count was recorded
 * an input was named and RUN on which the mutant and the original differ.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 78 pass, 0 fail | **78 pass, 0 fail** | — |
 * | `declaredClosureViolations` short-circuited to `return []` — the mutation #605 AC-4 asks for | 10 | **10 of 78** | `declaredClosureViolations([640], {states:{640:"OPEN"}})`: original returns one refusal naming #640, mutant returns `[]` |
 * | the keyword -> undeclared loop short-circuited | 7 | **7 of 78** | `keywordCloseViolations` over `"Filed and not fixed: #586"` with nothing declared: original returns one refusal, mutant returns `[]` |
 * | UNMEASURED defaulted to CLOSED — *Silent Default Substitution* | 4 | **4 of 78** | `declaredClosureViolations([662], null)`: original refuses naming UNMEASURED, mutant returns `[]` |
 * | the cheapest wrong fix: the live record's five declared ids appended to `BANKED` | 1 | **1 of 78** | the live `project-state.json`: the staleness arm names all five as banked ids the record does not produce |
 * | the pre-#605 conflation reinstated — the declared-but-unclosed loop put back | 7 | **7 of 78** | the AC-1 fixture (`declared: [662]`, a summary with no keyword in it): original returns `[]`, mutant returns *"the record declares #662 closed, but no closing keyword … will make GitHub close it"* |
 *
 * **Two rows are the ones to read.**
 *
 * The last row is the only one that measures the new cases against the
 * DEFECT rather than against a reconstruction of something else, and AC-1 —
 * *a declared id that is CLOSED on GitHub passes with no keyword anywhere* —
 * is in it. That case is red on the pre-#605 behaviour and green on this
 * tree, which is what makes it a witness of the fix rather than a case that
 * sits beside it.
 *
 * The `BANKED` row is the fifth shape — *a case that goes green under the
 * wrong fix* — measured rather than argued. The 5pm repair for any refusal
 * the live-record case produces is to append the id to `BANKED`: one array
 * element, suite green, distinction buried. **It does not work here**, for
 * two independent reasons. The bank is now a two-way ratchet, so an entry
 * the live record does not actually produce is itself a failure (that is
 * the 1). And the #605 cases are unreachable from it in any case: they are
 * synthetic records with ids of their own, and `BANKED` is read in exactly
 * one place, against the live file. Appending an id cannot turn any #605
 * case from red to green, so none of them certifies the regression it was
 * written to block.
 *
 * The keyword row is the #605 AC-3 control: *the keyword -> undeclared
 * direction is unchanged and its existing cases still pass*. Seven cases
 * depend on it, and none of them is among the ten the declared-side row
 * reds — the two deciders have disjoint witnesses, which is the evidence
 * that they are two and not one wearing two names.
 *
 * A note on the keyword row's prediction, because the arithmetic matters
 * more than the appearance of having been right: the first number written
 * down was "≈6", which was a mis-addition of a list of seven enumerated
 * cases. The seven measured are exactly the seven enumerated, so the
 * enumeration — which is the prediction that does any work — matched.
 *
 * None of the five #605 mutations is left in the tree; all were run and
 * reverted, and `scripts/check-state-record-closes.ts`,
 * `test/closing-keywords.test.ts` and this file were confirmed
 * byte-identical to the measured source afterwards by `shasum -a 256`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-state-record-closes.ts");
const source = readFileSync(SCRIPT, "utf-8");
const REPO = "hornjason/pai-harness";

// ── The mutant ───────────────────────────────────────────────────────────
//
// Built once, in a temp directory OUTSIDE the repo. Running it from there is
// what proves the script has no relative imports: a later `from "../lib/..."`
// would make every mutant die on module resolution, exiting non-zero, which
// would read as "the mutation was rejected on the merits" when in fact the
// mutant never ran.

let MUTANT = "";
let MUTANT_DIR = "";
let FIX = "";

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), "state-closes-mutant-"));
  const mutated = source.replace(/STATE_CLOSES_REFUSE_EXIT\s*=\s*1\b/, "STATE_CLOSES_REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `STATE_CLOSES_REFUSE_EXIT = 1` in " +
        "scripts/check-state-record-closes.ts",
    );
  }
  MUTANT = join(MUTANT_DIR, "check-state-record-closes.ts");
  writeFileSync(MUTANT, mutated);

  FIX = mkdtempSync(join(tmpdir(), "state-closes-fix-"));
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** A `project-state.json` holding one session, written to a scratch path. */
function stateFile(name: string, session: unknown): string {
  const dir = join(FIX, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project-state.json");
  writeFileSync(path, JSON.stringify({ updated: "2026-10-17", priorities: [], phases: [], sessions: [], session }, null, 2));
  return path;
}

/**
 * A GitHub reading on disk, which is how these cases drive the declared side
 * without a network (#605).
 *
 * `--issue-states github` is the live path and is deliberately never
 * exercised here: a case that reached out to api.github.com would be red on
 * a plane and green at a desk, and neither colour would be about the code.
 * The reading is injected in-process instead by
 * `test/closing-keywords.test.ts`, over a fake `fetch`.
 */
function statesFile(name: string, states: Record<number, "OPEN" | "CLOSED">): string {
  const dir = join(FIX, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "issue-states.json");
  writeFileSync(path, JSON.stringify(states, null, 2));
  return path;
}

/**
 * Assert a case is refused, and that the refusal is what is being observed.
 *
 * `reason` must match the real run's stderr AND the mutant's: the mutant is
 * the same code with the exit removed, so a mutant that printed nothing
 * either crashed or never reached the comparison, and in both of those a
 * `code === 0` means nothing at all.
 */
function expectRefused(args: string[], reason: RegExp) {
  const real = run(SCRIPT, args);
  expect(real.code, `expected a refusal for [${args.join(" ")}]\n${real.err}`).not.toBe(0);
  expect(real.err).toMatch(reason);

  const mutant = run(MUTANT, args);
  expect(
    mutant.err,
    `the mutant printed nothing for [${args.join(" ")}] — it crashed or never reached ` +
      `the comparison, so its exit code is not evidence.\n${mutant.err}`,
  ).toMatch(reason);
  expect(
    mutant.code,
    `the mutant (STATE_CLOSES_REFUSE_EXIT = 0) still exited ${mutant.code} for ` +
      `[${args.join(" ")}] — this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
}

// ── The property the mutant protects ─────────────────────────────────────

describe("#590 AC-6: the refusal is routed through exactly one exit code", () => {
  test("STATE_CLOSES_REFUSE_EXIT is declared once", () => {
    const decls = source.match(/STATE_CLOSES_REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("every process.exit goes through it", () => {
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, "no process.exit at all — nothing can refuse").toBeGreaterThan(0);
    for (const e of exits) {
      expect(
        e,
        `${e} bypasses STATE_CLOSES_REFUSE_EXIT, so the mutant cannot neutralise it and the ` +
          `negative cases below would pass for the wrong reason`,
      ).toBe("process.exit(STATE_CLOSES_REFUSE_EXIT)");
    }
  });

  test("the script has no relative imports", () => {
    // Without this, the mutant run from a temp directory dies on module
    // resolution — a non-zero exit that reads as a rejected mutation.
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });
});

// ── The cases ────────────────────────────────────────────────────────────

describe("#590 AC-6: zeroing the exit constant turns the real refusals green", () => {
  test("an undeclared keyword-derived close — the #586 shape — refuses, and the mutant does not", () => {
    const path = stateFile("undeclared", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [508],
      summary:
        "#582 closed #508: the body was expect(true). Filed and not fixed: #586, where a " +
        "scaffold run rewrites spec criteria text.",
    });
    const states = statesFile("undeclared", { 508: "CLOSED" });
    expectRefused(
      ["--state", path, "--repo", REPO, "--issue-states", states],
      /will CLOSE #586/,
    );
  });

  test("#605: a declared id that is OPEN on GitHub refuses, and the mutant does not", () => {
    // The input only the declared-side decider can reach: no closing keyword
    // exists anywhere in this record, so the keyword side has nothing to
    // iterate. Under #590 the same fixture refused for the opposite reason —
    // "no closing keyword behind it" — and the way to clear it was to write
    // one into prose.
    const path = stateFile("declared-open", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [508, 586],
      summary: "Session 49 landed the spec rewrite and left the scaffold criterion alone.",
    });
    const states = statesFile("declared-open", { 508: "CLOSED", 586: "OPEN" });
    expectRefused(
      ["--state", path, "--repo", REPO, "--issue-states", states],
      /declares #586 closed, but #586 is OPEN on GitHub/,
    );
  });

  test("#605: a declared id with no reading behind it is UNMEASURED, and refuses", () => {
    // An unavailable GitHub is a third state. `0`, `{}` and SKIP are
    // indistinguishable from success; UNMEASURED is not.
    const path = stateFile("declared-unmeasured", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [586],
      summary: "Session 49 landed the spec rewrite and left the scaffold criterion alone.",
    });
    expectRefused(["--state", path, "--repo", REPO], /#586 is UNMEASURED/);
  });

  test("#605: an unreadable --issue-states file refuses rather than reading as no reading", () => {
    const path = stateFile("states-absent", {
      number: 49, date: "2026-10-17", suite: "green", issues_closed: [586],
      summary: "Session 49 landed the spec rewrite.",
    });
    expectRefused(
      ["--state", path, "--repo", REPO, "--issue-states", join(FIX, "nope", "states.json")],
      /could not be read/,
    );
  });

  test("a qualified reference with no --repo refuses, and the mutant does not", () => {
    const path = stateFile("unknown-repo", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [],
      summary: "fixes some-owner/some-repo#586",
    });
    expectRefused(["--state", path], /unknown/i);
  });

  test("an empty session summary refuses rather than reporting a clean record", () => {
    const path = stateFile("empty", {
      number: 49, date: "2026-10-17", suite: "green", issues_closed: [], summary: "   ",
    });
    expectRefused(["--state", path, "--repo", REPO], /no text was read/);
  });

  test("a state document with no session record refuses, and the mutant does not", () => {
    const dir = join(FIX, "no-session");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "project-state.json");
    writeFileSync(path, JSON.stringify({ updated: "2026-10-17", priorities: [], phases: [], sessions: [] }));
    expectRefused(["--state", path, "--repo", REPO], /no "session" record/);
  });

  test("an unreadable state file refuses, and the mutant does not", () => {
    expectRefused(["--state", join(FIX, "nope", "absent.json"), "--repo", REPO], /could not be read/);
  });

  test("an unparseable entry in 'Issues closed:' refuses, and the mutant does not", () => {
    const path = stateFile("bad-list", {
      number: 49, date: "2026-10-17", suite: "green",
      issues_closed: "508,not-a-number",
      summary: "#582 closed #508.",
    });
    expectRefused(["--state", path, "--repo", REPO], /not an issue number/);
  });

  test("an unknown option refuses, and the mutant does not", () => {
    expectRefused(["--nonsense", "x"], /unknown option/);
  });
});

describe("#590: the positive control — a record whose sets agree is not refused", () => {
  // An audit that refused every record would satisfy all eight cases above
  // and be worse than nothing.
  test("a clean record exits 0 and reports what it read", () => {
    const path = stateFile("clean", {
      number: 50,
      date: "2026-10-18",
      suite: "green",
      issues_closed: [586, 590],
      summary: "This closes #586 and fixes #590. Filed and not yet looked at: see #591.",
    });
    const states = statesFile("clean", { 586: "CLOSED", 590: "CLOSED" });
    const real = run(SCRIPT, ["--state", path, "--repo", REPO, "--issue-states", states]);
    expect(real.code, real.err).toBe(0);
    expect(real.out).toContain("OK");
    // Coverage, not merely a verdict: 36 of 426 and 426 of 426 are the same
    // PASS, and no reader can tell them apart from the output.
    expect(real.out).toMatch(/\d+ of \d+ texts read/);
    expect(real.out).toContain("2 in this repository");
    // #605: and a PASS over a record whose declared ids were read from
    // GitHub must be distinguishable from one over a record nobody asked
    // about. Both exit 0 today, so the coverage line is the only witness.
    expect(real.out).toContain("2 of 2 declared ids read from GitHub");
  });

  test("#605: a clean record with no keyword at all also exits 0", () => {
    // AC-1 at the CLI. This is the record the fix exists to allow: a session
    // that closed its issues through their own PRs, declaring them, with no
    // closing keyword written into the summary to satisfy a checker.
    const path = stateFile("clean-no-keyword", {
      number: 50,
      date: "2026-10-18",
      suite: "green",
      issues_closed: [586, 590],
      summary: "Session 50 landed the spec rewrite and the state-record comparison, through their own PRs.",
    });
    const states = statesFile("clean-no-keyword", { 586: "CLOSED", 590: "CLOSED" });
    const real = run(SCRIPT, ["--state", path, "--repo", REPO, "--issue-states", states]);
    expect(real.code, real.err).toBe(0);
    expect(real.out).toContain("OK");
    expect(real.out).toContain("0 in this repository");
    expect(real.out).toContain("2 of 2 declared ids read from GitHub");
  });

  test("the title, the body and the commit message are all read", () => {
    // A check that read only the summary would pass a PR whose BODY carries
    // the keyword, which is where a `Closes #N` line usually lives.
    const path = stateFile("texts", {
      number: 50, date: "2026-10-18", suite: "green", issues_closed: [], summary: "a clean summary",
    });
    const body = join(FIX, "texts", "body.md");
    writeFileSync(body, "Closes #777\n");
    expectRefused(["--state", path, "--repo", REPO, "--body-file", body], /will CLOSE #777/);

    const message = join(FIX, "texts", "message.txt");
    writeFileSync(message, "docs: record session 50\n\nresolves #778\n");
    expectRefused(["--state", path, "--repo", REPO, "--message-file", message], /will CLOSE #778/);

    expectRefused(["--state", path, "--repo", REPO, "--title", "fix #779 at last"], /will CLOSE #779/);
  });
});
