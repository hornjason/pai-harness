import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSuiteMeasurement, suiteMeasurementSha } from "../lib/suite-measurement";
import { SUITE_MEASUREMENT_FIELDS, WorkflowStateSchema } from "../gates/schema";
import { REFUSE_EXIT, shaFromGitOutput } from "../scripts/record-suite-measurement";

/**
 * The suite result and the ship verdict, bound by a commit SHA (#224).
 *
 * The run that forced this reported `regressions: 0` over a branch whose
 * suite had one failing test. A count with no commit attached cannot be
 * checked against the tree being shipped, and an absent count serialises to
 * the same thing as a clean one. So: a measurement carries the SHA it was
 * measured against, and everything that is not a complete, internally
 * consistent, SHA-carrying record reads UNMEASURED — never PASS, and never a
 * zero-failure reading that a consumer would count as "no failures".
 *
 * Every refusal in the recorder runs TWICE: once against the real script, and
 * once against a mutant copy whose single exit-code constant is 0. The second
 * run is the evidence that the case is caught by the refusal under test rather
 * than by a crash, a typo or a module-resolution failure
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-suite-measurement.ts");
const SHA = "dd242a62aea9371d788abb58f3d26922d5dd6cbc";

let DIR = "";
let STATE = "";
let MUTANT = "";
/**
 * A real repository for the recorder to read a commit out of (#312 SC-A12).
 *
 * `--sha` is gone: the measured commit comes from the tree now, so the CLI
 * cases below cannot assert against the `SHA` literal above and have to
 * compare with whatever this fixture's HEAD turned out to be. The reader's
 * tests still use the literal, because they are about a value already in a
 * state file and have no project to read.
 */
let PROJECT = "";
let HEAD_SHA = "";
/** Every mutant copy written into scripts/ by this file, cleaned in afterEach. */
let MUTANTS: string[] = [];

/**
 * Captured runner output, which is what the recorder reads since #469/#490.
 *
 * Written here rather than executed: this file's subject is the recorder's
 * arguments and its refusals, and the output is its INPUT. The proof that
 * these shapes are the ones a real runner produces is in
 * test/suite-run-reading.test.ts, which runs five live `bun test` fixtures
 * and reads them with the same function.
 */
const OUTPUT = {
  clean: " 3 pass\n 0 fail\nRan 3 tests across 2 files. [1.00ms]\n",
  oneFailure: " 2 pass\n 1 fail\nRan 3 tests across 2 files. [1.00ms]\n",
  fourFailures: " 0 pass\n 4 fail\nRan 4 tests across 2 files. [1.00ms]\n",
  /** #469 — the files were gone by the time the runner reached them. */
  noSummary:
    "bun test v1.3.14 (d1632b29)\n\n# Unhandled error between tests\n" +
    '-------------------------------\nerror: ENOENT reading "/gone/a.test.ts"\n' +
    "-------------------------------\n",
  /** #490 — one file, no tests, exit 0. */
  nothingRan: " 0 pass\n 0 fail\nRan 0 tests across 1 file. [6.00ms]\n",
  /**
   * The same nothing, from a runner that reports no file count.
   *
   * The input that reaches ONLY the reading's refusal. The row above is
   * caught twice — by `readSuiteRun` and again by the schema's `tests: 0`
   * refusal, which is a legitimate pair since each has an input the other
   * cannot see, but it means the row above cannot witness either of them
   * alone. Measured: disabling the reading's executed-zero refusal left the
   * row above green, held up by the schema. This one has no `tests` to
   * record, so the schema has nothing to say about it.
   */
  nothingRanNoFileCount: " 0 pass\n 0 fail\n",
};
/** Paths of the above, filled in beforeEach. */
let OUT: Record<keyof typeof OUTPUT, string> = {} as any;

/** The smallest workflow-state.json that writeWorkflowState will accept. */
function baseState(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    issue: 224,
    slug: "pai-harness-224",
    phase: "BUILD",
    issueGoal: "the suite measurement carries the commit it was measured against",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "suiteMeasurement carries the commit SHA the suite ran against",
        threshold: { op: "==", value: 0, unit: "failing tests" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...extra,
  };
}

/** A workflow state carrying a suite measurement, for the reader's tests. */
function stateWith(measurement: unknown) {
  return { ...baseState(), suiteMeasurement: measurement };
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "record-suite-measurement-"));
  STATE = join(DIR, "workflow-state.json");
  writeFileSync(STATE, JSON.stringify(baseState(), null, 2));

  OUT = {} as any;
  for (const [name, body] of Object.entries(OUTPUT)) {
    const path = join(DIR, `suite-${name}.txt`);
    writeFileSync(path, body);
    (OUT as Record<string, string>)[name] = path;
  }

  PROJECT = join(DIR, "project");
  mkdirSync(PROJECT, { recursive: true });
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", PROJECT, ...a], { encoding: "utf-8" }).stdout ?? "";
  git("init", "-q", "-b", "main");
  // Spelled out rather than routed through `git()` above: the #84 guard reads
  // the argv at the call site and cannot see a wrapper's prepended `-C`, so a
  // helper here is indistinguishable from a write to the real global config.
  spawnSync("git", ["-C", PROJECT, "config", "user.email", "t@example.test"]);
  spawnSync("git", ["-C", PROJECT, "config", "user.name", "T"]);
  writeFileSync(join(PROJECT, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  HEAD_SHA = git("rev-parse", "HEAD").trim();

  // The mutant lives in scripts/, not in the temp dir, because the script
  // imports `../gates/orchestrator` — AC3 requires it to write through
  // writeWorkflowState. From a temp directory that import does not resolve,
  // bun exits 1, and every mutant run would read as "the mutation was
  // rejected on the merits" when the mutant never ran. Removed in afterEach,
  // and `no mutant is left behind` asserts it.
  const source = readFileSync(SCRIPT, "utf-8");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/record-suite-measurement.ts");
  }
  MUTANT = join(REPO_ROOT, "scripts", ".record-suite-measurement.mutant.ts");
  writeFileSync(MUTANT, mutated);
  MUTANTS = [MUTANT];
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
  for (const m of MUTANTS) rmSync(m, { force: true });
  MUTANTS = [];
});

function run(args: string[], script = SCRIPT) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(STATE, "utf-8"));
}

// ── The reader ───────────────────────────────────────────────────────────

describe("#224: a suite record with no usable SHA reads UNMEASURED", () => {
  const CASES: Array<[string, unknown]> = [
    ["no state at all", undefined],
    ["a null state", null],
    ["a state that is not an object", "workflow-state.json"],
    ["a state with no suiteMeasurement key", baseState()],
    ["suiteMeasurement: null", stateWith(null)],
    ["suiteMeasurement as an array", stateWith([])],
    ["suiteMeasurement as a string", stateWith("PASS")],
    ["no measuredSha", stateWith({ verdict: "PASS", failures: 0 })],
    ["an empty measuredSha", stateWith({ verdict: "PASS", failures: 0, measuredSha: "" })],
    ["measuredSha: HEAD", stateWith({ verdict: "PASS", failures: 0, measuredSha: "HEAD" })],
    ["a branch name as the SHA", stateWith({ verdict: "PASS", failures: 0, measuredSha: "main" })],
    ["a too-short SHA", stateWith({ verdict: "PASS", failures: 0, measuredSha: "dd242a" })],
    ["a non-hex SHA", stateWith({ verdict: "PASS", failures: 0, measuredSha: "zzzzzzzzz" })],
    ["a numeric SHA", stateWith({ verdict: "PASS", failures: 0, measuredSha: 12345678 })],
    ["no failure count", stateWith({ verdict: "PASS", measuredSha: SHA })],
    ["a stringified failure count", stateWith({ verdict: "PASS", failures: "0", measuredSha: SHA })],
    ["a negative failure count", stateWith({ verdict: "FAIL", failures: -1, measuredSha: SHA })],
    ["a fractional failure count", stateWith({ verdict: "FAIL", failures: 1.5, measuredSha: SHA })],
    ["no verdict", stateWith({ failures: 0, measuredSha: SHA })],
    ["a lowercase verdict", stateWith({ verdict: "pass", failures: 0, measuredSha: SHA })],
    ["a verdict nobody recognises", stateWith({ verdict: "SKIP", failures: 0, measuredSha: SHA })],
    ["UNMEASURED written as a verdict", stateWith({ verdict: "UNMEASURED", failures: 0, measuredSha: SHA })],
    ["a PASS contradicted by its own count", stateWith({ verdict: "PASS", failures: 3, measuredSha: SHA })],
    ["a FAIL contradicted by its own count", stateWith({ verdict: "FAIL", failures: 0, measuredSha: SHA })],
  ];

  for (const [label, state] of CASES) {
    test(`${label} reads UNMEASURED, not PASS`, () => {
      const reading = readSuiteMeasurement(state);
      expect(reading.verdict).toBe("UNMEASURED");
      // The specific shape of the production bug: an absent measurement that
      // a consumer counts as "0 failing tests".
      expect(reading.failures).toBeNull();
      expect(reading.failures).not.toBe(0);
      expect(reading.measuredSha).toBeNull();
      expect(reading.reason, "an UNMEASURED reading must say why").toBeTruthy();
    });
  }

  test("no input at all produces a PASS", () => {
    const everything = CASES.map(([, state]) => readSuiteMeasurement(state));
    expect(everything.filter(r => r.verdict === "PASS")).toEqual([]);
    expect(everything.filter(r => r.failures === 0)).toEqual([]);
  });
});

describe("#224: a complete record reads as what it measured", () => {
  test("zero failures against a real commit is PASS", () => {
    const reading = readSuiteMeasurement(stateWith({ verdict: "PASS", failures: 0, measuredSha: SHA }));
    expect(reading.verdict).toBe("PASS");
    expect(reading.failures).toBe(0);
    expect(reading.measuredSha).toBe(SHA);
    expect(reading.reason).toBeNull();
  });

  test("a failing suite is FAIL and keeps its count", () => {
    const reading = readSuiteMeasurement(stateWith({ verdict: "FAIL", failures: 1, measuredSha: SHA }));
    expect(reading.verdict).toBe("FAIL");
    expect(reading.failures).toBe(1);
    expect(reading.measuredSha).toBe(SHA);
  });

  test("an abbreviated SHA is a SHA, and case does not change which commit it names", () => {
    const short = readSuiteMeasurement(stateWith({ verdict: "PASS", failures: 0, measuredSha: "dd242a6" }));
    expect(short.verdict).toBe("PASS");
    expect(short.measuredSha).toBe("dd242a6");

    const upper = readSuiteMeasurement(stateWith({ verdict: "PASS", failures: 0, measuredSha: SHA.toUpperCase() }));
    expect(upper.measuredSha).toBe(SHA);
  });

  test("suiteMeasurementSha refuses everything that is not a commit SHA", () => {
    expect(suiteMeasurementSha(SHA)).toBe(SHA);
    expect(suiteMeasurementSha(` ${SHA.toUpperCase()} `)).toBe(SHA);
    for (const bad of ["", "HEAD", "main", "dd242a", "zzzzzzz", null, undefined, 12345678, {}, [SHA]]) {
      expect(suiteMeasurementSha(bad), `${JSON.stringify(bad)} is not a SHA`).toBeNull();
    }
  });
});

// ── The schema ───────────────────────────────────────────────────────────

describe("#224: the SHA round-trips through the schema", () => {
  test("a recorded PASS keeps its measuredSha through a parse", () => {
    const parsed = WorkflowStateSchema.parse(stateWith({ verdict: "PASS", failures: 0, measuredSha: SHA }));
    expect((parsed as any).suiteMeasurement.measuredSha).toBe(SHA);
    // What was broken to prove this fails: dropping `suiteMeasurement` from
    // WorkflowStateSchema makes Zod strip the key, and this reads UNMEASURED.
    expect(readSuiteMeasurement(parsed).verdict).toBe("PASS");
  });

  test("a recorded FAIL keeps its measuredSha and count through a parse", () => {
    const parsed = WorkflowStateSchema.parse(stateWith({ verdict: "FAIL", failures: 2, measuredSha: SHA }));
    expect((parsed as any).suiteMeasurement).toMatchObject({ verdict: "FAIL", failures: 2, measuredSha: SHA });
    expect(readSuiteMeasurement(parsed).verdict).toBe("FAIL");
  });

  const REJECTED: Array<[string, unknown]> = [
    ["a measurement with no measuredSha", { verdict: "PASS", failures: 0 }],
    ["a measurement pinned to HEAD", { verdict: "PASS", failures: 0, measuredSha: "HEAD" }],
    ["a PASS with failing tests", { verdict: "PASS", failures: 1, measuredSha: SHA }],
    ["a FAIL with no failing tests", { verdict: "FAIL", failures: 0, measuredSha: SHA }],
    ["UNMEASURED as a recorded verdict", { verdict: "UNMEASURED", failures: 0, measuredSha: SHA }],
    ["a negative failure count", { verdict: "FAIL", failures: -1, measuredSha: SHA }],
    ["a fractional failure count", { verdict: "FAIL", failures: 1.5, measuredSha: SHA }],
  ];

  for (const [label, measurement] of REJECTED) {
    test(`the schema rejects ${label}`, () => {
      expect(WorkflowStateSchema.safeParse(stateWith(measurement)).success).toBe(false);
    });
  }
});

// ── The recorder ─────────────────────────────────────────────────────────

describe("#224: scripts/record-suite-measurement.ts records what it measured", () => {
  test("zero failures is written as a PASS carrying the SHA", () => {
    const r = run(["--state", STATE, "--project", PROJECT, "--output", OUT.clean]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, verdict: "PASS", measuredSha: HEAD_SHA });

    const state = readState();
    expect(state.suiteMeasurement).toMatchObject({ verdict: "PASS", failures: 0, measuredSha: HEAD_SHA });
    expect(readSuiteMeasurement(state).verdict).toBe("PASS");
  });

  test("SC-1834: the record carries what the run covered - not only what it found", () => {
    // #490. A verdict with no coverage beside it cannot tell `0 fail` over
    // two files from `0 fail` over one empty one, and both print a summary
    // that reads the same.
    run(["--state", STATE, "--project", PROJECT, "--output", OUT.clean]);
    expect(readState().suiteMeasurement).toMatchObject({ tests: 3, files: 2 });

    // A runner that reported no file count records null, never 0 — "asked and
    // did not say" and "said none" are opposite facts.
    writeFileSync(join(DIR, "bare.txt"), " 3 pass\n 0 fail\n");
    run(["--state", STATE, "--project", PROJECT, "--output", join(DIR, "bare.txt")]);
    const bare = readState().suiteMeasurement as Record<string, unknown>;
    expect(bare.files).toBeNull();
    expect(bare.files).not.toBe(0);

    // The changelog says the coverage too, because the state file is the
    // artefact a reader reaches for after the run is over.
    const changelog = readState().changelog as Array<Record<string, unknown>>;
    expect(String(changelog.find(e => e.event === "suite-measurement")?.detail)).toContain("test(s)");
  });

  test("a failing suite is written as a FAIL the reader can act on", () => {
    const r = run(["--state", STATE, "--project", PROJECT, "--output", OUT.oneFailure]);
    expect(r.code, r.err).toBe(0);

    const reading = readSuiteMeasurement(readState());
    expect(reading.verdict).toBe("FAIL");
    expect(reading.failures).toBe(1);
    expect(reading.measuredSha).toBe(HEAD_SHA);
  });

  test("the verdict comes from the output, not from the caller", () => {
    // There is no --verdict option, and since #469 there is no --failures
    // either. A caller cannot hand this script the word PASS over a suite
    // that failed, nor a zero over a suite that never reported one — those
    // are #224 and #469 in one argument each.
    const options = readFileSync(SCRIPT, "utf-8").match(/const OPTIONS = new Set\(\[([^\]]*)\]\)/);
    expect(options, "OPTIONS is no longer a single-line Set literal — this check cannot read it").toBeTruthy();
    expect(options![1]).not.toContain("verdict");
    expect(options![1]).not.toContain("failures");
    expect(run(["--state", STATE, "--project", PROJECT, "--output", OUT.fourFailures]).code).toBe(0);
    expect((readState().suiteMeasurement as any)).toMatchObject({ verdict: "FAIL", failures: 4 });
  });

  test("the measurement is written through writeWorkflowState", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toMatch(/import\s*\{\s*writeWorkflowState\s*\}\s*from\s*"\.\.\/gates\/orchestrator"/);
    expect(source).toMatch(/writeWorkflowState\(/);
    // Zod validation at write time is the point; a raw write would skip it.
    expect(source).not.toMatch(/writeFileSync/);
  });

  test("the run is recorded in the changelog", () => {
    run(["--state", STATE, "--project", PROJECT, "--output", OUT.clean]);
    const changelog = readState().changelog as Array<Record<string, unknown>>;
    expect(changelog.some(e => e.event === "suite-measurement")).toBe(true);
  });
});

describe("#224: refusals, each shown against a mutant that does not refuse", () => {
  /**
   * Assert a case is refused, that the file is untouched, and that the
   * refusal is what is being observed. `mutantCode` is 0 for every case: each
   * of them funnels into the script's one `process.exit(REFUSE_EXIT)`.
   */
  function expectRefused(label: string, args: string[], reason: RegExp) {
    const before = readFileSync(STATE, "utf-8");

    const real = run(args);
    expect(real.code, `the real script accepted ${label}\n${real.out}`).toBe(REFUSE_EXIT);
    expect(real.err).toMatch(reason);
    expect(readFileSync(STATE, "utf-8"), `${label} was refused but the state changed`).toBe(before);

    const mutant = run(args, MUTANT);
    expect(
      mutant.code,
      `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for ${label} — ` +
        `this case is not being caught by the refusal under test.\n${mutant.err}`,
    ).toBe(0);
  }

  test("no --state", () => {
    expectRefused("a missing --state", ["--project", PROJECT, "--output", OUT.clean], /--state is required/);
  });

  test("no --project", () => {
    expectRefused("a missing --project", ["--state", STATE, "--output", OUT.clean], /--project is required/);
  });

  test("--sha, which this script used to require", () => {
    // #312 SC-A12. Not "unexpected argument": the flag was in the documented
    // usage for this script's whole life, so a caller still passing it is
    // following instructions, not making a typo. The refusal names what
    // replaced it, and the SHA passed here is the fixture's real HEAD —
    // a value the recorder would have accepted — so what is refused is the
    // CALLER choosing the commit, not the commit being wrong.
    expectRefused(
      "a caller-supplied SHA",
      ["--state", STATE, "--project", PROJECT, "--sha", HEAD_SHA, "--output", OUT.clean],
      /--sha is no longer accepted/,
    );
  });

  test("SC-1835: --failures, the last value the caller still chose", () => {
    // #469/#490. Refused by name rather than as "unexpected argument", for
    // the same reason as `--sha`: it was in the documented usage for this
    // script's whole life, so a caller still passing it is following
    // instructions. The count passed here is 0 over a real clean fixture —
    // a value the recorder would have accepted — so what is refused is the
    // CALLER reading the summary, not the number being wrong.
    expectRefused(
      "a caller-supplied failure count",
      ["--state", STATE, "--project", PROJECT, "--failures", "0", "--output", OUT.clean],
      /--failures is no longer accepted/,
    );
  });

  test("--result, which the heal prompt used to pass", () => {
    // The other half of the contradiction #312 found: the prompt on main sent
    // `--result PASS|FAIL`, which this script never had. A caller-named
    // verdict is #224 in one argument, so it is refused by name too.
    expectRefused(
      "a caller-supplied verdict",
      ["--state", STATE, "--project", PROJECT, "--result", "PASS"],
      /--result is not a flag/,
    );
  });

  test("a --project with no commit in it", () => {
    const empty = join(DIR, "empty");
    mkdirSync(empty, { recursive: true });
    spawnSync("git", ["-C", empty, "init", "-q", "-b", "main"], { encoding: "utf-8" });
    // The git on this machine exits non-zero for an unborn HEAD, so this
    // arrives through the exec failure rather than through the output check.
    // Which route it takes is a property of the git version, not of the
    // recorder — `shaFromGitOutput` below is the other route, driven
    // directly because no fixture here can produce it.
    expectRefused(
      "a repository with no commits",
      ["--state", STATE, "--project", empty, "--output", OUT.clean],
      /could not read a commit/,
    );
  });

  test("a --project that is not a repository", () => {
    expectRefused(
      "a directory that is not a git repository",
      ["--state", STATE, "--project", join(DIR, "nope"), "--output", OUT.clean],
      /could not read a commit/,
    );
  });

  test("no --output", () => {
    // The whole bug: no count recorded, and the record still reads as a result.
    expectRefused("a missing --output", ["--state", STATE, "--project", PROJECT], /--output is required/);
  });

  test("an --output file that is not there", () => {
    expectRefused(
      "an unreadable suite output",
      ["--state", STATE, "--project", PROJECT, "--output", join(DIR, "never-written.txt")],
      /could not read the suite output/,
    );
  });

  test("SC-1836: a run that printed no summary is refused, not recorded as clean", () => {
    // #469. The state is asserted untouched by expectRefused, which is the
    // load-bearing half: `lib/suite-measurement.ts` reads an absent record as
    // UNMEASURED, so refusing leaves the run saying the true thing. Recording
    // an UNMEASURED verdict instead would park an unmeasured run in the field
    // that proves the suite ran.
    expectRefused(
      "a run with no pass/fail summary",
      ["--state", STATE, "--project", PROJECT, "--output", OUT.noSummary],
      /no pass\/fail summary/,
    );
    expect(readSuiteMeasurement(readState()).verdict).toBe("UNMEASURED");
    expect(readSuiteMeasurement(readState()).failures).toBeNull();
  });

  test("SC-1837: a run that executed nothing is refused, not recorded as clean", () => {
    // #490. `0 pass / 0 fail / Ran 0 tests across 1 file.` exits 0 and every
    // indicator is green. The refusal names the coverage so an operator can
    // tell this from a runner that found no files at all.
    expectRefused(
      "a run that executed no tests",
      ["--state", STATE, "--project", PROJECT, "--output", OUT.nothingRan],
      /executed 0 tests/,
    );
    expect(readSuiteMeasurement(readState()).verdict).toBe("UNMEASURED");

    // And the same nothing from a runner that reports no file count, which
    // is the input only `readSuiteRun` reaches. The row above is caught
    // twice — the schema refuses a recorded `tests: 0` as well — so without
    // this one, disabling the reading's refusal leaves both green and the
    // proof belongs to a decider this case is not about. Measured: that
    // mutation was 3 red before this line and 5 after it.
    expectRefused(
      "a run that executed no tests and reported no file count",
      ["--state", STATE, "--project", PROJECT, "--output", OUT.nothingRanNoFileCount],
      /executed 0 tests/,
    );
  });

  test("a git that answers with something that is not a commit", () => {
    // The route the fixtures above cannot produce, driven at the function.
    // `git rev-parse HEAD` printing the literal `HEAD` and exiting zero is
    // the historical behaviour for an unborn branch; recording that would be
    // a measurement whose provenance reads "whatever the checkout happens to
    // be", which is #224 with a SHA-shaped hole in it.
    for (const answer of ["HEAD", "", "main", "dd242a", "not-a-sha"]) {
      expect(
        () => shaFromGitOutput("/tmp/x", answer),
        `git answering ${JSON.stringify(answer)} was accepted as a commit`,
      ).toThrow(/no commit to measure against/);
    }
    // And the shape it must accept, so the guard is not simply "throw".
    expect(shaFromGitOutput("/tmp/x", `  ${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  test("an unknown argument", () => {
    expectRefused("an unknown flag", ["--state", STATE, "--project", PROJECT, "--output", OUT.clean, "--commit", "x"], /unexpected argument/);
  });

  test("a state file that is not there", () => {
    expectRefused(
      "a missing state file",
      ["--state", join(DIR, "absent.json"), "--project", PROJECT, "--output", OUT.clean],
      /record-suite-measurement/,
    );
  });

  test("a state the schema rejects is not written", () => {
    // Proves the Zod gate runs at write time (AC3): the invalid value is in
    // the file this script was handed, and the write refuses rather than
    // persisting it alongside a valid measurement.
    writeFileSync(STATE, JSON.stringify(baseState({ changelog: [{ ts: "now", event: "x", actor: "robot" }] })));
    expectRefused(
      "a state with an invalid changelog actor",
      ["--state", STATE, "--project", PROJECT, "--output", OUT.clean],
      /actor/,
    );
  });
});

describe("#224: the properties the mutant depends on", () => {
  const source = () => readFileSync(SCRIPT, "utf-8");

  test("REFUSE_EXIT is declared once", () => {
    const decls = source().match(/REFUSE_EXIT\s*=/g) || [];
    expect(decls.length, "more than one assignment to REFUSE_EXIT — the mutant would only neutralise one").toBe(1);
  });

  test("every exit goes through REFUSE_EXIT", () => {
    for (const e of source().match(/process\.exit\([^)]*\)/g) || []) {
      expect(e, `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it`).toBe("process.exit(REFUSE_EXIT)");
    }
  });

  test("the mutant is not simply a script that always exits 0", () => {
    // Guards the guard: if the mutant refused nothing AND did nothing, every
    // expectRefused above would pass vacuously.
    const r = run(["--state", STATE, "--project", PROJECT, "--output", OUT.oneFailure], MUTANT);
    expect(r.code).toBe(0);
    expect((readState().suiteMeasurement as any)).toMatchObject({ verdict: "FAIL", failures: 1, measuredSha: HEAD_SHA });
  });

  test("no mutant is left behind", () => {
    // Scoped to this file's own mutants: other test files write theirs into
    // the same directory, and a shared check would make this flaky rather
    // than informative.
    const stray = spawnSync("ls", [join(REPO_ROOT, "scripts")], { encoding: "utf-8" }).stdout || "";
    const mine = stray
      .split("\n")
      .filter(f => f.startsWith(".record-suite-measurement") && f.endsWith(".mutant.ts"))
      .filter(f => !MUTANTS.some(m => m.endsWith(f)));
    expect(mine).toEqual([]);
  });
});

// ── The documented shape ─────────────────────────────────────────────────

describe("#224: the schema exports the field list the guide is checked against", () => {
  test("SUITE_MEASUREMENT_FIELDS names every field of the measurement", () => {
    expect([...SUITE_MEASUREMENT_FIELDS].sort())
      .toEqual(["failures", "files", "measuredAt", "measuredSha", "tests", "verdict"]);
  });

  test("SC-1838: the schema refuses a measurement over zero files", () => {
    // The write path's half of #490, and an input only it reaches: the
    // recorder cannot produce `files: 0` because `readSuiteRun` refuses that
    // output, but a state file edited by hand, merged, or written by an older
    // harness arrives here without passing through either.
    const over = (files: unknown) =>
      WorkflowStateSchema.safeParse(
        stateWith({ verdict: "PASS", failures: 0, measuredSha: SHA, tests: 3, files }),
      ).success;
    expect(over(0), "a measurement over zero discovered files was accepted").toBe(false);
    expect(over(-1)).toBe(false);
    // null is the honest answer for a runner that did not report a count, and
    // it has to stay writable or every non-bun runner is refused.
    expect(over(null)).toBe(true);
    expect(over(2)).toBe(true);
  });

  test("SC-1844: the schema refuses a measurement over zero executed tests", () => {
    // The row above enforces the PROXY. On its own it would be the trap this
    // issue is about, applied to its own fix: `files: 1, tests: 0` is one
    // empty test file, it satisfies "files > 0", and it measures nothing.
    // Flagged by the commit security review on this branch.
    const withTests = (tests: unknown) =>
      WorkflowStateSchema.safeParse(
        stateWith({ verdict: "PASS", failures: 0, measuredSha: SHA, tests, files: 1 }),
      ).success;
    expect(withTests(0), "a run that executed no tests was accepted over one discovered file").toBe(false);
    expect(withTests(3)).toBe(true);
    // null stays writable for the same reason `files: null` does — a runner
    // that did not report a count has not reported a zero.
    expect(withTests(null)).toBe(true);
  });
});
