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

/**
 * `13 skip` and `818 todo` — bun prints these only when they are non-zero.
 *
 * Read so that `pass + fail` and `tests` stop being two unexplained numbers
 * for one event (#673). On run `wf_62d68d55-81c` the changelog said 13084
 * and the structured field said 13915; the difference was exactly this
 * run's `13 skip + 818 todo`, and nothing in the record said so. A reader
 * comparing either against a previous run's number may be comparing
 * different quantities.
 *
 * **Searched in the SUMMARY BLOCK, not the document.** `pass` and `fail` get
 * away with `lastMatch` over the whole output because the outer run's
 * summary is the last thing printed. These two cannot: bun OMITS them when
 * the count is zero, so a last-match over the document walks BACKWARD past
 * the summary into whatever the suite captured. That is not hypothetical —
 * `~/.rungate/pai-harness-669/suite-output.txt` carries a nested
 * `1 pass / 0 fail` at line 2600 of 2688, from a test that drives bun
 * itself. A nested run's skips would have been recorded as the outer run's.
 * `.claude/rules/checks-must-be-able-to-fail.md`: search the slice.
 *
 * **Absent means zero only when the producer's own total says so.** bun
 * omits the line at zero, so for bun absent and zero are the same statement
 * — but that is a fact about one runner, and a reading that asserts `skip:
 * 0` over a runner with no concept of skipping is a number nobody measured.
 * `pass + fail + skip + todo === tests` is the producer's own arithmetic,
 * and it is what resolves the absence: when it closes, the missing counts
 * really are zero; when it does not, they are `null` — not reported. Both
 * findings were raised by the security review of this change.
 */
const SKIP_LINE = /^\s*(\d+)\s+skip\s*$/gm;
const TODO_LINE = /^\s*(\d+)\s+todo\s*$/gm;

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
   * Tests the runner declined to execute, by kind (#673).
   *
   * These exist so that "tests that RAN" and "tests that EXIST" are both
   * nameable without anybody subtracting to find out which is which.
   *
   * **null, not 0, when the runner did not say.** A missing line resolves to
   * zero only when the runner's own `Ran N tests` total closes without it —
   * see the patterns above. "This runner reports no skip count" and "this
   * runner skipped none" are opposite facts, and `0` is the one value that
   * would let a reader add them together.
   */
  skip: number | null;
  todo: number | null;
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

  // #469's shape, and half of it. ONE branch, two sentences: the run printed
  // no summary, or printed half of one, and in both cases there is no result
  // to read. Written as a single decider on purpose — a separate `!pass &&
  // !fail` branch above this would be a second guard answering a question
  // this one already answers, and no behavioural test could tell them apart
  // (.claude/rules/checks-must-be-able-to-fail.md, the fourth shape). The
  // distinction is a wording, so it lives in the wording.
  if (!passMatch || !failMatch) {
    const missing = [!passMatch && "pass", !failMatch && "fail"].filter(Boolean) as string[];
    const what =
      missing.length === 2
        ? "printed no pass/fail summary, so it never reported a result — this is a run that " +
          "measured nothing, not a run that found nothing wrong"
        : `printed a "${passMatch ? "pass" : "fail"}" count but no "${missing[0]}" count, so its ` +
          "summary is incomplete and the missing half cannot be assumed to be zero";
    return unmeasured(`the test runner ${what} (#469). Last output: ${tail(output)}`);
  }

  const pass = Number(passMatch[1]);
  const fail = Number(failMatch[1]);

  const ran = lastMatch(RAN_LINE, output);
  const tests = ran ? Number(ran[1]) : null;
  const files = ran ? Number(ran[2]) : null;

  // The summary block, cut from the two lines that are always in it. bun
  // prints `pass`, then `skip` and `todo` when non-zero, then `fail`, so the
  // span between those two anchors is where a skip count belongs and
  // anywhere else in the output is somebody else's run.
  const at = (m: RegExpMatchArray) => m.index ?? 0;
  const summary = output.slice(
    Math.min(at(passMatch), at(failMatch)),
    Math.max(at(passMatch) + passMatch[0].length, at(failMatch) + failMatch[0].length),
  );
  const skipMatch = lastMatch(SKIP_LINE, summary);
  const todoMatch = lastMatch(TODO_LINE, summary);
  const skipRead = skipMatch ? Number(skipMatch[1]) : null;
  const todoRead = todoMatch ? Number(todoMatch[1]) : null;
  // The runner's own total is what resolves an absent line. It closes only
  // if the counts it did print account for everything it says it ran.
  const absentIsZero = tests !== null && pass + fail + (skipRead ?? 0) + (todoRead ?? 0) === tests;
  const skip = skipRead ?? (absentIsZero ? 0 : null);
  const todo = todoRead ?? (absentIsZero ? 0 : null);

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

  return { status: "MEASURED", pass, fail, tests, files, skip, todo };
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

/* ─────────────────────────────────────────────────────────────
 * The failures that happen before there is any output (#621)
 * ───────────────────────────────────────────────────────────── */

/**
 * What a caller knows about one attempt to measure the suite.
 *
 * `readSuiteRun` above reads what a runner PRINTED, and that is everything
 * once a runner has run. Two of the three ways a measurement fails never get
 * that far, and both of them print nothing:
 *
 *  - the full-suite slot pool refused, so no runner was started at all;
 *  - the runner binary could not be executed.
 *
 * Both reach the output parser as an empty string, where they are
 * indistinguishable from each other and from a runner that ran and said
 * nothing. The facts that separate them are not IN the output, so they travel
 * beside it.
 */
export interface SuiteRunAttempt {
  /**
   * The full-suite slot pool's answer, when one was asked for.
   *
   * Structurally typed rather than imported from `lib/test-suite-lock.ts`: a
   * real `AcquireResult` satisfies it, and this module stays free of `fs` and
   * `child_process` so it can be read anywhere a verdict is read. Omit it
   * when no slot was required — `undefined` means "not asked", which is not
   * the same fact as a refusal.
   */
  slot?: SlotOutcome | null;
  /**
   * What the process launcher reported when it could not start the runner —
   * `spawnSync(...).error`, or anything else that says the launch failed.
   * Absent and null both mean the runner launched.
   */
  launchError?: unknown;
  /** The command that was attempted, as argv or as a string. */
  command?: unknown;
  /** What the runner printed, handed to `readSuiteRun` unchanged. */
  output?: unknown;
  /**
   * The exit status, when there was one.
   *
   * RECORDED, NEVER CONSULTED. It is quoted into an UNMEASURED reason so an
   * operator reading the artefact does not have to go and re-run anything,
   * and no branch below asks what it is. SC-1829 is the measurement that says
   * why: among this module's fixtures, exit 0 and exit 1 each cover both a
   * measured and an unmeasured run, so a reading keyed off it is wrong about
   * one of them.
   */
  exitCode?: unknown;
}

/** The shape of a slot-pool answer this module needs. `AcquireResult` is one. */
export interface SlotOutcome {
  ok: boolean;
  holders?: ReadonlyArray<{
    sessionId?: string;
    workerId?: string;
    ageSeconds?: number;
  }>;
  degraded?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `bun test`, from argv or from a string. Never empty — an unnamed command
 * is a fact worth printing rather than a hole in the sentence. */
function describeCommand(command: unknown): string {
  if (Array.isArray(command)) {
    const parts = command.filter((p): p is string => typeof p === "string" && p !== "");
    if (parts.length > 0) return parts.join(" ");
  }
  if (typeof command === "string" && command.trim() !== "") return command.trim();
  return "(the harness did not record which command it tried to run)";
}

/** `ENOENT: Executable not found in $PATH: "…"`. */
function describeLaunchFailure(error: unknown): string {
  const record = isRecord(error) ? error : null;
  const code = record && typeof record.code === "string" ? record.code : null;
  const message =
    record && typeof record.message === "string" && record.message !== ""
      ? record.message
      : String(error);
  return code ? `${code}: ${message}` : message;
}

/** ` by holder-worker (12s)`, or nothing when the pool named nobody. */
function describeHolders(holders: SlotOutcome["holders"]): string {
  if (!Array.isArray(holders)) return "";
  const named = holders
    .filter(isRecord)
    .map(h => {
      const who = typeof h.workerId === "string" && h.workerId !== ""
        ? h.workerId
        : typeof h.sessionId === "string" && h.sessionId !== ""
          ? h.sessionId
          : "an unidentified worker";
      const age = typeof h.ageSeconds === "number" && Number.isFinite(h.ageSeconds)
        ? `${h.ageSeconds}s`
        : "age unknown";
      return `${who} (${age})`;
    });
  return named.length === 0 ? "" : ` by ${named.join(", ")}`;
}

/** `. The runner exited 1.`, or nothing when no status was recorded. */
function describeExit(exitCode: unknown): string {
  return typeof exitCode === "number" ? ` The runner exited ${exitCode}.` : "";
}

/**
 * Read one attempt to measure the suite.
 *
 * FAILS CLOSED, like everything else here, and for the one reason #621 names
 * by hand: `scripts/test-clean-env.ts` exits 2 when the slot pool refuses,
 * and **that exit must record UNMEASURED, never FAIL**. A refused run and a
 * broken runner are not results about the tree; they are the absence of a
 * measurement, and an absence that reads as a failing suite is as wrong as
 * one that reads as a clean one — it just fails in the direction nobody
 * notices, by making the gate cry wolf until its reader stops believing it.
 *
 * The three refusals are ORDERED and each is the only decider for its fact.
 * The output parser is `readSuiteRun`, called once at the end rather than
 * re-implemented, so the missing-summary refusal has exactly one binding and
 * a mutation of it cannot be held up by a copy in here
 * (.claude/rules/checks-must-be-able-to-fail.md, the fourth shape).
 */
export function readSuiteAttempt(attempt: SuiteRunAttempt): SuiteRun {
  // 1. The pool refused. Checked first because nothing downstream of it ran:
  //    there is no launch error and no output, so every later branch would
  //    describe this as "the runner printed nothing", which is true and
  //    useless — the runner was never asked to print anything.
  //
  //    `ok !== true` rather than `ok === false`: a slot answer this module
  //    cannot read is not an acquired slot.
  const slot = attempt.slot;
  if (slot !== undefined && slot !== null && slot.ok !== true) {
    return unmeasured(
      "the suite was never run: the full-suite slot pool is exhausted — every slot is held" +
        `${describeHolders(slot.holders)}, so ${describeCommand(attempt.command)} was refused ` +
        "before any runner started. A refused run has no result, and must not be read as a " +
        "failing one (#621)",
    );
  }

  // 2. The runner could not be executed. Also checked before the output,
  //    because an ENOENT launch prints nothing: left to the parser it would
  //    report "the test runner produced no output", which names neither the
  //    runner nor the fact that there isn't one to name.
  if (attempt.launchError !== undefined && attempt.launchError !== null) {
    return unmeasured(
      `the test runner could not be executed: ${describeCommand(attempt.command)} — ` +
        `${describeLaunchFailure(attempt.launchError)}. No suite ran, so there is no result to ` +
        "read, and the absence of a runner is not the absence of failures (#621)",
    );
  }

  // 3. Whatever the runner printed, read by the one reader that reads output.
  //    The exit status is appended to a refusal rather than consulted for it.
  const run = readSuiteRun(attempt.output);
  if (run.status === "UNMEASURED") {
    return unmeasured(`${run.reason}${describeExit(attempt.exitCode)}`);
  }
  return run;
}
