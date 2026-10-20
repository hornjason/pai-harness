/**
 * #323 SC-3 — a failing suite run that cannot say WHICH test failed.
 *
 * One of three consecutive full-suite runs on 2026-10-11 reported `1 fail`,
 * the two either side were clean, and the name was lost. The issue's framing
 * is that the number every PR is measured against is unreliable; the half of
 * it that is still reachable, two weeks and ten thousand tests later, is that
 * **a failure is not captured**.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **SC-3 as written: tee the output to a file.** One shell operator, the
 * criterion satisfied literally, and it does not answer the question.
 *
 * Measured on bun 1.3.14, and the measurement is the fixture below rather
 * than a transcription: two files, one ordinary failing assertion and one
 * module-scope `throw`, report
 *
 *     1 pass
 *     2 fail
 *     1 error
 *     Ran 3 tests across 2 files.
 *
 * with exactly ONE `(fail)` line. **A module-scope error counts toward the
 * failure total and has no test name at all**, because the test that would
 * have carried it never ran. A tee preserves a record that does not contain
 * the answer, and the summary block — the part anybody actually reads —
 * says `2 fail` either way.
 *
 * The same shape appeared in this repository's own CI on 2026-10-20: shard 4
 * reported `1 fail`, `1 error`, and `1 tests failed:` followed by an empty
 * list, with no `(fail)` line anywhere in the job log. The cause was a
 * structural cut whose anchor a refactor had renamed away.
 *
 * **AC-2 is the case that does not survive the tee**: a reading over that
 * output must say two failed, one was named, and the other is accounted for
 * by an unhandled error. Nothing about where the bytes were written changes
 * that reading, which is the point.
 *
 * ## The second cheapest wrong fix, inside the change
 *
 * **Report the names that were found and stop.** `failingTests: []` beside
 * `fail: 2` reads as "nothing to name" — `0`, `{}` and silence are
 * indistinguishable from success (`.claude/rules/config-access.md`). AC-2
 * and AC-3 both pin the arithmetic rather than the list.
 *
 * ## The trap this file is built around
 *
 * `skip` and `todo` are read from the summary SLICE, because a captured
 * nested run's counts are not this run's. `(fail)` lines cannot be: bun
 * prints them as the run goes, throughout the output, and this repository's
 * own suite drives `bun test` in subprocesses. That asymmetry is reported
 * rather than hidden — when more names are found than the summary counts,
 * the names are withheld and the contradiction is stated. AC-4 plants it.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/suite-run-reading.test.ts`. Counts predicted in
 * `/tmp/323-battery/predictions.md` before the battery ran, and **the
 * baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | read first | **26 pass, 0 fail** | — |
 * | M1 **the second cheapest wrong fix**: the unnamed count dropped from the sentence | 3 | **3 of 26** | the two-file scene: the original says *"2 failing test(s), 1 of them unnamed: beta fails — and the runner reported 1 unhandled error(s)…"*, the mutant says *"2 failing test(s): beta fails"* |
 * | M2 **the defect restored**: the names never parsed | 6 | **6 of 26** | the one-file scene: the original reads `["beta fails"]`, the mutant `[]` |
 * | M3 the `N error` line never read | 3 | **3 of 26** | the two-file scene: the original reports `errors: 1`, the mutant `null`, and the sentence stops being able to say what ate the name |
 * | M4 the `(fail)` pattern unanchored | 1 | **1 of 26** | a line of prose containing `(fail)` mid-sentence: the original names one test, the mutant two |
 * | M5 the over-named branch removed | 1 | **1 of 26** | output carrying a nested runner's two `(fail)` lines over a summary of `1 fail` |
 * | M6 the recorder stops writing the two fields | 2 | **1 of 26** | the planted scene: the original persists `failingTests: ["beta fails"], errors: 1`, the mutant persists neither |
 * | M7 the two fields dropped from `SuiteMeasurementShape` | 2 | **1 of 26**, plus **2** in `test/suite-verdict-binding.test.ts` + `gates/schema-parity.test.ts` | the field list: `SUITE_MEASUREMENT_FIELDS` and SCHEMA-GUIDE.md stop agreeing in both directions |
 * | M8 the summary span narrowed back to the `fail` line — the first draft | not predicted | **3 of 26** | the two-file scene: bun prints `error` AFTER `fail`, so the narrow span reads `errors: null` over a run that plainly says `1 error` |
 *
 * **Three rows read LOW on the first pass, and the low rows were right.** M1,
 * M2 and M3 measured 2, 4 and 2 against those same predictions, and the
 * missing reds were all in one case: AC-5's first draft grepped
 * `scripts/record-suite-measurement.ts` for `failingTests: run.failingTests`.
 * Row M6 removes exactly that line from `buildMeasurement` — **and the case
 * stayed green, because the same string also appears in the CLI's JSON echo
 * twenty lines down.** A source-text assertion cannot tell which of two
 * matching sites it matched (#484), and the thing worth asserting was never
 * the source: AC-5 now runs the real recorder over a planted scene and reads
 * the artefact back. With that case executing rather than grepping, every
 * one of the five predictions matches exactly.
 *
 * **M8 is not a mutation of a shipped decision; it is the bug this file
 * caught while it was being written**, kept as a row because the span is the
 * kind of thing a later edit tidies. `skip` and `todo` are printed before
 * `fail` and `error` after it, so the span has to close on `Ran N tests`.
 *
 * **M6's missing red is a fact about the two sites, not a gap.** The
 * changelog line is composed from the READING and the record from
 * `buildMeasurement`; removing the record's fields leaves the changelog
 * correct, which is why both are asserted and neither stands in for the
 * other. **M7's real guard is elsewhere by design** — one declaring position
 * for the field list, checked against the guide in both directions.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * `cp` backups, never `git checkout --`, and all three sources were confirmed
 * byte-identical by sha256 afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describeSuiteFailures, readSuiteRun, type MeasuredRun } from "../lib/suite-run-reading";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Real `bun test` output over planted files.
 *
 * Executed, never transcribed. A hand-written fixture asserts that the
 * reader can parse a string somebody typed; the defect this file is about is
 * a property of what bun actually prints, and #235's rule is that the
 * fixture has to be measured on the producing side too.
 */
function runSuite(files: Record<string, string>): { output: string; run: MeasuredRun } {
  const project = mkdtempSync(join(tmpdir(), "rg-323-"));
  scratch.push(project);
  mkdirSync(project, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(project, name), body);
  const r = spawnSync("bun", ["test", ...Object.keys(files)], {
    cwd: project,
    encoding: "utf-8",
    timeout: 120_000,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const run = readSuiteRun(output);
  if (run.status !== "MEASURED") throw new Error(`the fixture produced no reading: ${run.reason}`);
  return { output, run };
}

const PASS_AND_FAIL =
  'import { test, expect } from "bun:test";\n' +
  'test("alpha passes", () => { expect(1).toBe(1); });\n' +
  'test("beta fails", () => { expect(1).toBe(2); });\n';

/** The same file plus a module-scope throw — one thing varied (#585). */
const MODULE_THROW =
  'import { test, expect } from "bun:test";\n' +
  'test("gamma never runs", () => { expect(1).toBe(1); });\n' +
  'throw new Error("module scope boom");\n';

describe("#323 AC-1: an ordinary failure is named", () => {
  test("the reading carries the test's name, not only a count", () => {
    const { run } = runSuite({ "a.test.ts": PASS_AND_FAIL });
    expect(run.fail).toBe(1);
    expect(run.failingTests).toEqual(["beta fails"]);
    expect(describeSuiteFailures(run)).toBe("1 failing test(s): beta fails");
  });

  test("a clean run names nothing, and says zero rather than being silent", () => {
    // The control. Without it every assertion above is satisfied by a reader
    // that reports a name for every run.
    const { run } = runSuite({
      "clean.test.ts": 'import { test, expect } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    });
    expect(run.fail).toBe(0);
    expect(run.failingTests).toEqual([]);
    expect(describeSuiteFailures(run)).toBe("0 failing tests");
  });
});

describe("#323 AC-2: a failure with no name is reported as one, not dropped", () => {
  test("a module-scope throw counts toward fail and prints no (fail) line", () => {
    // The premise, asserted before anything is read off it. If bun ever
    // starts naming these, the cases below stop measuring what they claim
    // and this is the line that says so.
    const { output, run } = runSuite({ "a.test.ts": PASS_AND_FAIL, "b.test.ts": MODULE_THROW });
    expect(run.fail, "the module-scope throw was not counted as a failure").toBe(2);
    expect(
      (output.match(/^\s*\(fail\)/gm) ?? []).length,
      "bun named both failures, so this fixture no longer reproduces #323's shape",
    ).toBe(1);
    expect(run.errors, "bun reported no unhandled error count").toBe(1);
  });

  test("the reading says two failed, one is named, and the other is accounted for", () => {
    const { run } = runSuite({ "a.test.ts": PASS_AND_FAIL, "b.test.ts": MODULE_THROW });
    expect(run.failingTests).toEqual(["beta fails"]);
    const said = describeSuiteFailures(run);
    expect(said, "the count is not stated").toContain("2 failing test(s)");
    expect(said, "the unnamed failure is not reported as unnamed").toContain("1 of them unnamed");
    expect(said, "the name that WAS found is withheld").toContain("beta fails");
    expect(said, "nothing explains where the other name went").toContain("1 unhandled error");
  });

  test("the pair differs in exactly one file, so this is a measurement of it", () => {
    // #585: a pair that varies two things measures neither. The second scene
    // is the first plus one file, derived rather than written out again.
    const one = runSuite({ "a.test.ts": PASS_AND_FAIL });
    const two = runSuite({ "a.test.ts": PASS_AND_FAIL, "b.test.ts": MODULE_THROW });
    expect(two.run.failingTests).toEqual(one.run.failingTests);
    expect(two.run.fail).toBe(one.run.fail + 1);
    expect(describeSuiteFailures(two.run)).not.toBe(describeSuiteFailures(one.run));
  });

  test("an unnamed failure with NO error count is unexplained, not explained away", () => {
    // A runner that counts a failure, names none, and reports no errors has
    // told us nothing about where the name went. That is a different
    // sentence from "a module-scope error ate it", and collapsing them would
    // make the reader confident about a cause nobody measured.
    const synthetic: MeasuredRun = {
      status: "MEASURED", pass: 1, fail: 2, tests: 3, files: 1, skip: 0, todo: 0,
      failingTests: ["only one"], errors: null, expectCalls: null,
    };
    const said = describeSuiteFailures(synthetic);
    expect(said).toContain("1 of them unnamed");
    expect(said).toContain("no error count");
    expect(said).not.toContain("unhandled error(s) between tests");
  });
});

describe("#323 AC-3: the names are not read out of another runner's output", () => {
  test("more names than the summary counts withholds them and says why", () => {
    // This repository's own suite drives `bun test` in subprocesses, so a
    // captured nested run's `(fail)` lines sit at column zero like
    // everybody else's and cannot be cut away the way `skip` and `todo` are.
    // Reporting them confidently would attribute another run's failures to
    // this one.
    const nested = [
      "(fail) somebody else's case [1.00ms]",
      "(fail) and another [1.00ms]",
      "",
      " 5 pass",
      " 1 fail",
      "Ran 6 tests across 2 files. [10.00ms]",
    ].join("\n");
    const run = readSuiteRun(nested);
    expect(run.status).toBe("MEASURED");
    const said = describeSuiteFailures(run);
    expect(said).toContain("names 2 failing test(s) but the summary counts 1");
    expect(said, "another runner's names were attributed to this run").not.toContain("somebody else");
  });

  test("a `(fail)` inside captured prose is not read as a failing test", () => {
    // The detector has to be narrower than the document. A sentence
    // mentioning the marker mid-line is not a result line, and a reader that
    // cannot tell them apart invents failures out of test output.
    const prose = [
      "  the check prints (fail) when it refuses, which is the point",
      "(fail) the real one [0.10ms]",
      "",
      " 1 pass",
      " 1 fail",
      "Ran 2 tests across 1 file. [5.00ms]",
    ].join("\n");
    const run = readSuiteRun(prose);
    expect(run.status).toBe("MEASURED");
    expect((run as MeasuredRun).failingTests).toEqual(["the real one"]);
  });
});

describe("#323 AC-4: an UNMEASURED run offers no names at all", () => {
  test("a run with no summary describes its refusal rather than listing names", () => {
    // A reading with no result must not arrive carrying detail: a list of
    // names beside "this run measured nothing" makes the absence of a
    // measurement look like a measurement.
    const run = readSuiteRun("(fail) something [0.10ms]\nerror: ENOENT reading \"x\"\n");
    expect(run.status).toBe("UNMEASURED");
    expect(describeSuiteFailures(run)).toBe((run as { reason: string }).reason);
    // No list, no count, no field. The refusal DOES quote the last lines of
    // the output — that is #469's behaviour and the reason an operator does
    // not have to go and re-run anything — but it quotes them as evidence
    // that nothing was measured, not as a result.
    expect(run).not.toHaveProperty("failingTests");
    expect(run).not.toHaveProperty("errors");
    expect(describeSuiteFailures(run)).toContain("measured nothing");
  });
});

describe("#323 AC-5: the reading reaches the artefact, not just the return value", () => {
  /**
   * The REAL recorder, run against a real suite output, read back off disk.
   *
   * The first draft of this case grepped `scripts/record-suite-measurement.ts`
   * for `failingTests: run.failingTests` — and the battery found it: row M6
   * removes that line from `buildMeasurement`, the artefact loses both
   * fields, and the case stayed GREEN because the same string also appears
   * in the CLI's JSON echo twenty lines down. A source-text assertion cannot
   * tell which of two matching sites it matched (#484), and the thing worth
   * asserting was never the source anyway. A reading nothing persists is
   * #530's shape.
   */
  function recorded(): Record<string, any> {
    const root = mkdtempSync(join(tmpdir(), "rg-323-rec-"));
    scratch.push(root);
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "a.test.ts"), PASS_AND_FAIL);
    writeFileSync(join(project, "b.test.ts"), MODULE_THROW);
    for (const argv of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@example.test"],
      ["config", "user.name", "T"],
      ["add", "-A"],
      ["commit", "-q", "-m", "one"],
    ]) {
      spawnSync("git", ["-C", project, ...argv], { encoding: "utf-8" });
    }

    const r = spawnSync("bun", ["test", "a.test.ts", "b.test.ts"], {
      cwd: project, encoding: "utf-8", timeout: 120_000,
    });
    const outputPath = join(root, "suite-output.txt");
    writeFileSync(outputPath, `${r.stdout ?? ""}${r.stderr ?? ""}`);

    const state = join(root, "workflow-state.json");
    writeFileSync(state, JSON.stringify({
      schemaVersion: 2, slug: "t", issue: 323, phase: "BUILD", issueGoal: "g", acs: [],
      createdTs: "2026-01-01T00:00:00Z", updatedTs: "2026-01-01T00:00:00Z", changelog: [],
    }));

    const rec = spawnSync("bun", [
      join(import.meta.dir, "..", "scripts", "record-suite-measurement.ts"),
      "--state", state, "--project", project, "--output", outputPath, "--scope", "full",
    ], { cwd: project, encoding: "utf-8", timeout: 120_000 });
    const parsed = JSON.parse(readFileSync(state, "utf-8"));
    if (!parsed.suiteMeasurement) {
      throw new Error(`the recorder wrote no measurement: ${rec.stdout ?? ""}${rec.stderr ?? ""}`);
    }
    return parsed;
  }

  test("the persisted measurement carries the names and the error count", () => {
    const m = recorded().suiteMeasurement;
    expect(m.verdict).toBe("FAIL");
    expect(m.failures, "the count moved").toBe(2);
    expect(m.failingTests, "the artefact carries the count and not the names (#323)").toEqual([
      "beta fails",
    ]);
    expect(m.errors, "the artefact does not say what ate the other name").toBe(1);
  });

  test("the changelog line a human reads says it too", () => {
    // The count alone sends every reader back to a log that may not contain
    // the answer — a module-scope error has no test name anywhere in it.
    const entries = (recorded().changelog ?? []).filter((c: any) => c?.event === "suite-measurement");
    expect(entries.length, "the recorder logged no suite-measurement event").toBeGreaterThan(0);
    const detail = String(entries[entries.length - 1].detail ?? "");
    expect(detail).toContain("beta fails");
    expect(detail).toContain("1 of them unnamed");
  });

  test("the schema declares both fields, so the guide and the record agree", () => {
    // Not about persistence — `writeWorkflowState` uses `passthrough()`, so
    // an undeclared field survives the write (#530 measured that). It is
    // about the CONTRACT: `SUITE_MEASUREMENT_FIELDS` is what
    // gates/schema-parity.test.ts checks SCHEMA-GUIDE.md against in both
    // directions, so a field the recorder writes and the schema does not
    // declare is a field no consumer is told exists.
    const schema = readFileSync(join(import.meta.dir, "..", "gates", "schema.ts"), "utf-8");
    const shape = schema.slice(
      schema.indexOf("const SuiteMeasurementShape"),
      schema.indexOf("export const SUITE_MEASUREMENT_FIELDS"),
    );
    expect(shape.length, "the SuiteMeasurementShape slice is empty").toBeGreaterThan(200);
    expect(shape).toContain("failingTests:");
    expect(shape).toContain("errors:");
  });
});
