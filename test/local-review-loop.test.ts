import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  LOCAL_REVIEW_AT_CAP,
  LOCAL_REVIEW_CONTINUE,
  LOCAL_REVIEW_SETTLED,
  LOCAL_REVIEW_UNMEASURED,
} from "../lib/local-review-rounds.ts";
import { AI_REVIEW_ROUND_CAP } from "../lib/ai-review-rounds.ts";

/**
 * Covers #1421 — the local review loop RUNS, and it STOPS.
 *
 * #1342 shipped a decision function and no caller. A decision function nobody
 * calls is indistinguishable from one that works, and this repository has been
 * bitten by that shape twice in one day (`carryForward` and five siblings have
 * zero production callers, #1381). So the acceptance here is not another unit
 * case over the predicate: it is a loop that is driven to termination, and the
 * thing asserted is **which round it stopped on and why**.
 *
 * ## The loop under test
 *
 * `driveLoop` is the whole driver. Each turn it writes a findings payload the
 * way a reviewer would, calls `scripts/local-review-round.ts`, and **continues
 * only while that script exits 0**. The exit code is the loop's only exit;
 * `MAX_TURNS` is a backstop, and a run that reaches it is a run that did not
 * terminate. Nothing else in the driver can stop it.
 *
 * ## Why the two mutant rows are the measurement
 *
 * A loop that stops is not evidence that anything stopped it — a fixture that
 * runs out of rounds stops too, and reads identically. Both control rows below
 * drive the SAME reviewer against a mutated decision and watch the termination
 * move:
 *
 * - **CONTROL-NOEXIT** (`runAnotherRound` → always true) must reach
 *   `MAX_TURNS`. It names what the loop's termination is caused BY. Without
 *   it, every row here is satisfied by a driver that happens to stop.
 * - **CONTROL-COUNTONLY** (nothing is ever a repeat) must take the repeating
 *   reviewer all the way to the cap instead of settling at round 2. It is the
 *   cheapest wrong fix — a round counter — failing in a live loop rather than
 *   in a unit assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const MAX_TURNS = 12;

/**
 * #1304's class, as round 1 spelled it.
 *
 * Every pair of fixtures in this file that is meant to be ONE class now
 * agrees on what its integers counted — `38 findings`, `12 allowed` — and
 * not merely on the integers. #1536 made a reading carry that word, so two
 * spellings saying *"38 open findings, 12 were allowed"* and *"38 findings,
 * 12 still allowed"* stopped being one reading. The bodies were corrected
 * rather than the assertions: a class that disagrees about what it counted
 * is two classes, which is the whole point of the change.
 */
const classA1 = {
  id: "new",
  title: "The filing gate reads a different value than `gh` for `headRefOid`",
  body:
    "`lib/issue-filing-gate.ts` has `resolveFiling` compare its own reading against what `gh pr view` returns. " +
    "Measured over 38 findings, 12 allowed through.",
};

/** The same class, as a later round spelled it. */
const classA2 = {
  id: "new",
  title: "`resolveFiling` still disagrees with `gh` about `headRefOid`",
  body:
    "In `lib/issue-filing-gate.ts` the `resolveFiling` path still reads a different `headRefOid` than `gh` does. " +
    "Re-measured after the fix: 38 findings, 12 allowed and still wrong.",
};

/** A reviewer that restates one class forever — #1304's rounds 2-5. */
const repeating = (turn: number) => [turn === 1 ? classA1 : classA2];

/** A reviewer that raises a class nobody has raised, every single turn. */
const alwaysNovel = (turn: number) => [
  {
    id: "new",
    title: `Finding ${turn}`,
    body: `\`lib/module-${turn}.ts\` \`handler${turn}Value\` drops ${turn * 11 + 17} of ${turn * 13 + 23} rows.`,
  },
];

/* ── the sandbox, and the two mutants ────────────────────────────────────── */

let SANDBOX = "";
const SCRIPTS: Record<string, string> = {};

function plant(name: string, mutate: (lib: string) => string) {
  const dir = join(SANDBOX, name);
  cpSync(join(REPO_ROOT, "lib"), join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });

  const libPath = join(dir, "lib", "local-review-rounds.ts");
  const before = readFileSync(libPath, "utf-8");
  const after = mutate(before);
  if (name !== "real" && after === before) {
    throw new Error(`mutant "${name}" did not apply — it would be a second copy of the real run`);
  }
  writeFileSync(libPath, after);

  const script = join(dir, "scripts", "local-review-round.ts");
  writeFileSync(script, readFileSync(join(REPO_ROOT, "scripts", "local-review-round.ts"), "utf-8"));
  SCRIPTS[name] = script;
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "rg1421-"));
  plant("real", s => s);
  // Always another round. Names what the termination is caused by.
  plant("noexit", s =>
    s.replace(
      "return reading.decision === LOCAL_REVIEW_CONTINUE;",
      "return true; // CONTROL-NOEXIT",
    ),
  );
  // Nothing is ever a repeat, so only the counter can stop the loop.
  plant("countonly", s =>
    s.replace(
      "const overlap = duplicateOverlap(finding, prior);",
      "const overlap = { duplicate: false, keys: [] as string[] }; void duplicateOverlap;",
    ),
  );
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

interface Turn {
  turn: number;
  decision: string;
  exit: number;
}

/**
 * Drive the loop to termination, or to the backstop.
 *
 * The ONLY `break` is on the script's exit code. A run whose length equals
 * `MAX_TURNS` is a run that never terminated, and every row below states
 * which of the two it expects.
 */
function driveLoop(
  which: string,
  reviewer: (turn: number) => unknown[],
  opts: { history?: string; seed?: string } = {},
): { turns: Turn[]; history: string; reasons: string[] } {
  const dir = mkdtempSync(join(SANDBOX, "run-"));
  const history = opts.history ?? join(dir, "history.json");
  if (opts.seed !== undefined) writeFileSync(history, opts.seed);

  const reasons: string[] = [];
  const turns: Turn[] = [];
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const findings = join(dir, `round-${turn}.json`);
    writeFileSync(findings, JSON.stringify({ findings: reviewer(turn) }));
    const r = spawnSync(
      "bun",
      [SCRIPTS[which], "--history", history, "--findings", findings],
      { encoding: "utf-8" },
    );
    let decision = "(no decision printed)";
    let reason = "(no reading printed)";
    try {
      const read = JSON.parse(r.stdout ?? "");
      decision = read.decision ?? decision;
      reason = read.reason ?? reason;
    } catch {
      /* left as the sentinels: a turn that printed nothing is a turn that failed to run */
    }
    turns.push({ turn, decision, exit: r.status ?? -1 });
    reasons.push(reason);
    if (r.status !== 0) break;
  }
  return { turns, history, reasons };
}

const last = (t: Turn[]) => t[t.length - 1];

describe("the local review loop terminates (#1421)", () => {
  test("AC-LL1: a reviewer that restates one class stops the loop at round 2", () => {
    const { turns } = driveLoop("real", repeating);
    expect(turns).toHaveLength(2);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_SETTLED);
    expect(last(turns).exit).not.toBe(0);
    expect(turns[0].decision).toBe(LOCAL_REVIEW_CONTINUE);
  });

  test("AC-LL2: a reviewer that is new every round stops the loop at the cap", () => {
    const { turns } = driveLoop("real", alwaysNovel);
    expect(turns).toHaveLength(AI_REVIEW_ROUND_CAP + 1);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_AT_CAP);
    expect(last(turns).exit).not.toBe(0);
    for (const t of turns.slice(0, -1)) expect(t.decision).toBe(LOCAL_REVIEW_CONTINUE);
  });

  /**
   * CONTROL-NOEXIT. What the termination above is caused BY.
   *
   * A loop that stops is not evidence that anything stopped it. With
   * `runAnotherRound` forced true the driver has no exit at all and must run
   * to the backstop — on BOTH reviewers, because a row that only held for one
   * of them would leave the other's termination unexplained.
   */
  test("CONTROL-NOEXIT: with the refusal removed neither reviewer ever ends the loop", () => {
    for (const [name, reviewer] of [["repeating", repeating], ["alwaysNovel", alwaysNovel]] as const) {
      const { turns } = driveLoop("noexit", reviewer);
      expect(turns, `${name}: the loop ended with the refusal removed`).toHaveLength(MAX_TURNS);
      expect(last(turns).exit, name).toBe(0);
    }
  });

  /**
   * CONTROL-COUNTONLY. The cheapest wrong fix, failing in a live loop.
   *
   * Nothing is ever a repeat, so only the counter can stop it. The repeating
   * reviewer — four rounds of one class, which is #1304 — then runs to the cap
   * instead of settling at round 2. Two extra review rounds and two extra
   * pushes, which is the cost #1342 was filed about.
   */
  test("CONTROL-COUNTONLY: a round counter alone takes the repeating reviewer to the cap", () => {
    const { turns } = driveLoop("countonly", repeating);
    expect(turns).toHaveLength(AI_REVIEW_ROUND_CAP + 1);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_AT_CAP);
    // And the real decision settles the same reviewer two rounds earlier. The
    // comparison is the claim; either number alone is just a number.
    expect(driveLoop("real", repeating).turns).toHaveLength(2);
  });
});

/**
 * The payload a REAL reviewer writes.
 *
 * `AI_REVIEW_FINDING_FIELDS` — `{severity, file, line, summary,
 * failure_scenario}`. No `title`, no `body`. The first version of this PR
 * read only `lib/finding-arbiter.ts`'s `{id, title, body}` shape and refused
 * everything else as UNMEASURED, so a real payload would have refused on
 * every round and the whole mechanism would have been unreachable on real
 * input — a caller that exists and can never be fed, which is the dormant
 * control one level deeper than #1381's. Reported by the `ai-review` on this
 * PR's second push.
 *
 * These rows drive the SAME loop as the ones above with the SAME classes, in
 * the contract's shape. If the two shapes ever stop agreeing on what a class
 * is, these terminate somewhere else and say so.
 */
const contractA1 = {
  severity: "high",
  file: "lib/issue-filing-gate.ts",
  line: 393,
  summary: "The filing gate reads a different value than `gh` for `headRefOid`",
  failure_scenario:
    "`resolveFiling` compares its own reading against what `gh pr view` returns. Measured over " +
    "38 findings, 12 allowed through.",
};
const contractA2 = {
  severity: "high",
  file: "lib/issue-filing-gate.ts",
  line: 412,
  summary: "`resolveFiling` still disagrees with `gh` about `headRefOid`",
  failure_scenario:
    "Re-measured after the fix: 38 findings, 12 allowed through `resolveFiling`, and the " +
    "`headRefOid` it reads is still not the one `gh` reports.",
};
const contractB = {
  severity: "medium",
  file: "lib/ai-review-rounds.ts",
  line: 533,
  summary: "The ledger evicts its oldest rounds when the comment body overflows",
  failure_scenario:
    "`readLedger` parses a comment capped at 65536 bytes, so round 20 silently drops round 1 " +
    "and the suppression set loses 14 keys.",
};

const contractRepeating = (turn: number) => [turn === 1 ? contractA1 : contractA2];
const contractNovel = (turn: number) => [
  {
    severity: "high",
    file: `lib/module-${turn}.ts`,
    line: turn * 7,
    summary: `\`handler${turn}Value\` drops rows`,
    failure_scenario: `\`handler${turn}Value\` drops ${turn * 11 + 17} of ${turn * 13 + 23} rows.`,
  },
];

describe("the loop reads the payload a real reviewer writes (#1421)", () => {
  test("AC-LL8: the contract's shape is accepted, and one class in it still settles at round 2", () => {
    const { turns } = driveLoop("real", contractRepeating);
    expect(
      turns[0].decision,
      "the first contract-shaped round was refused, so the mechanism never runs on real input",
    ).toBe(LOCAL_REVIEW_CONTINUE);
    expect(turns).toHaveLength(2);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_SETTLED);
  });

  test("AC-LL9: a contract-shaped reviewer that is new every round stops at the cap", () => {
    const { turns } = driveLoop("real", contractNovel);
    expect(turns).toHaveLength(AI_REVIEW_ROUND_CAP + 1);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_AT_CAP);
  });

  test("AC-LL10: a finding carrying neither shape is still UNMEASURED", () => {
    // The widening must not become "accept anything". A payload with no
    // summary and no title names no defect, and recording it as a round that
    // found nothing would clear the loop on an unread finding.
    const { turns } = driveLoop("real", () => [{ severity: "high", line: 4 }]);
    expect(turns).toHaveLength(1);
    expect(turns[0].decision).toBe(LOCAL_REVIEW_UNMEASURED);
  });

  /**
   * AC-LL12 — the `file` half of the synthesised body, isolated.
   *
   * The rows above do not need it, and that is measured rather than assumed:
   * a mutant dropping the file path from the body reddens NOTHING against
   * `contractA1`/`contractA2`, because their prose shares two backticked
   * symbols and `sameSymptom` only needs one shared location key. The first
   * draft of the code comment claimed both halves were load-bearing; half of
   * that was false.
   *
   * These two findings are the case the others cannot see: plain prose, no
   * backticked symbols at all, agreeing only on the file they name and the
   * two integers they report. The file key is the only location key there
   * is, so dropping it takes the pair below the threshold and the loop stops
   * settling — which is a failure that looks like success, two rounds later.
   */
  const plain = (summary: string, scenario: string) => ({
    severity: "high",
    file: "lib/issue-filing-gate.ts",
    line: 393,
    summary,
    failure_scenario: scenario,
  });
  test("AC-LL12: two findings sharing only a file and their readings are still one class", () => {
    const first = plain(
      "The gate reads a different value than the tracker does",
      "Over 38 attempts, 12 allowed through.",
    );
    const second = plain(
      "The gate and the tracker still disagree about the pull request head",
      "Re-measured after the change: 38 attempts, 12 allowed and still wrong.",
    );
    const { turns } = driveLoop("real", turn => [turn === 1 ? first : second]);
    expect(turns).toHaveLength(2);
    expect(last(turns).decision).toBe(LOCAL_REVIEW_SETTLED);
  });

  test("AC-LL11: the two shapes agree about what a class is", () => {
    // The claim the rows above rest on, asserted rather than assumed: the
    // same two classes, expressed both ways, terminate the loop on the same
    // round. A body synthesis that lost the file or the quantities would
    // still "work" — it would just stop settling, two rounds later.
    expect(driveLoop("real", contractRepeating).turns).toHaveLength(2);
    expect(driveLoop("real", repeating).turns).toHaveLength(2);
    expect(driveLoop("real", contractNovel).turns).toHaveLength(AI_REVIEW_ROUND_CAP + 1);
    expect(driveLoop("real", alwaysNovel).turns).toHaveLength(AI_REVIEW_ROUND_CAP + 1);
  });
});

describe("the history is durable, and an unreadable one is not an empty one (#1421)", () => {
  test("AC-LL3: every round the loop ran is on disk afterwards", () => {
    const { turns, history } = driveLoop("real", alwaysNovel);
    const written = JSON.parse(readFileSync(history, "utf-8"));
    expect(Array.isArray(written)).toBe(true);
    expect(
      written,
      "a round the loop ran that the history does not hold makes the next run miscount",
    ).toHaveLength(turns.length);
    for (const entry of written) {
      expect(typeof entry.at).toBe("string");
      expect(Array.isArray(entry.findings)).toBe(true);
    }
  });

  test("AC-LL4: an absent history is round 1 — a measured absence, and the loop proceeds", () => {
    const dir = mkdtempSync(join(SANDBOX, "absent-"));
    const history = join(dir, "nested", "history.json");
    expect(existsSync(history)).toBe(false);
    const { turns } = driveLoop("real", alwaysNovel, { history });
    expect(turns[0].decision).toBe(LOCAL_REVIEW_CONTINUE);
    expect(turns[0].exit).toBe(0);
    expect(existsSync(history), "the first round did not create the history it was told to keep").toBe(true);
  });

  /**
   * The pair that makes AC-LL4 a reading rather than a default. Both yield
   * "no rounds I can see"; only one of them is a reading. A corrupt history
   * read as empty restarts the count at 1 on every turn, which is a cap that
   * can never be reached — the fail-open `roundOutcome` already refuses for
   * an unreadable budget, arriving by a different door.
   */
  const corrupt: Array<[string, string]> = [
    ["truncated JSON", '[{"at":"x","findings":[]'],
    ["an object rather than an array", '{"rounds":[]}'],
    ["not JSON at all", "this is not json"],
    ["an empty file", ""],
  ];
  for (const [name, seed] of corrupt) {
    test(`AC-LL5: a history that is ${name} refuses, and does not restart at round 1`, () => {
      const { turns } = driveLoop("real", alwaysNovel, { seed });
      expect(turns).toHaveLength(1);
      expect(turns[0].decision).toBe(LOCAL_REVIEW_UNMEASURED);
      expect(turns[0].exit).not.toBe(0);
    });
  }

  /**
   * AC-LL7 — a history that EXISTS and cannot be read.
   *
   * Reported by the `ai-review` on this pull request's first push, against
   * `recordThenRead`, and it was right: the read collapsed every failure into
   * `null`, `null` is what an ABSENT history looks like, and the run then
   * recorded round 1 and OVERWROTE the file it had failed to read. The guard
   * that was supposed to catch it tested `typeof existing !== "string"` on a
   * value that could only ever be a string or null, so it was unreachable.
   *
   * Every other corrupt-history row in this file hands the reader bytes it
   * can parse an opinion out of. This one is the case where the read itself
   * fails, which is a different code path and the one nothing covered.
   */
  test("AC-LL7: a history that exists and cannot be read refuses, and survives", () => {
    const dir = mkdtempSync(join(SANDBOX, "unreadable-"));
    const history = join(dir, "history.json");
    const seed = '[{"at":"a","findings":[]}]';
    writeFileSync(history, seed);
    // WRITE-ONLY, not 0o000, and the difference is the whole case. At 0o000
    // the WRITE fails too, so the run refuses on the write-side guard and the
    // file survives for a reason that has nothing to do with the read — the
    // case passes against the defective code, witnessing the wrong mechanism
    // (`.claude/rules/checks-must-be-able-to-fail.md`, sixth shape). It was
    // written that way first and did exactly that. At 0o222 the read fails
    // and the write succeeds, which is the only configuration in which the
    // read-side refusal is the thing being observed.
    chmodSync(history, 0o222);
    try {
      // Both halves of the precondition are ESTABLISHED, not assumed. Running
      // as root — or on a filesystem that ignores the mode — breaks one or
      // both, and the case would then pass having exercised the ordinary
      // path. A vacuous green, so it fails loudly rather than skipping.
      let readable = true;
      try {
        readFileSync(history, "utf-8");
      } catch {
        readable = false;
      }
      expect(
        readable,
        "the history is still readable at mode 0222, so this case cannot reach the " +
          "unreadable-read path and must not be counted as covering it",
      ).toBe(false);
      expect(
        (() => {
          try {
            // `accessSync`, not a trial write: every write flag either needs
            // read permission too (`r+`) or destroys the seed (`w`, `a`), and
            // a control that damages the fixture it is checking is not one.
            accessSync(history, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })(),
        "the history is not writable at mode 0222, so a refusal here could be the " +
          "write-side guard rather than the read-side one",
      ).toBe(true);

      const { turns, reasons } = driveLoop("real", alwaysNovel, { history });
      expect(turns).toHaveLength(1);
      expect(turns[0].decision).toBe(LOCAL_REVIEW_UNMEASURED);
      expect(turns[0].exit).not.toBe(0);
      expect(
        reasons[0],
        "the refusal does not name the READ, so it came from the write-side guard and this " +
          "case is not observing the mechanism it is about",
      ).toMatch(/could not be read/);

      chmodSync(history, 0o600);
      expect(
        readFileSync(history, "utf-8"),
        "the run overwrote a history it could not read, which discards every round it held",
      ).toBe(seed);
    } finally {
      chmodSync(history, 0o600);
    }
  });

  test("AC-LL6: a refused round is not appended — a history nobody could read is not overwritten", () => {
    const dir = mkdtempSync(join(SANDBOX, "keep-"));
    const history = join(dir, "history.json");
    const seed = '[{"at":"x","findings":[]';
    writeFileSync(history, seed);
    driveLoop("real", alwaysNovel, { history });
    expect(
      readFileSync(history, "utf-8"),
      "the refused round overwrote the history it could not read, destroying the evidence " +
        "of how many rounds had already happened",
    ).toBe(seed);
  });
});
