import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * #314 defect 2 — the gate checks measured `projectRoot`, which is where
 * configuration is READ, not the tree the change lives in.
 *
 * On run `wf_5cdce852-1e2` the ship gate ran in the main checkout. `tsc-pass`
 * typechecked main — green by construction, because main is already merged —
 * while the branch it was gating carried two real type errors that reached CI.
 * `code-committed` ran `git status` on a checkout the work had never been in,
 * and `code-pushed` asked whether main was ahead of its upstream. All three
 * passed, and none of them had looked at the change.
 *
 * A check that reads the right field is not the claim. The claim is that the
 * two trees can DISAGREE and the check follows the one under test, so every
 * case here plants two separate compilable projects and makes them disagree:
 *
 *   - config tree clean, tree-under-test broken  → must go RED
 *   - config tree broken, tree-under-test clean  → must go GREEN
 *
 * One direction alone proves nothing. The red case is satisfied by a check
 * that fails on everything; the green case is satisfied by the original bug.
 * Only the pair pins the check to the correct tree
 * (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * The checks are EXECUTED — `bun test gates/workflow.test.ts -t <name>`
 * against a planted work dir — not asserted on source text. A source-text
 * assertion here would say "the file mentions treeUnderTest", which is true of
 * a file that mentions it in a comment.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");

/**
 * Scratch root, inside the repo rather than os.tmpdir(), for the reason
 * test/gate-vacuous-checks.test.ts gives: from an unrelated temp directory
 * `bunx tsc` may fail to resolve a compiler at all, and that exits non-zero,
 * which reads as "the type error was caught" no matter what the files contain.
 */
/**
 * Created in `beforeAll`, not at module scope (#437).
 *
 * At module scope the directory appears when bun IMPORTS this file — before
 * any lifecycle hook can run, and before any hook is guaranteed to run at
 * all. A suite that is interrupted, killed, or that throws during collection
 * leaves it behind empty. 34 of those had accumulated in the repo root; all
 * but one were 0 bytes, which is the fingerprint of exactly that.
 */
let SCRATCH = "";

/**
 * The mutant lives in gates/ so its relative imports (`./schema` and friends)
 * resolve unchanged, and it deliberately does NOT end in `.test.ts` so the
 * default `bun test` glob cannot pick it up if a run is interrupted before
 * cleanup. It is spawned by explicit path, which bun accepts.
 */
const MUTANT = join(REPO_ROOT, "gates", ".tree-under-test-mutant.ts");

let WORK = "";
let CONFIG_TREE = "";
let BRANCH_TREE = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(REPO_ROOT, ".tree-under-test-scratch-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  WORK = join(SCRATCH, "work");
  CONFIG_TREE = join(SCRATCH, "main-checkout");
  BRANCH_TREE = join(SCRATCH, "worktree");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(CONFIG_TREE, ".claude"), { recursive: true });
  mkdirSync(join(BRANCH_TREE, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(MUTANT, { force: true });
});

/** A project tsc will actually compile, clean or with one real type error. */
function plantProject(root: string, opts: { typeError: boolean }): void {
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "src.ts"),
    opts.typeError
      ? "export const n: number = 'not a number';\n"
      : "export const n: number = 1;\n",
  );
  writeFileSync(
    join(root, ".claude", "typecheck-baseline.json"),
    JSON.stringify({ errors: 0, updated: "2026-10-11" }, null, 2),
  );
}

/**
 * The smallest state the gate suite reads fields out of. `treeUnderTest` is
 * passed explicitly — including as `undefined`, which is the UNMEASURED case —
 * so no test here can accidentally rely on a default.
 */
function plantState(treeUnderTest: string | undefined): void {
  const state: Record<string, unknown> = {
    schemaVersion: 2,
    issue: 314,
    slug: "pai-harness-314",
    phase: "VERIFY",
    projectRoot: CONFIG_TREE,
    issueGoal: "gate checks measure the tree under test, not the config root",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the tsc-pass check runs the compiler in the tree under test",
        threshold: { op: "==", value: 0, unit: "errors above baseline" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
  };
  if (treeUnderTest !== undefined) state.treeUnderTest = treeUnderTest;
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

/**
 * Run one named check out of a gate suite against the planted work dir.
 *
 * `ran` is not a formality. A `-t` filter that matches nothing leaves bun
 * reporting zero failures, which is indistinguishable from the check passing —
 * and is also what a mutant that failed to resolve its imports looks like.
 * Every assertion below goes through `ran` first.
 */
function runCheck(name: string, suite = GATE_SUITE): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", suite, "-t", name], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 240000,
    env: { ...process.env, TEST_WORK_DIR: WORK },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const passed = count("pass");
  const failed = count("fail");
  // Exactly one, not at least one: a filter that widened to two checks would
  // let a green one mask a red one.
  return { ran: passed + failed === 1, red: failed === 1, output };
}

/**
 * The pre-#314 gate suite, built from the real one so it cannot drift: the
 * refusal is short-circuited away and `treeRoot()` points back at
 * `projectRoot`. Both halves are needed — removing only the refusal leaves the
 * checks reading the right tree, and redirecting only the root leaves them
 * refusing before they get there.
 *
 * Each binding is required to appear exactly once. A second copy of either
 * would survive the mutation and the mutant would then go red for a reason
 * that has nothing to do with the mutation working, which is the vacuous proof
 * this file exists to rule out.
 */
function buildMutant(): void {
  const source = readFileSync(GATE_SUITE, "utf-8");

  const REFUSAL_HEAD = "export function treeUnderTestViolations(tree: unknown, checkName: string): string[] {";
  const ROOT_BODY = '  const t = sf("treeUnderTest");\n  return typeof t === "string" && t.trim() !== "" ? t : null;';

  for (const [label, needle] of [["the refusal", REFUSAL_HEAD], ["the root resolver", ROOT_BODY]] as const) {
    const hits = source.split(needle).length - 1;
    if (hits !== 1) {
      throw new Error(`could not build the mutant: ${label} appears ${hits} times, expected exactly 1`);
    }
  }

  const mutated = source
    .replace(REFUSAL_HEAD, `${REFUSAL_HEAD}\n  if (true) return []; // MUTANT (#314): the refusal removed`)
    .replace(ROOT_BODY, '  const t = sf("projectRoot"); // MUTANT (#314): back to the config root\n  return typeof t === "string" && t.trim() !== "" ? t : null;');

  writeFileSync(MUTANT, mutated);
}

describe("#314: gate checks measure the tree under test, not the config root", () => {
  test(
    "tsc-pass fails when the tree under test is broken and the config root is clean",
    () => {
      // THE PLANTED DEFECT, in the shape it actually shipped: the branch does
      // not compile, main does. Before #314 the check ran in main and passed.
      plantProject(CONFIG_TREE, { typeError: false });
      plantProject(BRANCH_TREE, { typeError: true });
      plantState(BRANCH_TREE);

      const r = runCheck("tsc-pass");
      expect(r.ran, `tsc-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
      expect(
        r.red,
        `tsc-pass passed over a tree under test carrying a type error. It is ` +
          `measuring the config root, which is clean by construction.\n${r.output}`,
      ).toBe(true);
    },
    240000,
  );

  test(
    "tsc-pass passes when the tree under test is clean and the config root is broken",
    () => {
      // The other direction, and the one that proves the check is not simply
      // failing on everything. A check still reading projectRoot goes red here
      // — so this case and the one above cannot both be satisfied by the bug,
      // and cannot both be satisfied by a check that refuses unconditionally.
      plantProject(CONFIG_TREE, { typeError: true });
      plantProject(BRANCH_TREE, { typeError: false });
      plantState(BRANCH_TREE);

      const r = runCheck("tsc-pass");
      expect(r.ran, `tsc-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
      expect(
        r.red,
        `tsc-pass failed over a clean tree under test. It is measuring the ` +
          `config root, which is the checkout this run is not shipping.\n${r.output}`,
      ).toBe(false);
    },
    240000,
  );

  test(
    "tsc-pass refuses as UNMEASURED when the state names no tree under test",
    () => {
      // Absent is a refusal, not a fallback. The config root is planted clean
      // precisely so that a silent fallback to it would go GREEN — which is
      // what the gate did for every run before #314.
      plantProject(CONFIG_TREE, { typeError: false });
      plantProject(BRANCH_TREE, { typeError: true });
      plantState(undefined);

      const r = runCheck("tsc-pass");
      expect(r.ran, `tsc-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
      expect(
        r.red,
        `an absent treeUnderTest was treated as a pass rather than as an ` +
          `unmeasured run\n${r.output}`,
      ).toBe(true);
      // A suite that failed to load is red too, so the refusal has to say why.
      expect(r.output).toContain("UNMEASURED");
    },
    240000,
  );

  test(
    "the mutant — treeRoot pointed back at projectRoot — does NOT catch the broken tree",
    () => {
      // The mutation, performed and observed rather than described. Without
      // this, the red case above is satisfied by any check that happens to be
      // failing, and nothing establishes that the redirect is what caught it.
      plantProject(CONFIG_TREE, { typeError: false });
      plantProject(BRANCH_TREE, { typeError: true });
      plantState(BRANCH_TREE);

      const real = runCheck("tsc-pass");
      expect(real.ran, `the real suite never ran:\n${real.output}`).toBe(true);
      expect(real.red, `the real suite did not catch the broken tree:\n${real.output}`).toBe(true);

      buildMutant();
      const mutant = runCheck("tsc-pass", MUTANT);
      expect(mutant.ran, `the mutant never ran — it likely failed to load:\n${mutant.output}`).toBe(true);
      expect(
        mutant.red,
        `the pre-#314 suite caught the broken tree too, so the redirect to ` +
          `treeUnderTest is not what makes the real suite red and this proof ` +
          `is vacuous\n${mutant.output}`,
      ).toBe(false);
    },
    240000,
  );

  test("every executing gate check reads treeUnderTest, and only the config read reads projectRoot", () => {
    // The scope half. The four cases above execute one check; this one is how
    // the other seven are held to the same rule, and it is the assertion that
    // notices a NEW check added against the wrong field.
    const gate = readFileSync(GATE_SUITE, "utf-8");
    const refusals = gate.match(/treeUnderTestViolations\(sf\("treeUnderTest"\)/g) || [];
    expect(refusals.length, "a migrated check lost its treeUnderTest refusal").toBe(10);

    // Exactly two sites may still read projectRoot, and neither measures a
    // tree with it:
    //   - `loadProjectHarness`, because config is READ from the project root
    //     by definition;
    //   - the UI-change path stripper, which removes BOTH roots from AC text
    //     so a directory name cannot match the service-name regex.
    // Any third reader is a check measuring the main checkout, which is green
    // by construction — the #314 defect reintroduced.
    const projectRootReads = gate.match(/sf\("projectRoot"\)/g) || [];
    expect(
      projectRootReads.length,
      "a third site is reading projectRoot — the only two permitted are the " +
        "config loader and the UI path stripper",
    ).toBe(2);
  });
});
