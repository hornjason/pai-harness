import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { extractTestFailureCount } from "../gates/gate-executor";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";
import { readSuiteRun, suiteRunVerdict } from "../lib/suite-run-reading";

/**
 * #224 — the suite result and the ship verdict were not connected.
 *
 * Run `wf_7ac5f614-d21` returned `regressions: 0` on a branch whose suite ran
 * `3984 pass / 1 fail`. The failing test was a real guard (#149) catching a
 * real regression. Detection was never the gap: the signal existed and did not
 * reach the verdict.
 *
 * This file proves the two halves of that connection can go red, the way
 * .claude/rules/checks-must-be-able-to-fail.md requires — by breaking them and
 * watching, not by asserting prose:
 *
 *  1. A fixture project carrying one deliberately failing test is RUN, its
 *     failure counted with the same parser the harness uses, and the resulting
 *     verdict fed through the real `tests-pass` check, which goes red. The
 *     positive control is the same fixture with the failing test repaired.
 *  2. The binding itself — `suiteVerdictViolations` in gates/workflow.test.ts,
 *     the single site that turns a non-PASS suite reading into a refusal — is
 *     removed from a MUTANT COPY of that source, and the mutant is watched
 *     shipping the exact fixture the real source refuses.
 *
 * Nothing is written inside the repo. The mutant lives in a temp directory
 * with its relative imports rewritten to absolute ones, because a mutant that
 * dies on module resolution exits non-zero and reads as "the mutation was
 * rejected on the merits" — the trap the rule names.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const GATES_DIR = join(REPO_ROOT, "gates");
const GATE_SUITE = join(GATES_DIR, "workflow.test.ts");

/**
 * The one line the mutation removes. Declared here rather than regex-built so
 * that renaming the function in gates/workflow.test.ts aborts this file
 * instead of quietly mutating nothing.
 */
const BINDING_SIGNATURE =
  "export function suiteVerdictViolations(val: unknown, measurement?: SuiteReading): string[] {";

/**
 * #235's binding, mutated the same way. The pre-validator already knew which
 * AC evidence commands were broken and printed it; nothing turned that reading
 * into a refusal. `prevalidationViolations` is now the one site that does.
 */
const PREVALIDATION_SIGNATURE =
  "export function prevalidationViolations(val: unknown, gatePhase?: unknown): string[] {";

/**
 * #414's binding. `lib/worktree-repo.ts` exported the unforgeable reading
 * since #218 and nothing could call it, because the only place that wanted it
 * — `workflows/ship.js` — has no subprocess (#69). `worktreeRepoViolations`
 * is the one site that turns a reading of the disk into a refusal.
 */
const WORKTREE_REPO_SIGNATURE =
  "export function worktreeRepoViolations(entries: unknown, expectedRepo: unknown, read?: (p: string) => RemoteReading): string[] {";

let SCRATCH = "";
let WORK = "";
let PROJECT = "";
let MUTANTS = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "suite-binding-"));
  WORK = join(SCRATCH, "work");
  PROJECT = join(SCRATCH, "project");
  MUTANTS = join(SCRATCH, "mutant");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(PROJECT, ".claude"), { recursive: true });
  mkdirSync(MUTANTS, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ── the fixture ─────────────────────────────────────────────────────────────

/**
 * A project with exactly one test, failing or passing on request. `bun test`
 * needs no install here: `bun:test` is a builtin, so the fixture runs from a
 * temp directory with nothing in it.
 */
function plantProject(opts: { failing: boolean }): void {
  writeFileSync(
    join(PROJECT, "fixture.test.ts"),
    opts.failing
      ? 'import { test, expect } from "bun:test";\n' +
          'test("the deliberately failing test", () => { expect(1).toBe(2); });\n'
      : 'import { test, expect } from "bun:test";\n' +
          'test("the deliberately failing test, repaired", () => { expect(1).toBe(1); });\n',
  );
  writeFileSync(
    join(PROJECT, ".claude", "rungate.json"),
    JSON.stringify({ dev: { testCmd: "bun test" } }, null, 2),
  );
}

/**
 * Run the fixture's suite and read the failure count out of it with
 * `extractTestFailureCount` — the parser the harness itself uses. The verdict
 * written into the state below is therefore a measurement of a run, not a
 * string this test chose.
 */
function measureFixture(): { failures: number; verdict: "PASS" | "FAIL" } {
  const r = spawnSync("bun", ["test", "fixture.test.ts"], {
    cwd: PROJECT,
    encoding: "utf-8",
    timeout: 60000,
  });
  const failures = extractTestFailureCount(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  return { failures, verdict: failures > 0 ? "FAIL" : "PASS" };
}

/**
 * A project whose test files are gone by the time the runner reaches them
 * (#469), and what `bun test` printed when it tried.
 *
 * The first file bun imports removes the directory the rest live in, which is
 * what a worktree being deleted mid-run looks like from inside the runner.
 * The incident's own run exited 0; this reproduction exits 1, and neither
 * number is consulted — `readSuiteRun` keys off the absence of a summary,
 * which is the only thing both runs have in common.
 */
function measureVanishingFixture(): { output: string; code: number } {
  mkdirSync(join(PROJECT, "sub"), { recursive: true });
  writeFileSync(
    join(PROJECT, "000-remover.test.ts"),
    'import { rmSync } from "fs";\nrmSync(`${import.meta.dir}/sub`, { recursive: true, force: true });\n',
  );
  for (const n of ["a", "b", "c"]) {
    writeFileSync(
      join(PROJECT, "sub", `${n}.test.ts`),
      'import { test, expect } from "bun:test";\ntest("t", () => { expect(1).toBe(1); });\n',
    );
  }
  writeFileSync(
    join(PROJECT, ".claude", "rungate.json"),
    JSON.stringify({ dev: { testCmd: "bun test" } }, null, 2),
  );
  const r = spawnSync("bun", ["test"], { cwd: PROJECT, encoding: "utf-8", timeout: 60000 });
  return { output: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
}

function plantState(local: Record<string, unknown> | undefined): void {
  const state = {
    schemaVersion: 2,
    issue: 224,
    slug: "pai-harness-224",
    phase: "VERIFY",
    projectRoot: PROJECT,
    issueGoal: "the suite result and the ship verdict are connected",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "a measured suite failure reaches the tests-pass check",
        threshold: { op: "==", value: 0, unit: "failures" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...(local === undefined ? {} : { environments: { local } }),
  };
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

/**
 * The producer, run against the fixture, with nothing in between (#530).
 *
 * Until #530 the only way to get a verdict into `environments.local.tests`
 * was to write it by hand — and that is the defect, not a convenience of the
 * test: the recorder wrote `suiteMeasurement`, the gate read
 * `environments.local.tests`, and nothing bridged them. Every green row in
 * this file was a hand-written enum standing in for a chain that did not
 * connect, which is why the chain's absence survived #224, #307 and #312.
 *
 * So the fixture is committed to a real repository (the recorder refuses a
 * measurement with no commit behind it, #224/#312), its suite output is
 * captured, and the recorder is run. What `tests-pass` then reads is what
 * the producer wrote.
 */
function recordFixtureSuite(): { code: number; err: string } {
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", PROJECT, ...a], { encoding: "utf-8" });
  if (!existsSync(join(PROJECT, ".git"))) {
    git("init", "-q", "-b", "main");
    // Spelled out rather than through `git()`: the #84 guard reads the argv
    // at the call site and cannot see a wrapper's prepended `-C`.
    spawnSync("git", ["-C", PROJECT, "config", "user.email", "t@example.test"]);
    spawnSync("git", ["-C", PROJECT, "config", "user.name", "T"]);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const out = join(WORK, "suite-output.txt");
  const run = spawnSync("bun", ["test"], { cwd: PROJECT, encoding: "utf-8", timeout: 60000 });
  writeFileSync(out, `${run.stdout ?? ""}${run.stderr ?? ""}`);

  const r = spawnSync(
    "bun",
    [
      join(REPO_ROOT, "scripts", "record-suite-measurement.ts"),
      "--state", join(WORK, "workflow-state.json"),
      "--project", PROJECT,
      "--output", out,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  return { code: r.status ?? -1, err: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── running one named check out of a gate suite ─────────────────────────────

/**
 * `ran` is not a formality: a filter that matches nothing leaves bun reporting
 * zero failures, which is indistinguishable from the check passing. It is also
 * what a mutant that failed to resolve its imports looks like, so every
 * assertion below goes through it first.
 */
function runCheck(suitePath: string, filter = "tests-pass"): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", suitePath, "-t", filter], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, TEST_WORK_DIR: WORK },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const passed = count("pass");
  const failed = count("fail");
  return { ran: passed + failed === 1, red: failed === 1, output };
}

// ── the mutation ────────────────────────────────────────────────────────────

/**
 * Short-circuit the binding: `suiteVerdictViolations` returns no violations, so
 * no suite reading can produce a refusal. Everything else in the gate suite is
 * left exactly as it is.
 *
 * Throws rather than returning an unmutated copy when the signature moves. A
 * harness that silently no-ops when its target is renamed is the decorative
 * check this whole exercise exists to rule out.
 */
export function buildMutantSource(src: string, signature = BINDING_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second copy of it exists and removing one would leave the other refusing.`,
    );
  }
  const shortCircuited = src.replace(
    signature,
    `${signature}\n  return []; // MUTANT: suite-to-verdict binding removed`,
  );

  // The mutant runs from a temp directory, so every relative specifier has to
  // become absolute. If one survives, the mutant dies on module resolution and
  // exits non-zero, which reads as a refusal it never made.
  // #277: the `..` arm had never been exercised. The pattern matched both
  // `./x` and `../x` but captured only the part AFTER the slashes, then
  // joined it to GATES_DIR — so `../lib/x` became `gates/lib/x`, one level
  // wrong, and the mutant died on module resolution. A non-zero exit reads
  // as a refusal, which is exactly what the leftover check below exists to
  // prevent and what this arm quietly reintroduced for any import outside
  // `gates/`. The whole specifier is resolved now.
  const relocated = shortCircuited.replace(
    /from "(\.\.?\/[A-Za-z0-9._\-/]+)"/g,
    (_m, spec: string) => `from "${resolve(GATES_DIR, spec)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that non-zero exit reads as a refusal`,
    );
  }
  return relocated;
}

function writeMutant(signature = BINDING_SIGNATURE): string {
  const path = join(MUTANTS, `workflow-mutant-${createHash("sha1").update(signature).digest("hex").slice(0, 8)}.ts`);
  writeFileSync(path, buildMutantSource(readFileSync(GATE_SUITE, "utf-8"), signature));
  return path;
}

// ── AC-1: the planted failing test reaches the check ────────────────────────

describe("#224 fixture: a measured suite failure reaches tests-pass", () => {
  test("the fixture's failing test really fails — counted, not asserted", () => {
    plantProject({ failing: true });
    const failing = measureFixture();
    expect(failing.failures, "the planted failing test did not fail").toBe(1);
    expect(failing.verdict).toBe("FAIL");

    plantProject({ failing: false });
    const repaired = measureFixture();
    expect(repaired.failures, "the repaired fixture still reports a failure").toBe(0);
    expect(repaired.verdict).toBe("PASS");
  }, 120000);

  test("SC-1846: fixture with one failing test: the real tests-pass check goes red", () => {
    plantProject({ failing: true });
    plantState(undefined);
    // Through the RECORDER, since #530. Nothing between the suite and the
    // check writes a verdict, so this row fails if the producer stops
    // reaching the field the consumer reads.
    const rec = recordFixtureSuite();
    expect(rec.code, `the recorder refused a measurable fixture:\n${rec.err}`).toBe(0);

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured suite failure did not fail tests-pass:\n${r.output}`).toBe(true);
    // Red for the stated reason. A gate suite that failed to load is also red,
    // and the two are indistinguishable from the count alone.
    expect(r.output, "red, but not from the suite reading").toContain("tests: FAIL — expected PASS");
  }, 180000);

  test("SC-1847: fixture with the failing test repaired: the same check is green", () => {
    // The control, and since #530 it is also the end-to-end proof: a PASS
    // that reaches this check has been written by the recorder from a run
    // that happened, not planted. Without this row a check that refuses
    // everything satisfies the case above — and without the recorder in the
    // chain, a producer that writes nowhere the consumer reads satisfies
    // both, which is how #530 survived three issues about this exact field.
    plantProject({ failing: false });
    plantState(undefined);
    const rec = recordFixtureSuite();
    expect(rec.code, `the recorder refused a clean fixture:\n${rec.err}`).toBe(0);

    // Both shapes of the one fact, written by one write.
    const written = JSON.parse(readFileSync(join(WORK, "workflow-state.json"), "utf-8"));
    expect(written.environments?.local?.tests, "the recorder did not write the field the gate reads").toBe("PASS");
    expect(written.suiteMeasurement?.verdict).toBe("PASS");

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured suite PASS failed tests-pass:\n${r.output}`).toBe(false);
  }, 180000);

  test("SC-1848: a PASS with no measurement behind it is refused", () => {
    // The hand-written verdict, which the ship prompt has only ever
    // forbidden in prose — and which was the ONLY way this check could pass
    // before #530, because nothing wrote the field.
    plantProject({ failing: false });
    plantState({ tests: "PASS" });

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran:\n${r.output}`).toBe(true);
    expect(r.red, `a typed PASS with no measurement was accepted:\n${r.output}`).toBe(true);
    expect(r.output).toContain("a verdict somebody typed");

    // And the control one line over: the same enum, now backed. Without this
    // the refusal above is satisfied by a check that rejects every PASS.
    const rec = recordFixtureSuite();
    expect(rec.code, rec.err).toBe(0);
    const backed = runCheck(GATE_SUITE);
    expect(backed.ran).toBe(true);
    expect(backed.red, `a measured PASS was refused:\n${backed.output}`).toBe(false);
  }, 180000);

  test("fixture with nothing measured at all: still red", () => {
    // #224's actual shape. The run did not record FAIL, it recorded nothing,
    // and nothing read as zero regressions.
    plantProject({ failing: true });
    plantState({});

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `an unmeasured suite did not fail tests-pass:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the missing reading").toContain("local.tests not set");
  }, 180000);

  test("SC-1839: a run whose test files vanished reads UNMEASURED and the same check goes red", () => {
    // #469 SC-1 and SC-2 in one chain, and the chain is the point: the
    // verdict handed to the check is DERIVED from a run that really happened,
    // not a string this test chose. A hand-written "UNMEASURED" would prove
    // the check can read a word.
    const run = measureVanishingFixture();
    // The instrument first. A fixture that stopped reproducing and a reader
    // that stopped refusing produce the same UNMEASURED, and only this can
    // tell them apart (.claude/rules/checks-must-be-able-to-fail.md).
    expect(run.output, "the vanishing fixture now prints a summary — re-derive it")
      .not.toMatch(/^\s*\d+\s+(pass|fail)\s*$/m);

    const reading = readSuiteRun(run.output);
    expect(reading.status, reading.status === "MEASURED" ? "the run was read as measured" : "").toBe("UNMEASURED");
    const verdict = suiteRunVerdict(reading);
    expect(verdict).toBe("UNMEASURED");
    // The specific shape of #469: this must not be the verdict a clean run
    // gets. `extractTestFailureCount` reads the same output as 0 failures,
    // which is how the run that forced this issue reported success.
    expect(verdict).not.toBe("PASS");
    expect(extractTestFailureCount(run.output), "the old parser still reads this run as clean").toBe(0);

    plantState({ tests: verdict });
    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `an UNMEASURED suite reading did not fail tests-pass:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the suite reading").toContain("tests: UNMEASURED — expected PASS");
  }, 180000);
});

// ── AC-2: the binding removed, and observed not refusing ────────────────────

describe("#224 mutant: removing the binding makes the gate ship the failure", () => {
  test("the mutant ships the exact fixture the real source refuses", () => {
    plantProject({ failing: true });
    const measured = measureFixture();
    expect(measured.verdict).toBe("FAIL");
    plantState({ tests: measured.verdict });

    // Both halves run against one planted state. The real one refusing is not
    // on its own evidence that the refusal came from the binding; the mutant
    // going green on the same input is.
    const real = runCheck(GATE_SUITE);
    expect(real.ran, `tests-pass never ran in the real source:\n${real.output}`).toBe(true);
    expect(real.red, `the real source shipped a measured FAIL:\n${real.output}`).toBe(true);
    expect(real.output).toContain("tests: FAIL — expected PASS");

    const mutant = runCheck(writeMutant());
    expect(
      mutant.ran,
      `the mutant never ran — module resolution or the name filter, not a verdict:\n${mutant.output}`,
    ).toBe(true);
    expect(
      mutant.red,
      `the mutant still refused, so the refusal does not come from the binding:\n${mutant.output}`,
    ).toBe(false);
  }, 240000);

  test("SC-1840: the mutant ships an UNMEASURED run the real source refuses", () => {
    // #469 SC-2, through the harness the issue names. The real source
    // refusing an UNMEASURED reading is not on its own evidence that the
    // refusal comes from `suiteVerdictViolations` — the mutant going green on
    // the same planted state is.
    const run = measureVanishingFixture();
    const verdict = suiteRunVerdict(readSuiteRun(run.output));
    expect(verdict).toBe("UNMEASURED");
    plantState({ tests: verdict });

    const real = runCheck(GATE_SUITE);
    expect(real.ran, `tests-pass never ran in the real source:\n${real.output}`).toBe(true);
    expect(real.red, `the real source shipped an UNMEASURED reading:\n${real.output}`).toBe(true);
    expect(real.output).toContain("tests: UNMEASURED — expected PASS");

    const mutant = runCheck(writeMutant());
    expect(
      mutant.ran,
      `the mutant never ran — module resolution or the name filter, not a verdict:\n${mutant.output}`,
    ).toBe(true);
    expect(
      mutant.red,
      `the mutant still refused, so the refusal does not come from the binding:\n${mutant.output}`,
    ).toBe(false);
  }, 240000);

  test("the mutation harness throws when the binding is renamed", () => {
    const renamed = readFileSync(GATE_SUITE, "utf-8").replace(
      BINDING_SIGNATURE,
      "export function suiteVerdictViolationsRenamed(val: unknown): string[] {",
    );
    expect(() => buildMutantSource(renamed)).toThrow(/could not build the mutant/);
  });

  test("the mutation harness throws when a second copy of the binding exists", () => {
    // A duplicated refusal path would survive the mutation and make the mutant
    // go red for a reason that has nothing to do with the mutation working.
    const src = readFileSync(GATE_SUITE, "utf-8");
    expect(() => buildMutantSource(`${src}\n${BINDING_SIGNATURE}\n  return [];\n}\n`)).toThrow(
      /appears 2 times/,
    );
  });

  test("the mutation harness throws when a relative import survives", () => {
    // `$` is outside the character class the rewriter accepts, so this import
    // is one the rewriter cannot see — exactly the case where the mutant would
    // die on module resolution and that non-zero exit would be mistaken for a
    // refusal. The leftover sweep is what notices.
    const withLeftover = `${readFileSync(GATE_SUITE, "utf-8")}\nimport { q } from "./odd$name";\n`;
    expect(() => buildMutantSource(withLeftover)).toThrow(/relative import/);
  });

  test("a parent-relative import resolves to the right level (#277)", () => {
    // The `..` arm had never run. The pattern matched `../lib/x` but captured
    // only `lib/x` and joined it to GATES_DIR, producing `gates/lib/x` — one
    // level wrong. The mutant then died on module resolution, and that
    // non-zero exit reads as a refusal it never made, which is the precise
    // failure the leftover sweep above exists to prevent and which this arm
    // reintroduced for every import outside `gates/`.
    //
    // Found when `gates/workflow.test.ts` gained its first `../lib/` import
    // and three mutation harnesses went red at once.
    const out = buildMutantSource(readFileSync(GATE_SUITE, "utf-8"));
    const parents = [...out.matchAll(/from "([^"]*\/lib\/[^"]*)"/g)].map(m => m[1]);
    expect(parents.length, "no parent-relative import left to check — this control is now blind").toBeGreaterThan(0);
    for (const p of parents) {
      expect(p, `${p} was resolved one level too deep`).not.toContain("/gates/lib/");
      expect(existsSync(`${p}.ts`), `${p} does not exist — the mutant would die on module resolution`).toBe(true);
    }
  });

  test("nothing the suite-binding mutation wrote is left anywhere in the tree", () => {
    plantProject({ failing: true });
    plantState({ tests: "FAIL" });
    const path = writeMutant();
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(tmpdir()), `the mutant was written inside the repo: ${path}`).toBe(true);

    // And the real source is untouched by having been mutated.
    expect(readFileSync(GATE_SUITE, "utf-8")).not.toContain("MUTANT: suite-to-verdict binding removed");
    for (const dir of [GATES_DIR, join(REPO_ROOT, "test")]) {
      expect(
        readdirSync(dir).filter(f => /mutant/i.test(f) && f !== "suite-binding-mutation.test.ts"),
        `a mutant file was left in ${dir}`,
      ).toEqual([]);
    }
  });
});

// ── #235: the evidence pre-validation reading reaches the verdict ───────────

/**
 * The pre-validation fixture, dry-run inside the same temp PROJECT the suite
 * fixture uses. One AC whose evidence command cannot succeed, one whose
 * command can.
 *
 * Neither command is one `lib/evidence-prevalidator.ts` auto-fixes: the broken
 * one is not a bare `grep` and not a `bun test` pipe, so it reaches the
 * `broken` classification on its own merits rather than being repaired first.
 */
const BROKEN_AC = {
  id: "AC-2",
  type: "CODE",
  statement: "the evidence command runs",
  threshold: { op: "==", value: 0, unit: "errors" },
  evidenceMethod: { type: "COMMAND", command: "ls ./no-such-path-in-this-fixture" },
};

const WORKING_AC = {
  id: "AC-1",
  type: "CODE",
  statement: "the evidence command runs",
  threshold: { op: "==", value: 0, unit: "errors" },
  evidenceMethod: { type: "COMMAND", command: "echo measured" },
};

/**
 * Dry-run the fixture's evidence commands through `prevalidateEvidence` — the
 * real pre-validator the harness runs at SCOPE — and derive the reading from
 * what it classified. The verdict the gate sees below is therefore a
 * measurement of commands that were actually executed, not a string this test
 * chose. Short-circuiting that function to `return []` is what turns these
 * cases red.
 */
async function measurePrevalidation(
  acs: Array<Record<string, unknown>>,
): Promise<{ broken: string[]; acs: unknown[]; verdict: "PASS" | "FAIL" }> {
  const results = await prevalidateEvidence(acs as any, PROJECT);
  const broken = results.filter(r => r.status === "broken").map(r => r.id);
  // `acs` is carried through as the producer returns it (#295). The planted
  // reading used to be `{verdict, broken}`, a shape no writer has ever
  // produced: `lib/evidence-prevalidator.ts` returns `acs`, and the reader was
  // reaching for `broken` to match. The fixture and the reader agreed with
  // each other and not with the producer between them, which is why neither
  // noticed that every real refusal was unable to name an AC.
  return { broken, acs: results, verdict: broken.length > 0 ? "FAIL" : "PASS" };
}

function plantPrevalidationState(opts: {
  acs: Array<Record<string, unknown>>;
  reading?: unknown;
}): void {
  const state: Record<string, unknown> = {
    schemaVersion: 2,
    issue: 235,
    slug: "pai-harness-235",
    phase: "VERIFY",
    projectRoot: PROJECT,
    issueGoal: "a broken evidence command refuses the ship gate",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: opts.acs,
  };
  if ("reading" in opts) state.evidencePrevalidation = opts.reading;
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

describe("#235 fixture: a measured pre-validation failure reaches the gate", () => {
  test("the fixture's broken evidence command really is broken — dry-run, not asserted", async () => {
    plantProject({ failing: false });

    const measured = await measurePrevalidation([WORKING_AC, BROKEN_AC]);
    expect(measured.broken, "the planted broken evidence command was not classified broken").toEqual([
      "AC-2",
    ]);
    expect(measured.verdict).toBe("FAIL");

    const repaired = await measurePrevalidation([WORKING_AC]);
    expect(repaired.broken, "the working evidence command was classified broken").toEqual([]);
    expect(repaired.verdict).toBe("PASS");
  }, 120000);

  test("fixture with a broken evidence command: the real check goes red, naming the AC", async () => {
    plantProject({ failing: false });
    const measured = await measurePrevalidation([WORKING_AC, BROKEN_AC]);
    expect(measured.verdict).toBe("FAIL");
    plantPrevalidationState({
      acs: [WORKING_AC, BROKEN_AC],
      reading: { verdict: measured.verdict, acs: measured.acs },
    });

    const r = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured pre-validation FAIL did not fail the gate:\n${r.output}`).toBe(true);
    // Red for the stated reason, and naming what to fix. A gate suite that
    // failed to load is also red, and the two are indistinguishable from the
    // count alone.
    expect(r.output, "red, but not from the pre-validation reading").toContain(
      "broken evidence commands on AC-2",
    );
  }, 180000);

  test("fixture with the evidence command repaired: the same check is green", async () => {
    // Without this control, a check that refuses everything satisfies the case
    // above.
    plantProject({ failing: false });
    const measured = await measurePrevalidation([WORKING_AC]);
    expect(measured.verdict).toBe("PASS");
    plantPrevalidationState({
      acs: [WORKING_AC],
      reading: { verdict: measured.verdict, acs: measured.acs },
    });

    const r = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured pre-validation PASS failed the gate:\n${r.output}`).toBe(false);
  }, 180000);

  test("fixture with nothing pre-validated at all: still red", async () => {
    // #235's actual shape. The pre-validator printed the broken commands to
    // the console, the state recorded nothing, and nothing read as clean.
    plantProject({ failing: false });
    plantPrevalidationState({ acs: [WORKING_AC, BROKEN_AC] });

    const r = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `an unmeasured pre-validation did not fail the gate:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the missing reading").toContain(
      "evidencePrevalidation not recorded",
    );
  }, 180000);

  test("an explicit UNMEASURED reading refuses the same way an absent one does", () => {
    plantProject({ failing: false });
    plantPrevalidationState({
      acs: [WORKING_AC, BROKEN_AC],
      reading: { verdict: "UNMEASURED", acs: [] },
    });

    const r = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `an UNMEASURED pre-validation did not fail the gate:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the unmeasured reading").toContain(
      "An unmeasured pre-validation is not a clean one",
    );
  }, 180000);
});

// ── #414: the worktree-repository reading, mutated the same way ──

/**
 * Two real checkouts and a state naming one of them.
 *
 * `git init` + `git remote add`, not a stub: the whole point of #414 is that
 * the reading comes off the disk rather than out of a reply, and a stubbed
 * reader would prove the comparison can compare while proving nothing about
 * whether git was ever asked.
 *
 * `reportedRepo` is always the RIGHT slug, so the state is exactly what an
 * agent answering from its brief produces — the reply ship.js checks is
 * correct, and only the disk disagrees. That is the input #218 structurally
 * cannot refuse, which is why it is the one planted here.
 */
function makeCheckout(origin: string, tag: string): string {
  const tree = join(SCRATCH, `worktree-${tag}-${createHash("sha1").update(origin).digest("hex").slice(0, 8)}`);
  mkdirSync(tree, { recursive: true });
  spawnSync("git", ["init", "-q", tree], { encoding: "utf-8" });
  spawnSync("git", ["-C", tree, "remote", "add", "origin", origin], { encoding: "utf-8" });
  return tree;
}

/**
 * `extraWorktree` plants a SECOND checkout that is not the tree under test.
 *
 * Without it the state's `worktrees` entry and `treeUnderTest` are the same
 * path, the gate deduplicates them, and dropping the `worktrees` reading
 * changes nothing — measured as a zero in the #414 battery before this
 * existed. It is also the shape #218's incident actually had: a decomposed
 * run where the FIRST agent's worktree was correct and a later one was not.
 */
function plantWorktreeState(opts: { origin: string; reportedRepo?: string; extraWorktree?: string }): string {
  const tree = makeCheckout(opts.origin, "tut");
  const state = {
    schemaVersion: 2,
    issue: 414,
    repo: "hornjason/pai-harness",
    slug: "pai-harness-414",
    phase: "SHIP",
    projectRoot: PROJECT,
    treeUnderTest: tree,
    issueGoal: "the worktree a run built in is the repository the run targets",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the gate reads origin off the checkout",
        threshold: { op: "==", value: 0, unit: "violations" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...(opts.extraWorktree
      ? {
          worktrees: [
            ...(opts.reportedRepo ? [{ path: tree, reportedRepo: opts.reportedRepo }] : []),
            { path: makeCheckout(opts.extraWorktree, "extra"), reportedRepo: RIGHT_ORIGIN },
          ],
        }
      : opts.reportedRepo
        ? { worktrees: [{ path: tree, reportedRepo: opts.reportedRepo }] }
        : {}),
  };
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
  return tree;
}

const WRONG_ORIGIN = "https://github.com/example-owner/example-project.git";
const RIGHT_ORIGIN = "git@github.com:hornjason/pai-harness.git";
const WORKTREE_CHECK = "worktree-repo";

describe("#414 fixture: a checkout of another repository reaches the gate", () => {
  test("the planted checkout really has the wrong origin — read, not asserted", () => {
    const tree = plantWorktreeState({ origin: WRONG_ORIGIN });
    const got = spawnSync("git", ["-C", tree, "remote", "get-url", "origin"], { encoding: "utf-8" });
    expect(got.status, "the fixture is not a checkout with an origin").toBe(0);
    expect(String(got.stdout).trim()).toBe(WRONG_ORIGIN);
  }, 60000);

  test("a worktree of another repository fails the real check", () => {
    plantWorktreeState({ origin: WRONG_ORIGIN, reportedRepo: RIGHT_ORIGIN });
    const r = runCheck(GATE_SUITE, WORKTREE_CHECK);
    expect(r.ran, `${WORKTREE_CHECK} never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a worktree of another repository passed the gate:\n${r.output}`).toBe(true);
    // Red for the stated reason. A gate suite that failed to load is red too,
    // and the count alone cannot tell them apart.
    expect(r.output, "red, but not from the disk reading").toContain("example-owner/example-project");
  }, 180000);

  test("a worktree of the run's own repository passes the same check", () => {
    // Without this control, a check that refuses everything satisfies the
    // case above.
    plantWorktreeState({ origin: RIGHT_ORIGIN, reportedRepo: RIGHT_ORIGIN });
    const r = runCheck(GATE_SUITE, WORKTREE_CHECK);
    expect(r.ran, `${WORKTREE_CHECK} never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a correct worktree failed the gate:\n${r.output}`).toBe(false);
  }, 180000);

  test("a correct tree under test does not excuse a second worktree that is wrong", () => {
    // The decomposed shape, and the one #218's incident actually had: the
    // first agent's worktree was right and a later one was not. Without this
    // the `worktrees` reading is never load-bearing — `treeUnderTest` covers
    // the same path, the gate deduplicates, and removing the reading scores
    // zero.
    plantWorktreeState({
      origin: RIGHT_ORIGIN,
      reportedRepo: RIGHT_ORIGIN,
      extraWorktree: WRONG_ORIGIN,
    });
    const r = runCheck(GATE_SUITE, WORKTREE_CHECK);
    expect(r.ran, `${WORKTREE_CHECK} never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a second worktree in another repository passed the gate:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the second worktree").toContain("example-owner/example-project");
  }, 180000);

  test("the refusal says the reply and the disk disagreed", () => {
    // #414 SC-2. The operator's first question is which reading refused:
    // ship.js's, from the agent's reply, or this one, from the checkout.
    plantWorktreeState({ origin: WRONG_ORIGIN, reportedRepo: RIGHT_ORIGIN });
    const r = runCheck(GATE_SUITE, WORKTREE_CHECK);
    expect(r.ran).toBe(true);
    expect(r.output).toContain("read from the checkout");
  }, 180000);
});

describe("#414 mutant: removing the binding makes the gate ship the wrong checkout", () => {
  test("the mutant ships the exact fixture the real source refuses", () => {
    plantWorktreeState({ origin: WRONG_ORIGIN, reportedRepo: RIGHT_ORIGIN });

    const real = runCheck(GATE_SUITE, WORKTREE_CHECK);
    expect(real.ran, `${WORKTREE_CHECK} never ran in the real source:\n${real.output}`).toBe(true);
    expect(real.red, `the real source shipped a worktree of another repository:\n${real.output}`).toBe(true);

    const mutant = runCheck(writeMutant(WORKTREE_REPO_SIGNATURE), WORKTREE_CHECK);
    expect(
      mutant.ran,
      `the mutant never ran — module resolution or the name filter, not a verdict:\n${mutant.output}`,
    ).toBe(true);
    expect(
      mutant.red,
      `the mutant still refused, so the refusal does not come from the binding:\n${mutant.output}`,
    ).toBe(false);
  }, 240000);

  test("the mutation harness throws when the worktree binding is renamed", () => {
    const renamed = readFileSync(GATE_SUITE, "utf-8").replace(
      WORKTREE_REPO_SIGNATURE,
      "export function worktreeRepoRefusal(entries: unknown, expectedRepo: unknown, read?: (p: string) => RemoteReading): string[] {",
    );
    expect(() => buildMutantSource(renamed, WORKTREE_REPO_SIGNATURE)).toThrow(
      /could not build the mutant: the binding signature appears 0 times/,
    );
  });

  test("the mutation harness throws when a second copy of the worktree binding exists", () => {
    const src = readFileSync(GATE_SUITE, "utf-8");
    expect(() =>
      buildMutantSource(`${src}\n${WORKTREE_REPO_SIGNATURE}\n  return [];\n}\n`, WORKTREE_REPO_SIGNATURE),
    ).toThrow(/appears 2 times/);
  });
});

describe("#235 mutant: removing the binding makes the gate ship the broken commands", () => {
  test("the mutant ships the exact fixture the real source refuses", async () => {
    plantProject({ failing: false });
    const measured = await measurePrevalidation([WORKING_AC, BROKEN_AC]);
    expect(measured.verdict).toBe("FAIL");
    plantPrevalidationState({
      acs: [WORKING_AC, BROKEN_AC],
      reading: { verdict: measured.verdict, acs: measured.acs },
    });

    // Both halves run against one planted state. The real one refusing is not
    // on its own evidence that the refusal came from the binding; the mutant
    // going green on the same input is.
    const real = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(real.ran, `evidence-prevalidation never ran in the real source:\n${real.output}`).toBe(true);
    expect(real.red, `the real source shipped a measured pre-validation FAIL:\n${real.output}`).toBe(true);
    expect(real.output).toContain("broken evidence commands on AC-2");

    const mutant = runCheck(writeMutant(PREVALIDATION_SIGNATURE), "evidence-prevalidation");
    expect(
      mutant.ran,
      `the mutant never ran — module resolution or the name filter, not a verdict:\n${mutant.output}`,
    ).toBe(true);
    expect(
      mutant.red,
      `the mutant still refused, so the refusal does not come from the binding:\n${mutant.output}`,
    ).toBe(false);
  }, 240000);

  test("the mutation harness throws when the pre-validation binding is renamed", () => {
    const renamed = readFileSync(GATE_SUITE, "utf-8").replace(
      PREVALIDATION_SIGNATURE,
      "export function prevalidationRefusal(val: unknown): string[] {",
    );
    expect(() => buildMutantSource(renamed, PREVALIDATION_SIGNATURE)).toThrow(
      /could not build the mutant: the binding signature appears 0 times/,
    );
  });

  test("the mutation harness throws when a second copy of the pre-validation binding exists", () => {
    // A duplicated refusal path would survive the mutation and make the mutant
    // go red for a reason that has nothing to do with the mutation working.
    const src = readFileSync(GATE_SUITE, "utf-8");
    expect(() =>
      buildMutantSource(`${src}\n${PREVALIDATION_SIGNATURE}\n  return [];\n}\n`, PREVALIDATION_SIGNATURE),
    ).toThrow(/appears 2 times/);
  });

  test("nothing the pre-validation mutation wrote is left anywhere in the tree", () => {
    plantProject({ failing: false });
    plantPrevalidationState({
      acs: [WORKING_AC, BROKEN_AC],
      reading: { verdict: "FAIL", acs: [{ id: "AC-2", status: "broken" }] },
    });
    const path = writeMutant(PREVALIDATION_SIGNATURE);
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(tmpdir()), `the mutant was written inside the repo: ${path}`).toBe(true);
    expect(readFileSync(GATE_SUITE, "utf-8")).not.toContain("MUTANT: suite-to-verdict binding removed");
  });
});

// ── #126: the verify fan-out binding ────────────────────────────────────────

/**
 * The third binding, and the one that had never been load-bearing at all.
 *
 * `b1-adversary-verify-structure` and `b2-evidence-validator-structure` read
 * their slot and, finding nothing, warned and returned — so the failure mode
 * they existed for, the agent never running, was the one case they could not
 * catch. `verifyFanoutViolations` is now the single site that turns "no
 * record" into a refusal, and this proves removing it makes the gate accept a
 * run whose adversarial verification never happened.
 *
 * The real/mutant pair matters more here than in the two cases above, because
 * this check spent its whole life green: "it passes" is the state it was
 * already in, and only "the mutant passes where the real one refuses"
 * distinguishes the fix from the defect.
 */
const FANOUT_SIGNATURE =
  "export function verifyFanoutViolations(label: string, val: unknown, tier: unknown): string[] {";

/** A verify-phase state whose fan-out slots are missing — what #126 leaves behind. */
function plantFanoutGap(): void {
  const state = {
    schemaVersion: 2,
    issue: 126,
    slug: "pai-harness-126",
    // SHIP, not VERIFY: gate-executor runs this suite before it spawns the
    // fan-out and persists the slots, so the check reads at ship, by which
    // point the fan-out has run or recorded why it did not.
    phase: "SHIP",
    projectRoot: PROJECT,
    issueGoal: "the verify fan-out leaves a trace or the gate refuses",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "an absent adversary record is a refusal",
        threshold: { op: "==", value: 0, unit: "failures" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    gates: { verify: { evidenceValidator: { ts: "2026-10-10T00:00:00Z", verdicts: [] } } },
  };
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

describe("#126 binding: an unrun adversary is refused, and the mutant proves it", () => {
  test("the real source refuses the gap, the mutant ships it", () => {
    plantFanoutGap();

    const real = runCheck(GATE_SUITE, "b1-adversary-verify-structure");
    expect(real.ran, `the real check never ran:\n${real.output}`).toBe(true);
    expect(real.red, `a run with no adversary record was accepted:\n${real.output}`).toBe(true);
    expect(real.output, "the refusal does not name the missing slot").toContain("adversary");

    const mutant = runCheck(writeMutant(FANOUT_SIGNATURE), "b1-adversary-verify-structure");
    expect(
      mutant.ran,
      `the mutant never ran — module resolution or the name filter, not a verdict:\n${mutant.output}`,
    ).toBe(true);
    expect(
      mutant.red,
      `the mutant still refused, so the refusal does not come from the binding:\n${mutant.output}`,
    ).toBe(false);
  }, 240000);

  test("the mutation harness throws when the fan-out binding is renamed", () => {
    const renamed = readFileSync(GATE_SUITE, "utf-8").replace(
      FANOUT_SIGNATURE,
      "export function verifyFanoutViolationsRenamed(label: string, val: unknown, tier: unknown): string[] {",
    );
    expect(() => buildMutantSource(renamed, FANOUT_SIGNATURE)).toThrow(/could not build the mutant/);
  });

  test("the binding is used by BOTH slots, not just the one the mutant drives", () => {
    // A fix applied to b1 alone would pass the pair above while leaving b2
    // exactly as it was. Asserted on the suite source because the two call
    // sites are what make the single binding worth having.
    const src = readFileSync(GATE_SUITE, "utf-8");
    const calls = src.match(/verifyFanoutViolations\(/g) || [];
    expect(
      calls.length,
      "the fan-out binding is declared and called fewer than twice — one of the two slots still reads its own absence",
    ).toBeGreaterThanOrEqual(3);
    expect(src).toContain('verifyFanoutViolations("adversary"');
    expect(src).toContain('verifyFanoutViolations("evidenceValidator"');
  });
});
