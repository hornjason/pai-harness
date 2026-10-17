/**
 * Covers SC-1712..SC-1717 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #312 SC-A12,
 * SC-A13 and SC-A14. Fixes #285.
 *
 * On main the heal prompt and the recorder contradicted each other outright.
 * The prompt emitted:
 *
 *     --state <…> --result PASS|FAIL --project <…>
 *
 * and `scripts/record-suite-measurement.ts` declared
 * `OPTIONS = {state, sha, failures}`, so the FIRST flag was refused as an
 * unexpected argument and the command could never record anything. The suite
 * result would then be missing at the verify gate, in a run whose whole
 * purpose was to supply it.
 *
 * Four tests covered that step and all four were green, because every one of
 * them asserted on prompt TEXT. `test/suite-measurement-parity.test.ts:287`
 * even asserted the prompt must not pass `--sha` while the recorder required
 * it — the contradiction was pinned from both ends by tests that agreed with
 * each other and with neither side of the real contract.
 *
 * So this file does the one thing none of those did: it takes the command the
 * workflow actually builds and RUNS it, against the real recorder, in a real
 * temp git repository. A flag the recorder rejects turns this red.
 *
 * The builder is extracted from its marker block and executed rather than
 * grepped. Grepping ship.js for `--failures` would pass against a prompt that
 * mentions the flag in prose and emits something else.
 */
import { describe, test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HARNESS_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(HARNESS_ROOT, "workflows", "ship.js"), "utf-8");

/** The text between a START/END marker pair. */
function markedBlock(source: string, name: string): string {
  const start = source.indexOf(`// ──── ${name}-START ────`);
  const end = source.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return source.slice(start, end);
}

interface Builders {
  recorderCommand: (harnessRoot: string, workDir: string, projectRoot: string, quote: (w: string) => string) => string;
  suiteCaptureCommand: (projectRoot: string, testCommand: string, workDir: string, quote: (w: string) => string) => string;
}

function builderFrom(source: string): Builders {
  return new Function(
    `${markedBlock(source, "RECORDER-COMMAND")}\nreturn { recorderCommand, suiteCaptureCommand }`,
  )() as Builders;
}

const { recorderCommand, suiteCaptureCommand } = builderFrom(SHIP);
const quote = (w: string) => `'${String(w).replace(/'/g, "'\\''")}'`;

/**
 * The test file a scenario's project carries.
 *
 * `vanishing` is #469: the first file bun imports removes the directory the
 * rest live in, so the run is launched over files that are gone by the time
 * it reaches them — the shape a worktree deleted mid-run produces.
 */
type Suite = "passing" | "failing" | "vanishing" | "empty";

function plantSuite(project: string, suite: Suite): void {
  const body = (ok: boolean) =>
    'import { test, expect } from "bun:test";\n' +
    `test("t", () => { expect(1).toBe(${ok ? 1 : 2}); });\n`;
  if (suite === "empty") {
    // #490: a test file that declares no tests. bun reports
    // `0 pass / 0 fail / Ran 0 tests across 1 file.` and exits 0.
    writeFileSync(join(project, "a.test.ts"), "export const x = 1;\n");
    return;
  }
  if (suite === "vanishing") {
    mkdirSync(join(project, "sub"), { recursive: true });
    writeFileSync(
      join(project, "000-remover.test.ts"),
      'import { rmSync } from "fs";\nrmSync(`${import.meta.dir}/sub`, { recursive: true, force: true });\n',
    );
    for (const n of ["a", "b", "c"]) writeFileSync(join(project, "sub", `${n}.test.ts`), body(true));
    return;
  }
  writeFileSync(join(project, "a.test.ts"), body(suite === "passing"));
}

/** A git repo with one commit, and a workflow-state.json beside it. */
function scenario(suite: Suite = "passing"): { root: string; workDir: string; state: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-312-"));
  const project = join(root, "project");
  const workDir = join(root, "work");
  mkdirSync(project, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  plantSuite(project, suite);

  const git = (...a: string[]) =>
    execFileSync("git", ["-C", project, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  // Spelled out rather than routed through `git()` above: the #84 guard reads
  // the argv at the call site and cannot see a wrapper's prepended `-C`, so a
  // helper here is indistinguishable from a write to the real global config.
  execFileSync("git", ["-C", project, "config", "user.email", "t@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "config", "user.name", "T"], { stdio: "ignore" });
  writeFileSync(join(project, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");

  const state = join(workDir, "workflow-state.json");
  writeFileSync(
    state,
    JSON.stringify({
      schemaVersion: 2,
      slug: "t",
      issue: 1,
      phase: "BUILD",
      issueGoal: "g",
      acs: [],
      createdTs: "2026-01-01T00:00:00Z",
      updatedTs: "2026-01-01T00:00:00Z",
      changelog: [],
    }),
  );
  return { root, workDir, state, head: git("rev-parse", "HEAD").trim() };
}

/** Run one built command through a shell. */
function sh(command: string, cwd: string): { code: number; err: string } {
  const r = spawnSync("sh", ["-c", command.replace(/\\\n\s*/g, " ").replace("PASS|FAIL", "PASS")], {
    cwd,
    encoding: "utf-8",
    timeout: 60000,
  });
  return { code: r.status ?? -1, err: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Both of the prompt's commands, in the order the prompt gives them.
 *
 * The capture step is not scaffolding — since #469 it is half the contract.
 * The recorder reads the file that command writes, so a prompt whose two
 * halves disagree about where the output goes is the #312 defect again in a
 * different pair of flags, and only running them together can see it.
 */
function capture(s: { root: string; workDir: string }, testCommand = "bun test"): void {
  sh(suiteCaptureCommand(join(s.root, "project"), testCommand, s.workDir, quote), s.root);
}

function runSteps(
  s: { root: string; workDir: string },
  opts: { recorder?: string; testCommand?: string } = {},
): { code: number; err: string } {
  capture(s, opts.testCommand);
  const project = join(s.root, "project");
  return sh(opts.recorder ?? recorderCommand(HARNESS_ROOT, s.workDir, project, quote), s.root);
}

describe("#312: the heal command is run, not described", () => {
  test("SC-1712: the command the prompt emits is accepted by the real recorder", () => {
    const s = scenario("passing");
    try {
      const { code, err } = runSteps(s);
      expect(code, `the recorder refused the prompt's own command:\n${err}`).toBe(0);

      const state = JSON.parse(readFileSync(s.state, "utf-8"));
      expect(state.suiteMeasurement?.verdict).toBe("PASS");
      expect(state.suiteMeasurement?.failures).toBe(0);
      // The point of the whole exercise: the record carries the commit, and
      // the commit came from the tree rather than from the command line.
      expect(state.suiteMeasurement?.measuredSha).toBe(s.head);
      // And since #469 the count came from the run rather than from the
      // command line either — which is only checkable because the suite the
      // capture step ran is a real one with a known shape.
      expect(state.suiteMeasurement?.tests).toBe(1);
      expect(state.suiteMeasurement?.files).toBe(1);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1713: a failing suite records FAIL - through the same command", () => {
    // Without this the happy path alone would be satisfied by a recorder that
    // writes PASS unconditionally — and a verdict that cannot say FAIL is
    // #224 with extra steps.
    const s = scenario("failing");
    try {
      expect(runSteps(s).code).toBe(0);

      const state = JSON.parse(readFileSync(s.state, "utf-8"));
      expect(state.suiteMeasurement?.verdict).toBe("FAIL");
      expect(state.suiteMeasurement?.failures).toBe(1);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1841: the prompt's own two commands refuse a run that measured nothing", () => {
    // #469, end to end through the text an agent is handed. The project's
    // test files are gone by the time the runner reaches them; the capture
    // step writes whatever it printed; the recorder reads it and refuses.
    //
    // This is the row that could not exist while the count was an argument:
    // the old prompt told the agent to type the number it saw, and the number
    // it would have seen here is zero.
    const s = scenario("vanishing");
    try {
      const { code, err } = runSteps(s);
      expect(code, `a run that measured nothing was recorded:\n${err}`).not.toBe(0);
      expect(err).toContain("no pass/fail summary");
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1842: a runner that executed nothing is refused the same way", () => {
    // #490, through the same two commands, and a different refusal from
    // SC-1841 above: that run printed no summary at all, this one prints a
    // clean summary over nothing — `0 pass / 0 fail / Ran 0 tests across
    // 1 file.`, exit 0. Every indicator green. The two reasons are asserted
    // separately because a single refusal covering both would be one decider
    // wearing two names.
    const s = scenario("empty");
    try {
      const { code, err } = runSteps(s);
      expect(code, `a run that executed nothing was recorded:\n${err}`).not.toBe(0);
      expect(err).toContain("executed 0 tests");
      expect(err, "refused for SC-1841's reason, not this one").not.toContain("no pass/fail summary");
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1714: reintroducing --result into the prompt turns this red", () => {
    // SC-A14, performed rather than promised. This is the text that was on
    // main, built by a mutated copy of the same marker block and run against
    // the same recorder. If it passed, the extraction above would not be
    // reaching the command and SC-1712 would be a test of string formatting.
    const mutated = SHIP.replace(
      "`    --output ${quote(suiteOutputPath(workDir))}`",
      "`    --result PASS|FAIL`",
    );
    expect(mutated, "the mutation did not apply — the builder's text moved").not.toBe(SHIP);

    const s = scenario();
    try {
      const built = builderFrom(mutated).recorderCommand(HARNESS_ROOT, s.workDir, join(s.root, "project"), quote);
      const { code, err } = runSteps(s, { recorder: built });

      expect(code, "the recorder accepted a caller-supplied verdict").not.toBe(0);
      expect(err).toContain("--result is not a flag");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1843: reintroducing --failures into the prompt turns this red", () => {
    // The same demonstration for the flag #469 retired. An agent typing a
    // count is the defect; a prompt that asks for one is how it gets typed.
    const mutated = SHIP.replace(
      "`    --output ${quote(suiteOutputPath(workDir))}`",
      "`    --failures 0`",
    );
    expect(mutated, "the mutation did not apply — the builder's text moved").not.toBe(SHIP);

    const s = scenario();
    try {
      const built = builderFrom(mutated).recorderCommand(HARNESS_ROOT, s.workDir, join(s.root, "project"), quote);
      const { code, err } = runSteps(s, { recorder: built });

      expect(code, "the recorder accepted a caller-supplied failure count").not.toBe(0);
      expect(err).toContain("--failures is no longer accepted");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 120000);

  test("SC-1715: a caller-supplied SHA is refused by name", () => {
    // `--sha` was in the documented usage for this script's whole life, so
    // "unexpected argument" would read as a typo rather than as a contract
    // change. The refusal has to say what replaced it.
    const s = scenario();
    try {
      const r = spawnSync(
        "bun",
        [
          join(HARNESS_ROOT, "scripts", "record-suite-measurement.ts"),
          "--state", s.state,
          "--sha", s.head,
          "--output", join(s.workDir, "suite-output.txt"),
        ],
        { encoding: "utf-8" },
      );
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("read from --project");

      // And nothing was written. A refusal that still records is not a refusal.
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1716: a project with no commit is refused - not recorded as HEAD", () => {
    // `git rev-parse HEAD` prints the string `HEAD` back for a repo with no
    // commits. Recording that would be a measurement whose provenance field
    // says "whatever the checkout happens to be", which is exactly the hole
    // #224 opened this script to close.
    const s = scenario();
    const empty = join(s.root, "empty");
    mkdirSync(empty, { recursive: true });
    execFileSync("git", ["-C", empty, "init", "-q", "-b", "main"], { stdio: "ignore" });
    try {
      // A real, readable suite output, so the only thing wrong here is the
      // provenance. Without it the recorder would refuse for the missing
      // output instead and this case would be green for the wrong reason.
      capture(s);
      const { code, err } = sh(recorderCommand(HARNESS_ROOT, s.workDir, empty, quote), s.root);

      expect(code).not.toBe(0);
      expect(err).toMatch(/no commit to measure against|could not read a commit/);
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();

      // A directory that is not a repository at all fails the same way, and
      // separately: the two reach the refusal by different routes (git exits
      // non-zero here, prints a non-SHA above) and only one of them is
      // covered by either case alone.
      const notARepo = join(s.root, "plain");
      mkdirSync(notARepo, { recursive: true });
      const second = sh(recorderCommand(HARNESS_ROOT, s.workDir, notARepo, quote), s.root);
      expect(second.code).not.toBe(0);
      expect(second.err).toContain("could not read a commit");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1717: the step in the prompt is the command this file ran", () => {
    // The cheap half, kept: everything above proves the BUILDER is sound, and
    // none of it would notice the prompt calling a different builder, or
    // inlining the old text beside this one. One assertion ties the executed
    // function to the step an agent is actually handed.
    const at = SHIP.indexOf("For tests-pass:");
    expect(at, "ship.js has no tests-pass remediation step").toBeGreaterThan(-1);
    const step = SHIP.slice(at, at + 1200);

    expect(step).toContain("recorderCommand(HARNESS_ROOT, WORK_DIR, PROJECT_ROOT, shellQuote)");
    // Both halves, since #469. The recorder reads a file, so a step that
    // emits the record command without the capture command tells an agent to
    // read something nothing wrote.
    expect(step).toContain("suiteCaptureCommand(PROJECT_ROOT, testCommand, WORK_DIR, shellQuote)");
    // The retired flags are gone from the step, including from its prose —
    // an agent reading `--result` in a sentence will type it, and that is as
    // true of `--failures`, which this step asked for by name until #469.
    expect(step).not.toContain("--result");
    expect(step).not.toContain("--failures");
    expect(step).not.toMatch(/record-suite-measurement\.ts[\s\S]{0,400}--sha/);
  });
});
