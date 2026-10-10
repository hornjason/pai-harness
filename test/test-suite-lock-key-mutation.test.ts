import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * #239 — proving the counter key is what the sibling case detects.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: before you trust a check,
 * break the thing it guards and watch it go red. The sibling-isolation test in
 * test/test-suite-lock.test.ts asserts that two workers sharing one session id
 * get their own rate budgets — but a test like that can pass for reasons that
 * have nothing to do with the key. If `workerId` ever stopped reaching
 * `counterPath`, the two workers would share a counter again and the only
 * thing standing between the harness and another 22-minute sleep would be a
 * green test nobody could tell from a vacuous one.
 *
 * So the binding is mutated: a copy of lib/test-suite-lock.ts with
 * `counterKey` short-circuited to the bare session id — the pre-#239 code,
 * restored verbatim — is run against the same scenario as the real module.
 * Real refuses the sibling nothing, mutant refuses it a run. One input, both
 * halves asserted.
 *
 * Two properties make the harness real rather than decorative, and both are
 * asserted here rather than left as conventions:
 *
 *  - the signature appears EXACTLY ONCE, so a rename aborts this file instead
 *    of quietly mutating nothing, and a second budget-key site cannot survive
 *    the mutation and go red for an unrelated reason;
 *  - the module has NO relative imports, so the mutant runs from a temp
 *    directory. One surviving `../lib/x` would kill the mutant on module
 *    resolution, and that non-zero exit reads as a refusal it never made.
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * this file + test/test-suite-lock.test.ts (121 tests):
 *
 *   | Mutation                                          | Red |
 *   |---------------------------------------------------|-----|
 *   | `counterKey` short-circuited to `return sessionId` | 5   |
 *   | `counterKey` renamed                               | both files abort |
 *   | the guard hook stops passing `{ workerId }`        | 2   |
 *   | the release hook stops passing `{ workerId }`      | 2   |
 *   | a refused run appends its attempt to the window    | 2   |
 *
 * None is left in the tree; all were run and reverted. The rename does not
 * produce a count because it is meant not to: the import in
 * test/test-suite-lock.test.ts fails to resolve and the mutant-building cases
 * here throw "the binding signature appears 0 times", so both files abort
 * loudly instead of passing quietly against a binding that moved.
 */

// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Success Criteria — SC-625, SC-627

const REPO_ROOT = join(import.meta.dir, "..");
const LOCK_MODULE = join(REPO_ROOT, "lib", "test-suite-lock.ts");

/**
 * The one line the mutation removes. Written out rather than regex-built, so
 * that changing the signature in lib/test-suite-lock.ts aborts this file.
 */
const BINDING_SIGNATURE =
  "export function counterKey(sessionId: string, options: LockOptions = {}): string {";

let SCRATCH = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "lock-key-mutation-"));
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/**
 * Short-circuit the budget key back to the session id. Everything else in the
 * module — the slots, the window, the refusal text — is left exactly as it is,
 * so any difference the scenario sees is this one line.
 */
export function buildMutantSource(src: string, signature = BINDING_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second copy of it exists and removing one would leave the other re-keying.`,
    );
  }

  const leftover = src.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) in lib/test-suite-lock.ts; ` +
        `the mutant runs from a temp directory and would die on module resolution, which reads as a refusal`,
    );
  }

  return src.replace(
    signature,
    `${signature}\n  return sessionId; // MUTANT: #239 counter key reverted to the bare session id`,
  );
}

/**
 * One parent session, two sibling workers, run against whichever copy of the
 * module it is pointed at.
 *
 * w1 spends its two runs and is refused a third; w2 has spent nothing. The
 * question the scenario answers is whether w2 is allowed to run.
 */
function scenarioSource(modulePath: string): string {
  return `
import { evaluateFullSuiteRequest, releaseFullSuiteSlot } from ${JSON.stringify(modulePath)};

const lockDir = process.argv[2];
const t0 = 1_700_000_000_000;
// Liveness pinned ON: these are budget verdicts, and a reclaimed slot would
// let the scenario answer a concurrency question instead.
// The rate is pinned rather than inherited. The scenario's whole shape is
// "w1 spends its budget and is refused the next one", and at the production
// default that sentence would need a different number of runs — which would
// make this case quietly stop being about the counter KEY, the one thing it
// exists to detect.
const o = (worker, ms) => ({
  lockDir,
  workerId: worker,
  maxRunsPerSession: 2,
  now: t0 + ms,
  suitesRunning: () => true,
});
const run = (worker, ms) => {
  const verdict = evaluateFullSuiteRequest("parent", "bun test", o(worker, ms));
  if (verdict.allow) releaseFullSuiteSlot("parent", o(worker, ms));
  return verdict.allow;
};

process.stdout.write(JSON.stringify({
  first: run("w1", 0),
  second: run("w1", 60_000),
  third: run("w1", 120_000),
  sibling: run("w2", 120_000),
}) + "\\n");
`;
}

interface Outcome {
  ran: boolean;
  first?: boolean;
  second?: boolean;
  third?: boolean;
  sibling?: boolean;
  output: string;
}

/** Run the scenario against one module copy, in its own lock directory. */
function runScenario(modulePath: string, name: string): Outcome {
  const scenario = join(SCRATCH, `${name}-scenario.ts`);
  const lockDir = mkdtempSync(join(SCRATCH, `${name}-locks-`));
  writeFileSync(scenario, scenarioSource(modulePath));

  const r = spawnSync("bun", [scenario, lockDir], { encoding: "utf-8", timeout: 60_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  try {
    // `ran` is not a formality: a mutant that failed to resolve its imports
    // prints nothing and exits non-zero, which is indistinguishable from a
    // scenario whose every answer was false.
    const parsed = JSON.parse((r.stdout ?? "").trim());
    return { ran: r.status === 0, ...parsed, output };
  } catch {
    return { ran: false, output };
  }
}

describe("AC-5: the counter key is what the sibling case detects (#239)", () => {
  test("the real module gives sibling workers their own budgets", () => {
    const real = runScenario(LOCK_MODULE, "real");
    expect(real.ran, `the real scenario did not run:\n${real.output}`).toBe(true);
    expect(real.first).toBe(true);
    expect(real.second).toBe(true);
    // w1's own budget still binds — the fix re-keys DIR-L29, it does not
    // delete it.
    expect(real.third).toBe(false);
    // ...and the sibling, which has run nothing, is unaffected.
    expect(real.sibling).toBe(true);
  });

  test("the mutant — counter key reverted to the session id — refuses the sibling", () => {
    const mutantPath = join(SCRATCH, "test-suite-lock.mutant.ts");
    writeFileSync(mutantPath, buildMutantSource(readFileSync(LOCK_MODULE, "utf-8")));

    const mutant = runScenario(mutantPath, "mutant");
    expect(mutant.ran, `the mutant did not run:\n${mutant.output}`).toBe(true);
    // Everything before the sibling is identical, which is what makes the one
    // difference attributable to the key rather than to the mutant being
    // broken in some other way.
    expect(mutant.first).toBe(true);
    expect(mutant.second).toBe(true);
    expect(mutant.third).toBe(false);
    // The defect, restored: w2 pays for w1's runs. This is sub-agent 235002
    // of run wf_18abb197-f03, asleep for 22 minutes.
    expect(mutant.sibling).toBe(false);
  });

  test("the two differ on exactly the sibling, for the same input", () => {
    const mutantPath = join(SCRATCH, "test-suite-lock.mutant.ts");
    writeFileSync(mutantPath, buildMutantSource(readFileSync(LOCK_MODULE, "utf-8")));

    const real = runScenario(LOCK_MODULE, "real");
    const mutant = runScenario(mutantPath, "mutant");
    expect(real.ran && mutant.ran).toBe(true);
    expect([real.first, real.second, real.third]).toEqual([
      mutant.first,
      mutant.second,
      mutant.third,
    ]);
    expect(real.sibling).not.toBe(mutant.sibling);
  });

  test("a renamed binding aborts the harness instead of mutating nothing", () => {
    // The failure mode this whole file exists to rule out: a mutation harness
    // that silently no-ops when its target moves reports green forever.
    const src = readFileSync(LOCK_MODULE, "utf-8");
    expect(() => buildMutantSource(src, "export function noSuchBinding(): string {")).toThrow(
      /appears 0 times/,
    );
  });

  test("the binding is a single site, so no second key path survives it", () => {
    const src = readFileSync(LOCK_MODULE, "utf-8");
    expect(src.split(BINDING_SIGNATURE).length - 1).toBe(1);
    // And one place builds a counter filename, so the key cannot be bypassed
    // by a second construction the mutation never touches. Matched on the
    // `join` form, not the bare prefix: prose mentions the prefix too, and a
    // detector that cannot tell a comment from code is the shape this
    // repository keeps shipping.
    expect(src.split("join(lockDir, `rungate-test-suite-count-").length - 1).toBe(1);
  });
});
