import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/**
 * #239 — proving the KEY is what the sibling-isolation test detects.
 *
 * `test/test-suite-lock.test.ts` asserts that two sub-agents sharing one
 * session id spend separate rate budgets. On its own that assertion is exactly
 * the shape `.claude/rules/checks-must-be-able-to-fail.md` warns about: it
 * passes, and nothing in it demonstrates that it could ever have failed. A
 * later refactor could key the counter back on the session and the only
 * evidence would be a test nobody saw go red.
 *
 * So the binding — `budgetKey`, the single site where a session id and a worker
 * id become one filename — is short-circuited in a MUTANT COPY of
 * lib/test-suite-lock.ts back to the pre-#239 behaviour (`return sessionId`),
 * and the same scenario is run against both copies in the same way. Real
 * green, mutant red, one input, one process each.
 *
 * Three properties make it a real proof rather than a decorative one, and all
 * three are asserted here instead of left as conventions:
 *
 *  - The signature appears EXACTLY ONCE in the source. Two keying sites would
 *    leave one of them intact and the mutant would stay green for a reason
 *    that has nothing to do with the mutation.
 *  - The mutant has no relative imports left. It runs from a temp directory, so
 *    a surviving `../x` would kill it on module resolution — a non-zero exit
 *    that reads as the mutation being rejected on its merits.
 *  - Both halves observe the SAME positive control: worker A's third run is
 *    refused in both copies. Without that, a mutant that failed to load at all
 *    would be indistinguishable from a mutant that was caught.
 *
 * SC-623.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const LOCK_MODULE = join(REPO_ROOT, "lib", "test-suite-lock.ts");
const lockSource = readFileSync(LOCK_MODULE, "utf-8");

/**
 * The one line the mutation rewrites. Written out rather than regex-built, so
 * renaming `budgetKey` aborts this file instead of quietly mutating nothing.
 */
const BUDGET_KEY_SIGNATURE =
  "export function budgetKey(sessionId: string, workerId?: string): string {";

/** The pre-#239 key, restored: the worker id is read and then ignored. */
const MUTATION = `${BUDGET_KEY_SIGNATURE}\n  return sessionId; // MUTANT: counter key reverted to the bare session id`;

let SCRATCH = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "suite-lock-key-"));
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

export function buildMutantSource(src: string, signature = BUDGET_KEY_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the key signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second keying site exists and reverting one would leave the other.`,
    );
  }
  const mutated = src.replace(signature, MUTATION);

  // The mutant runs from a temp directory, so every relative specifier has to
  // become absolute first. test-suite-lock.ts imports only node builtins today;
  // this is here so that the day it does not, the mutant fails loudly instead
  // of dying on module resolution and reading as a refusal.
  const relocated = mutated.replace(
    /from "\.\.?\/([A-Za-z0-9._\-/]+)"/g,
    (_m, rest: string) => `from "${join(REPO_ROOT, "lib", rest)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that non-zero exit reads as a verdict`,
    );
  }
  return relocated;
}

/**
 * The scenario, run in a child process against whichever copy of the module it
 * is pointed at. Written once and shared, because two copies of it is how the
 * real half and the mutant half start testing different things.
 */
function driverSource(modulePath: string): string {
  return `
import { evaluateFullSuiteRequest, releaseFullSuiteSlot } from ${JSON.stringify(modulePath)};

const lockDir = process.argv[2];
const t0 = 1700000000000;
const MINUTE = 60000;
const A = "/wt/a";
const B = "/wt/b";
const at = (ms, workerId) => ({ lockDir, now: t0 + ms, suitesRunning: () => true, workerId });
const out = {};

out.a1 = evaluateFullSuiteRequest("parent", "bun test", at(0, A)).allow;
releaseFullSuiteSlot("parent", { lockDir, workerId: A });
out.a2 = evaluateFullSuiteRequest("parent", "bun test", at(MINUTE, A)).allow;
releaseFullSuiteSlot("parent", { lockDir, workerId: A });

const a3 = evaluateFullSuiteRequest("parent", "bun test", at(2 * MINUTE, A));
out.a3 = a3.allow;
out.a3reason = a3.reason || "";

const b1 = evaluateFullSuiteRequest("parent", "bun test", at(2 * MINUTE, B));
out.b1 = b1.allow;
out.b1reason = b1.reason || "";

process.stdout.write(JSON.stringify(out));
`;
}

interface Scenario {
  a1: boolean;
  a2: boolean;
  a3: boolean;
  a3reason: string;
  b1: boolean;
  b1reason: string;
}

/** Run the scenario against one module copy, in its own empty lock directory. */
function runScenario(name: string, modulePath: string): Scenario {
  const dir = join(SCRATCH, name);
  const lockDir = join(dir, "lock");
  mkdirSync(lockDir, { recursive: true });
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, driverSource(modulePath));

  const r = spawnSync("bun", [driver, lockDir], {
    cwd: dirname(driver),
    encoding: "utf-8",
    timeout: 60_000,
  });
  const output = `${r.stdout ?? ""}`;
  if (r.status !== 0 || output.trim() === "") {
    throw new Error(
      `the ${name} scenario did not run (exit ${r.status}): ${r.stderr ?? ""}\n${output}`,
    );
  }
  return JSON.parse(output) as Scenario;
}

describe("AC-5: the counter key is what the sibling-isolation case detects (#239)", () => {
  test("the key signature appears exactly once in lib/test-suite-lock.ts", () => {
    expect(lockSource.split(BUDGET_KEY_SIGNATURE).length - 1).toBe(1);
  });

  test("the real module isolates sibling workers; the mutant does not", () => {
    const mutantPath = join(SCRATCH, "mutant", "test-suite-lock.ts");
    mkdirSync(dirname(mutantPath), { recursive: true });
    writeFileSync(mutantPath, buildMutantSource(lockSource));

    const real = runScenario("real", LOCK_MODULE);
    const mutant = runScenario("mutant", mutantPath);

    // Positive control, observed in BOTH copies: the scenario really ran, and
    // the budget really is spent by worker A's two runs. A mutant that failed
    // to load, or a scenario that silently did nothing, fails here first.
    for (const [name, s] of [["real", real], ["mutant", mutant]] as const) {
      expect(s.a1, `${name}: worker A's first run`).toBe(true);
      expect(s.a2, `${name}: worker A's second run`).toBe(true);
      expect(s.a3, `${name}: worker A's third run`).toBe(false);
      expect(s.a3reason, `${name}: worker A's refusal`).toContain("DIR-L29");
    }

    // The one difference the mutation makes.
    expect(real.b1, "the real module gives the sibling its own budget").toBe(true);
    expect(mutant.b1, "the mutant charges the sibling for worker A's runs").toBe(false);
    expect(mutant.b1reason).toContain("DIR-L29");
  }, 120_000);

  test("a renamed binding aborts the mutation rather than mutating nothing", () => {
    // The failure mode this whole file exists to rule out: a harness that
    // silently no-ops when its target moves, and so always reports success.
    expect(() => buildMutantSource(lockSource, "export function somethingElse(): string {")).toThrow(
      /appears 0 times/,
    );
    expect(() =>
      buildMutantSource(`${lockSource}\n${BUDGET_KEY_SIGNATURE}\n}\n`),
    ).toThrow(/appears 2 times/);
  });

  test("a surviving relative import aborts the mutation, rather than dying as a verdict", () => {
    const withRelative = `import { x } from "./helper";\n${lockSource}`;
    // `./helper` IS rewritten; `../../outside/..` with a character the rewriter
    // does not admit is the case that must abort.
    expect(() => buildMutantSource(`import { y } from "../lib/$weird";\n${lockSource}`)).toThrow(
      /relative import/,
    );
    expect(buildMutantSource(withRelative)).toContain(join(REPO_ROOT, "lib", "helper"));
  });
});
