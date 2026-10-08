/**
 * #188 — a compliance grade can now stop a run.
 *
 * workflows/ship.js computed grades, logged them, persisted them, fed the
 * brief hill-climb with them and returned them in the run summary. Nothing
 * read them to decide anything. On run wf_5dd989db-fda Marcus was graded
 * TDD_SEQUENCE_VIOLATED — "no test run after writing source (missing green
 * phase)" — which means the `regressions: 0` that run reported came from a
 * suite run predating its final source change. The harness scored that, wrote
 * it to disk, opened a PR, passed the ship gate, reported SHIPPED, and CI went
 * red. Same shape as #129: a measurement that reaches the transcript and
 * nothing that can refuse.
 *
 * The block under test is EXECUTED, not grepped. "ship.js contains
 * TDD_SEQUENCE_VIOLATED" stays true after the refusal is reduced to a log
 * line, which is the whole failure mode this file exists to rule out — see
 * PROJECT-STATE.md's WATCH item, where every mutation that survived a first
 * pass in this repo was a source-text assertion. ship.js is not importable
 * (the Workflow sandbox has no module loading, #69), so the marked block is
 * sliced out and run with `new Function` over a Proxy scope, the same way
 * test/security-verdict-blocks.test.ts and test/ship-collect-destination.test.ts
 * do it.
 *
 * ship.js is resolved from this file's own directory, never from HARNESS_ROOT:
 * under worktree isolation that variable can point at a different checkout
 * than the one being graded (#190).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { checkTDD } from "../lib/transcript-checker";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── BLOCKING-GRADES-START ────";
const BLOCK_END = "// ──── BLOCKING-GRADES-END ────";

/**
 * Module scope on purpose: if the markers go missing this throws while the
 * file is loading and every test in it fails, rather than each test quietly
 * skipping. A harness that no-ops when its target moves is the decorative
 * check .claude/rules/checks-must-be-able-to-fail.md is about.
 */
const BLOCK = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("workflows/ship.js is missing the BLOCKING-GRADES-START / BLOCKING-GRADES-END markers");
  }
  return shipSource.slice(start + BLOCK_START.length, end);
})();

interface Outcome {
  result: Record<string, any> | undefined;
  logs: string[];
}

/**
 * Run one copy of the block over a sandbox.
 *
 * `with` over a Proxy rather than a parameter list: the block declares names
 * with `const`, and a parameter list of the same name is a SyntaxError. Names
 * the sandbox does not carry fall through to the real globals, so `String`,
 * `Array` and friends still resolve.
 *
 * The tail `return` is how a run that is ALLOWED to ship is observed, and it
 * doubles as the read-out of the declared blocking set — the block's own
 * value, not a copy this file keeps in step by hand. A refusal returns
 * `{ status: 'SHIP_FAILED', ... }` before ever reaching it.
 */
async function runBlock(block: string, scope: Record<string, unknown> = {}): Promise<Outcome> {
  const logs: string[] = [];
  const full: Record<string, unknown> = {
    log: (m: unknown) => logs.push(String(m)),
    SKIP_GRADE: false,
    ISSUE: 188,
    SLUG: "pai-harness-188",
    WORK_DIR: "/tmp/pai-harness-188",
    gradeResult: { grades: [] },
    ...scope,
  };
  const sandbox = new Proxy(full, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      return key in target
        ? target[key as string]
        : (globalThis as unknown as Record<string, unknown>)[key as string];
    },
  });
  const factory = new Function(
    "__scope__",
    `return (async function () { with (__scope__) {
${block}
return { __shipped: true, blockingSet: typeof BLOCKING_GRADE_VIOLATIONS === 'undefined' ? null : BLOCKING_GRADE_VIOLATIONS }
} })()`,
  );
  const result = (await factory(sandbox)) as Record<string, any> | undefined;
  return { result, logs };
}

const shipped = (o: Outcome) => o.result?.__shipped === true;
const refused = (o: Outcome) => o.result?.status === "SHIP_FAILED";

// ── Fixtures ────────────────────────────────────────────────────────────

/** One jsonl transcript line carrying a single tool call. */
function call(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

/**
 * The flagged string is DERIVED, not typed out.
 *
 * grade-deterministic.ts:206 writes `TDD_SEQUENCE_VIOLATED: ${evidence}` from
 * checkTDD's own output. Hardcoding the evidence here would leave this file
 * green after a reword in lib/transcript-checker.ts that production stopped
 * matching — a fixture drifting away from the thing it stands in for.
 */
const TDD_FLAG = (() => {
  const transcript = [
    call("Write", { file_path: "test/widget.test.ts" }),
    call("Bash", { command: "bun test test/widget.test.ts" }),
    call("Edit", { file_path: "lib/widget.ts" }),
  ].join("\n");
  const tdd = checkTDD(transcript);
  if (tdd.verdict !== "TEST_AFTER") {
    throw new Error(`fixture transcript no longer produces a TDD violation (verdict ${tdd.verdict})`);
  }
  return `TDD_SEQUENCE_VIOLATED: ${tdd.evidence}`;
})();

const violatingGrades = () => ({
  grades: [{ role: "marcus", total: 12, followed: 9, flagged: [TDD_FLAG] }],
});

/**
 * COMP-9 is "Tool call budget" (lib/compliance-report.ts) — a heuristic about
 * how expensive a run was, not a claim that anything it reported is false.
 * COMP-2 is the suite-run limit, same category. Both must stay advisory.
 */
const advisoryGrades = () => ({
  grades: [
    { role: "marcus", total: 12, followed: 10, flagged: ["COMP-9: Tool call budget", "COMP-2: Full test suite run limit"] },
    { role: "quinn", total: 6, followed: 5, flagged: ["DIR-L29: Run full suite at most twice"] },
  ],
});

// ── AC-1 / AC-3: the grade reaches a decision ───────────────────────────

describe("AC-1: a run whose test evidence predates its final source change is refused", () => {
  test("the evidence lib/transcript-checker.ts actually emits is what blocks", async () => {
    expect(TDD_FLAG).toContain("no test run after writing source (missing green phase)");
  });

  test("the block returns SHIP_FAILED before record-env-and-pr can run", async () => {
    const outcome = await runBlock(BLOCK, { gradeResult: violatingGrades() });
    expect(refused(outcome)).toBe(true);
    expect(shipped(outcome)).toBe(false);
  });

  test("the refusal names the violation and the role", async () => {
    const outcome = await runBlock(BLOCK, { gradeResult: violatingGrades() });
    expect(String(outcome.result?.reason)).toContain("TDD_SEQUENCE_VIOLATED");
    expect(String(outcome.result?.reason)).toContain("marcus");
    expect(outcome.logs.join("\n")).toContain("TDD_SEQUENCE_VIOLATED");
  });

  /**
   * The positive control, and it is load-bearing: a blocking set containing
   * every rule refuses every run, which passes every "it refused" test above
   * while breaking the harness outright.
   */
  test("a run with only advisory violations still ships", async () => {
    const outcome = await runBlock(BLOCK, { gradeResult: advisoryGrades() });
    expect(shipped(outcome)).toBe(true);
    expect(refused(outcome)).toBe(false);
  });

  test("a clean run ships", async () => {
    const outcome = await runBlock(BLOCK, {
      gradeResult: { grades: [{ role: "marcus", total: 12, followed: 12 }] },
    });
    expect(shipped(outcome)).toBe(true);
  });

  test("one violating role among passing roles still refuses", async () => {
    const outcome = await runBlock(BLOCK, {
      gradeResult: {
        grades: [
          { role: "quinn", total: 6, followed: 6, flagged: ["COMP-9: Tool call budget"] },
          { role: "marcus", total: 12, followed: 9, flagged: [TDD_FLAG] },
        ],
      },
    });
    expect(refused(outcome)).toBe(true);
  });
});

// ── AC-2: the set is named, and narrow ──────────────────────────────────

describe("AC-2: the declared blocking set", () => {
  test("is non-empty and contains TDD_SEQUENCE_VIOLATED", async () => {
    const outcome = await runBlock(BLOCK);
    expect(Array.isArray(outcome.result?.blockingSet)).toBe(true);
    expect(outcome.result?.blockingSet.length).toBeGreaterThan(0);
    expect(outcome.result?.blockingSet).toContain("TDD_SEQUENCE_VIOLATED");
  });

  test("excludes COMP-9, so the advisory majority stays advisory", async () => {
    const outcome = await runBlock(BLOCK);
    expect(outcome.result?.blockingSet).not.toContain("COMP-9");
  });

  test("matches the id before the colon, not the whole flagged string", async () => {
    // Real entries are `${id}: ${evidence}` and the evidence varies run to
    // run. An equality match would never fire in production.
    const outcome = await runBlock(BLOCK, {
      gradeResult: { grades: [{ role: "marcus", total: 1, followed: 0, flagged: ["TDD_SEQUENCE_VIOLATED: something else entirely"] }] },
    });
    expect(refused(outcome)).toBe(true);
  });

  test("a flagged id that merely contains a blocking id does not block", async () => {
    const outcome = await runBlock(BLOCK, {
      gradeResult: { grades: [{ role: "marcus", total: 1, followed: 0, flagged: ["NOT_TDD_SEQUENCE_VIOLATED_EITHER: x"] }] },
    });
    expect(shipped(outcome)).toBe(true);
  });
});

// ── AC-7 (process rule 4): an absent grade is handled deliberately ──────

describe("an absent grade", () => {
  test("skipGrade=true does not refuse, and says so rather than passing silently", async () => {
    const outcome = await runBlock(BLOCK, { SKIP_GRADE: true, gradeResult: null });
    expect(shipped(outcome)).toBe(true);
    expect(outcome.logs.join("\n")).toContain("GRADE BLOCK");
  });

  test("grading that was NOT opted out of but produced nothing refuses", async () => {
    // skipGrade is a caller-supplied flag — an authorised opt-out. A missing
    // grade without it means the grading step itself failed, and "we could not
    // measure it" is not "it passed".
    const outcome = await runBlock(BLOCK, { SKIP_GRADE: false, gradeResult: null });
    expect(refused(outcome)).toBe(true);
  });

  test("a malformed grades payload refuses rather than reading as clean", async () => {
    const outcome = await runBlock(BLOCK, { SKIP_GRADE: false, gradeResult: { grades: "none" } });
    expect(refused(outcome)).toBe(true);
  });

  test("a grade with no flagged array at all is clean, not malformed", async () => {
    const outcome = await runBlock(BLOCK, { gradeResult: { grades: [{ role: "marcus", total: 3, followed: 3 }] } });
    expect(shipped(outcome)).toBe(true);
  });
});

// ── AC-5: the refusal is proven able to fail ────────────────────────────

/**
 * Build a copy of the block with the blocking set emptied.
 *
 * The mutation is the removal of the refusal, performed and observed. Without
 * it, "the block refused" and "the block refuses everything for an unrelated
 * reason" are indistinguishable — and so is "the block was deleted and the
 * assertion now reads a stale fixture".
 *
 * Two properties are asserted rather than assumed, both taken from
 * .claude/rules/checks-must-be-able-to-fail.md: the set is declared exactly
 * once, so no second hardcoded id can bypass the mutation; and the mutation
 * actually changes the source, so a set that is already empty aborts the file
 * instead of passing quietly.
 */
const DECLARATION = /const\s+BLOCKING_GRADE_VIOLATIONS\s*=\s*\[[^\]]*\]/g;

function mutantBlock(): string {
  const found = BLOCK.match(DECLARATION) || [];
  if (found.length !== 1) {
    throw new Error(
      `could not build the mutant — expected exactly one BLOCKING_GRADE_VIOLATIONS array literal in the marked block, found ${found.length}`,
    );
  }
  const mutated = BLOCK.replace(DECLARATION, "const BLOCKING_GRADE_VIOLATIONS = []");
  if (mutated === BLOCK) {
    throw new Error("could not build the mutant — the blocking set is already empty, so there is nothing to remove");
  }
  return mutated;
}

describe("AC-5: the mutant ships where the real block refuses", () => {
  test("the mutant can be built at all", () => {
    expect(mutantBlock()).not.toBe(BLOCK);
  });

  test("real block refuses the TDD violation, mutant ships it", async () => {
    const real = await runBlock(BLOCK, { gradeResult: violatingGrades() });
    const mutant = await runBlock(mutantBlock(), { gradeResult: violatingGrades() });

    expect(refused(real)).toBe(true);
    expect(shipped(mutant)).toBe(true);
    expect(mutant.result?.blockingSet).toEqual([]);
  });

  test("the mutant is not a no-op elsewhere: it still ships an advisory-only run", async () => {
    // Guards the inverse mistake — a mutant that refuses everything would make
    // the comparison above pass for the wrong reason.
    const mutant = await runBlock(mutantBlock(), { gradeResult: advisoryGrades() });
    expect(shipped(mutant)).toBe(true);
  });
});

// ── Ordering: the refusal is upstream of PR creation ────────────────────

describe("the block sits where it can stop a PR", () => {
  test("the marked block precedes the record-env-and-pr step and the ship gate", () => {
    const block = shipSource.indexOf(BLOCK_START);
    const pr = shipSource.indexOf("record-env-and-pr");
    const shipPhase = shipSource.indexOf("phase('Ship')");
    expect(block).toBeGreaterThan(-1);
    expect(pr).toBeGreaterThan(block);
    expect(shipPhase).toBeGreaterThan(block);
  });

  test("it runs after grading, so there is a grade to read", () => {
    const grade = shipSource.indexOf("let gradeResult = null");
    expect(grade).toBeGreaterThan(-1);
    expect(shipSource.indexOf(BLOCK_START)).toBeGreaterThan(grade);
  });
});
