/**
 * #323 SC-5 — ten consecutive runs on an unchanged tree, read rather than
 * eyeballed.
 *
 * The issue is not "a test flaked". It is that **the number every PR in that
 * stretch was measured against is unreliable and nobody can say by how
 * much**: one of three consecutive full-suite runs on `main` reported 1
 * failure, the failure was never captured, and the only surviving difference
 * between the runs is that the failing one executed 384 more `expect()`
 * calls than either clean one.
 *
 * SC-3 shipped in #788: a failure is now NAMED rather than counted. This is
 * SC-5 — the series that says whether the suite is stable — and the half of
 * SC-4 that is still reachable: the assertion count is now a field, so the
 * next delta is a reading instead of something somebody notices by accident
 * nine days later.
 *
 * ## What is NOT fixable here, stated first
 *
 * SC-1, SC-2 and the rest of SC-4 ask which test failed on 2026-10-11 and
 * why. That tree is hundreds of commits gone and the suite is three times
 * the size; there is no checkout on which the question can be asked. Saying
 * so is the honest half — `.claude/rules/checks-must-be-able-to-fail.md`:
 * *"this cannot be checked" is a claim, and it is checkable.* The population
 * splits, and the half the repo can own is enforced here.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **`for i in $(seq 10); do bun test 2>&1 | grep -q "0 fail" && echo ok;
 * done`.** It is three minutes of work, it produces the ten lines SC-5 asks
 * for, and it is approximately what produced the 2026-10-11 reading this
 * issue exists about.
 *
 * Three cases here do not survive it, and each is a different hole:
 *
 * - **AC-2** — a run that discovered nothing to execute. `Ran 0 tests across
 *   1 file.` exits 0, prints a literal ` 0 fail`, and is #490's shape: the
 *   grep reports a clean run and `readSuiteRun` reports UNMEASURED. The two
 *   instruments give OPPOSITE answers, which is what makes it the witness
 *   rather than merely the stricter reading.
 * - **AC-3** — the tree moving between runs. Ten green runs over three
 *   different trees is not a series, and a loop cannot see it at all.
 * - **AC-5** — the assertion-count delta, which is the issue's own stated
 *   lead and which no pass/fail grep can express.
 *
 * ## What this does NOT catch, said here rather than left as an omission
 *
 * The first draft of AC-2 used a different fixture: an outer run killed
 * mid-stream whose log still carries a NESTED suite's `1 pass / 0 fail`,
 * captured by one of the tests here that drives `bun test` in a subprocess.
 * **`readSuiteRun` reads that as a clean run**, and the case went red as
 * written — recorded rather than quietly replaced, because the reason is
 * the interesting part.
 *
 * It is not a bug in the reader and it is not fixable here. `lastMatch` over
 * the whole document is deliberate (#307): the outer run's summary is
 * normally the last thing printed, so the last summary is the right one to
 * read. When the outer run never printed one, the nested summary IS the last
 * thing in the log and there is no information in the text distinguishing
 * the two. Claiming to catch it would be a check that cannot fail.
 *
 * So the honest scope: a series is protected against a run that printed no
 * summary and against one that executed nothing, and it is NOT protected
 * against a run killed after a subprocess printed a summary of its own.
 * #690 is the issue about the thing doing that killing.
 *
 * ## Two decisions, made rather than left open
 *
 * - **FLAKY and FAILING are different verdicts.** A suite that fails every
 *   run is red, which is an ordinary thing to be and is somebody's build to
 *   fix. A suite that fails some runs is the defect this issue is about. One
 *   word for both would make the series unable to report its own subject.
 * - **The assertion count is reported BESIDE the verdict, not folded into
 *   it.** A varying count over otherwise-clean runs means some test did a
 *   different amount of work, which is a finding; it is not, on its own,
 *   evidence that anything is wrong, because a case enumerating a directory
 *   legitimately varies. Folding it into the verdict would make one of those
 *   two readings unavailable. Two facts, two fields, one sentence carrying
 *   both — and `UNREPORTED` as a first-class third value, because a runner
 *   that printed no count and a runner whose count held steady are opposite
 *   facts and `0` is the value that would let a reader add them together.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/suite-run-reading.test.ts`. Counts predicted in
 * `/tmp/323b/predictions.md` before the battery ran, and **the baseline row
 * read first** — an instrument that has stopped reporting takes the baseline
 * down with it, and that is the row nobody mutates anything to produce.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | read first | **42 pass, 0 fail** | — |
 * | M1 `flakeReading` short-circuited to a CONSISTENT/STABLE verdict | 12 | **12 of 42** | every refusing fixture; the signature-key, reader, script and workflow cases are a different binding and stay green |
 * | M2 the unmeasured-run loop removed | 2 | **2 of 42** | a ten-run series whose run 4 printed ` 0 pass / 0 fail / Ran 0 tests` — the original is UNMEASURED, the mutant reads the other nine and reports CONSISTENT |
 * | M3 the tree-signature block removed | 2 | **2 of 42** | a ten-run series whose run 7 carries `.spec-collection-scratch/x` as a dirty path |
 * | M4 the short-series check removed | 2 | **2 of 42** | three runs where ten were asked for; and the empty series, where zero clean runs out of zero is perfect agreement |
 * | M5 FLAKY collapsed into FAILING | 1 | **1 of 42** | nine clean runs and a tenth that fails: the original says FLAKY, the mutant says all ten failed |
 * | M6 assertion stability hardcoded to STABLE | 2 | **2 of 42** | two clean runs reporting 13648 and 14032; and a pair whose runner reported no count at all |
 * | M7 `expectCalls` last-matched over the document instead of the summary slice | 1 | **1 of 42** | a run whose own summary omits the assertion line while its captured nested output reports 7 — the original reads null, the mutant reads 7 |
 * | M8 `expectCalls` never read | 5 | **6 of 42** | any real bun summary |
 *
 * **M8 came back HIGH, and the extra red is the real kind.** The six are
 * named: both AC-1 cases, both assertion cases in AC-5, and in AC-6 both
 * *"the real reader finds the count"* and *"the control: an outer summary
 * that DOES carry a count"*. That last one is the miscount — it was added
 * in the same edit that rebuilt the M7 fixture and was not folded into the
 * prediction. Every red is about the mutated behaviour, 36 cases still
 * pass, and the file parses and runs, so this is not a crashing mutant: the
 * prediction was wrong and the check is what it was thought to be.
 *
 * **M7's first form was not a mutation at all, and that is recorded rather
 * than quietly fixed.** The original fixture put a nested `7 expect() calls`
 * ABOVE an outer summary carrying `13648`. The outer summary is printed
 * last, so a document-wide last-match reads 13648 too — there is no input on
 * which that mutant and the original differ, and the row would have measured
 * the code running twice. The fixture was rebuilt around the case where the
 * outer run omits the line, which is the shape bun actually produces, before
 * any row was run.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * `cp` backups, never `git checkout --`, and `lib/suite-flake.ts` and
 * `lib/suite-run-reading.ts` were confirmed byte-identical by sha256
 * afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import { readSuiteRun } from "../lib/suite-run-reading";
import { testCommandAgreement } from "../lib/test-command-positions";
import {
  describeFlakeReading,
  flakeReading,
  treeSignatureKey,
  type FlakeRun,
  type TreeSignature,
} from "../lib/suite-flake";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = "scripts/suite-flake-run.ts";
const WORKFLOW = join(ROOT, ".github", "workflows", "suite-flake.yml");

const CLEAN_TREE: TreeSignature = { head: "c05fe357", dirty: [] };

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratchDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `rg-323-${tag}-`));
  scratch.push(d);
  return d;
}

/** A real bun summary, parameterised by the numbers that vary. */
function summary(opts: { pass: number; fail: number; expectCalls?: number; names?: string[] }): string {
  const names = (opts.names ?? []).map(n => `(fail) ${n} [0.12ms]`).join("\n");
  const total = opts.pass + opts.fail;
  return [
    "bun test v1.3.14 (d1632b29)",
    names,
    ` ${opts.pass} pass`,
    ` ${opts.fail} fail`,
    opts.expectCalls === undefined ? "" : ` ${opts.expectCalls} expect() calls`,
    `Ran ${total} tests across 324 files. [412.00s]`,
  ]
    .filter(l => l !== "")
    .join("\n");
}

/** One entry in a series. The reading is taken by the REAL parser. */
function run(index: number, output: string, signature: TreeSignature = CLEAN_TREE): FlakeRun {
  return { index, signature, run: readSuiteRun(output), log: `run-${index}.log`, seconds: 412 };
}

/** N clean runs, every one identical. */
function cleanSeries(n: number, expectCalls = 13648): FlakeRun[] {
  return Array.from({ length: n }, (_, i) => run(i + 1, summary({ pass: 5464, fail: 0, expectCalls })));
}

describe("#323 AC-1: a clean series says so, and the fixtures really are readable", () => {
  test("ten identical clean runs read CONSISTENT and STABLE", () => {
    // The control, first and on its own. Every refusal below is satisfied by
    // a binding that refuses everything, so the clearing case is established
    // before any of them run.
    const series = cleanSeries(10);
    // Non-vacuous: the fixtures are parsed by the real reader and every one
    // of them MEASURED. A series of ten UNMEASURED readings would satisfy a
    // verdict case that only looked at the word.
    expect(series.every(r => r.run.status === "MEASURED")).toBe(true);

    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("CONSISTENT");
    expect(reading.reasons).toEqual([]);
    expect(reading.assertions).toBe("STABLE");
    expect(reading.runs).toBe(10);
    expect(describeFlakeReading(reading)).toContain("10 consecutive run");
  });

  test("the series records every run's counts, not just the verdict", () => {
    // A verdict with no numbers under it is a claim. The 2026-10-11 reading
    // was lost precisely because the only thing kept was a word.
    const reading = flakeReading(cleanSeries(3), 3);
    expect(reading.assertionCounts).toEqual([13648, 13648, 13648]);
  });
});

describe("#323 AC-2: a run that measured nothing is not a run that found nothing", () => {
  test("a run that discovered nothing to run taints the series", () => {
    // The cheapest wrong fix's blind spot, and the fixture is #490's shape
    // because it is the one where the grep and the reader give OPPOSITE
    // answers rather than merely different confidence. `Ran 0 tests across 1
    // file.` exits 0 with every indicator green and prints a literal
    // ` 0 fail`, so `grep -q "0 fail"` reports a clean run over a suite that
    // executed nothing — a collection failure, a bad filter, a shard
    // selector that matched no files.
    const discoveredNothing = [
      "bun test v1.3.14 (d1632b29)",
      " 0 pass",
      " 0 fail",
      "Ran 0 tests across 1 file. [0.01s]",
    ].join("\n");
    // The premise, asserted rather than assumed: the text a grep would match
    // really is in there, so the two instruments really do disagree.
    expect(discoveredNothing).toContain(" 0 fail");
    expect(readSuiteRun(discoveredNothing).status).toBe("UNMEASURED");

    const series = [...cleanSeries(3), run(4, discoveredNothing), ...cleanSeries(6)];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.verdict).not.toBe("CONSISTENT");
    expect(reading.reasons.join(" "), "the series does not say which run was unreadable").toContain("run 4");
  });

  test("a log with no summary at all taints the series too", () => {
    // The killed-run shape: the output stops mid-stream. Both instruments
    // catch this one — a grep finds no `0 fail` either — so it is here as
    // coverage of the second refusal branch and NOT as evidence that the
    // reader beats the loop. Saying which cases are witnesses and which are
    // not is the point of the distinction.
    const killed = "bun test v1.3.14 (d1632b29)\n\ntest/a.test.ts:\n";
    const series = [...cleanSeries(9), run(10, killed)];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.reasons.join(" ")).toContain("run 10");
  });

  test("the control: the same series with run 4 readable is CONSISTENT", () => {
    // Varying exactly one thing (#585). Without this, the case above is
    // satisfied by a binding that refuses every ten-run series.
    const series = [...cleanSeries(3), run(4, summary({ pass: 5464, fail: 0, expectCalls: 13648 })), ...cleanSeries(6)];
    expect(flakeReading(series, 10).verdict).toBe("CONSISTENT");
  });
});

describe("#323 AC-3: ten runs over three trees is not a series", () => {
  test("a tree that moved mid-series is UNMEASURED, and the change is named", () => {
    // Invisible to a shell loop, and it is the precondition the whole SC
    // rests on — "on an unchanged tree" is half the criterion.
    const moved: TreeSignature = { head: "c05fe357", dirty: [".spec-collection-scratch/x"] };
    const series = [...cleanSeries(6), run(7, summary({ pass: 5464, fail: 0, expectCalls: 13648 }), moved), ...cleanSeries(3)];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("UNMEASURED");
    // The PATH, not merely the fact. A scratch directory appearing under the
    // repo is SC-6's hypothesis, and a reading that said only "the tree
    // moved" would not tell anyone where to look.
    expect(reading.reasons.join(" ")).toContain(".spec-collection-scratch/x");
  });

  test("a different HEAD is caught too, not only a dirty path", () => {
    const rebased: TreeSignature = { head: "deadbeef", dirty: [] };
    const series = [...cleanSeries(9), run(10, summary({ pass: 5464, fail: 0, expectCalls: 13648 }), rebased)];
    expect(flakeReading(series, 10).verdict).toBe("UNMEASURED");
    expect(flakeReading(series, 10).reasons.join(" ")).toContain("deadbeef");
  });

  test("the signature key is the whole signature, and order does not forge agreement", () => {
    // Two trees dirty in the same files, listed in different orders, are one
    // tree. Two trees dirty in different files are not — asserted together,
    // so the normalisation cannot be satisfied by a key that discards the
    // paths altogether.
    const a = treeSignatureKey({ head: "abc", dirty: ["b.ts", "a.ts"] });
    const b = treeSignatureKey({ head: "abc", dirty: ["a.ts", "b.ts"] });
    const c = treeSignatureKey({ head: "abc", dirty: ["a.ts"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("#323 AC-4: a short series is not a clean series", () => {
  test("three runs where ten were asked for is UNMEASURED, not CONSISTENT", () => {
    // The instrument failing is not the subject passing. A job that died
    // after three runs has measured three runs, and SC-5 asks for ten.
    const reading = flakeReading(cleanSeries(3), 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.reasons.join(" ")).toContain("3 of 10");
  });

  test("no runs at all is UNMEASURED rather than vacuously clean", () => {
    // Zero clean runs out of zero is perfect agreement, which is the third
    // shape in `.claude/rules/checks-must-be-able-to-fail.md`.
    const reading = flakeReading([], 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.verdict).not.toBe("CONSISTENT");
  });
});

describe("#323 AC-5: flaky and failing are different findings", () => {
  test("one failure in ten is FLAKY, and the failing test is named", () => {
    // #323 in one fixture: nine clean runs and one that is not. SC-3's
    // `failingTests` is what makes the tenth actionable instead of a number
    // somebody re-runs away.
    const failing = summary({
      pass: 5463,
      fail: 1,
      expectCalls: 14032,
      names: ["gate-vacuous-checks > a planted project typechecks"],
    });
    const series = [...cleanSeries(9), run(10, failing)];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("FLAKY");
    expect(reading.verdict).not.toBe("FAILING");
    expect(reading.reasons.join(" ")).toContain("gate-vacuous-checks");
    expect(describeFlakeReading(reading)).toContain("1 of 10");
  });

  test("every run failing is FAILING — a red suite is not a flaky one", () => {
    // Different fact, different word. A suite that is simply red is an
    // ordinary thing to be, and reporting it as flake sends somebody looking
    // for non-determinism that is not there.
    const red = summary({ pass: 5463, fail: 1, expectCalls: 13648, names: ["a > b"] });
    const series = Array.from({ length: 10 }, (_, i) => run(i + 1, red));
    expect(flakeReading(series, 10).verdict).toBe("FAILING");
  });

  test("the assertion count varying over clean runs is reported, not folded into the verdict", () => {
    // The 2026-10-11 numbers exactly: two runs, both clean, 384 assertions
    // apart. The verdict is about failures and stays CONSISTENT; the
    // stability field is what carries the finding, and the sentence carries
    // both.
    const series = [
      run(1, summary({ pass: 5464, fail: 0, expectCalls: 13648 })),
      run(2, summary({ pass: 5464, fail: 0, expectCalls: 14032 })),
    ];
    const reading = flakeReading(series, 2);
    expect(reading.verdict).toBe("CONSISTENT");
    expect(reading.assertions).toBe("VARIED");
    const sentence = describeFlakeReading(reading);
    expect(sentence).toContain("13648");
    expect(sentence).toContain("14032");
  });

  test("a runner that printed no count is UNREPORTED, never STABLE", () => {
    // `0`, `null` and silence are indistinguishable from success. A series
    // whose runner says nothing about assertions has not shown them stable.
    const series = [
      run(1, summary({ pass: 5464, fail: 0 })),
      run(2, summary({ pass: 5464, fail: 0 })),
    ];
    const reading = flakeReading(series, 2);
    expect(reading.assertions).toBe("UNREPORTED");
    expect(reading.assertions).not.toBe("STABLE");
    // …and the control, varying exactly that one thing: with the line
    // present the same pair is STABLE. Without it the case above is
    // satisfied by a reader that reports UNREPORTED for everything.
    expect(flakeReading(cleanSeries(2), 2).assertions).toBe("STABLE");
  });
});

describe("#323 AC-6: the assertion count is a reading of THIS run", () => {
  test("the count comes from the summary block, not from captured output", () => {
    // `skip`, `todo` and `error` are cut to the summary span for this reason
    // and the count is no different — but the fixture has to be built with
    // care, and the first draft of this case was not.
    //
    // Putting a nested count ABOVE an outer summary that has one of its own
    // proves nothing: the outer summary is printed last, so a last-match
    // over the whole document reads the right number anyway, and there is
    // no input on which the sliced reader and an unsliced one differ.
    // `.claude/rules/checks-must-be-able-to-fail.md`: before believing a
    // row, name the input.
    //
    // The input that separates them is a run whose OWN summary has no
    // assertion line — bun omits it, the way it omits `skip` and `todo` at
    // zero — while the output it captured has one. An unsliced last-match
    // then walks backward out of the summary and attributes a subprocess's
    // seven assertions to a run that reported none.
    const nested = [
      "bun test v1.3.14 (d1632b29)",
      "  a nested run captured by a test that drives bun:",
      " 1 pass",
      " 0 fail",
      " 7 expect() calls",
      "Ran 1 test across 1 file. [0.10s]",
      "",
      "  the outer run, which asserted nothing of its own:",
      " 5464 pass",
      " 0 fail",
      "Ran 5464 tests across 324 files. [412.00s]",
    ].join("\n");
    // The premise, asserted rather than assumed: the document really does
    // contain a count that is not this run's, and this run really does
    // report none. Without both, the case passes over an output with nothing
    // to mis-attribute.
    expect(nested).toContain(" 7 expect() calls");
    expect(nested.split(" expect() calls")).toHaveLength(2);

    const reading = readSuiteRun(nested);
    expect(reading.status).toBe("MEASURED");
    if (reading.status !== "MEASURED") return;
    expect(reading.expectCalls, "a nested run's assertion count was read as this run's").not.toBe(7);
    expect(reading.expectCalls).toBeNull();
  });

  test("a summary with no assertion line reads null, never zero", () => {
    const reading = readSuiteRun(summary({ pass: 10, fail: 0 }));
    expect(reading.status).toBe("MEASURED");
    if (reading.status !== "MEASURED") return;
    expect(reading.expectCalls).toBeNull();
    expect(reading.expectCalls).not.toBe(0);
  });

  test("the control: an outer summary that DOES carry a count is read, nested or not", () => {
    // Varying exactly one line against the fixture above (#585). Without
    // it, the slice case is satisfied by a reader that returns null for
    // every output containing captured text.
    const withOwn = [
      "bun test v1.3.14 (d1632b29)",
      "  a nested run captured by a test that drives bun:",
      " 1 pass",
      " 0 fail",
      " 7 expect() calls",
      "Ran 1 test across 1 file. [0.10s]",
      "",
      " 5464 pass",
      " 0 fail",
      " 13648 expect() calls",
      "Ran 5464 tests across 324 files. [412.00s]",
    ].join("\n");
    const reading = readSuiteRun(withOwn);
    expect(reading.status).toBe("MEASURED");
    if (reading.status !== "MEASURED") return;
    expect(reading.expectCalls).toBe(13648);
  });

  test("the real reader finds the count in a real bun summary", () => {
    const reading = readSuiteRun(summary({ pass: 5464, fail: 0, expectCalls: 13648 }));
    expect(reading.status).toBe("MEASURED");
    if (reading.status !== "MEASURED") return;
    expect(reading.expectCalls).toBe(13648);
  });
});

describe("#323 AC-7: the script refuses rather than guessing, proved by running it", () => {
  /**
   * EXECUTED, not grepped.
   *
   * The #323 battery for SC-3 caught a case that grepped a source for a
   * string present at two sites and stayed green when the site it named was
   * deleted (#484). A refusal is a behaviour; provoke it.
   */
  function run(args: string[], cwd = ROOT): { code: number | null; out: string } {
    const r = spawnSync("bun", [join(ROOT, SCRIPT), ...args], { cwd, encoding: "utf-8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  test("one run is refused — a single run cannot disagree with itself", () => {
    const r = run(["--runs", "1", "--out", scratchDir("one")]);
    expect(r.code, `a one-run series was accepted: ${r.out}`).not.toBe(0);
    expect(r.out).toContain("--runs must be an integer of at least");
  });

  test("a non-integer run count is refused rather than coerced", () => {
    // `Number("10; rm -rf /")` is NaN and `parseInt` would return 10. Which
    // of those two a reader assumes is exactly the ambiguity worth closing.
    const r = run(["--runs", "10x", "--out", scratchDir("nan")]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--runs must be an integer");
  });

  test("no output directory is refused, so a series cannot be run and kept nowhere", () => {
    // The defect this whole issue is about is a failure nobody kept.
    const r = run(["--runs", "10"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage:");
  });

  test("a project naming no test command is refused, not defaulted to `bun test`", () => {
    // #621: there are three declaring positions and they must agree. A
    // default here would be a fourth, and a series measured with a command
    // the project does not use measures something else.
    const empty = scratchDir("nocmd");
    const r = run(["--runs", "10", "--out", join(empty, "logs"), "--project", empty]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("names no test command");
  });

  test("the control: this repository DOES name one, so the refusal above is about the project", () => {
    // Without this, the case above is satisfied by a script that refuses
    // every project. Two runs over the one `--project` difference (#585);
    // the series itself is not driven, because running this repository's
    // full suite from inside its own suite is the thing the concurrency cap
    // exists to prevent.
    const agreement = testCommandAgreement(ROOT);
    expect(agreement.violations).toEqual([]);
    expect(agreement.commands.length).toBeGreaterThan(0);
  });
});

describe("#323 AC-8: the instrument exists in CI and is not pushed onto consumers", () => {
  test("a workflow runs the script, by hand rather than on a schedule", () => {
    const text = readFileSync(WORKFLOW, "utf-8");
    expect(text).toContain(SCRIPT);
    expect(text, "the flake series is scheduled — it costs an hour of runner time per press")
      .not.toContain("schedule:");
    expect(text, "the series cannot be triggered at all").toContain("workflow_dispatch:");
  });

  test("the run count reaches the script through the environment, never the command text", () => {
    // #696's shape. A dispatch input on a `run:` line is an injection point,
    // and the script validating it as an integer is downstream of the shell
    // that would already have run.
    const text = readFileSync(WORKFLOW, "utf-8");
    expect(text, "a dispatch input is interpolated into the command line").not.toContain(
      "--runs \"${{ inputs.runs }}\"",
    );
    expect(text).toContain("RUNS: ${{ inputs.runs }}");
    expect(text).toContain('--runs "$RUNS"');
  });

  test("every log is uploaded even when the series refuses", () => {
    // An artefact kept only on success is the defect: the series worth
    // having the logs from is the one that failed.
    const text = readFileSync(WORKFLOW, "utf-8");
    expect(text).toContain("upload-artifact");
    expect(text, "the logs are uploaded only on success").toContain("if: always()");
  });

  test("the generator emits no flake workflow", () => {
    // The negative control, as #789's AC-4 is: adding this to the templates
    // must score as a scope change rather than a tightening. A scheduled
    // hour of runner time in every scaffolded project is not a gift.
    const root = scratchDir("gen");
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "c", ci: { runner: "ubuntu-latest", branches: ["main"] } }, null, 2) + "\n",
    );
    createCiWorkflows(root, []);

    const out = readdirSync(join(root, ".github", "workflows"));
    expect(out.length, "the generator wrote nothing, so this reads nothing").toBeGreaterThan(0);
    for (const name of out) {
      const text = readFileSync(join(root, ".github", "workflows", name), "utf-8");
      expect(text, `the generated ${name} runs the harness's flake series (#323)`).not.toContain(SCRIPT);
    }
    expect(out, "a flake workflow was generated into the consumer").not.toContain("suite-flake.yml");
  });

  test("no pinned tool version is written down a second time", () => {
    // `test/ci-global-tools.test.ts` holds `ci.globalTools` as the one
    // declaring position. This workflow installs the same tools, so the
    // temptation is an `npm install -g 'agnix@x.y.z'` line here — which is
    // #689's shape, two copies of one fact with nothing comparing them.
    const text = readFileSync(WORKFLOW, "utf-8");
    expect(text, "the flake workflow pins a tool version of its own").not.toContain("npm install -g");
    expect(text).toContain("scripts/install-global-tools.ts");
    const installer = readFileSync(join(ROOT, "scripts", "install-global-tools.ts"), "utf-8");
    expect(installer, "the installer carries a version literal instead of reading the config")
      .not.toMatch(/@\d+\.\d+\.\d+/);
  });
});
