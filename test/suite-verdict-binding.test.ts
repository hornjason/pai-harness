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
    const r = run(["--state", STATE, "--project", PROJECT, "--failures", "0"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, verdict: "PASS", measuredSha: HEAD_SHA });

    const state = readState();
    expect(state.suiteMeasurement).toMatchObject({ verdict: "PASS", failures: 0, measuredSha: HEAD_SHA });
    expect(readSuiteMeasurement(state).verdict).toBe("PASS");
  });

  test("a failing suite is written as a FAIL the reader can act on", () => {
    const r = run(["--state", STATE, "--project", PROJECT, "--failures", "1"]);
    expect(r.code, r.err).toBe(0);

    const reading = readSuiteMeasurement(readState());
    expect(reading.verdict).toBe("FAIL");
    expect(reading.failures).toBe(1);
    expect(reading.measuredSha).toBe(HEAD_SHA);
  });

  test("the verdict comes from the count, not from the caller", () => {
    // There is no --verdict option. A caller cannot hand this script the word
    // PASS over a suite that failed — that is the #224 defect in one argument.
    const options = readFileSync(SCRIPT, "utf-8").match(/const OPTIONS = new Set\(\[([^\]]*)\]\)/);
    expect(options, "OPTIONS is no longer a single-line Set literal — this check cannot read it").toBeTruthy();
    expect(options![1]).not.toContain("verdict");
    expect(run(["--state", STATE, "--project", PROJECT, "--failures", "4"]).code).toBe(0);
    expect((readState().suiteMeasurement as any).verdict).toBe("FAIL");
  });

  test("the measurement is written through writeWorkflowState", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toMatch(/import\s*\{\s*writeWorkflowState\s*\}\s*from\s*"\.\.\/gates\/orchestrator"/);
    expect(source).toMatch(/writeWorkflowState\(/);
    // Zod validation at write time is the point; a raw write would skip it.
    expect(source).not.toMatch(/writeFileSync/);
  });

  test("the run is recorded in the changelog", () => {
    run(["--state", STATE, "--project", PROJECT, "--failures", "0"]);
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
    expectRefused("a missing --state", ["--project", PROJECT, "--failures", "0"], /--state is required/);
  });

  test("no --project", () => {
    expectRefused("a missing --project", ["--state", STATE, "--failures", "0"], /--project is required/);
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
      ["--state", STATE, "--project", PROJECT, "--sha", HEAD_SHA, "--failures", "0"],
      /--sha is no longer accepted/,
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
      ["--state", STATE, "--project", empty, "--failures", "0"],
      /could not read a commit/,
    );
  });

  test("a --project that is not a repository", () => {
    expectRefused(
      "a directory that is not a git repository",
      ["--state", STATE, "--project", join(DIR, "nope"), "--failures", "0"],
      /could not read a commit/,
    );
  });

  test("no --failures", () => {
    // The whole bug: no count recorded, and the record still reads as a result.
    expectRefused("a missing --failures", ["--state", STATE, "--project", PROJECT], /--failures is required/);
  });

  test("a --failures that is not a count", () => {
    expectRefused("a non-numeric count", ["--state", STATE, "--project", PROJECT, "--failures", "none"], /--failures/);
  });

  test("a negative --failures", () => {
    expectRefused("a negative count", ["--state", STATE, "--project", PROJECT, "--failures", "-1"], /--failures/);
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
    expectRefused("an unknown flag", ["--state", STATE, "--project", PROJECT, "--failures", "0", "--commit", "x"], /unexpected argument/);
  });

  test("a state file that is not there", () => {
    expectRefused(
      "a missing state file",
      ["--state", join(DIR, "absent.json"), "--project", PROJECT, "--failures", "0"],
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
      ["--state", STATE, "--project", PROJECT, "--failures", "0"],
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
    const r = run(["--state", STATE, "--project", PROJECT, "--failures", "2"], MUTANT);
    expect(r.code).toBe(0);
    expect((readState().suiteMeasurement as any)).toMatchObject({ verdict: "FAIL", failures: 2, measuredSha: HEAD_SHA });
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
    expect([...SUITE_MEASUREMENT_FIELDS].sort()).toEqual(["failures", "measuredAt", "measuredSha", "verdict"]);
  });
});
