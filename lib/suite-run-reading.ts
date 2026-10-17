/**
 * What a test runner's own output says it did (#469, #490).
 *
 * `lib/suite-measurement.ts` reads the RECORD a run left behind and refuses
 * everything that is not a complete, SHA-bound result. This file is one step
 * upstream of it: it reads the runner's output and decides whether there is a
 * result to record at all. The two defects it exists for are the same defect
 * at two sizes.
 *
 * **#469 — a run that read none of its files exits 0.** Observed verbatim on
 * 2026-10-16, after a worktree was deleted by hand while its suite was
 * running: four `error: ENOENT reading "…"` blocks, no `N pass / N fail`
 * summary, and `[exited with code 0]`. Reproduced here on bun 1.3.14 by
 * removing the test directory from the first file imported, which prints the
 * banner and nothing else. The exit code differs between the two — 0 then, 1
 * now — which is the argument for not reading the exit code at all. Both runs
 * measured nothing, and only the absence of a summary says so.
 *
 * **#490 — a runner that discovers nothing looks exactly like a clean run.**
 * Measured on the same bun: a project whose only test file declares no tests
 * prints
 *
 *     0 pass
 *     0 fail
 *     Ran 0 tests across 1 file. [6.00ms]
 *
 * and exits 0. Every indicator is green over a suite that asserted nothing.
 *
 * **The file count is the proxy; the executed count is the property.** #490
 * asks for the discovered FILE count to be greater than zero, and that row
 * above is why this module does not stop there: one empty file satisfies
 * "files > 0" while measuring exactly as much as no files at all. That is the
 * trap `.claude/rules/checks-must-be-able-to-fail.md` records as wording a
 * refusal after the cheapest proxy rather than after the property — a proxy
 * is a thing people can satisfy directly. So the file count is READ, RECORDED
 * and refused when it contradicts the results, and the refusal that carries
 * the weight is about what the runner executed.
 *
 * Nothing here throws, for the same reason nothing in `lib/suite-measurement.ts`
 * does: it is read on the path that decides whether a run may ship, and a
 * throw is a refusal the caller's error handling can turn back into a ship.
 */

/**
 * `N pass` and `N fail` on their own lines — bun's summary, and the shape
 * `parseTestFailureCount` in gates/gate-executor.ts has read since #307.
 * Anchored to the whole line so a sentence mentioning "0 fail" inside a
 * captured test output cannot be read as the summary.
 */
const PASS_LINE = /^\s*(\d+)\s+pass\s*$/gm;
const FAIL_LINE = /^\s*(\d+)\s+fail\s*$/gm;

/** `Ran 11521 tests across 324 files.` — and `1 test across 1 file.` */
const RAN_LINE = /^Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\./gm;

export interface MeasuredRun {
  status: "MEASURED";
  pass: number;
  fail: number;
  /**
   * Tests the runner says it ran, or null when it did not say.
   *
   * null rather than `pass + fail`: a derived number here would be
   * indistinguishable from one the runner reported, and the point of the
   * whole module is that a number nobody measured must not be reportable.
   */
  tests: number | null;
  /**
   * Test files the runner discovered, or null when it did not say.
   *
   * **null, never 0.** "This runner does not report a file count" and "this
   * runner found no files" are opposite facts, and `0` is the one value that
   * would let a reader add them together — `.claude/rules/config-access.md`,
   * *Silent Default Substitution*, pointed at the number #490 is about.
   */
  files: number | null;
}

export interface UnmeasuredRun {
  status: "UNMEASURED";
  reason: string;
}

export type SuiteRun = MeasuredRun | UnmeasuredRun;

function unmeasured(reason: string): UnmeasuredRun {
  return { status: "UNMEASURED", reason };
}

/** The last match of a global pattern, or null. Last, because a suite run can
 * contain another suite's captured output and the summary is printed at the
 * end — the same choice `parseTestFailureCount` made in #307. */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
  const all = [...text.matchAll(re)];
  return all.length === 0 ? null : all[all.length - 1];
}

/** How much of the output to quote back in a refusal, so a reason is readable
 * without pasting a 400 KB suite log into a gate failure. */
function tail(output: string, limit = 240): string {
  const lines = output.trimEnd().split("\n").filter(l => l.trim() !== "");
  const last = lines.slice(-3).join(" / ");
  return last.length > limit ? `${last.slice(0, limit)}…` : last || "(nothing)";
}

/**
 * Read a test runner's output.
 *
 * FAILS CLOSED. Every path that cannot positively establish that the runner
 * executed something returns UNMEASURED with a reason. There is no path that
 * returns a zero-failure MEASURED reading from an output that does not say so.
 *
 * The EXIT CODE is deliberately not a parameter. #469's run exited 0 having
 * measured nothing; the reproduction of it here exits 1. A reading that
 * consulted the exit code would have been wrong about one of them, and
 * choosing which is not a thing this function can know.
 */
export function readSuiteRun(output: unknown): SuiteRun {
  if (typeof output !== "string" || output.trim() === "") {
    return unmeasured(
      "the test runner produced no output, so there is nothing to read a result out of — " +
        "a run with no output is not a run with no failures (#469)",
    );
  }

  const passMatch = lastMatch(PASS_LINE, output);
  const failMatch = lastMatch(FAIL_LINE, output);

  // #469's shape. The run printed its banner, some errors, and stopped. An
  // exit code is the only other thing a caller has, and it lied.
  if (!passMatch && !failMatch) {
    return unmeasured(
      "the test runner printed no pass/fail summary, so it never reported a result — " +
        `this is a run that measured nothing, not a run that found nothing wrong (#469). Last output: ${tail(output)}`,
    );
  }
  // Half a summary is not a summary. Reading the half that is present and
  // defaulting the other to 0 is the fail-open this module exists to remove.
  if (!passMatch || !failMatch) {
    const present = passMatch ? "pass" : "fail";
    const missing = passMatch ? "fail" : "pass";
    return unmeasured(
      `the test runner printed a "${present}" count but no "${missing}" count, so its summary is ` +
        `incomplete and the missing half cannot be assumed to be zero (#469). Last output: ${tail(output)}`,
    );
  }

  const pass = Number(passMatch[1]);
  const fail = Number(failMatch[1]);

  const ran = lastMatch(RAN_LINE, output);
  const tests = ran ? Number(ran[1]) : null;
  const files = ran ? Number(ran[2]) : null;

  // #490 SC-1, as a contradiction rather than as a second way of asking
  // whether anything ran. A runner claiming results it discovered no files to
  // produce is not reporting a measurement of this project, and it is the one
  // case the executed-count refusal below cannot see: that one fires when
  // nothing ran, and this one fires only when something did.
  if (files === 0 && pass + fail > 0) {
    return unmeasured(
      `the test runner reported ${pass + fail} result(s) but says it discovered 0 test files — ` +
        "the counts contradict each other, so neither can be read as a measurement of this project (#490)",
    );
  }

  // #490's real shape, and the reason this is about the executed count rather
  // than the file count: `Ran 0 tests across 1 file.` exits 0 with every
  // indicator green. One empty file satisfies "files > 0" and measures
  // nothing.
  if (pass + fail === 0) {
    const where =
      files === null
        ? "and it did not say how many test files it discovered"
        : `across the ${files} test file(s) it discovered`;
    return unmeasured(
      `the test runner executed 0 tests ${where} — a runner that discovered nothing to run is ` +
        "indistinguishable from a clean suite by its exit code, and it is not one (#490)",
    );
  }

  return { status: "MEASURED", pass, fail, tests, files };
}

/**
 * The verdict a reading supports.
 *
 * Three verdicts and not two, for the reason `lib/suite-measurement.ts`
 * states: UNMEASURED is not a result, it is the statement that this run has
 * no suite evidence.
 */
export function suiteRunVerdict(run: SuiteRun): "PASS" | "FAIL" | "UNMEASURED" {
  if (run.status !== "MEASURED") return "UNMEASURED";
  return run.fail === 0 ? "PASS" : "FAIL";
}
