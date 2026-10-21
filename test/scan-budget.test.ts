import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  describeTimeoutDeclarations,
  perTestTimeoutDeclarations,
} from "../lib/per-test-timeouts";
import {
  SCAN_CEILING,
  describeScanBudget,
  measureScan,
  scanBudgetFromBunfig,
  scanBudgetViolations,
  type ScanBudgetReading,
} from "../lib/scan-budget";

/**
 * #804 / #323 — a scan that says what it was doing when it ran out of time.
 *
 * #804's two red `main` runs are the subject:
 *
 *   39391609067 shard 4 — `(fail) #323 SC-6: … is unique per run [5005.68ms]`
 *   39425026505 shard 3 — the same case, `[5172.46ms]`
 *
 * Neither carries a message. A per-test timeout kills the case before any
 * assertion runs, so the one thing in the tree that knew what was slow — the
 * scan's own failure text, which names the file, the offending path and the
 * repair — was never reachable. What an agent sees is a red case named after
 * a rule it has not broken.
 *
 * This file holds the population for the reading that replaces that silence.
 * The cases below are split into WITNESSES, which go red on the pre-#798
 * condition, and CONTROLS, which are green on both sides and exist only to
 * stop a check that refuses everything reading as a check that catches
 * something.
 */

const ROOT = join(import.meta.dir, "..");
const BUDGET = 5000;

/** A reading with every field present, so a case varies exactly one thing. */
function reading(over: Partial<ScanBudgetReading> = {}): ScanBudgetReading {
  return {
    budgetMs: BUDGET,
    elapsedMs: 100,
    filesRead: 400,
    filesTotal: 400,
    root: "test/",
    current: null,
    slowest: { path: "test/a.test.ts", ms: 4 },
    complete: true,
    ...over,
  };
}

describe("#804: the scan reports its own duration against its own budget", () => {
  /**
   * WITNESS. The pair that is the whole of #804, varying ONE field.
   *
   * 3482ms over 378 files is the pre-#798 scan, measured on 2026-10-20 — the
   * cost that took `main` red twice at 5005.68ms and 5172.46ms once a shard
   * loaded it. 174.68ms over 427 files is the same scan on `41d287c5`,
   * measured 2026-10-21 after #798 rewrote it.
   *
   * Both rows carry the same budget and the same ceiling. Only the duration
   * moves, so a green-to-red difference between them is a measurement of the
   * duration and not of anything else (#585).
   */
  test("the pre-#798 cost is reported by name; the cost that replaced it is not", () => {
    const before = scanBudgetViolations(reading({ elapsedMs: 3482, filesRead: 378, filesTotal: 378 }));
    const after = scanBudgetViolations(reading({ elapsedMs: 174.68, filesRead: 427, filesTotal: 427 }));

    expect(after, `174.68ms of a ${BUDGET}ms budget is 3.5% and must not be reported`).toEqual([]);
    expect(before).toHaveLength(1);
    // The three facts #323 asks a failure to leave behind. Asserted as three
    // separate expectations rather than one `toContain` of a whole sentence,
    // so a message that loses one of them names which one it lost.
    expect(before[0], "the measured duration is missing").toContain("3482.00ms");
    expect(before[0], "the budget in force is missing").toContain("5000ms");
    expect(before[0], "the path being scanned is missing").toContain("test/");
  });

  /**
   * WITNESS. The boundary, which is what makes the row above a measurement of
   * the ceiling rather than of two numbers that happen to differ.
   */
  test("the ceiling is the boundary: at it is reported, one millisecond under it is not", () => {
    const at = BUDGET * SCAN_CEILING;
    expect(scanBudgetViolations(reading({ elapsedMs: at }))).toHaveLength(1);
    expect(scanBudgetViolations(reading({ elapsedMs: at - 1 }))).toEqual([]);
  });

  /**
   * WITNESS. The message has to say what to do, or it is an obstacle rather
   * than a check (`.claude/rules/self-referential-tests.md`). It also has to
   * refuse the repair that produced #804 in the first place, in its own text,
   * because the next reader of a red row is the person about to apply it.
   */
  test("the report names the repair and refuses the cheapest wrong one", () => {
    const [v] = scanBudgetViolations(reading({ elapsedMs: 3482 }));
    expect(v, "the report does not say what to do").toContain("Make the scan cheaper");
    expect(v, "the report does not refuse raising the ceiling").toContain("Raising the ceiling");
    expect(v, "the report does not connect a per-test timeout to the #621 blind spot").toContain(
      "proximity reading",
    );
  });

  /**
   * WITNESS. "Which path it was scanning" has two honest answers and the
   * report carries both: the file in hand when the ceiling was crossed, and
   * the costliest file seen. A regression is usually in the second.
   */
  test("the report names the file in hand and the costliest file", () => {
    const [v] = scanBudgetViolations(
      reading({
        elapsedMs: 4000,
        current: "test/huge.test.ts",
        slowest: { path: "test/slowest.test.ts", ms: 980 },
        complete: false,
      }),
    );
    expect(v).toContain("scanning test/huge.test.ts");
    expect(v).toContain("test/slowest.test.ts at 980.00ms");
  });

  // ---- refusals: an unreadable reading is not a clean one --------------

  /**
   * WITNESS for the UNMEASURED path. A budget that could not be read is not a
   * scan that fits inside one. `0`, `null` and silence are indistinguishable
   * from success (`.claude/rules/config-access.md`).
   */
  test("no readable budget is UNMEASURED, not clean", () => {
    for (const budgetMs of [null, 0, NaN]) {
      const v = scanBudgetViolations(reading({ budgetMs, elapsedMs: 10 }));
      expect(v, `a budget of ${budgetMs} was treated as a pass`).toHaveLength(1);
      expect(v[0]).toContain("UNMEASURED");
    }
  });

  /**
   * WITNESS. The #492 shape, and the one this check could most easily acquire
   * by accident: a `readdirSync` filter that stops matching produces a scan
   * that completes in 0ms having read nothing, which is inside every budget.
   */
  test("a completed scan that read no files is UNMEASURED, not fast", () => {
    const v = scanBudgetViolations(reading({ elapsedMs: 0, filesRead: 0, filesTotal: 427 }));
    expect(v, "an empty scan was reported as being inside its budget").toHaveLength(1);
    expect(v[0]).toContain("UNMEASURED");
    expect(v[0], "the refusal does not say how many files it could see").toContain("0 of 427");
  });

  /**
   * WITNESS, and it is the cheapest wrong fix written down as a refusal.
   *
   * The 5pm repair for a red row here is to raise the ceiling. Below 1 that is
   * a judgement call and a reviewer's problem. At or past 1 it is not a
   * widening at all — the runner kills the case at the budget, so a ceiling
   * there can never fire, and the check becomes a line in a report.
   */
  test("a ceiling at or past the budget cannot fire, and is refused as UNMEASURED", () => {
    for (const ceiling of [1.0001, 2, 12]) {
      const v = scanBudgetViolations(reading({ elapsedMs: 10 }), ceiling);
      expect(v, `a ceiling of ${ceiling} was accepted`).toHaveLength(1);
      expect(v[0]).toContain("UNMEASURED");
    }
    // CONTROL: the boundary below it is a legal, if lax, judgement call.
    expect(scanBudgetViolations(reading({ elapsedMs: 10 }), 1)).toEqual([]);
  });

  /** CONTROL. A clean reading describes itself with its own numbers. */
  test("a clean reading still states the duration and the budget", () => {
    const line = describeScanBudget(reading({ elapsedMs: 174.68, filesRead: 427, filesTotal: 427 }));
    expect(line).toContain("MEASURED");
    expect(line).toContain("174.68ms");
    expect(line).toContain("5000ms");
    expect(line).toContain("427 of 427");
  });
});

describe("#323: the evidence is emitted DURING the scan, so a kill cannot take it", () => {
  /**
   * WITNESS, and the one case that is about #323 rather than #804.
   *
   * An assertion after the loop is unreachable on exactly the run that
   * matters. The clock is injected so a scan that spends 5000ms of simulated
   * time costs nothing real — a timing test that had to be slow to prove
   * anything would be the next thing to time out.
   */
  test("the crossing is emitted mid-scan, once, naming the file in hand", () => {
    let t = 0;
    const emitted: string[] = [];
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

    const { reading: r } = measureScan<string>({
      root: "test/",
      files,
      budgetMs: BUDGET,
      read: () => {
        t += 1000;
        return [];
      },
      now: () => t,
      emit: line => emitted.push(line),
    });

    // 5000ms budget, 0.5 ceiling, 1000ms per file: the limit is crossed when
    // the third file completes, with two files still unread.
    expect(emitted, "nothing was emitted before the scan ended").toHaveLength(1);
    expect(emitted[0]).toContain("scanning c.ts");
    expect(emitted[0], "the emitted line does not carry the elapsed time").toContain("3000.00ms");
    expect(emitted[0], "the emitted line does not carry the budget").toContain("5000ms");
    expect(emitted[0], "the emitted line is not attributable").toContain("[#804]");

    // The final reading is the whole scan, and it still reports.
    expect(r.complete).toBe(true);
    expect(r.filesRead).toBe(5);
    expect(scanBudgetViolations(r)).toHaveLength(1);
  });

  /**
   * CONTROL. Without this, the case above is satisfied by an emitter that
   * fires on every scan — which is the failure mode #804's own thread
   * recorded: a line that prints on every run is a line nobody reads.
   */
  test("a scan inside its ceiling emits nothing at all", () => {
    let t = 0;
    const emitted: string[] = [];
    const { reading: r } = measureScan<string>({
      root: "test/",
      files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      budgetMs: BUDGET,
      read: () => {
        t += 10;
        return [];
      },
      now: () => t,
      emit: line => emitted.push(line),
    });
    expect(emitted).toEqual([]);
    expect(scanBudgetViolations(r)).toEqual([]);
  });

  /**
   * CONTROL. `measureScan` has to be a scan as well as a stopwatch. A helper
   * that timed correctly and dropped a file would make every caller quietly
   * narrower, and a narrower scan is faster, so the budget reading would
   * improve as the check got worse.
   */
  test("every file is read and every value is returned", () => {
    const seen: string[] = [];
    const { values, reading: r } = measureScan<string>({
      root: "test/",
      files: ["a.ts", "b.ts", "c.ts"],
      budgetMs: BUDGET,
      read: f => {
        seen.push(f);
        return [`hit:${f}`];
      },
      now: () => 0,
      emit: () => {},
    });
    expect(seen).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(values).toEqual(["hit:a.ts", "hit:b.ts", "hit:c.ts"]);
    expect(r.filesRead).toBe(3);
    expect(r.slowest).not.toBeNull();
  });
});

describe("#804: the SC-6 scan is visible to the #621 proximity reading", () => {
  const SCAN_FILE = "scratch-paths-unique.test.ts";

  /**
   * The detector moved to `lib/per-test-timeouts.ts` in #968, and its
   * fixtures moved with it to `test/per-test-timeouts.test.ts`.
   *
   * It used to be a regex here:
   * `/\}\s*,\s*([0-9_]+)\s*\)\s*;/g`. MEASURED on bun 1.3.14 under
   * `--timeout 300` with a 600ms case — the control is killed and all of
   * `}, TIMEOUT);`, `}, 60 * 1000);`, `}, 60_000)` without a semicolon,
   * `}, { timeout: 5000 });` and `setDefaultTimeout(5000);` run to
   * completion. All five raise the budget exactly as the matched form does,
   * and the regex saw none of them. The guard against reintroducing #802's
   * override was one `const` away from being walked around.
   *
   * The fixtures had to leave this file as well as the regex. They are
   * `}, 60_000)` text, and the live case below reads a sibling file for
   * exactly that text — keeping them here is how a detector and its witness
   * end up being the same bytes.
   */
  test("the detector is wired to the live case, and is not vacuous", () => {
    // A witness that the import above reaches a working reading, without
    // restating the fixtures that test/per-test-timeouts.test.ts owns.
    expect(perTestTimeoutDeclarations('test("ordinary", () => {});\n')).toEqual([]);
    expect(perTestTimeoutDeclarations('test("slow", () => {}, TIMEOUT);\n')).toHaveLength(1);
  });

  /**
   * WITNESS for #804's fix.
   *
   * `lib/junit-checks.ts` says, in its own words, that declaring a per-test
   * timeout SILENCES the proximity row — deliberately, because an 8-second
   * test that says it needs 8 seconds is a decision somebody made. The scan
   * case carried `}, 60_000)` from #802 until this change, which means the one
   * case #804 is about was also the one case #621's instrument could not see.
   *
   * Measured on `41d287c5` before the override came out: 174.68ms over 427
   * files, 3.5% of the 5000ms budget. The override bought nothing and cost the
   * reading.
   */
  test("the scan case declares no budget of its own, in any form", () => {
    const src = readFileSync(join(ROOT, "test", SCAN_FILE), "utf-8");
    const found = perTestTimeoutDeclarations(src);
    // REFUSAL, kept distinct from `[]` (#968). A parser that stopped parsing
    // reports exactly as clean as a file with no overrides, and a clean
    // report from a detector that read nothing is worse than no detector.
    expect(
      found,
      `test/${SCAN_FILE} did not parse, so this reading is UNMEASURED rather than clean`,
    ).not.toBeNull();
    expect(
      found,
      `test/${SCAN_FILE} raises its own budget:\n${describeTimeoutDeclarations(found ?? [])}\n` +
        `A budget of its own deliberately silences timeoutProximityViolations in lib/junit-checks.ts, ` +
        `so the case would be invisible to the one instrument that warns before a kill — which is how ` +
        `#804 happened. Make the scan cheaper instead; lib/scan-budget.ts will say by how much.`,
    ).toEqual([]);
  });

  /**
   * CONTROL against the whole file above being satisfied by a budget nobody
   * declares. `scanBudgetViolations` refuses a null budget, so a bunfig that
   * stopped declaring one would make every live reading UNMEASURED rather
   * than clean — but it would do so silently from this file's point of view.
   */
  test("this repository declares the budget the scan is measured against", () => {
    const declared = scanBudgetFromBunfig(readFileSync(join(ROOT, "bunfig.toml"), "utf-8"));
    expect(declared, "bunfig.toml declares no [test] timeout for the scan to be measured against").toBe(
      BUDGET,
    );
  });
});
