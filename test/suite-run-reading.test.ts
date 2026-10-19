/**
 * Covers SC-1825..SC-1832 (HARNESS-STANDARD.md), #469 and #490.
 *
 * Two runs that measured nothing and read as clean:
 *
 *  - #469. A worktree was deleted by hand while its suite was running. The run
 *    printed four `error: ENOENT reading "…"` blocks, no `N pass / N fail`
 *    summary, and `[exited with code 0]`.
 *  - #490. A runner that discovers nothing exits 0. So does a clean run.
 *
 * Every fixture below is EXECUTED, not described. A recorded output string
 * would make this a test of a regex against text this file chose, and the
 * whole subject is that the text a real runner produces is not the text
 * anybody expects. The three synthetic cases are marked as such and exist for
 * shapes bun does not produce — a half summary, and a runner contradicting
 * itself — because a branch no fixture can enter is a branch that cannot fail.
 *
 * **The exit code is not consulted, and the fixtures prove it has to be that
 * way:** among the live runs below, exit 0 covers one measured and one
 * unmeasured run, and so does exit 1. #469's run exited 0; the reproduction
 * of it on bun 1.3.14 exits 1. A reading keyed off the exit code would have
 * been wrong about one of them.
 *
 * ── #621 AC-2 ────────────────────────────────────────────────
 *
 * The second half of the file is about the three ways a measurement can fail
 * BEFORE there is any output worth parsing, and the one thing they have in
 * common: none of them is a FAIL.
 *
 *  - the full-suite slot pool is exhausted, so the run was refused before the
 *    runner started. #621 names this one by hand: `test-clean-env.ts` exits 2
 *    when `acquireFullSuiteSlot` refuses, and "exit 2 must record UNMEASURED,
 *    never FAIL".
 *  - the test runner binary cannot be executed at all.
 *  - the runner exited non-zero having printed no pass/fail summary.
 *
 * Each has to record its OWN reason, because the thing an operator has to go
 * and do about them is different in all three cases, and a shared reason
 * would make the recorded artefact unable to say which one happened.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSuiteAttempt, readSuiteRun, suiteRunVerdict } from "../lib/suite-run-reading";
import { readSuiteMeasurement } from "../lib/suite-measurement";
import { acquireFullSuiteSlot, type AcquireResult } from "../lib/test-suite-lock";
import { buildMeasurement } from "../scripts/record-suite-measurement";

let ROOT = "";

interface Run {
  output: string;
  code: number;
}

/** A real `bun test` in a real directory, with everything it printed. */
function runSuite(dir: string): Run {
  const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf-8", timeout: 60000 });
  return { output: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
}

function plant(name: string, files: Record<string, string>): string {
  const dir = join(ROOT, name);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ONE_PASSING = 'import { test, expect } from "bun:test";\ntest("t", () => { expect(1).toBe(1); });\n';

/** Named so the four live runs can be read as a table rather than as prose. */
const LIVE: Record<"vanishing" | "noFiles" | "emptyFile" | "clean" | "failing", Run> = {} as any;

/**
 * A binary that does not exist, spelled so it cannot start existing by
 * accident. The reason for AC-2b has to NAME it, which is what separates that
 * branch from "the runner produced no output" — an ENOENT launch produces no
 * output either, so a reading that fell through to the output parser would be
 * green on everything except the one thing an operator needs to be told.
 */
const ABSENT_RUNNER = "rungate-no-such-test-runner-9f3c1a";

/** The real `child_process` failure for a runner that is not on PATH. */
let LAUNCH: ReturnType<typeof spawnSync>;

/** The real refusal from a real exhausted slot pool, in a private lock dir. */
let SLOT_REFUSAL: AcquireResult;
let LOCK_DIR = "";

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "suite-run-reading-"));

  // #469, reproduced. The first file bun imports removes the directory the
  // rest live in, so the run is launched over files that are gone by the time
  // it reaches them — which is what a worktree being deleted mid-run looks
  // like from inside the runner.
  LIVE.vanishing = runSuite(
    plant("vanishing", {
      "000-remover.test.ts":
        'import { rmSync } from "fs";\n' +
        'rmSync(`${import.meta.dir}/sub`, { recursive: true, force: true });\n',
      "sub/a.test.ts": ONE_PASSING,
      "sub/b.test.ts": ONE_PASSING,
      "sub/c.test.ts": ONE_PASSING,
    }),
  );

  // A directory with no test files in it at all.
  LIVE.noFiles = runSuite(plant("no-files", { "README.md": "nothing here\n" }));

  // #490, reproduced. One test file, zero tests. Every indicator is green.
  LIVE.emptyFile = runSuite(plant("empty-file", { "only.test.ts": "export const x = 1;\n" }));

  LIVE.clean = runSuite(plant("clean", { "a.test.ts": ONE_PASSING }));

  LIVE.failing = runSuite(
    plant("failing", {
      "a.test.ts": 'import { test, expect } from "bun:test";\ntest("t", () => { expect(1).toBe(2); });\n',
    }),
  );

  // #621 AC-2b, executed. `spawnSync` reports a runner that is not on PATH
  // through `.error` with a null status and no output at all.
  LAUNCH = spawnSync(ABSENT_RUNNER, ["test"], { encoding: "utf-8" });

  // #621 AC-2a, executed against the real slot pool rather than a hand-written
  // `{ ok: false }`. A literal would make the case a test of a boolean; the
  // library's own refusal is what the measurement path will actually be
  // handed. The lock dir is private and the capacity is 1, so this cannot see
  // or take a slot any real suite is using — and `suitesRunning` is pinned so
  // the held slot is never reclaimed as stale while the fixture is being read.
  LOCK_DIR = mkdtempSync(join(tmpdir(), "suite-run-reading-slots-"));
  const pool = { lockDir: LOCK_DIR, capacity: 1, suitesRunning: () => true };
  const held = acquireFullSuiteSlot("holder-session", { ...pool, workerId: "holder-worker" });
  if (!held.ok) throw new Error("the slot fixture could not take the only slot, so nothing is exhausted");
  SLOT_REFUSAL = acquireFullSuiteSlot("asking-session", { ...pool, workerId: "asking-worker" });
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  // The slot files live in this directory, so removing it releases them.
  if (LOCK_DIR) rmSync(LOCK_DIR, { recursive: true, force: true });
});

// ── the fixtures are what they claim to be ───────────────────

describe("#469/#490: the fixtures still reproduce what they were built for", () => {
  test("SC-1825: a run whose test files vanish prints no pass/fail summary", () => {
    // The instrument check, before any reading of it. A fixture that stopped
    // reproducing and a parser that stopped matching produce the same
    // UNMEASURED below, and only this row can tell them apart
    // (.claude/rules/checks-must-be-able-to-fail.md).
    expect(LIVE.vanishing.output, "the vanishing fixture no longer runs bun at all").toContain("bun test v");
    expect(LIVE.vanishing.output, "the vanishing fixture now prints a summary — re-derive it")
      .not.toMatch(/^\s*\d+\s+(pass|fail)\s*$/m);

    const run = readSuiteRun(LIVE.vanishing.output);
    expect(run.status).toBe("UNMEASURED");
    if (run.status === "UNMEASURED") expect(run.reason).toContain("no pass/fail summary");
    expect(suiteRunVerdict(run)).toBe("UNMEASURED");
    expect(suiteRunVerdict(run)).not.toBe("PASS");
  });

  test("SC-1826: a runner that discovered one file and ran nothing in it reads UNMEASURED", () => {
    // #490 exactly, and the row that says why this module refuses on the
    // EXECUTED count rather than on the discovered file count: this run
    // discovered a file. "files > 0" is satisfied, and nothing was measured.
    expect(LIVE.emptyFile.output, "the empty-file fixture no longer reports a file").toMatch(/across 1 file/);
    expect(LIVE.emptyFile.code, "the empty-file fixture no longer exits clean — it is the point that it does")
      .toBe(0);

    const run = readSuiteRun(LIVE.emptyFile.output);
    expect(run.status).toBe("UNMEASURED");
    if (run.status === "UNMEASURED") {
      expect(run.reason).toContain("executed 0 tests");
      // The reason carries the coverage, so an operator can tell "no files"
      // from "files with nothing in them" without re-running anything.
      expect(run.reason).toContain("1 test file");
    }
  });

  test("SC-1827: a directory with no test files reads UNMEASURED", () => {
    // The instrument, asserted as a PROPERTY rather than as bun's sentence.
    // The first draft asserted `toContain("0 test files matching")`, which is
    // the exact wording of bun 1.3.14 — CI ran `bun-version: latest` until
    // #622 and 1.4.3 says `No tests found!` instead, so the row went red in CI while
    // the reading was correct on both. An assertion on a vendor's phrasing is
    // a detector narrower than what it detects
    // (.claude/rules/checks-must-be-able-to-fail.md), and the property here
    // is that the runner said something and none of it was a summary.
    expect(LIVE.noFiles.output.trim(), "the no-files fixture printed nothing at all").not.toBe("");
    expect(LIVE.noFiles.output, "the no-files fixture now prints a summary — re-derive it")
      .not.toMatch(/^\s*\d+\s+(pass|fail)\s*$/m);

    const run = readSuiteRun(LIVE.noFiles.output);
    expect(run.status).toBe("UNMEASURED");
    if (run.status === "UNMEASURED") expect(run.reason).toContain("no pass/fail summary");
  });

  test("SC-1828: a real suite is measured - and keeps the coverage it reported", () => {
    // The control. Without it a reader that refused everything would satisfy
    // every row above while making the harness unable to record any run.
    const clean = readSuiteRun(LIVE.clean.output);
    expect(clean.status, clean.status === "UNMEASURED" ? clean.reason : "").toBe("MEASURED");
    if (clean.status !== "MEASURED") return;
    expect(clean.pass).toBe(1);
    expect(clean.fail).toBe(0);
    expect(clean.tests).toBe(1);
    expect(clean.files).toBe(1);
    expect(suiteRunVerdict(clean)).toBe("PASS");

    const failing = readSuiteRun(LIVE.failing.output);
    expect(failing.status).toBe("MEASURED");
    if (failing.status !== "MEASURED") return;
    expect(failing.fail).toBe(1);
    expect(suiteRunVerdict(failing)).toBe("FAIL");
  });

  test("SC-1829: the exit code decides nothing - both values appear on both verdicts", () => {
    // #469's run exited 0 having measured nothing; the reproduction of it
    // above exits 1. Neither value is evidence either way, and this row is
    // the measurement that says so rather than a sentence claiming it.
    const rows = [
      ["vanishing", LIVE.vanishing, "UNMEASURED"],
      ["no files", LIVE.noFiles, "UNMEASURED"],
      ["empty file", LIVE.emptyFile, "UNMEASURED"],
      ["clean", LIVE.clean, "PASS"],
      ["failing", LIVE.failing, "FAIL"],
    ] as const;

    const actual = rows.map(([label, run, expected]) => {
      const verdict = suiteRunVerdict(readSuiteRun(run.output));
      return { label, code: run.code, expected, verdict };
    });
    expect(actual.filter(r => r.verdict !== r.expected)).toEqual([]);

    const measuredCodes = new Set(actual.filter(r => r.verdict !== "UNMEASURED").map(r => r.code));
    const unmeasuredCodes = new Set(actual.filter(r => r.verdict === "UNMEASURED").map(r => r.code));
    // A reading keyed off the exit code cannot separate these two sets, and
    // that is the whole claim: an overlap in BOTH directions, measured.
    expect([...measuredCodes].sort(), `measured runs exited: ${[...measuredCodes]}`).toEqual([0, 1]);
    expect([...unmeasuredCodes].sort(), `unmeasured runs exited: ${[...unmeasuredCodes]}`).toEqual([0, 1]);
  });
});

// ── shapes bun does not produce ──────────────────────────────

describe("#469/#490: outputs no bun fixture can make, driven directly", () => {
  test("SC-1830: half a summary is not a summary", () => {
    // Synthetic on purpose: bun always prints both lines, so no fixture here
    // can enter this branch. A runner that printed one of them would
    // otherwise have the other defaulted to zero, which is the fail-open the
    // whole module exists to remove.
    const passOnly = readSuiteRun("some runner\n 7 pass\n");
    expect(passOnly.status).toBe("UNMEASURED");
    if (passOnly.status === "UNMEASURED") expect(passOnly.reason).toContain('no "fail" count');

    const failOnly = readSuiteRun("some runner\n 0 fail\n");
    expect(failOnly.status).toBe("UNMEASURED");
    if (failOnly.status === "UNMEASURED") expect(failOnly.reason).toContain('no "pass" count');
  });

  test("SC-1831: results reported from zero discovered files contradict each other", () => {
    // #490 SC-1 — the discovered file count asserted greater than zero — as
    // the one question the executed-count refusal cannot ask. That one fires
    // when nothing ran; this fires only when something did, so each has an
    // input the other never sees and neither can hold the other up
    // (.claude/rules/checks-must-be-able-to-fail.md, the fourth shape).
    const run = readSuiteRun(" 3 pass\n 0 fail\nRan 3 tests across 0 files. [1.00ms]\n");
    expect(run.status).toBe("UNMEASURED");
    if (run.status === "UNMEASURED") {
      expect(run.reason).toContain("discovered 0 test files");
      expect(run.reason).toContain("contradict");
    }

    // The same output with one file is measured, so the refusal is about the
    // zero and not about the shape of the line.
    const ok = readSuiteRun(" 3 pass\n 0 fail\nRan 3 tests across 1 file. [1.00ms]\n");
    expect(ok.status).toBe("MEASURED");
  });

  test("SC-1832: a runner that reports no file count is measured with files null - never 0", () => {
    // The population split. This repo can read bun; it cannot read every
    // runner a consumer configures. A runner that printed counts has proved
    // it executed something whether or not it said how many files they came
    // from, so the file count is recorded as null — "asked and did not say" —
    // rather than as a 0 a reader could add up
    // (.claude/rules/config-access.md, Silent Default Substitution).
    const run = readSuiteRun("=== 12 passed, 3 failed ===\n 12 pass\n 3 fail\n");
    expect(run.status).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    expect(run.files).toBeNull();
    expect(run.files).not.toBe(0);
    expect(run.tests).toBeNull();
    expect(suiteRunVerdict(run)).toBe("FAIL");

    // And nothing at all is still a refusal, not a zero.
    for (const empty of ["", "   \n", undefined, null, 0, {}]) {
      const r = readSuiteRun(empty);
      expect(r.status, `${JSON.stringify(empty)} was read as a result`).toBe("UNMEASURED");
    }
  });

  test("SC-1833: the summary is read off whole lines - not out of prose", () => {
    // A detector narrower than what it detects, in the other direction: a
    // captured log that MENTIONS a count must not be read as reporting one.
    // Without the line anchors, the sentence below reports a clean suite.
    const prose = readSuiteRun(
      "the previous attempt had 0 fail and 0 pass, which is why this run exists\nbut it printed no summary\n",
    );
    expect(prose.status).toBe("UNMEASURED");

    // And when a run really does contain an inner suite's output, the LAST
    // summary is the one that belongs to this run — the choice
    // `parseTestFailureCount` made in #307, kept so the two agree.
    const nested = readSuiteRun(
      " 1 pass\n 0 fail\nRan 1 test across 1 file.\n--- outer ---\n 9 pass\n 2 fail\nRan 11 tests across 4 files.\n",
    );
    expect(nested.status).toBe("MEASURED");
    if (nested.status === "MEASURED") {
      expect(nested.fail).toBe(2);
      expect(nested.files).toBe(4);
    }
  });
});

// ── #621 AC-2: three measurement failures, three reasons ─────

/** The three attempts, built from the executed fixtures above. */
function attempts() {
  return {
    // AC-2a. The pool refused, so the runner never started and there is no
    // output of any kind to read — which is why the slot answer has to travel
    // with the attempt rather than be inferred from what was printed.
    slotExhausted: { slot: SLOT_REFUSAL, command: ["bun", "test"] },
    // AC-2b.
    absentRunner: {
      command: [ABSENT_RUNNER, "test"],
      launchError: LAUNCH.error,
      output: `${LAUNCH.stdout ?? ""}${LAUNCH.stderr ?? ""}`,
      exitCode: LAUNCH.status,
    },
    // AC-2c.
    noSummary: { command: ["bun", "test"], output: LIVE.vanishing.output, exitCode: LIVE.vanishing.code },
  };
}

function reasonOf(attempt: Parameters<typeof readSuiteAttempt>[0]): string {
  const run = readSuiteAttempt(attempt);
  if (run.status !== "UNMEASURED") throw new Error(`expected UNMEASURED, got ${run.status}`);
  return run.reason;
}

/**
 * The artefact a recorder would leave behind, derived rather than typed out.
 *
 * `scripts/record-suite-measurement.ts` refuses on UNMEASURED and writes
 * nothing, so the state a failed measurement produces carries no
 * `suiteMeasurement` at all. Mirroring that here — with the recorder's own
 * `buildMeasurement` for the measured half — is what makes AC-2e a claim
 * about the recorded artefact and not only about the in-memory reading.
 */
function recordedState(attempt: Parameters<typeof readSuiteAttempt>[0]): Record<string, unknown> {
  const run = readSuiteAttempt(attempt);
  if (run.status !== "MEASURED") return {};
  // `"full"`: these fixtures are whole-suite runs, and #673 made the scope a
  // required argument because the output cannot say which kind of run it was.
  return {
    suiteMeasurement: buildMeasurement("0f1e2d3c4b5a69788796a5b4c3d2e1f0abcdef01", run, "full"),
  };
}

describe("#621 AC-2: a measurement that failed records UNMEASURED and says which way", () => {
  test("AC-2a: a run refused because the full-suite slot is held records UNMEASURED naming slot exhaustion", () => {
    // The instrument, before anything is read off it: the pool really did
    // refuse, and it really did name a holder. A fixture that silently started
    // succeeding would make every assertion below describe a different input.
    expect(SLOT_REFUSAL.ok, "the slot fixture was granted a slot — the pool is not exhausted").toBe(false);
    expect(SLOT_REFUSAL.degraded ?? false, "the slot guard degraded, so this is not a refusal").toBe(false);
    expect((SLOT_REFUSAL.holders ?? []).length, "the refusal named no holder").toBeGreaterThan(0);

    const run = readSuiteAttempt(attempts().slotExhausted);
    expect(run.status).toBe("UNMEASURED");
    if (run.status !== "UNMEASURED") return;
    expect(run.reason).toContain("slot");
    expect(run.reason).toContain("exhaust");
    // The holder is named, so an operator can tell a wedged slot from a busy
    // one without going to look at the lock directory.
    expect(run.reason).toContain("holder-worker");
    expect(suiteRunVerdict(run)).toBe("UNMEASURED");
    expect(suiteRunVerdict(run)).not.toBe("FAIL");

    // The cheapest wrong repair for a reading that refuses too much is to make
    // the slot branch unconditional. This is the input that catches it: a pool
    // that GRANTED the slot, over a clean run, is a measurement.
    const granted = readSuiteAttempt({
      slot: { ok: true },
      command: ["bun", "test"],
      output: LIVE.clean.output,
      exitCode: LIVE.clean.code,
    });
    expect(granted.status, "a granted slot over a clean run must still be measured").toBe("MEASURED");
  });

  test("AC-2b: a run whose test runner cannot be executed records UNMEASURED naming the absent runner", () => {
    expect(LAUNCH.error, "the absent-runner fixture found a binary — rename it").toBeTruthy();
    // `spawnSync` reports no status at all for a launch that never happened —
    // undefined on bun, null on node. Either way it is NOT a number, and that
    // is the property: there is no exit code to read, so a reading that waited
    // for one would wait forever.
    expect(typeof LAUNCH.status, "the absent-runner fixture produced an exit status, so it launched")
      .not.toBe("number");
    // The whole difficulty of this mode, asserted as the premise it is: an
    // ENOENT launch prints NOTHING, so the output parser downstream has no
    // way to tell it from a runner that ran and said nothing.
    expect(`${LAUNCH.stdout ?? ""}${LAUNCH.stderr ?? ""}`, "the absent runner printed something").toBe("");

    const run = readSuiteAttempt(attempts().absentRunner);
    expect(run.status).toBe("UNMEASURED");
    if (run.status !== "UNMEASURED") return;
    expect(run.reason).toContain(ABSENT_RUNNER);
    expect(run.reason).toContain("could not be executed");
    expect(run.reason).toContain("ENOENT");
    expect(suiteRunVerdict(run)).toBe("UNMEASURED");
    expect(suiteRunVerdict(run)).not.toBe("FAIL");
  });

  test("AC-2c: a non-zero exit with no pass/fail summary records UNMEASURED naming the missing summary", () => {
    expect(LIVE.vanishing.code, "the vanishing fixture now exits 0 — AC-2c is about a non-zero exit")
      .not.toBe(0);
    expect(LIVE.vanishing.output, "the vanishing fixture now prints a summary — re-derive it")
      .not.toMatch(/^\s*\d+\s+(pass|fail)\s*$/m);

    const run = readSuiteAttempt(attempts().noSummary);
    expect(run.status).toBe("UNMEASURED");
    if (run.status !== "UNMEASURED") return;
    expect(run.reason).toContain("no pass/fail summary");
    expect(run.reason).toContain(`exited ${LIVE.vanishing.code}`);
    expect(suiteRunVerdict(run)).toBe("UNMEASURED");
    expect(suiteRunVerdict(run)).not.toBe("FAIL");

    // The exit code must not have become a decider on the way in. SC-1829
    // measures that for `readSuiteRun`; this is the same claim for the attempt
    // reader, and it is the input that fails under the cheapest wrong fix for
    // AC-2c — "refuse when the exit code is non-zero", which would turn every
    // genuinely failing suite into an unmeasured one and switch the gate off.
    const measuredFailure = readSuiteAttempt({
      command: ["bun", "test"],
      output: LIVE.failing.output,
      exitCode: LIVE.failing.code,
    });
    expect(LIVE.failing.code, "the failing fixture no longer exits non-zero").not.toBe(0);
    expect(measuredFailure.status, "a non-zero exit WITH a summary is a result").toBe("MEASURED");
    expect(suiteRunVerdict(measuredFailure)).toBe("FAIL");
  });

  test("AC-2d: the three reasons are pairwise distinct", () => {
    const a = attempts();
    const reasons = {
      slotExhausted: reasonOf(a.slotExhausted),
      absentRunner: reasonOf(a.absentRunner),
      noSummary: reasonOf(a.noSummary),
    };
    const list = Object.values(reasons);
    expect(new Set(list).size, `two modes share a reason: ${JSON.stringify(reasons, null, 2)}`).toBe(3);

    // Distinct strings are the floor, not the property. Three reasons that
    // differ only in a timestamp would pass the line above while leaving an
    // operator unable to tell the modes apart, so each reason must carry its
    // OWN marker and neither of the other two.
    const markers = {
      slotExhausted: /slot/i,
      absentRunner: new RegExp(ABSENT_RUNNER),
      noSummary: /no pass\/fail summary/,
    } as const;
    const crossed: string[] = [];
    for (const [mode, reason] of Object.entries(reasons)) {
      for (const [other, marker] of Object.entries(markers)) {
        const hit = marker.test(reason);
        if (mode === other && !hit) crossed.push(`${mode} does not carry its own marker`);
        if (mode !== other && hit) crossed.push(`${mode} carries ${other}'s marker`);
      }
    }
    expect(crossed).toEqual([]);

    // And no reason is a prefix or substring of another, which is the way two
    // reasons stay distinguishable to a reader doing a substring match.
    for (const [i, one] of list.entries()) {
      for (const [j, other] of list.entries()) {
        if (i === j) continue;
        expect(one.includes(other), `reason ${i} contains reason ${j} whole`).toBe(false);
      }
    }
  });

  test("AC-2e: no mode returns FAIL - through either module, and FAIL is still reachable", () => {
    const a = attempts();
    const modes = [
      ["slot exhausted", a.slotExhausted],
      ["absent runner", a.absentRunner],
      ["no summary", a.noSummary],
    ] as const;

    const verdicts = modes.map(([label, attempt]) => ({
      label,
      reading: suiteRunVerdict(readSuiteAttempt(attempt)),
      recorded: readSuiteMeasurement(recordedState(attempt)).verdict,
    }));
    expect(verdicts.filter(v => v.reading === "FAIL" || v.recorded === "FAIL")).toEqual([]);
    expect(verdicts.map(v => `${v.reading}/${v.recorded}`)).toEqual([
      "UNMEASURED/UNMEASURED",
      "UNMEASURED/UNMEASURED",
      "UNMEASURED/UNMEASURED",
    ]);

    // The positive control, without which a pair of modules that never
    // returned FAIL at all would satisfy every row above. Same two functions,
    // same helper, a run that really did fail.
    const failing = { command: ["bun", "test"], output: LIVE.failing.output, exitCode: LIVE.failing.code };
    expect(suiteRunVerdict(readSuiteAttempt(failing))).toBe("FAIL");
    expect(readSuiteMeasurement(recordedState(failing)).verdict).toBe("FAIL");
  });
});
