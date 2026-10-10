import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractTestFailureCount } from "../gates/gate-executor";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";

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
const BINDING_SIGNATURE = "export function suiteVerdictViolations(val: unknown): string[] {";

/**
 * #235's binding, mutated the same way. The pre-validator already knew which
 * AC evidence commands were broken and printed it; nothing turned that reading
 * into a refusal. `prevalidationViolations` is now the one site that does.
 */
const PREVALIDATION_SIGNATURE = "export function prevalidationViolations(val: unknown): string[] {";

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
  const relocated = shortCircuited.replace(
    /from "\.\.?\/([A-Za-z0-9._\-/]+)"/g,
    (_m, rest: string) => `from "${join(GATES_DIR, rest)}"`,
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

  test("fixture with one failing test: the real tests-pass check goes red", () => {
    plantProject({ failing: true });
    const measured = measureFixture();
    expect(measured.verdict).toBe("FAIL");
    plantState({ tests: measured.verdict });

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured suite failure did not fail tests-pass:\n${r.output}`).toBe(true);
    // Red for the stated reason. A gate suite that failed to load is also red,
    // and the two are indistinguishable from the count alone.
    expect(r.output, "red, but not from the suite reading").toContain("tests: FAIL — expected PASS");
  }, 180000);

  test("fixture with the failing test repaired: the same check is green", () => {
    // Without this control, a check that refuses everything satisfies the case
    // above.
    plantProject({ failing: false });
    const measured = measureFixture();
    expect(measured.verdict).toBe("PASS");
    plantState({ tests: measured.verdict });

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tests-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a measured suite PASS failed tests-pass:\n${r.output}`).toBe(false);
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
): Promise<{ broken: string[]; verdict: "PASS" | "FAIL" }> {
  const results = await prevalidateEvidence(acs as any, PROJECT);
  const broken = results.filter(r => r.status === "broken").map(r => r.id);
  return { broken, verdict: broken.length > 0 ? "FAIL" : "PASS" };
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
      reading: { verdict: measured.verdict, broken: measured.broken },
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
      reading: { verdict: measured.verdict, broken: measured.broken },
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
      reading: { verdict: "UNMEASURED", broken: [] },
    });

    const r = runCheck(GATE_SUITE, "evidence-prevalidation");
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `an UNMEASURED pre-validation did not fail the gate:\n${r.output}`).toBe(true);
    expect(r.output, "red, but not from the unmeasured reading").toContain(
      "An unmeasured pre-validation is not a clean one",
    );
  }, 180000);
});

describe("#235 mutant: removing the binding makes the gate ship the broken commands", () => {
  test("the mutant ships the exact fixture the real source refuses", async () => {
    plantProject({ failing: false });
    const measured = await measurePrevalidation([WORKING_AC, BROKEN_AC]);
    expect(measured.verdict).toBe("FAIL");
    plantPrevalidationState({
      acs: [WORKING_AC, BROKEN_AC],
      reading: { verdict: measured.verdict, broken: measured.broken },
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
      reading: { verdict: "FAIL", broken: ["AC-2"] },
    });
    const path = writeMutant(PREVALIDATION_SIGNATURE);
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(tmpdir()), `the mutant was written inside the repo: ${path}`).toBe(true);
    expect(readFileSync(GATE_SUITE, "utf-8")).not.toContain("MUTANT: suite-to-verdict binding removed");
  });
});
