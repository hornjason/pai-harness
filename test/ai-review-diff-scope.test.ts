/**
 * Diff-only re-review after the first few rounds (CRC-N2, #1600).
 *
 * Covers CRC-N2 (CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` carried this as a DECLARED
 * DEVIATION rather than a gap, with its own retirement condition: *"an
 * adjudicator re-emits unresolved findings."* That fired on run
 * `40137812549`, whose carry step reported `2 finding(s) from earlier rounds
 * are unanswered at this commit` — a resolved value, not a configuration.
 * This file is the adoption, and the shape of it is set by two facts that
 * were known before a line was written.
 *
 * ## What this file can measure, and what it cannot
 *
 * **#1533 measured the reviewer reading the FILE rather than the DIFF.** So
 * `review_scope=diff` is a configuration and "the reviewer's reads were
 * confined" is a behaviour, and nothing in a test suite can turn the first
 * into the second. Every case here is about the first. Not one of them
 * licenses the sentence "the reviewer narrowed its reads", and the spec
 * records that observation as UNMEASURED with its reason rather than taking
 * the config value for it — `.claude/rules/checks-must-be-able-to-fail.md`'s
 * subject exactly, and SUCCESS.md claim 4's.
 *
 * Stated here as well as in the spec because a reader arriving at a green
 * suite is the reader most likely to conclude the wrong thing from it.
 *
 * ## The case that matters is AC-N2-3, and it is the negative control
 *
 * The deviation existed because *"dropping to diff-only first would lose
 * [unresolved priors] silently"*. So the case that must not regress is: a
 * prior unresolved finding whose file is NOT in the diff is still handed to
 * the reviewer on a narrowed round. It is driven end to end through the real
 * generated bash, and a MUTANT that drops the carry injection turns it red
 * while leaving the scope word untouched — which is what makes it a control
 * over the carry rather than a second reading of the scope.
 *
 *  - AC-N2-1  the words and the floor are bound to the library
 *  - AC-N2-2  the generated bash and `reviewScopeForRound` agree over a matrix,
 *             completeness gates included
 *  - AC-N2-3  the negative control — including an anchor SHIFTED by an edit
 *             above it (#1601) — and the mutants that redden each half
 *  - AC-N2-4  the decision reaches the file the reviewer reads
 *  - AC-N2-5  the prompt states both words and exempts the carried list
 *  - AC-N2-6  the committed workflow carries it, and the rounds step still does not
 *
 * ## What was broken to prove it
 *
 * Run over this file + `test/ai-review-rounds.test.ts` +
 * `test/ai-review-rounds-step.test.ts` + `test/ai-review-carry-forward.test.ts`.
 * The fourth file is in scope because #1600's narrowing is only safe on top
 * of #1601's anchor fix, and the two ship together: a battery that measured
 * the scope decision without the carry it narrows over would be measuring
 * half a change. Every count was predicted before the battery ran — in
 * `/tmp/rg1601/predictions.md`, written before the first row — and **the
 * baseline row was read before any mutation row**, an instrument that has
 * stopped reporting takes the baseline down with it, and that is the row
 * nobody mutates anything to produce. Each source was restored from a `cp`
 * backup and confirmed byte-identical by sha256, never by `git checkout --`.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 167 pass, 0 fail | **167 pass, 0 fail** | — |
 * | M1 the generated `review_scope_for_round()` short-circuited to `full` | 7 | **7 of 167** | round 4, complete carry, `lib/a.ts` changed: original `diff`, mutant `full` |
 * | M2 the library's blind-spot gate removed | 6 | **6 of 167** | round 9, READ, `unmeasuredRounds: "1"`: original FULL, mutant DIFF |
 * | M3 the library's changed-file gate removed | 4 | **4 of 167** | the same row with `changedFileCount: "0"` |
 * | M4 the library's carry-state gate removed | 5 | **5 of 167** | the same row with `AI_REVIEW_CARRY_ABSENT` |
 * | M5 the carry render line deleted in the REAL source | 13 | **23 of 167** | AC-N2-3's rig: the original's state file names `lib/untouched.ts`, the mutant's does not |
 * | M6 the library's round floor removed — #1241 inverted | 4 | **4 of 167** | round 2, complete carry: original FULL, mutant DIFF |
 * | M7 the library's TRUNCATION gate removed | 2 | **2 of 167** | round 9, everything else complete, `truncatedRounds: "1"`: original FULL, mutant DIFF |
 * | M8 the library's ROUND-GAP gate removed | 2 | **2 of 167** | round 9, `highestPriorRound: "7"`, `priorRounds: "7"`: original FULL, mutant DIFF |
 * | **M9 the pre-#1601 line-number anchor restored** | 5 | **5 of 167** | AC-C4's shifted fixture: the recorded text is still in the file, two lines lower. The original counts one matching line and carries; the mutant reads the recorded LINE, finds other text, and resolves |
 *
 * **M5 came back HIGH, at 23 against a predicted 13, and the extra reds are
 * the real kind.** The prediction estimated rather than counted the
 * population that depends on the render line. Every one of the ten extra is
 * a `test/ai-review-carry-forward.test.ts` case asserting a non-empty
 * rendered carried list — squarely the mutated behaviour — 144 cases still
 * pass, and AC-C1's three state cases (`READ`/`ABSENT`/`UNMEASURED`) stay
 * green, so the mutant is not broken and the file still loads. Per
 * `.claude/rules/checks-must-be-able-to-fail.md`'s arithmetic that reads as
 * *the prediction was wrong and the check is better than you thought*.
 *
 * **M6 came back LOW first, at 3 against 4, and the low row was a real
 * weakness in a case rather than in the code.** AC-3's gate-1 row handed the
 * round-9 completeness reading to a round-2 scope question, so it varied two
 * things at once: gate 5 refused it on the history and gate 1 was never
 * asked. That is #585's pair discipline — vary exactly ONE reading — and the
 * row is 4 with the reading derived from the round.
 *
 * **Which cells are witnesses and which are controls**, because the next
 * reader otherwise counts them all. Two mutations define the two halves:
 *
 *  - **M1 is the pre-#1600 behaviour** — the narrowing never firing — and
 *    seven cases see it: four of AC-N2-2's (the agreement matrix, the
 *    per-gate inputs, the completeness parity rows, and the floor's `08`
 *    row) and three of AC-N2-3's (the narrowed round that still carries,
 *    the shift case, and the carry-injection mutant).
 *  - **M9 is the pre-#1601 behaviour** — the anchor read by line number —
 *    and five cases see it: three in AC-C4 (the shifted row, the mutant
 *    case that must redden row 2 **and only row 2**, and the consistency
 *    case binding the step's key namespace to `carryKey`), AC-C3's own
 *    mutant case, and AC-N2-3's shift case, which is the only cell red
 *    under both and is the one that says the two changes compose.
 *
 * AC-C4 rows 1 and 3 — unchanged carries and unreadable carries — stay
 * GREEN under M9. That is what makes M9 a measurement of the anchoring
 * rather than a mutant that broke the carry: a row that reddened all three
 * would mean the step had stopped working.
 *
 * Everything else is a control, green on BOTH pre-fix sources, and there is
 * no state of the code in which it goes red for either original defect:
 * AC-N2-1's agreement cases, the floor-only (#1241) mutant case, AC-N2-3's
 * premise and unreadable-history cases, both AC-N2-4 cases, AC-N2-5's three
 * prompt cases, AC-N2-6's two workflow cases, and AC-C4's blank-anchor and
 * ambiguous-anchor cases. They exist to refuse the wrong *shape* of each
 * fix — a scope decided in the rounds step, a prompt naming no scope, a
 * second write site, an anchor rule that resolves on an ambiguous match, a
 * blank line that becomes permanently uncarryable.
 *
 * M1 is the behaviour of the pre-#1600 step and not its text: the real
 * pre-#1600 step wrote no scope line at all, so AC-N2-4 is green under M1
 * for a reason that would not hold against the genuine earlier source.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AI_REVIEW_CARRY_READ_STATE,
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  reviewScopeForRound,
} from "../lib/ai-review-rounds.ts";
import {
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_BASENAME,
  AI_REVIEW_CARRY_PATH_VAR,
  AI_REVIEW_CARRY_READ,
  AI_REVIEW_CARRY_SCOPE_KEY,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_STEP_ID,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_CHANGED_FILES_BASENAME,
  AI_REVIEW_CHANGED_FILES_PATH_VAR,
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL,
  AI_REVIEW_EVENT_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_LEDGER_REPO_VAR,
  AI_REVIEW_LEDGER_TOKEN_VAR,
  AI_REVIEW_ROUNDS_STEP_ID,
  AI_REVIEW_SCOPE_DIFF_WORD,
  AI_REVIEW_SCOPE_FULL_WORD,
  AI_REVIEW_SNAPSHOT_ROUND_VAR,
  buildCarryScript,
  buildReviewPrompt,
  buildRoundsScript,
} from "../lib/scaffold/ai-review-step.ts";
import { AI_REVIEW_LEDGER_IDENTITY } from "../lib/ai-review-rounds.ts";
import { structuralCut } from "../lib/source-slice.ts";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

setDefaultTimeout(gitFixtureTestTimeout());

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ai-review.yml");

/** The one anchor the scope decision hangs off in the generated script. */
const SCOPE_FN = "review_scope_for_round() {";

// ── AC-N2-1: the words and the floor are bound to the library ────────────

describe("AC-N2-1: the generated literals are bound to the library", () => {
  test("AC-N2-1: the two scope words are the library's two scope words", () => {
    // `lib/scaffold/ai-review-step.ts` may gain no relative import — 27
    // suites copy it into a `mkdtemp` to build mutants, where a relative
    // specifier does not resolve and the mutant fails to LOAD, reading as a
    // behavioural difference on every row. The rule's own remedy for a file
    // that must stay import-free is an agreement assertion, and this is it.
    expect(AI_REVIEW_SCOPE_FULL_WORD).toBe(REVIEW_SCOPE_FULL);
    expect(AI_REVIEW_SCOPE_DIFF_WORD).toBe(REVIEW_SCOPE_DIFF);
    expect(AI_REVIEW_CARRY_READ).toBe(AI_REVIEW_CARRY_READ_STATE);
    expect(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL).toBe(AI_REVIEW_DIFF_SCOPE_FROM_ROUND);
  });

  test("AC-N2-1: the two words are different strings", () => {
    // Vacuity control. Every row of the matrix below compares one word
    // against another, and a pair of identical words makes all of them pass
    // whatever the decision did.
    expect(AI_REVIEW_SCOPE_FULL_WORD).not.toBe(AI_REVIEW_SCOPE_DIFF_WORD);
  });

  test("AC-N2-1: ai-review-rounds.ts still has no import of the scaffold module", () => {
    // The property the agreement assertion exists to preserve, asserted from
    // the other side: the library must not reach for the scaffold's spelling
    // either, or the two constants collapse into one and the agreement case
    // becomes a tautology.
    const src = readFileSync(join(ROOT, "lib", "ai-review-rounds.ts"), "utf8");
    const imports = [
      ...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
    ].map(m => m[1]!);
    expect(imports.filter(s => s.includes("scaffold"))).toEqual([]);
  });
});

// ── the rig ──────────────────────────────────────────────────────────────

/**
 * Run the generated scope decision alone, over one set of inputs.
 *
 * The function is CUT from the real generated script rather than copied into
 * this file. A copy would be a second spelling of the decision, and the
 * matrix below would then measure the copy agreeing with the library while
 * the deployed bash said something else.
 *
 * `structuralCut` and not a fixed window: #664's whole subject is that
 * `at + N` is a guess about how long a construct stays that size, and this
 * one is going to grow.
 */
interface ScopeInput {
  round?: string;
  state?: string;
  unmeasuredRounds?: string;
  changedFiles?: string | null;
  /** #1601-adjacent: the three completeness readings gate 4 and 5 take. */
  truncatedRounds?: string;
  priorRounds?: string;
  highestPriorRound?: string;
}

/**
 * The completeness readings a row that is MEANT to narrow must carry.
 *
 * Derived from the round rather than written down per-row: the gate asks for
 * rounds 1..r-1 with no hole, so a fixture that hardcoded a count would stop
 * meaning that the moment a row changed its round. Rows that vary one of
 * these away from complete are how each gate gets an input only it refuses.
 */
function completePriors(round: string | undefined) {
  const r = Number.parseInt((round ?? "").trim(), 10);
  const prior = Number.isSafeInteger(r) && r >= 1 ? String(r - 1) : "unknown";
  return { truncatedRounds: "0", priorRounds: prior, highestPriorRound: prior };
}

function scopeOf(input: ScopeInput): string {
  const script = buildCarryScript();
  const fn = structuralCut(script, SCOPE_FN, { balanced: "{" });
  const d = completePriors(input.round);
  const dir = mkdtempSync(join(tmpdir(), "ai-review-scope-"));
  try {
    const changed = join(dir, AI_REVIEW_CHANGED_FILES_BASENAME);
    if (input.changedFiles !== null && input.changedFiles !== undefined) {
      writeFileSync(changed, input.changedFiles);
    }
    const harness = join(dir, "scope.sh");
    writeFileSync(
      harness,
      [
        "set -uo pipefail",
        `scope_unmeasured_rounds=${JSON.stringify(input.unmeasuredRounds ?? "unknown")}`,
        `scope_truncated_rounds=${JSON.stringify(input.truncatedRounds ?? d.truncatedRounds)}`,
        `scope_prior_rounds=${JSON.stringify(input.priorRounds ?? d.priorRounds)}`,
        `scope_highest_prior=${JSON.stringify(input.highestPriorRound ?? d.highestPriorRound)}`,
        fn,
        `review_scope_for_round ${JSON.stringify(input.state ?? AI_REVIEW_CARRY_ABSENT)}`,
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", ["-e", harness], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(input.round === undefined ? {} : { [AI_REVIEW_SNAPSHOT_ROUND_VAR]: input.round }),
        ...(input.changedFiles === null ? {} : { [AI_REVIEW_CHANGED_FILES_PATH_VAR]: changed }),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `the generated scope function exited ${r.status} on ${JSON.stringify(input)}: ${r.stderr}`,
      );
    }
    return r.stdout ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The library's answer for the same row, through the one exported decider. */
function libraryScope(input: ScopeInput): string {
  const d = completePriors(input.round);
  return reviewScopeForRound(input.round, {
    truncatedRounds: input.truncatedRounds ?? d.truncatedRounds,
    priorRounds: input.priorRounds ?? d.priorRounds,
    highestPriorRound: input.highestPriorRound ?? d.highestPriorRound,
    state: input.state ?? AI_REVIEW_CARRY_ABSENT,
    unmeasuredRounds: input.unmeasuredRounds ?? "unknown",
    // The bash reads `[ -s <path> ]`; the library takes a count. One fact,
    // two shapes, and the rig derives the count from the SAME fixture string
    // the bash is handed so the two cannot be given different inputs.
    changedFileCount:
      input.changedFiles === null || input.changedFiles === undefined
        ? "unknown"
        : String(input.changedFiles.split("\n").filter(Boolean).length),
  });
}

// ── AC-N2-2: the bash and the library agree over a matrix ────────────────

describe("AC-N2-2: the generated bash and the library decide the same scope", () => {
  const ROUNDS = [undefined, "", "0", "1", "2", "3", "08", "12", "abc", " 3 ", "3x"];
  const STATES = [AI_REVIEW_CARRY_READ, AI_REVIEW_CARRY_ABSENT, AI_REVIEW_CARRY_UNMEASURED];
  const BLIND = ["0", "1", "unknown"];
  const CHANGED = ["lib/a.ts\n", "lib/a.ts\nlib/b.ts\n", null];

  test("AC-N2-2: every row agrees, and at least one row is DIFF", () => {
    let diffRows = 0;
    let fullRows = 0;
    for (const round of ROUNDS) {
      for (const state of STATES) {
        for (const unmeasuredRounds of BLIND) {
          for (const changedFiles of CHANGED) {
            const row = { round, state, unmeasuredRounds, changedFiles };
            const lib = libraryScope(row);
            const sh = scopeOf(row);
            expect(sh, `row ${JSON.stringify(row)}: bash ${sh}, library ${lib}`).toBe(lib);
            if (lib === REVIEW_SCOPE_DIFF) diffRows++;
            else fullRows++;
          }
        }
      }
    }
    // Both controls, and they are not decoration. A matrix in which every row
    // is FULL agrees perfectly with a decider that returns FULL
    // unconditionally — which is the pre-#1600 behaviour, and is what this
    // whole file exists to say has changed.
    expect(diffRows, "no row of the matrix narrowed, so it cannot see a narrowing").toBeGreaterThan(
      0,
    );
    expect(fullRows, "every row narrowed, so it cannot see a refusal").toBeGreaterThan(0);
  }, 240_000);

  test("AC-N2-2: each gate has an input only it refuses", () => {
    // #420's rule: two deciders that agree are behaviourally one, so each
    // gate needs an input that only it can see. One base row that narrows,
    // and four rows each varying exactly ONE field away from it (#585).
    const base = {
      round: String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND),
      state: AI_REVIEW_CARRY_READ,
      unmeasuredRounds: "0",
      changedFiles: "lib/a.ts\n",
    };
    expect(scopeOf(base), "the base row does not narrow, so nothing below varies from a DIFF").toBe(
      REVIEW_SCOPE_DIFF,
    );
    const rows: Array<[string, Record<string, unknown>]> = [
      ["gate 1 — one round below the floor", { round: String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND - 1) }],
      ["gate 2 — the carry was not read", { state: AI_REVIEW_CARRY_UNMEASURED }],
      ["gate 3 — a round with an unreadable findings list", { unmeasuredRounds: "1" }],
      ["gate 4 — no changed-file list", { changedFiles: null }],
    ];
    for (const [why, delta] of rows) {
      const row = { ...base, ...delta } as Parameters<typeof scopeOf>[0];
      expect(scopeOf(row), `${why}: the bash narrowed anyway`).toBe(REVIEW_SCOPE_FULL);
      expect(libraryScope(row), `${why}: the library narrowed anyway`).toBe(REVIEW_SCOPE_FULL);
    }
  }, 120_000);

  test("AC-N2-2: the COMPLETENESS gates agree between the bash and the library", () => {
    // The matrix above varies the round, the state, the blind-spot count and
    // the changed-file list, and holds the two completeness readings at
    // complete on every row. So it cannot see gate 4 or gate 5 at all —
    // #492's shape, a battery every one of whose fixtures meets the
    // precondition. These are the rows that do not meet it.
    //
    // A focused table rather than three more matrix dimensions: 297 rows
    // already spawn a shell each, and 2,673 would buy the same coverage for
    // twenty minutes of wall clock.
    const base = {
      round: "4",
      state: AI_REVIEW_CARRY_READ,
      unmeasuredRounds: "0",
      changedFiles: "lib/a.ts\n",
    };
    expect(scopeOf(base), "the base row does not narrow, so nothing below varies from a DIFF")
      .toBe(REVIEW_SCOPE_DIFF);
    expect(libraryScope(base)).toBe(REVIEW_SCOPE_DIFF);

    const rows: Array<[string, Record<string, string>]> = [
      ["gate 4 — the ledger dropped a round", { truncatedRounds: "1" }],
      ["gate 4 — whether it dropped any is unknown", { truncatedRounds: "unknown" }],
      ["gate 4 — a truncation count that is not a number", { truncatedRounds: "yes" }],
      ["gate 5 — the history stops one short", { highestPriorRound: "2", priorRounds: "2" }],
      ["gate 5 — a hole: three rounds recorded, highest is 3", { priorRounds: "2" }],
      ["gate 5 — how many prior rounds is unknown", { priorRounds: "unknown" }],
      ["gate 5 — the highest prior round is unknown", { highestPriorRound: "unknown" }],
      ["gate 5 — the history runs PAST this round", { highestPriorRound: "4", priorRounds: "4" }],
    ];
    for (const [why, delta] of rows) {
      const row = { ...base, ...delta };
      expect(scopeOf(row), `${why}: the bash narrowed anyway`).toBe(REVIEW_SCOPE_FULL);
      expect(libraryScope(row), `${why}: the library narrowed anyway`).toBe(REVIEW_SCOPE_FULL);
    }
  }, 120_000);

  test("AC-N2-2: `unknown` blind spots are refused, and `0` is not a coercion", () => {
    // The input on which a `!= 0` and a `Number(v) === 0` differ, named
    // rather than assumed: the carry's own word for a count it could not
    // establish, and an empty string, both of which coerce to zero.
    const base = {
      round: "4",
      state: AI_REVIEW_CARRY_READ,
      changedFiles: "lib/a.ts\n",
    };
    expect(libraryScope({ ...base, unmeasuredRounds: "0" })).toBe(REVIEW_SCOPE_DIFF);
    for (const bad of ["unknown", "", " 0 ", "00"]) {
      expect(
        libraryScope({ ...base, unmeasuredRounds: bad }),
        `a blind-spot count of ${JSON.stringify(bad)} was read as none`,
      ).toBe(REVIEW_SCOPE_FULL);
    }
  });

  test("AC-N2-2: the floor is a floor, and 08 is 8 rather than an octal abort", () => {
    // `[ 08 -ge 3 ]` is "value too great for base" under bash's octal
    // reading, which under `-e` aborts the step rather than answering. The
    // library reads `08` as 8. Without the strip they disagree on an input
    // the matrix supplies, and the disagreement is an exit code rather than
    // a word — which is why `scopeOf` throws on a non-zero status instead of
    // returning the empty string as a scope.
    const narrowing = {
      state: AI_REVIEW_CARRY_READ,
      unmeasuredRounds: "0",
      changedFiles: "lib/a.ts\n",
    };
    expect(scopeOf({ ...narrowing, round: "08" })).toBe(REVIEW_SCOPE_DIFF);
    expect(scopeOf({ ...narrowing, round: "02" })).toBe(REVIEW_SCOPE_FULL);
    expect(scopeOf({ ...narrowing, round: "000" })).toBe(REVIEW_SCOPE_FULL);
  }, 60_000);

  test("AC-N2-2: the MUTANT — the floor alone, which is #1241 — disagrees", () => {
    // The removal, performed and observed. Without it the rows above are a
    // pile of agreements that would also hold between a library and a bash
    // that had both stopped deciding anything.
    //
    // The mutant is the pre-#1255 shape: narrow on the round number alone.
    // It is the cheapest wrong fix for "adopt diff-only re-review", it is
    // the fix this repository already shipped and reverted, and the input it
    // differs on is named below rather than assumed.
    const script = buildCarryScript();
    const fn = structuralCut(script, SCOPE_FN, { balanced: "{" });
    const mutantFn = [
      `${SCOPE_FN}`,
      `  local r="\${${AI_REVIEW_SNAPSHOT_ROUND_VAR}:-}"`,
      `  case "\${r}" in`,
      `    ''|*[!0-9]*) printf '%s' '${AI_REVIEW_SCOPE_FULL_WORD}'; return 0 ;;`,
      `  esac`,
      `  if [ "\${r}" -lt ${AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL} ]; then`,
      `    printf '%s' '${AI_REVIEW_SCOPE_FULL_WORD}'; return 0`,
      `  fi`,
      `  printf '%s' '${AI_REVIEW_SCOPE_DIFF_WORD}'`,
      `}`,
    ].join("\n");
    expect(fn, "the mutation did not change anything — this measures nothing").not.toBe(mutantFn);

    // The input, named and run: round 4 with the history UNREADABLE and no
    // changed-file list. The real function refuses; the floor-only mutant
    // narrows, and a reviewer told `diff` there is one told to read a list
    // that does not exist while an earlier round's finding sits unlisted.
    const row = {
      round: "4",
      state: AI_REVIEW_CARRY_UNMEASURED,
      unmeasuredRounds: "unknown",
      changedFiles: null,
    } as const;
    expect(scopeOf(row)).toBe(REVIEW_SCOPE_FULL);
    expect(libraryScope(row)).toBe(REVIEW_SCOPE_FULL);
    expect(runScopeFn(mutantFn, row), "the mutant agreed with the real function").toBe(
      REVIEW_SCOPE_DIFF,
    );
  }, 60_000);
});

/** `scopeOf`'s shell, handed a function body the caller supplies. */
function runScopeFn(
  fn: string,
  input: { round?: string; state?: string; unmeasuredRounds?: string; changedFiles?: string | null },
): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-scope-mutant-"));
  try {
    const changed = join(dir, AI_REVIEW_CHANGED_FILES_BASENAME);
    if (input.changedFiles !== null && input.changedFiles !== undefined) {
      writeFileSync(changed, input.changedFiles);
    }
    const harness = join(dir, "scope.sh");
    writeFileSync(
      harness,
      [
        "set -uo pipefail",
        `scope_unmeasured_rounds=${JSON.stringify(input.unmeasuredRounds ?? "unknown")}`,
        fn,
        `review_scope_for_round ${JSON.stringify(input.state ?? AI_REVIEW_CARRY_ABSENT)}`,
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", ["-e", harness], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(input.round === undefined ? {} : { [AI_REVIEW_SNAPSHOT_ROUND_VAR]: input.round }),
        ...(input.changedFiles === null ? {} : { [AI_REVIEW_CHANGED_FILES_PATH_VAR]: changed }),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return r.stdout ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the end-to-end rig ───────────────────────────────────────────────────

interface CarryRig {
  /** The comment list the GET answers with. */
  list?: unknown[];
  /** Files planted in the checkout and added to its index. */
  files?: Record<string, string>;
  /** The changed-file list, or `null` for a step that produced none. */
  changedFiles?: string | null;
  /** The round the rounds step reported. */
  round?: string;
  /** A mutant in place of the real script. */
  script?: string;
}

/**
 * Run the WHOLE generated carry step and read the file the reviewer reads.
 *
 * The matrix above measures the decision. This measures that the decision
 * reaches the file — a correct decider wired to nothing is this repository's
 * most frequent defect, and the two cases cannot substitute for each other.
 */
function runCarry(rig: CarryRig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-n2-carry-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const listPath = join(dir, "list.json");
    writeFileSync(listPath, JSON.stringify(rig.list ?? []));
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash\ncat ${JSON.stringify(listPath)}\n`,
      { mode: 0o755 },
    );

    const work = join(dir, "work");
    mkdirSync(work);
    for (const [rel, contents] of Object.entries(rig.files ?? {})) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: work,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        encoding: "utf8",
      });
    git("init", "-q", "-b", "main", ".");
    git("add", "-A");

    const carryPath = join(dir, AI_REVIEW_CARRY_BASENAME);
    const changedPath = join(dir, AI_REVIEW_CHANGED_FILES_BASENAME);
    const changed = rig.changedFiles === undefined ? "lib/a.ts\n" : rig.changedFiles;
    if (changed !== null) writeFileSync(changedPath, changed);

    const script = join(dir, "carry.sh");
    writeFileSync(script, rig.script ?? buildCarryScript());

    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_WORKSPACE: work,
      [AI_REVIEW_LEDGER_PR_VAR]: "77",
      [AI_REVIEW_LEDGER_REPO_VAR]: "o/r",
      [AI_REVIEW_LEDGER_API_VAR]: "https://api.github.test",
      [AI_REVIEW_LEDGER_TOKEN_VAR]: "t",
      [AI_REVIEW_EVENT_VAR]: "pull_request",
      [AI_REVIEW_CARRY_PATH_VAR]: carryPath,
      [AI_REVIEW_SNAPSHOT_ROUND_VAR]: rig.round ?? "4",
    };
    if (changed !== null) env[AI_REVIEW_CHANGED_FILES_PATH_VAR] = changedPath;

    const r = spawnSync("bash", ["-e", script], {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const file = existsSync(carryPath) ? readFileSync(carryPath, "utf8") : null;
    const line = (key: string) =>
      (file ?? "")
        .split("\n")
        .map(l => (l.startsWith(`${key}=`) ? l.slice(key.length + 1) : null))
        .find((v): v is string => v !== null) ?? null;
    const carried = (file ?? "")
      .split("\n")
      .map(l => /^ {2}- \[round (.+?)\] (.*?):(.*?) \[(.*?)\] — (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ round: m[1]!, file: m[2]!, line: m[3]!, severity: m[4]!, summary: m[5]! }));
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      file,
      state: line(AI_REVIEW_CARRY_STATE_KEY),
      scope: line(AI_REVIEW_CARRY_SCOPE_KEY),
      carried,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTSIDE_FILE = "lib/untouched.ts";
const OUTSIDE_LINE = "const timeout = 0;";
const OUTSIDE_SUMMARY = "a zero timeout disables the deadline rather than setting one";

/**
 * A ledger for a pull request at round 4, whose ROUND 1 raised one finding
 * against `OUTSIDE_FILE` and whose rounds 2 and 3 found nothing.
 *
 * Rounds 2 and 3 are not padding: gate 5 requires the recorded rounds below
 * this one to be exactly 1..r-1, so a single-round ledger at a snapshot of 4
 * is a HOLE and refuses to narrow — correctly. Before #1601's completeness
 * gates this fixture was one round, which is not a history any real pull
 * request at round 4 has, and the case passed on it.
 */
function ledgerWithOutsideFinding(): unknown[] {
  const entry = (round: number, findings: unknown[]) => ({
    at: `t${round}`,
    sha: `sha${round}`,
    run: `run-${round}`,
    attempt: "1",
    identity: AI_REVIEW_LEDGER_IDENTITY,
    round,
    findings,
  });
  const rounds = [
    entry(1, [
      {
        severity: "high",
        file: OUTSIDE_FILE,
        line: 1,
        summary: OUTSIDE_SUMMARY,
        text: OUTSIDE_LINE,
      },
    ]),
    entry(2, []),
    entry(3, []),
  ];
  const body = [
    "<!-- rungate:ai-review-ledger:v1 -->",
    "```json",
    JSON.stringify({ rounds, truncated: 0 }),
    "```",
  ].join("\n");
  return [{ id: 1, body, user: { login: "github-actions[bot]", type: "Bot" } }];
}

// ── AC-N2-3: the negative control ────────────────────────────────────────

describe("AC-N2-3: a prior finding OUTSIDE the diff survives a narrowed round", () => {
  /**
   * The case the deviation existed to protect, and the only one here whose
   * regression is silent.
   *
   * `lib/untouched.ts` is NOT in the changed-file list. On a narrowed round
   * a reviewer reading only the diff never opens it, so if the carry does
   * not hand the finding over it is gone and the check goes green — which is
   * `46034035`, the fail-open this repository found and reverted, arriving
   * by a different door.
   */
  const RIG: CarryRig = {
    list: ledgerWithOutsideFinding(),
    files: { [OUTSIDE_FILE]: `${OUTSIDE_LINE}\n`, "lib/a.ts": "export const a = 1;\n" },
    changedFiles: "lib/a.ts\n",
    round: "4",
  };

  test("AC-N2-3: the round narrows AND the finding is carried", () => {
    const r = runCarry(RIG);
    expect(r.status, `the step failed: ${r.stderr}`).toBe(0);
    // Both halves, in one case, deliberately. A case asserting only the
    // carry would be green on a round that never narrowed, and a case
    // asserting only the scope would be green over a lost finding — the two
    // readings are only a control when they are taken together.
    expect(r.scope, "the round did not narrow, so this measures nothing about narrowing").toBe(
      REVIEW_SCOPE_DIFF,
    );
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried.map(c => c.file)).toEqual([OUTSIDE_FILE]);
    expect(r.carried[0]!.summary).toBe(OUTSIDE_SUMMARY);
  });

  test("AC-N2-3: the finding survives a narrowed round AND an edit above it", () => {
    // The case #1601 made the whole criterion rest on. Before the anchor
    // fix, narrowing the scope and losing the prior were failures in the
    // same direction at the same time — a reviewer that reads less AND
    // remembers less — and the plain outside-the-diff case above could not
    // see it, because its fixture never moved the cited line.
    //
    // Here `lib/untouched.ts` is outside the diff AND two lines have been
    // inserted above the finding, so the recorded line number now holds a
    // comment. The round must still narrow and the finding must still be
    // carried. On the pre-#1601 carry rule this is red.
    const r = runCarry({
      ...RIG,
      files: {
        [OUTSIDE_FILE]: `// an unrelated edit\n// and a second line of it\n${OUTSIDE_LINE}\n`,
        "lib/a.ts": "export const a = 1;\n",
      },
    });
    expect(r.status, `the step failed: ${r.stderr}`).toBe(0);
    expect(r.scope, "the round did not narrow, so this says nothing about narrowing").toBe(
      REVIEW_SCOPE_DIFF,
    );
    expect(
      r.carried.map(c => c.file),
      "the prior was lost to an edit above it, on a round that reads only the diff",
    ).toEqual([OUTSIDE_FILE]);
  });

  test("AC-N2-3: the premise — the shifted fixture really does move the cited line", () => {
    // #500's shape again, and it has to be asserted separately: the case
    // above is satisfied by a fixture in which nothing moved, and that
    // fixture passes on the defective rule too.
    const shifted = `// an unrelated edit\n// and a second line of it\n${OUTSIDE_LINE}\n`;
    const recordedLine = 1;
    expect(shifted.split("\n")[recordedLine - 1]).not.toBe(OUTSIDE_LINE);
    expect(shifted.split("\n").indexOf(OUTSIDE_LINE)).toBe(2);
  });

  test("AC-N2-3: the carried file is genuinely outside the diff", () => {
    // The premise, asserted rather than assumed. If `OUTSIDE_FILE` ever
    // appears in the changed-file fixture the case above still passes and
    // stops being about anything — #500's shape, a fixture reaching the
    // assertion without the feature.
    expect(RIG.changedFiles).not.toContain(OUTSIDE_FILE);
    expect(RIG.changedFiles!.split("\n").filter(Boolean)).toEqual(["lib/a.ts"]);
  });

  test("AC-N2-3: the MUTANT — the carry injection dropped — reddens exactly that", () => {
    // The mutation the acceptance names: drop the carry injection and watch
    // the outside-the-diff case go red. It is cut at the one site that
    // renders the carried list into the file the reviewer reads, so the
    // scope word is untouched — which is what makes this a control over the
    // CARRY and not a second reading of the scope.
    const real = buildCarryScript();
    const anchor =
      "printf '%s' \"${carried}\" | jq -r '.[] | \"  - [round ";
    const at = real.indexOf(anchor);
    expect(at, "could not build the mutant: the carry render site moved").toBeGreaterThan(-1);
    const end = real.indexOf("\n", at);
    const mutant = real.slice(0, at) + "true" + real.slice(end);
    expect(mutant, "the mutation did not apply — this measures nothing").not.toBe(real);

    const mut = runCarry({ ...RIG, script: mutant });
    expect(mut.status, `the mutant failed for an unrelated reason: ${mut.stderr}`).toBe(0);
    // The scope is UNCHANGED — the mutant still narrows. That is the point:
    // a narrowed round, and nothing telling the reviewer about the finding
    // in the file it is no longer going to open.
    expect(mut.scope, "the mutant stopped narrowing, so it is not this mutation").toBe(
      REVIEW_SCOPE_DIFF,
    );
    expect(mut.carried, "the mutant still carried the finding").toEqual([]);
    expect(mut.file).not.toContain(OUTSIDE_FILE);

    // And the real script does, on the same input through the same rig.
    const realRun = runCarry(RIG);
    expect(realRun.file).toContain(OUTSIDE_FILE);
  });

  test("AC-N2-3: an unreadable history refuses to narrow at all", () => {
    // The other half of the protection, and the one a round-number floor
    // cannot express: when the earlier findings could NOT be read, there is
    // no list to exempt from the scope, so the scope must not narrow.
    const r = runCarry({
      ...RIG,
      list: [{ id: 1, body: "<!-- rungate:ai-review-ledger:v1 -->\nno json here", user: { login: "github-actions[bot]", type: "Bot" } }],
    });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(r.scope).toBe(REVIEW_SCOPE_FULL);
  });
});

// ── AC-N2-4: the decision reaches the file the reviewer reads ────────────

describe("AC-N2-4: the scope and the state are one write", () => {
  test("AC-N2-4: every reading the step can produce carries a scope line", () => {
    // Three readings, three runs. A path that wrote a state and no scope
    // would hand the reviewer a file stating no scope, which the prompt
    // reads as `full` — safe, and indistinguishable from a step that
    // decided to review fully. Indistinguishable is the thing this
    // subsystem is not allowed to be.
    const rows: Array<[string, CarryRig, string]> = [
      ["ABSENT — no ledger", { list: [] }, AI_REVIEW_CARRY_ABSENT],
      [
        "READ — a ledger with one finding",
        { list: ledgerWithOutsideFinding(), files: { [OUTSIDE_FILE]: `${OUTSIDE_LINE}\n` } },
        AI_REVIEW_CARRY_READ,
      ],
      [
        "ABSENT — a merge_group entry",
        { list: [] },
        AI_REVIEW_CARRY_ABSENT,
      ],
    ];
    for (const [why, rig, state] of rows) {
      const r = runCarry(rig);
      expect(r.state, why).toBe(state);
      expect(r.scope, `${why}: no scope line was written`).not.toBeNull();
      expect([REVIEW_SCOPE_FULL, REVIEW_SCOPE_DIFF], `${why}: ${r.scope}`).toContain(r.scope!);
      // The state is still the FIRST line. `carryStateOf` in
      // lib/ai-review-suppression.ts reads line one and nothing else, so
      // appending the scope above it would silently blind the adjudicator.
      expect(r.file!.split("\n")[0]).toBe(`${AI_REVIEW_CARRY_STATE_KEY}=${state}`);
    }
  });

  test("AC-N2-4: the scope is written by the one function that writes the state", () => {
    // The structural property, asserted on the generated text: there is one
    // `carry_state()` and the scope key appears only inside it. A second
    // write site could emit a narrowed scope beside a reading that does not
    // license it, and no behavioural case would see it until it happened.
    const script = buildCarryScript();
    const writer = structuralCut(script, "carry_state() {", { balanced: "{" });
    const key = `'${AI_REVIEW_CARRY_SCOPE_KEY}'`;
    expect(script.split(key).length - 1, `${AI_REVIEW_CARRY_SCOPE_KEY} is written more than once`).toBe(1);
    expect(writer, "the scope is not written by carry_state").toContain(key);
  });
});

// ── AC-N2-5: the prompt ──────────────────────────────────────────────────

describe("AC-N2-5: the prompt states the scope and exempts the carried list", () => {
  const prompt = buildReviewPrompt();

  test("AC-N2-5: both words and the key are named, and the default is full", () => {
    expect(prompt).toContain(`${AI_REVIEW_CARRY_SCOPE_KEY}=`);
    expect(prompt).toContain(AI_REVIEW_SCOPE_FULL_WORD);
    expect(prompt).toContain(AI_REVIEW_SCOPE_DIFF_WORD);
    expect(prompt).toContain(AI_REVIEW_CHANGED_FILES_PATH_VAR);
  });

  test("AC-N2-5: the carried list is declared outside the scope", () => {
    // The sentence the negative control depends on. A narrowed reviewer that
    // treats the carried list as out of scope drops every finding whose file
    // the diff does not touch, which is every carried finding worth having.
    const clause = structuralCut(
      prompt,
      "THE CARRIED LIST IS OUTSIDE THE SCOPE AND IS READ ON EVERY ROUND.",
      { endAnchor: "do not treat it as resolved." },
    );
    expect(clause.length, "the clause is empty").toBeGreaterThan(200);
    // Whitespace-normalised: the prompt is hard-wrapped, so a clause that
    // happens to break across a line is the same instruction and an
    // assertion that cannot see that is a detector narrower than its subject.
    expect(clause.replace(/\s+/g, " ")).toContain("whether or not the diff touches it");
  });

  test("AC-N2-5: the pre-#1600 unconditional sentence is gone", () => {
    // The input on which this prompt and the previous one differ, named:
    // the old text told the reviewer that no round is ever diff-scoped, so
    // leaving it in beside the new paragraph would be two instructions
    // answering one question, and the reviewer would read both.
    expect(prompt).not.toContain("READ THE WHOLE BRANCH, ON EVERY ROUND");
    expect(prompt).not.toContain("No\nround is scoped to a diff");
  });
});

// ── AC-N2-6: the committed workflow ──────────────────────────────────────

describe("AC-N2-6: the committed workflow carries it", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  test("AC-N2-6: the carry step decides the scope and the reviewer gets the list", () => {
    const doc = Bun.YAML.parse(yml) as any;
    const steps = (doc.jobs?.[AI_REVIEW_JOB]?.steps ?? []) as any[];
    const carry = steps.find(s => s?.id === AI_REVIEW_CARRY_STEP_ID);
    expect(carry, "the carry step is gone from the committed workflow").toBeTruthy();
    expect(String(carry.run)).toContain(SCOPE_FN);
    // The two inputs the decision takes have to be in that step's own `env:`
    // — a step's env does not carry to a later step, and the round arrives
    // through an output rather than through the prepare step's directory.
    expect(Object.keys(carry.env ?? {})).toContain(AI_REVIEW_SNAPSHOT_ROUND_VAR);
    expect(Object.keys(carry.env ?? {})).toContain(AI_REVIEW_CHANGED_FILES_PATH_VAR);
    expect(String(carry.env[AI_REVIEW_SNAPSHOT_ROUND_VAR])).toContain(AI_REVIEW_ROUNDS_STEP_ID);

    const reviewer = steps.find(s => typeof s?.with?.prompt === "string");
    expect(reviewer, "no step hands the action a prompt").toBeTruthy();
    expect(
      Object.keys(reviewer.env ?? {}),
      "the reviewer is told to read a changed-file list it is not given",
    ).toContain(AI_REVIEW_CHANGED_FILES_PATH_VAR);
    expect(String(reviewer.with.prompt)).toContain(AI_REVIEW_CARRY_SCOPE_KEY);
  });

  test("AC-N2-6: the ROUNDS step still decides no scope — #1255 is not reopened", () => {
    // The guard CRC-N2 is most likely to break, and it is not a guard about
    // this change's correctness: it is about where the decision lives. A
    // round-number floor in the rounds step is #1241 verbatim, it would be
    // invisible to the four gates above, and it would sit one line from the
    // edit that reopens the fail-open.
    const rounds = buildRoundsScript();
    expect(rounds).not.toContain(AI_REVIEW_CARRY_SCOPE_KEY);
    expect(rounds).not.toContain(SCOPE_FN);
    expect(rounds, "the rounds step emits a scope output again").not.toMatch(/\bscope=/);
    // The control for three negatives: the rounds step is a real script that
    // still does its own job, so "no scope" is a reading of it rather than
    // of an empty string.
    expect(rounds.length).toBeGreaterThan(1000);
    expect(rounds).toContain("round=");
  });
});
