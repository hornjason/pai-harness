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
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSuiteRun, suiteRunVerdict } from "../lib/suite-run-reading";

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
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
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
    // the exact wording of bun 1.3.14 — CI runs `bun-version: latest` and
    // 1.4.3 says `No tests found!` instead, so the row went red in CI while
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
