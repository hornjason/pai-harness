/**
 * #673 — one measurement event, one denominator, and a partial reading that
 * says so.
 *
 * Two defects, observed on run `wf_62d68d55-81c` and read out of the run
 * state while it was live:
 *
 *  1. At 11:06 the state carried `{"verdict":"PASS","tests":1,"files":1}`.
 *     Nine minutes later the same key carried `{"verdict":"FAIL",
 *     "tests":13915,"files":387}`. For those nine minutes any reader — a
 *     person, a gate, a peer session — saw a green verdict over a
 *     measurement that observed one test. `PASS` with `tests: 1` and `PASS`
 *     with `tests: 13915` are the same word in the same field.
 *  2. The same event carried two numbers for how many tests there were:
 *     `changelog[].detail` said 13084 and `suiteMeasurement.tests` said
 *     13915. The difference is exactly that run's `13 skip + 818 todo`, so
 *     one counted tests that RAN and the other counted tests that EXIST, and
 *     neither said which.
 *
 * ## Why the fixtures are RUN rather than typed
 *
 * Every summary here comes out of a real `bun test` over a planted project.
 * A hand-written `"13915 tests across 387 files"` would assert that the
 * parser can read a string this file wrote — and the quantity in question is
 * a fact about what bun prints, not about what we can type. The identity
 * `tests === ran + skip + todo` is the whole basis for recording four
 * numbers instead of one, so it is measured here and will go red loudly if a
 * future bun stops holding it. It is deliberately NOT a write-path refusal:
 * a schema that rejected the arithmetic would turn a runner change into
 * every run refusing to record, which is a fix that brings its own outage.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSuiteMeasurement } from "../../lib/suite-measurement";
import { readSuiteRun, type MeasuredRun } from "../../lib/suite-run-reading";

const HARNESS_ROOT = join(import.meta.dir, "..", "..");
const RECORDER = join(HARNESS_ROOT, "scripts", "record-suite-measurement.ts");

/**
 * A suite shape, written so the four counts are all different numbers.
 *
 * Different on purpose: with `pass === skip` a case asserting "the skipped
 * count is 2" is satisfied by reading the wrong field, and no count in this
 * file would show it.
 */
type Shape = "mixed" | "one-passing";

function plant(project: string, shape: Shape): void {
  if (shape === "one-passing") {
    // The interim write from the issue, reproduced: one test, one file.
    writeFileSync(
      join(project, "only.test.ts"),
      'import { test, expect } from "bun:test";\ntest("a", () => { expect(1).toBe(1); });\n',
    );
    return;
  }
  const lines = [
    'import { test, expect } from "bun:test";',
    'test("p1", () => { expect(1).toBe(1); });',
    'test("p2", () => { expect(1).toBe(1); });',
    'test("p3", () => { expect(1).toBe(1); });',
    'test("f1", () => { expect(1).toBe(2); });',
    'test.skip("s1", () => { expect(1).toBe(1); });',
    'test.skip("s2", () => { expect(1).toBe(1); });',
    'test.todo("t1");',
    'test.todo("t2");',
    'test.todo("t3");',
    'test.todo("t4");',
  ];
  writeFileSync(join(project, "mixed.test.ts"), `${lines.join("\n")}\n`);
}

interface Scene {
  root: string;
  project: string;
  state: string;
  output: string;
  head: string;
  run: MeasuredRun;
}

/** A git repo with one commit, a real suite run captured, and a state file. */
function scene(shape: Shape): Scene {
  const root = mkdtempSync(join(tmpdir(), "rg-673-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  plant(project, shape);

  const git = (...a: string[]) =>
    execFileSync("git", ["-C", project, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  // Spelled out rather than routed through `git()`: the #84 guard reads the
  // argv at the call site and cannot see a wrapper's prepended `-C`.
  execFileSync("git", ["-C", project, "config", "user.email", "t@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "config", "user.name", "T"], { stdio: "ignore" });
  git("add", "-A");
  git("commit", "-q", "-m", "one");

  const r = spawnSync("bun", ["test"], { cwd: project, encoding: "utf-8", timeout: 120_000 });
  const output = join(root, "suite-output.txt");
  writeFileSync(output, `${r.stdout ?? ""}${r.stderr ?? ""}`);

  const reading = readSuiteRun(readFileSync(output, "utf-8"));
  if (reading.status !== "MEASURED") {
    throw new Error(`the fixture suite did not produce a reading: ${reading.reason}`);
  }

  const state = join(root, "workflow-state.json");
  writeFileSync(
    state,
    JSON.stringify({
      schemaVersion: 2,
      slug: "t",
      issue: 673,
      phase: "BUILD",
      issueGoal: "g",
      acs: [],
      createdTs: "2026-01-01T00:00:00Z",
      updatedTs: "2026-01-01T00:00:00Z",
      changelog: [],
    }),
  );
  return { root, project, state, output, head: git("rev-parse", "HEAD").trim(), run: reading };
}

interface Recorded {
  code: number;
  out: string;
  state: Record<string, any>;
  detail: string;
}

/** Run the REAL recorder and read back what it wrote. */
function record(s: Scene, scope: string | null): Recorded {
  const argv = [RECORDER, "--state", s.state, "--project", s.project, "--output", s.output];
  if (scope !== null) argv.push("--scope", scope);
  const r = spawnSync("bun", argv, { cwd: s.project, encoding: "utf-8", timeout: 120_000 });
  const state = JSON.parse(readFileSync(s.state, "utf-8"));
  const entries = (state.changelog ?? []).filter((c: any) => c?.event === "suite-measurement");
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    state,
    detail: entries.length === 0 ? "" : String(entries[entries.length - 1].detail ?? ""),
  };
}

/** The denominator the changelog line leads with, or null. */
function detailDenominator(detail: string): { count: number; quantity: string } | null {
  const collected = /of (\d+) test\(s\) collected/.exec(detail);
  if (collected) return { count: Number(collected[1]), quantity: "collected" };
  const ran = /of (\d+) test\(s\) that ran/.exec(detail);
  return ran ? { count: Number(ran[1]), quantity: "ran" } : null;
}

const MIXED = scene("mixed");
const ONE = scene("one-passing");

afterAll(() => {
  for (const s of [MIXED, ONE]) rmSync(s.root, { recursive: true, force: true });
});

describe("#673: the fixtures are a real runner's output, not a transcription", () => {
  test("the mixed suite really does skip and todo, so ran and collected differ", () => {
    // Criterion 5's premise, asserted before anything is read off it. A
    // fixture with zero skip and zero todo makes `ran` and `tests` the same
    // number, and every comparison below would hold whether or not the
    // distinction existed.
    expect(MIXED.run.skip, "the fixture skipped nothing").toBeGreaterThan(0);
    expect(MIXED.run.todo, "the fixture has no todo tests").toBeGreaterThan(0);
    expect(MIXED.run.pass + MIXED.run.fail).not.toBe(MIXED.run.tests);
    // Against what `plant()` WROTE, not against what the parser read back.
    // Every other case here compares a recorded number to `MIXED.run.*`, so
    // the parser would agree with itself; this is the one place the counts
    // are pinned to the source of the fixture.
    expect([MIXED.run.pass, MIXED.run.fail, MIXED.run.skip, MIXED.run.todo]).toEqual([3, 1, 2, 4]);
    // Four different numbers, so no assertion below can be satisfied by
    // reading the wrong field.
    const counts = [MIXED.run.pass, MIXED.run.fail, MIXED.run.skip, MIXED.run.todo];
    expect(new Set(counts).size, `two of ${JSON.stringify(counts)} coincide`).toBe(4);
  });

  test("bun's collected total is ran + skip + todo", () => {
    // The basis for recording four numbers instead of one. Measured against
    // the runner rather than assumed: if a future bun changes what `Ran N
    // tests` counts, this says so here instead of silently changing what
    // every recorded measurement means.
    const { pass, fail, skip, todo, tests } = MIXED.run;
    // Both counts were printed by this run, so neither is the "not reported"
    // reading — asserted, because `null + null` would otherwise coerce to 0
    // and make the identity hold over a run that said nothing.
    expect(skip).not.toBeNull();
    expect(todo).not.toBeNull();
    expect(tests).toBe(pass + fail + (skip ?? 0) + (todo ?? 0));
  });

  test("the one-test fixture is the interim write from the issue", () => {
    expect(ONE.run.pass + ONE.run.fail).toBe(1);
    expect(ONE.run.files).toBe(1);
    expect(ONE.run.fail).toBe(0);
  });
});

/**
 * Raised by the security review of this change, and both are real.
 *
 * `pass` and `fail` can be last-matched over the whole output because the
 * outer run's summary is the last thing printed. `skip` and `todo` cannot:
 * bun omits them at zero, so a last-match walks BACKWARD out of the summary
 * into whatever the suite captured — and this repo's suite captures bun runs.
 */
describe("#673 hardening: the skip counts come from the summary, not the document", () => {
  /** A real summary with a NESTED run's counts printed above it. */
  const NESTED = [
    "bun test v1.3.14",
    "",
    "  nested run captured by a test that drives bun:",
    " 1 pass",
    " 7 skip",
    " 9 todo",
    " 0 fail",
    "Ran 17 tests across 1 file. [0.10s]",
    "",
    "  the outer run:",
    " 40 pass",
    " 0 fail",
    "Ran 40 tests across 4 files. [1.00s]",
  ].join("\n");

  test("a nested run's skip and todo are not attributed to the outer run", () => {
    const run = readSuiteRun(NESTED);
    expect(run.status).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    // The premise: the document really does contain counts that would be
    // picked up by a whole-document search, and they are not the outer
    // run's. Without this the case would pass over an output with nothing
    // to mis-attribute.
    expect(NESTED).toContain(" 7 skip");
    expect(run.pass).toBe(40);
    expect(run.skip, "a nested run's skip count was read as this run's").not.toBe(7);
    expect(run.todo, "a nested run's todo count was read as this run's").not.toBe(9);
    // 40 pass + 0 fail accounts for all 40 collected, so the absent lines
    // really are zero — the runner's own total says so.
    expect(run.skip).toBe(0);
    expect(run.todo).toBe(0);
  });

  test("an absent count is null when the runner's own total does not account for it", () => {
    // A runner that reports 40 of 50 and names no skip or todo has not said
    // the other 10 were skipped. `0` would be a number nobody measured.
    const run = readSuiteRun(" 40 pass\n 0 fail\nRan 50 tests across 4 files. [1.00s]\n");
    expect(run.status).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    expect(run.skip).toBeNull();
    expect(run.todo).toBeNull();
    expect(run.skip).not.toBe(0);
  });

  test("an absent count is null when the runner reported no collected total at all", () => {
    const run = readSuiteRun(" 40 pass\n 0 fail\n");
    expect(run.status).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    expect(run.tests).toBeNull();
    expect(run.skip).toBeNull();
    expect(run.todo).toBeNull();
  });

  test("the recorded line says 'not reported' rather than printing a zero", () => {
    const s = scene("one-passing");
    // Overwrite the captured output with a summary carrying no collected
    // total, so the absence cannot be resolved.
    writeFileSync(s.output, " 40 pass\n 0 fail\n");
    const r = record(s, "full");
    expect(r.code, r.out).toBe(0);
    expect(r.detail).toContain("skip not reported");
    expect(r.detail).toContain("todo not reported");
    expect(r.detail).not.toContain("0 skipped");
    expect(r.state.suiteMeasurement.skip).toBeNull();
    rmSync(s.root, { recursive: true, force: true });
  });
});

describe("#673 criterion 1/2: a partial reading is not readable as a verdict", () => {
  test("a run the caller declared partial records PARTIAL, and a reader sees UNMEASURED", () => {
    const r = record(ONE, "partial");
    expect(r.code, `the recorder refused a partial run outright:\n${r.out}`).toBe(0);

    // The write happened and carries the counts — a partial reading is a
    // reading, and throwing it away would lose the only record that the run
    // measured anything at all.
    expect(r.state.suiteMeasurement.verdict).toBe("PARTIAL");
    expect(r.state.suiteMeasurement.tests).toBe(ONE.run.tests);

    // The verdict a READER sees, which is the thing criterion 2 asks for.
    // Not the stored string: every consumer in this repo goes through
    // `readSuiteMeasurement`, and what it answers is what a gate acts on.
    const reading = readSuiteMeasurement(r.state);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.verdict).not.toBe("PASS");
    expect(reading.reason, "a refusal that does not say it was partial is not actionable")
      .toContain("PART of the suite");

    // And the field the tests-pass gate reads is ABSENT, not `SKIP`.
    // `suiteVerdictViolations` returns no violations for `SKIP`, so writing
    // one would be a partial run satisfying the gate — the defect inverted.
    expect(r.state.environments?.local?.tests).toBeUndefined();
  });

  test("a PARTIAL does not leave a previous run's PASS standing beside it", () => {
    // The state carries a full PASS first, which is the realistic order: a
    // suite was measured, then somebody re-ran one file and recorded that.
    const s = scene("one-passing");
    expect(record(s, "full").state.environments.local.tests).toBe("PASS");
    const after = record(s, "partial");
    expect(after.state.suiteMeasurement.verdict).toBe("PARTIAL");
    expect(after.state.environments.local.tests).toBeUndefined();
    rmSync(s.root, { recursive: true, force: true });
  });

  test("the same output under --scope full is a PASS — the scope is the whole difference", () => {
    // The control, and the reason the case above is about the scope and not
    // about the fixture. One test in one file is a perfectly good PASS when
    // that is the whole suite; it is only a lie about the suite when it is
    // not. Without this, a recorder that refused every small run would pass
    // the case above having witnessed nothing.
    const s = scene("one-passing");
    const r = record(s, "full");
    expect(r.state.suiteMeasurement.verdict).toBe("PASS");
    expect(readSuiteMeasurement(r.state).verdict).toBe("PASS");
    expect(r.state.environments.local.tests).toBe("PASS");
    rmSync(s.root, { recursive: true, force: true });
  });

  test("an undeclared scope is refused, and nothing is written", () => {
    // Required rather than defaulted. A default of `full` makes the quiet
    // path the wrong one; a default of `partial` makes every honest run
    // record a reading no gate accepts.
    const s = scene("one-passing");
    const r = record(s, null);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--scope is required");
    expect(r.state.suiteMeasurement, "a refused run wrote a measurement anyway").toBeUndefined();
    rmSync(s.root, { recursive: true, force: true });
  });

  test("a scope this script cannot read is refused rather than guessed at", () => {
    const s = scene("one-passing");
    const r = record(s, "FULL");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--scope must be");
    expect(r.state.suiteMeasurement).toBeUndefined();
    rmSync(s.root, { recursive: true, force: true });
  });
});

describe("#673 criterion 3/4/5: one event, one denominator, and it says which", () => {
  test("the changelog count and suiteMeasurement.tests are the same quantity", () => {
    const r = record(MIXED, "full");
    expect(r.code, `the recorder refused:\n${r.out}`).toBe(0);

    const denominator = detailDenominator(r.detail);
    expect(denominator, `no denominator found in: ${JSON.stringify(r.detail)}`).not.toBeNull();
    expect(denominator!.count).toBe(r.state.suiteMeasurement.tests);

    // Non-vacuous: the ran count is a DIFFERENT number in this fixture, so
    // the equality above is a statement about which quantity was chosen and
    // not an arithmetic coincidence.
    const ran = MIXED.run.pass + MIXED.run.fail;
    expect(ran).not.toBe(r.state.suiteMeasurement.tests);
    expect(denominator!.count).not.toBe(ran);
  });

  test("the quantity declares itself, and the other three are beside it", () => {
    const r = record(MIXED, "full");
    const { pass, fail, skip, todo, tests, files } = MIXED.run;
    // Criterion 4. A reader can tell what each number counts without
    // subtracting skip and todo to find out.
    expect(r.detail).toContain(`${tests} test(s) collected`);
    expect(r.detail).toContain(`${pass + fail} ran`);
    expect(r.detail).toContain(`${skip} skipped`);
    expect(r.detail).toContain(`${todo} todo`);
    expect(r.detail).toContain(`across ${files} file(s)`);
    expect(r.detail).toContain(MIXED.head);
  });

  test("the record carries ran, skip and todo, so the structured field says it too", () => {
    const r = record(MIXED, "full");
    const m = r.state.suiteMeasurement;
    expect(m.ran).toBe(MIXED.run.pass + MIXED.run.fail);
    expect(m.skip).toBe(MIXED.run.skip);
    expect(m.todo).toBe(MIXED.run.todo);
    expect(m.tests).toBe(MIXED.run.tests);
    // The two numbers #673 is about, both present and both named. A reader
    // comparing this run's `tests` against a previous run's `tests` is now
    // comparing the same quantity by construction.
    expect(m.ran).not.toBe(m.tests);
  });

  test("the failing count is still the failing count, and the verdict follows it", () => {
    const r = record(MIXED, "full");
    expect(r.state.suiteMeasurement.failures).toBe(MIXED.run.fail);
    expect(r.state.suiteMeasurement.verdict).toBe("FAIL");
    expect(r.detail.startsWith(`FAIL: ${MIXED.run.fail} failing test(s) of `)).toBe(true);
  });
});
