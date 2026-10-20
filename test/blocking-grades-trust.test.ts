/**
 * #188's block decides on free text an LLM authored, and "I could not measure
 * it" is indistinguishable from "there was nothing to find" (#195).
 *
 * That is the exact defect #188 exists to fix, reproduced inside the fix. Two
 * independent background security reviews found it, and all three findings
 * share one root:
 *
 * 1. **Empty reads as clean, and the prompt instructed it.** `ship.js` told
 *    the grader "If no transcripts found, return {"grades": []}". The shape
 *    check is `!Array.isArray(gradeResult.grades)` — and `[]` IS an array, so
 *    a grading step that found no transcripts produced the same verdict as a
 *    run with perfect compliance.
 * 2. **The model is in the data path.** The deterministic work is
 *    `scripts/grade-deterministic.ts`, but what reached the decision was the
 *    agent's SUMMARY of that script's output, cross-checked against nothing.
 * 3. **Parser/validator differential.** `String(entry).split(':')[0]` reads
 *    an id out of prose the agent wrote, not out of the script's grammar.
 *    `"TDD_SEQUENCE_VIOLATED: no green phase"` matches;
 *    `"Marcus violated TDD_SEQUENCE_VIOLATED"` does not, and nothing noticed.
 *    #144's shape, one domain over.
 *
 * **The model does not leave the data path, and #195 AC-4 says it must not.**
 * Per #69 the Workflow sandbox has no filesystem and no exec, so everything
 * arrives through an agent. What changes is that absence stops reading as
 * compliance, and that the summary is checked against the script's own output
 * instead of believed.
 *
 * Three things are trusted from the agent and bounded rather than removed:
 * that it ran the command it was told to, that `rawGradeOutput` is that
 * command's stdout, and that it did not edit the stdout to agree with a
 * summary it also wrote. The first two are the #69 constraint. The third is
 * bounded by making disagreement the refusing direction: a model that wants
 * to hide a violation must now alter two fields consistently rather than
 * omit one.
 *
 * Covers SC-764..768 and SC-773 of INSTRUCTION-COMPLIANCE-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { checkTDD } from "../lib/transcript-checker";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── BLOCKING-GRADES-START ────";
const BLOCK_END = "// ──── BLOCKING-GRADES-END ────";

/** Module scope: a missing marker fails every case here rather than skipping. */
const BLOCK = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("workflows/ship.js is missing the BLOCKING-GRADES markers");
  }
  return shipSource.slice(start + BLOCK_START.length, end);
})();

const REFUSAL_HELPER: string = (() => {
  const START = "// ──── FAILURE-LEDGER-START ────";
  const END = "// ──── FAILURE-LEDGER-END ────";
  const a = shipSource.indexOf(START);
  const b = shipSource.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("ship.js is missing the FAILURE-LEDGER markers");
  const block = shipSource.slice(a, b);
  if (!block.includes("function shipFailed(")) {
    throw new Error("the FAILURE-LEDGER block no longer defines shipFailed");
  }
  return block;
})();

/**
 * ship.js's own line binding the caller's argument to the decision (#197,
 * SC-653). Every case below that injects `SKIP_GRADE` directly says nothing
 * about how that constant gets its value, and this is the line that matters
 * most in the wrong direction: a default flipped to `true` here would switch
 * off every refusal #195 added, on every run, with the whole block still
 * present and every other test in this file still green.
 *
 * Module scope, like the two slicers above it, and for the reason the rules
 * file gives: an extractor that throws from inside a `describe` does not fail
 * its cases, it deletes them — splitting the binding across two lines dropped
 * four tests and the suite reported green over 43.
 */
const SKIP_GRADE_BINDING: string = (() => {
  const pattern = /^const SKIP_GRADE = .*$/gm;
  const found = shipSource.match(pattern);
  if (!found) throw new Error("workflows/ship.js no longer binds SKIP_GRADE on one line");
  if (found.length > 1) throw new Error("workflows/ship.js binds SKIP_GRADE more than once");
  return found[0];
})();

/** Evaluate that one real line against planted caller arguments. */
function bindSkipGrade(parsedArgs: Record<string, unknown>): unknown {
  return new Function("parsedArgs", `${SKIP_GRADE_BINDING}; return SKIP_GRADE`)(parsedArgs);
}

interface Outcome { result: Record<string, any> | undefined; logs: string[] }

async function runBlock(scope: Record<string, unknown> = {}): Promise<Outcome> {
  const logs: string[] = [];
  const full: Record<string, unknown> = {
    log: (m: unknown) => logs.push(String(m)),
    SKIP_GRADE: false,
    ISSUE: 195,
    SLUG: "pai-harness-195",
    WORK_DIR: "/tmp/pai-harness-195",
    SPAWNED_ROLES: new Set<string>(),
    // #232: shipFailed preserves before it returns. Stubbed — see
    // test/preserve-every-exit.test.ts for the claim that it does.
    preserveSeenWorktrees: async () => ({ preserved: [], detail: '' }),
    restorePrimaryCheckout: async () => ({ reading: 'UNCHANGED', restoreOutcome: 'ALREADY_ON_START', lines: [] }),
    gradeResult: cleanResult(),
    ...scope,
  };
  const sandbox = new Proxy(full, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined
      : k in t ? t[k as string] : (globalThis as any)[k as string]),
  });
  const factory = new Function("__scope__",
    `return (async function () { with (__scope__) {
${REFUSAL_HELPER}
${BLOCK}
return { __shipped: true }
} })()`);
  return { result: (await factory(sandbox)) as any, logs };
}

const shipped = (o: Outcome) => o.result?.__shipped === true;
const refused = (o: Outcome) => o.result?.status === "SHIP_FAILED";
const why = (o: Outcome) => String(o.result?.immediateReason ?? "");

// ── Fixtures ────────────────────────────────────────────────────────────

const call = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

/** Derived from lib/transcript-checker.ts, never typed out — see #188's file. */
const TDD_FLAG = (() => {
  const tdd = checkTDD([
    call("Write", { file_path: "test/widget.test.ts" }),
    call("Bash", { command: "bun test test/widget.test.ts" }),
    call("Edit", { file_path: "lib/widget.ts" }),
  ].join("\n"));
  if (tdd.verdict !== "TEST_AFTER") throw new Error(`fixture no longer violates TDD (${tdd.verdict})`);
  return `TDD_SEQUENCE_VIOLATED: ${tdd.evidence}`;
})();

/** What a clean, fully-populated grading step produces. The positive control. */
function cleanResult(roles = ["marcus"]) {
  return {
    grades: roles.map(role => ({ role, total: 12, followed: 12, flagged: [], violationIds: [] })),
    rawGradeOutput: roles.map(r => `${r}: 12/12 rules followed`).join("\n"),
  };
}

// ── SC-764: a measurement that did not happen is not a pass ─────────────

describe("#195 SC-764: empty and partial grades are failures, not clean runs", () => {
  test("AC-2: the literal instruction's output refuses", async () => {
    // `{"grades": [], "efficiency": null, "timing": []}` is what ship.js:4349
    // told the agent to return when it found no transcripts.
    const o = await runBlock({ gradeResult: { grades: [], efficiency: null, timing: [] } });
    expect(refused(o)).toBe(true);
    expect(why(o)).toMatch(/BLOCKING_GRADE/);
  });

  test("a grades array missing a role the run spawned is refused", async () => {
    const o = await runBlock({
      SPAWNED_ROLES: new Set(["marcus", "quinn"]),
      gradeResult: { ...cleanResult(["marcus"]) },
    });
    expect(refused(o)).toBe(true);
    expect(why(o)).toContain("quinn");
    expect(why(o)).toContain("no grade for");
  });

  test("...and every spawned role present still ships", async () => {
    // Without this the case above is satisfied by refusing every run.
    const o = await runBlock({
      SPAWNED_ROLES: new Set(["marcus", "quinn"]),
      gradeResult: cleanResult(["marcus", "quinn"]),
    });
    expect(shipped(o), why(o)).toBe(true);
  });

  test("a role the run never spawned is not demanded", async () => {
    // rook is optional; demanding a grade for an agent that never ran would
    // refuse every run that did not need a security review.
    const o = await runBlock({ SPAWNED_ROLES: new Set(["marcus"]), gradeResult: cleanResult(["marcus"]) });
    expect(shipped(o), why(o)).toBe(true);
  });

  test("an empty grades array refuses even when the raw output is present", async () => {
    // Without this the AC-2 case above passes for the wrong reason: that
    // fixture has no rawGradeOutput either, so removing the empty-grades
    // branch entirely left every test green. Measured at 0 red.
    //
    // This is the realistic shape — the grader ran, printed something, and
    // reported no grades at all.
    const o = await runBlock({
      gradeResult: { grades: [], rawGradeOutput: "no agent-*.jsonl files matched; graded nothing" },
    });
    expect(refused(o)).toBe(true);
    expect(why(o)).toContain("empty");
  });

  test("the prompt no longer instructs the agent to report emptiness as success", () => {
    // SC-767. Source-text, and deliberately so: the instruction IS the
    // defect, and no fixture can observe a prompt.
    expect(shipSource).not.toContain('If no transcripts found, return {"grades": []');
    expect(shipSource, "the grade prompt must say that finding no transcripts is a failure")
      .toMatch(/transcripts.{0,200}FAIL|FAIL.{0,200}transcripts/s);
  });
});

// ── SC-765: the id is a field, not a prefix split out of prose ──────────

describe("#195 SC-765: the blocking decision reads a structured id", () => {
  test("a violation the prose parser cannot extract still blocks", async () => {
    // #144's shape. The agent wrote the sentence; the grammar was never
    // guaranteed. This string defeats `split(':')[0]` completely.
    const o = await runBlock({
      gradeResult: {
        grades: [{
          role: "marcus", total: 12, followed: 9,
          flagged: ["Marcus violated TDD_SEQUENCE_VIOLATED while writing lib/widget.ts"],
          violationIds: ["TDD_SEQUENCE_VIOLATED"],
        }],
        rawGradeOutput: "marcus: TDD_SEQUENCE_VIOLATED: no test run after writing source",
      },
    });
    expect(refused(o)).toBe(true);
    expect(why(o)).toContain("TDD_SEQUENCE_VIOLATED");
  });

  test("the canonical prose form still blocks — the parser is a cross-check, not a replacement", async () => {
    const o = await runBlock({
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 9, flagged: [TDD_FLAG], violationIds: ["TDD_SEQUENCE_VIOLATED"] }],
        rawGradeOutput: `marcus: ${TDD_FLAG}`,
      },
    });
    expect(refused(o)).toBe(true);
  });

  test("a grade with no violationIds field at all is a failed measurement", async () => {
    // Absence is the thing this issue is about. An older grader that cannot
    // produce the field has not produced evidence of compliance.
    const o = await runBlock({
      gradeResult: { grades: [{ role: "marcus", total: 12, followed: 12, flagged: [] }], rawGradeOutput: "ok" },
    });
    expect(refused(o)).toBe(true);
    expect(why(o)).toContain("violationIds");
  });

  test("AC-5: the blocking set is not widened — an advisory id still ships", async () => {
    const o = await runBlock({
      gradeResult: {
        grades: [{
          role: "marcus", total: 12, followed: 10,
          flagged: ["COMP-9: Tool call budget", "DIR-L29: Run full suite at most twice"],
          violationIds: ["COMP-9", "DIR-L29"],
        }],
        rawGradeOutput: "marcus: COMP-9: Tool call budget\nmarcus: DIR-L29: Run full suite at most twice",
      },
    });
    expect(shipped(o), why(o)).toBe(true);
  });
});

// ── SC-766: the summary is checked against the script's own output ──────

describe("#195 SC-766: a summary that disagrees with the raw output refuses", () => {
  test("clean grades over a raw output naming a blocking violation refuses", async () => {
    // The finding this is for: the agent summarises the script, and nothing
    // compared the two. A summary saying "clean" over a script that printed
    // TDD_SEQUENCE_VIOLATED is the case worth catching.
    const o = await runBlock({
      gradeResult: {
        ...cleanResult(["marcus"]),
        rawGradeOutput: "marcus: TDD_SEQUENCE_VIOLATED: no test run after writing source (missing green phase)",
      },
    });
    expect(refused(o)).toBe(true);
    expect(why(o)).toMatch(/disagree/i);
  });

  test("a missing rawGradeOutput is a failed measurement, not a clean one", async () => {
    const o = await runBlock({ gradeResult: { grades: cleanResult().grades } });
    expect(refused(o)).toBe(true);
    expect(why(o)).toContain("rawGradeOutput");
  });

  test("an empty rawGradeOutput is refused too", async () => {
    const o = await runBlock({ gradeResult: { ...cleanResult(), rawGradeOutput: "   " } });
    expect(refused(o)).toBe(true);
  });

  test("agreement ships — the cross-check is not a refuse-everything", async () => {
    const o = await runBlock({ gradeResult: cleanResult(["marcus"]) });
    expect(shipped(o), why(o)).toBe(true);
  });

  test("an id that merely CONTAINS a blocking id does not trip the cross-check", async () => {
    // Found by #188's own declared-set case, which uses this exact string to
    // prove the blocking set is a list and not a prefix match. A substring
    // cross-check fires on it and refuses a correct run — and a gate that
    // refuses correct runs gets switched off, which is how a gate dies.
    const o = await runBlock({
      gradeResult: {
        ...cleanResult(["marcus"]),
        rawGradeOutput: "marcus: NOT_TDD_SEQUENCE_VIOLATED_EITHER: a different id entirely",
      },
    });
    expect(shipped(o), why(o)).toBe(true);
  });

  test("...and the real id inside ordinary prose still trips it", async () => {
    // The inverse mistake: a token match so strict that the id only counts
    // when it stands alone would make the cross-check unfirable.
    const o = await runBlock({
      gradeResult: {
        ...cleanResult(["marcus"]),
        rawGradeOutput: "FAIL marcus [TDD_SEQUENCE_VIOLATED] missing green phase.",
      },
    });
    expect(refused(o)).toBe(true);
  });

  test("an advisory id in the raw output does not trip the cross-check", async () => {
    // Only the BLOCKING set is compared. Comparing everything would make any
    // wording difference between script and summary a refusal.
    const o = await runBlock({
      gradeResult: { ...cleanResult(["marcus"]), rawGradeOutput: "marcus: COMP-9: Tool call budget" },
    });
    expect(shipped(o), why(o)).toBe(true);
  });
});

// ── SC-768: the roles come from the run, not from the harness ──────────

describe("#195 SC-768: ship.js actually records the roles it spawns", () => {
  /**
   * Every case above injects `SPAWNED_ROLES` into the sandbox, and all of
   * them stay green when `timedAgent` stops recording it — the one call site
   * that makes the role-coverage check real. Measured at 0 red.
   *
   * So the AGENT-TIMING block is sliced out and EXECUTED, and the set is read
   * back from the block's own value rather than from anything this file keeps
   * in step by hand.
   */
  const TIMING_BLOCK = (() => {
    const START = "// ──── AGENT-TIMING-START ────";
    const END = "// ──── AGENT-TIMING-END ────";
    const a = shipSource.indexOf(START);
    const b = shipSource.indexOf(END);
    if (a === -1 || b === -1 || b <= a) throw new Error("ship.js is missing the AGENT-TIMING markers");
    const block = shipSource.slice(a + START.length, b);
    if (!block.includes("async function timedAgent(")) {
      throw new Error("the AGENT-TIMING block no longer defines timedAgent");
    }
    return block;
  })();

  async function spawnThrough(calls: Array<Record<string, unknown>>): Promise<string[]> {
    const scope: Record<string, unknown> = {
      log: () => {},
      agent: async () => ({}),
      TIMING_SCRIPT: "/bin/true",
      TIMING_ARTIFACT: "/tmp/timing.json",
      shellQuote: (s: string) => s,
      // #232: timedAgent records any worktree an agent reports. Stubbed —
      // test/preserve-every-exit.test.ts owns the claim that it does.
      noteWorktrees: () => {},
      // In the scope, not a parameter: the Proxy's `has` returns true for
      // every name, so `with` captures any identifier the factory takes and
      // resolves it through the Proxy to undefined.
      __calls__: calls,
    };
    const sandbox = new Proxy(scope, {
      has: () => true,
      get: (t, k) => (k === Symbol.unscopables ? undefined
        : k in t ? t[k as string] : (globalThis as any)[k as string]),
    });
    const factory = new Function("__scope__",
      `return (async function () { with (__scope__) {
${TIMING_BLOCK}
for (const c of __calls__) await timedAgent('x', c)
return [...SPAWNED_ROLES]
} })()`);
    return (await factory(sandbox)) as string[];
  }

  test("a call carrying a role records it", async () => {
    const roles = await spawnThrough([{ label: "marcus", role: "marcus" }]);
    expect(roles).toEqual(["marcus"]);
  });

  test("every distinct role in a run is recorded, once each", async () => {
    const roles = await spawnThrough([
      { label: "marcus", role: "marcus" },
      { label: "marcus-fix-1", role: "marcus" },
      { label: "quinn-local-1", role: "quinn" },
    ]);
    expect(roles.sort()).toEqual(["marcus", "quinn"]);
  });

  test("a call with no role records nothing — the ceremony agents are not graded roles", async () => {
    // `ctx-marcus`, `grade` and friends go through the same door and are not
    // roles. Recording them would demand a grade for every helper call.
    expect(await spawnThrough([{ label: "grade" }, { label: "ctx-marcus" }])).toEqual([]);
  });
});

// ── AC-3: skipGrade is an authorised opt-out and stays one ──────────────

describe("#195 AC-3: skipGrade still ships, and still says nothing was checked", () => {
  test("a skipped run ships even with no grades at all", async () => {
    const o = await runBlock({ SKIP_GRADE: true, gradeResult: null, SPAWNED_ROLES: new Set(["marcus"]) });
    expect(shipped(o), why(o)).toBe(true);
    expect(o.logs.join("\n")).toContain("NO blocking-grade check ran");
  });

  test("the caller's skipGrade argument is what reaches the decision", () => {
    expect(bindSkipGrade({ skipGrade: true })).toBe(true);
  });

  test("grading is on unless the caller asks for it off", () => {
    // Both the absent key and an explicit false, because a binding that read
    // the wrong key name would pass the first on its own.
    expect(bindSkipGrade({})).toBe(false);
    expect(bindSkipGrade({ skipGrade: false })).toBe(false);
    expect(bindSkipGrade({ skipGrading: true })).toBe(false);
  });

  test("the binding feeds the block it is read by", async () => {
    // The two halves joined: the argument the skill passes, carried through
    // ship.js's own line into ship.js's own decision block.
    const skipped = await runBlock({
      SKIP_GRADE: bindSkipGrade({ skipGrade: true }),
      gradeResult: null,
      SPAWNED_ROLES: new Set(["marcus"]),
    });
    expect(shipped(skipped), why(skipped)).toBe(true);
    expect(skipped.logs.join("\n")).toContain("NO blocking-grade check ran");

    // ...and the same path with the flag absent must still refuse, or the
    // case above is proving nothing about skipGrade.
    const graded = await runBlock({
      SKIP_GRADE: bindSkipGrade({}),
      gradeResult: null,
      SPAWNED_ROLES: new Set(["marcus"]),
    });
    expect(shipped(graded), why(graded)).toBe(false);
    expect(graded.logs.join("\n")).not.toContain("NO blocking-grade check ran");
  });
});
