/**
 * #323 SC-5 — the series instrument reported CONSISTENT over ten killed runs,
 * on its first real dispatch.
 *
 * Measured, not reconstructed. Run `39405680063` on `main` at `07def1bf`,
 * 2026-10-20, dispatched minutes after #791 merged:
 *
 * ```
 * run 1/10 [69s]  exit null: 1 pass, 0 fail, 1 expect() calls
 * …
 * run 10/10 [142s] exit null: 1 pass, 0 fail, 1 expect() calls
 * CONSISTENT: 10 consecutive run(s) on one tree, none failing.
 * ```
 *
 * **One pass, on a suite of about 5,500 tests, ten times, reported clean.**
 * Every log in the artefact is ~1.08 MB and ends mid-stream in the middle of
 * the conformity output. `run-01.log` is 6,293 lines and contains exactly
 * ONE summary, at line 3,245: a nested `1 pass / 0 fail / Ran 1 test across
 * 1 file.` printed by a test that drives `bun test` in a subprocess. The
 * outer run never printed a summary at all.
 *
 * This is the hole #791's own docblock named as a stated non-claim — *"a
 * series is NOT protected against a run killed after a subprocess printed a
 * summary of its own"* — and it fired on first use. Writing the limitation
 * down was worth doing and was not a substitute for closing it.
 *
 * ## The cause, reproduced rather than inferred
 *
 * `spawnSync`'s `maxBuffer` defaults to 1 MiB. On overflow the child is
 * **killed with SIGTERM**, the captured output is truncated, and `status` is
 * `null`. Reproduced directly before any repair was written:
 *
 * ```
 * $ spawnSync("sh", ["-c", "…2 MB…; echo DONE-MARKER"], { encoding: "utf-8" })
 * status: null  signal: SIGTERM  error: ENOBUFS (stdout or stderr buffer
 *   reached maxBuffer size limit)   has DONE-MARKER: false
 * $ …the same with maxBuffer raised
 * status: 0     has DONE-MARKER: true
 * ```
 *
 * So the instrument truncated its own measurement and reported success —
 * which is the defect class #323 exists about, produced by the tool built to
 * measure it. `.claude/rules/checks-must-be-able-to-fail.md`: *before you
 * believe a reading, check the instrument.* The baseline discipline catches
 * this inside a battery; nothing was catching it on a real dispatch.
 *
 * ## Two repairs, and one of them was rejected
 *
 * **Shipped — the cause.** `maxBuffer` is raised, and the output is written
 * to its log before anything reads it.
 *
 * **Shipped — the guard, because the cause is not the point.** A run that
 * did not finish is UNMEASURED whatever its text says. The series layer is
 * the right place for this and `readSuiteRun` is not: that function
 * deliberately takes no exit code, because #469's run exited 0 having
 * measured nothing and this one exited `null` having measured nothing, and
 * no reading of TEXT can tell which way to resolve that. A signal is not
 * ambiguous, and only the process's caller ever sees one.
 *
 * **Rejected — refusing a reading whose `failingTests` outnumber its
 * `fail`.** Runs 2 through 10 carry exactly that shape: `fail: 0` beside the
 * name of a real failing test. It looks like a free second witness and it is
 * a false-positive generator: this repository's suite spawns deliberately
 * failing mutant suites and captures their output, so a perfectly healthy
 * full run prints nested `(fail)` lines the outer summary does not count.
 * `describeSuiteFailures` already handles it correctly by WITHHOLDING the
 * names and stating the contradiction, and escalating that to a refusal
 * would make the instrument red on good runs. Recorded because the cheapest
 * second guard here is the wrong one.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Raise `maxBuffer` and stop there.** It is one option in one call, the
 * symptom disappears, the next series runs to completion, and the instrument
 * is exactly as unable to notice a killed run as it was — so the next cause
 * that kills a run, on a runner with less memory or a suite that grows,
 * reports CONSISTENT again.
 *
 * **AC-2 is the case that does not survive it**: it drives `flakeReading`
 * over a series whose run carries a SIGTERM, with text that parses as a
 * clean reading, and requires UNMEASURED. No buffer size changes its answer.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/suite-flake.test.ts`. Counts predicted in
 * `/tmp/323t/predictions.md` before the battery ran, and **the baseline row
 * read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | read first | **36 pass, 0 fail** | — |
 * | N1 `exitRefusal` short-circuited to `return null` | 4 | **4 of 36** | a series whose run 10 carries SIGTERM, ENOBUFS, exit 7, or no status at all |
 * | N2 only the SIGNAL arm removed | 1 | **1 of 36** | `{status: null, signal: "SIGTERM"}` — the null-status arm below still refuses, so the verdict is unchanged and only the claim that the refusal NAMES the signal goes red |
 * | N3 only the ERROR arm removed | 1 | **1 of 36** | the ENOBUFS record — the signal arm still refuses, with a message that sends a reader to the machine instead of to the call |
 * | N4 the 0-or-1 status allowlist deleted | 1 | **1 of 36** | `{status: 7}` |
 * | N5 `maxBuffer` reverted to the 1 MiB default in the script | 1 | **1 of 36** | the end-to-end fixture: the original reads `3 pass, 0 fail` off a log ending in its own summary, the mutant's child is killed and the log stops mid-stream |
 * | N6 the exit loop removed from `flakeReading`, `exitRefusal` left exported | 4 | **4 of 36** | the same four as N1 |
 * | N7 `exitRefusal` refuses EVERY exit | 8 | **11 of 36** | every clean series, `exit 1`, and the end-to-end run |
 *
 * **N1 and N6 are equal on purpose and N6 is the one that matters.** They
 * are the same behaviour in two syntaxes; N6 leaves the binding exported,
 * unit-testable and never called, which is #530 — *an unwired control is
 * byte-identical to no control*. A battery that only ran N1 would prove the
 * function works and say nothing about whether anything calls it.
 *
 * **N7 came back HIGH, and the three extra reds are the real kind.** They
 * are the three AC-2 cases that *expect* UNMEASURED — SIGTERM, ENOBUFS and
 * exit 7 — which the prediction scored as green because the mutant also
 * returns UNMEASURED. It does; what it does not do is say WHY, and each of
 * those cases asserts the refusal names its own cause. So the prediction
 * counted verdicts where the cases claim two things, and the fact the row
 * records is that **naming the cause is load-bearing in three places, not
 * decoration.** Not a crashing mutant: 25 cases still pass and every red is
 * about a verdict or a refusal message.
 *
 * None of the seven mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and `lib/suite-flake.ts` and
 * `scripts/suite-flake-run.ts` were confirmed byte-identical by sha256
 * afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { flakeReading, type FlakeRun, type TreeSignature } from "../lib/suite-flake";
import { readSuiteRun } from "../lib/suite-run-reading";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "suite-flake-run.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TREE: TreeSignature = { head: "07def1bf", dirty: [] };

/**
 * The reading the killed runs produced, verbatim in shape.
 *
 * A nested suite's summary, which is all `run-01.log` contained, and which
 * `readSuiteRun` reads as a clean MEASURED run — correctly, because there is
 * nothing in the text saying otherwise.
 */
const NESTED_ONLY = [
  "bun test v1.3.14 (d1632b29)",
  "  a test that drives bun printed this:",
  " 1 pass",
  " 0 fail",
  " 1 expect() calls",
  "Ran 1 test across 1 file. [15.00ms]",
  "",
  "(pass) a case that was running when the process died [0.02ms]",
].join("\n");

function entry(index: number, exit: FlakeRun["exit"], output = NESTED_ONLY): FlakeRun {
  return { index, signature: TREE, run: readSuiteRun(output), log: `run-${index}.log`, seconds: 69, exit };
}

const CLEAN_EXIT: FlakeRun["exit"] = { status: 0, signal: null, error: null };

describe("#323 AC-1: the text really does read clean, which is why a guard is needed", () => {
  test("the truncated log parses as a MEASURED, zero-failure run", () => {
    // The premise of every case below, asserted rather than assumed. If this
    // output were already UNMEASURED there would be nothing for the exit
    // guard to catch and the whole file would be measuring nothing (#492).
    const run = readSuiteRun(NESTED_ONLY);
    expect(run.status).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    expect(run.fail).toBe(0);
    expect(run.pass).toBe(1);
  });

  test("a series of them with clean exits is CONSISTENT — the pre-fix behaviour", () => {
    // Deliberately kept. It is the reading run 39405680063 produced, and it
    // is CORRECT for a run that genuinely exited 0: a one-test project is a
    // perfectly good clean series. The defect is not the text, it is that
    // nothing looked at how the process ended.
    const series = Array.from({ length: 10 }, (_, i) => entry(i + 1, CLEAN_EXIT));
    expect(flakeReading(series, 10).verdict).toBe("CONSISTENT");
  });
});

describe("#323 AC-2: a run that did not finish is UNMEASURED, whatever its log says", () => {
  test("SIGTERM taints the series, and the signal is named", () => {
    // The exact shape of run 39405680063: killed child, truncated output, a
    // nested summary that parses clean. The case the cheapest wrong fix —
    // raising maxBuffer and stopping — does not survive.
    const series = [
      ...Array.from({ length: 9 }, (_, i) => entry(i + 1, CLEAN_EXIT)),
      entry(10, { status: null, signal: "SIGTERM", error: null }),
    ];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.verdict).not.toBe("CONSISTENT");
    expect(reading.reasons.join(" ")).toContain("run 10");
    expect(reading.reasons.join(" "), "the series does not say how the run ended").toContain("SIGTERM");
  });

  test("the spawn's own error is carried, because ENOBUFS names the cause", () => {
    // "Killed" sends a reader to the machine. "ENOBUFS — maxBuffer" sends
    // them to the call. The difference is the whole of this issue's
    // diagnosis, and it was available in `r.error` all along.
    const series = [
      ...Array.from({ length: 9 }, (_, i) => entry(i + 1, CLEAN_EXIT)),
      entry(10, {
        status: null,
        signal: "SIGTERM",
        error: "spawnSync ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)",
      }),
    ];
    expect(flakeReading(series, 10).reasons.join(" ")).toContain("ENOBUFS");
  });

  test("an exit code bun does not use for a test result is UNMEASURED", () => {
    // 0 is a clean suite and 1 is a failing one. Anything else is the runner
    // falling over, which is not a verdict about the tests.
    const series = [...Array.from({ length: 9 }, (_, i) => entry(i + 1, CLEAN_EXIT)), entry(10, { status: 7, signal: null, error: null })];
    const reading = flakeReading(series, 10);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.reasons.join(" ")).toContain("it exited 7");
  });

  test("exit 1 is NOT refused — a failing suite is a measurement", () => {
    // The control, and the one that keeps the guard from swallowing the
    // finding it exists to surface. `bun test` exits 1 when tests fail, so
    // refusing a non-zero exit outright would turn every FLAKY and FAILING
    // series into UNMEASURED and make the instrument unable to report its
    // own subject.
    const failing = [
      "bun test v1.3.14 (d1632b29)",
      "(fail) a > b [0.12ms]",
      " 5463 pass",
      " 1 fail",
      " 13648 expect() calls",
      "Ran 5464 tests across 324 files. [412.00s]",
    ].join("\n");
    const clean = [
      "bun test v1.3.14 (d1632b29)",
      " 5464 pass",
      " 0 fail",
      " 13648 expect() calls",
      "Ran 5464 tests across 324 files. [412.00s]",
    ].join("\n");
    const series = [
      ...Array.from({ length: 9 }, (_, i) => entry(i + 1, CLEAN_EXIT, clean)),
      entry(10, { status: 1, signal: null, error: null }, failing),
    ];
    const reading = flakeReading(series, 10);
    expect(reading.verdict, `exit 1 was refused: ${reading.reasons.join(" ")}`).toBe("FLAKY");
    expect(reading.verdict).not.toBe("UNMEASURED");
  });

  test("a clean exit with no status at all is refused rather than assumed fine", () => {
    // `{status: null, signal: null}` is a spawn that reported nothing about
    // how it ended. Silence is not an exit code.
    const series = [...Array.from({ length: 9 }, (_, i) => entry(i + 1, CLEAN_EXIT)), entry(10, { status: null, signal: null, error: null })];
    expect(flakeReading(series, 10).verdict).toBe("UNMEASURED");
  });
});

describe("#323 AC-3: the script survives a suite that outprints the default buffer", () => {
  /**
   * A project the real script will accept, whose "suite" prints more than
   * 1 MiB and then a clean bun-shaped summary.
   *
   * END-TO-END on purpose. Every case above drives `flakeReading` with an
   * exit record typed by hand, which proves the guard reads what it is
   * given and proves nothing about whether the runner ever produces a
   * truthful one. This is the only case that executes the actual spawn, and
   * it is the regression test for the actual bug.
   */
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "rg-323t-"));
    scratch.push(root);
    const noisy = join(root, "noisy.sh");
    // Over 1 MiB, then the summary. Under the default maxBuffer the child is
    // killed before the summary is ever printed.
    writeFileSync(
      noisy,
      [
        "#!/bin/sh",
        "i=0",
        "while [ $i -lt 24000 ]; do",
        "  echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'",
        "  i=$((i+1))",
        "done",
        "echo ' 3 pass'",
        "echo ' 0 fail'",
        "echo ' 9 expect() calls'",
        "echo 'Ran 3 tests across 1 file. [0.10s]'",
      ].join("\n") + "\n",
    );
    chmodSync(noisy, 0o755);

    const command = "sh noisy.sh";
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "t", test: { command } }, null, 2) + "\n",
    );
    writeFileSync(root + "/AGENTS.md", `# t\n\n## Commands\n\n| Action | Command |\n|---|---|\n| Test | \`${command}\` |\n`);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "workflows", "ci.yml"),
      ["name: CI", "on: [push]", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", `      - run: ${command}`].join("\n") + "\n",
    );
    return root;
  }

  test("a suite printing over 1 MiB is measured, not killed and called clean", () => {
    const root = project();
    const out = join(root, "logs");
    const r = spawnSync("bun", [SCRIPT, "--runs", "2", "--out", out, "--project", root], {
      cwd: root,
      encoding: "utf-8",
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    // The premise, asserted inside the case: the fixture really does exceed
    // the default buffer. A fixture that fitted would pass whether or not
    // anything was fixed (#500).
    const log = readFileSync(join(out, "run-01.log"), "utf-8");
    expect(log.length, "the fixture does not exceed the 1 MiB default buffer").toBeGreaterThan(1024 * 1024);

    expect(r.status, `the series refused: ${said}`).toBe(0);
    expect(said).toContain("CONSISTENT");
    // The summary is at the END of the output, so reading it at all is proof
    // the child was not killed partway.
    expect(said, "the run was truncated before its own summary").toContain("3 pass, 0 fail");
    expect(log.trimEnd().endsWith("Ran 3 tests across 1 file. [0.10s]")).toBe(true);
  });
});
