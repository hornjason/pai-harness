/**
 * #799 — the suite collected 56 fewer tests on its first run than on every
 * run after it, and CI only ever measures the first.
 *
 * Measured, not reconstructed. The #323 series instrument, run `39412289321`
 * on `main` at `cf21bf1c` — ten consecutive full runs on one tree, all
 * `exit 0`, verdict `CONSISTENT`:
 *
 * ```
 * run  1   15194 tests   807 todo   24 skip   43140 expect()
 * run  2   15250 tests   863 todo   23 skip   43063 expect()
 * ...
 * run 10   15250 tests   863 todo   23 skip   43063 expect()
 * ```
 *
 * Runs 2 through 10 are identical in every column. Only the first differs,
 * and it differs in what it COLLECTED — every run reported `0 fail`. The
 * series' own `assertions: VARIED` field is what surfaced it; folding that
 * into the verdict would have made it invisible.
 *
 * ## The chain
 *
 * `test/phase-0.test.ts` calls `runScaffoldConformity(OUTPUT)` at module
 * scope, so the list is built at COLLECTION time — before any `beforeAll`
 * has scaffolded anything. `OUTPUT` was the fixed path
 * `/tmp/rungate-phase0-test`, and `runScaffoldConformity` builds its tests by
 * reading SC checkboxes off disk, declining an empty read by name:
 *
 * ```ts
 * if (specMap.size === 0) {
 *   test.skip("at least one testable spec with SCs exists (no specs found — consumer project)", () => {});
 *   return;
 * }
 * ```
 *
 * So the first run on a machine that has never run the suite reads nothing
 * and emits one skip. The suite then scaffolds the fixture in `beforeAll`.
 * Every later run collects the real spec list instead: 56 criteria under
 * `api-spec.md` and `scaffold-verification-spec.md`, and the "no specs found"
 * skip disappears. That accounts for all four moved numbers.
 *
 * **CI always measures run 1; a local re-run always measures run 2 or
 * later.** A test added inside that `describe` is invisible to CI on the run
 * that introduces it.
 *
 * ## This is #86 again, from outside the working tree
 *
 * `lib/conformity.ts` carries the comment immediately below that refusal:
 * *"run N mutated the input run N+1 collected from, so the generated test
 * list alternated between two shapes — 57 tests, then 99, then 57. Both
 * parities reported 0 fail, so nothing ever surfaced it."* #86 removed the
 * `afterAll` checkbox flip that caused it. A fixed `/tmp` fixture project
 * reintroduces the same property from a place none of the guards can see:
 * `test/scratch-paths-unique.test.ts` refuses a fixed scratch directory
 * **in the repository**, and the #323 series signs each run's tree with
 * `git status --porcelain`, which is also blind to `/tmp` — which is why
 * that series reported one tree across all ten runs and was right to.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Delete the fixture directory at collection time instead of building
 * it.** One line, every run then reads nothing, `specMap.size === 0`, one
 * skip, and the counts agree perfectly at 15,194 — consistent and blind,
 * with 56 conformity checks that never run again.
 *
 * It is the repair the symptom invites, because the symptom is a
 * DISAGREEMENT between two numbers and making both of them small is the
 * shortest way to end a disagreement. So the case below cannot be a count
 * comparison: `AC-1` requires the collection to be NON-EMPTY, which no
 * amount of deleting satisfies.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file alone (3 tests). Counts predicted in
 * `/tmp/799-battery/predictions.md` before the battery ran, and **the
 * baseline row read first.**
 *
 * | Row | Predicted | Measured | Which case | The input on which mutant and original differ |
 * |---|---|---|---|---|
 * | **baseline** — unmutated | read first | **3 pass, 0 fail** | — | — |
 * | Q1 the genuinely pre-#799 `test/phase-0.test.ts`, from `origin/main` | 1 | **1 of 3** | AC-2 | this machine, which already holds `/tmp/rungate-phase0-test` from an earlier run |
 * | Q2 the module-scope scaffold moved back into `beforeAll`, unique path kept | 1 | **1 of 3** | AC-1 | a unique root nothing has populated: the original collects 56 criteria, the mutant collects one `no specs found` skip |
 * | Q3 the unique paths reverted to fixed literals, module-scope scaffold kept | 1 | **1 of 3** | AC-2 | the live tree: the collection is right either way, so only the reintroduction guard fires |
 * | Q4 the cheapest wrong fix — the fixture REMOVED at collection instead of built | 1 | **1 of 3** | AC-1 | the live tree: the collection goes empty and AC-1 refuses it |
 * | Q5 `fixedFixturePaths` short-circuited to `return []` | 1 | **1 of 3** | AC-3 | the control's planted literal. AC-2 is already `[]` and stays green, which is what says AC-2 passes because the FILE holds nothing rather than because the scanner finds nothing |
 *
 * **Q1 is 1 and not 2, and that row is itself the finding.** The true
 * pre-#799 file reds only the source-text guard here, because this machine
 * has run the suite before and the inherited directory supplies the specs.
 * A developer checking out the defect on their own laptop cannot observe it
 * behaviourally at all — which is exactly why it took ten consecutive CI-
 * shaped runs to see, and why Q2 exists as the fresh-machine reconstruction.
 *
 * **Q2 and Q3 are 1 each and they are DIFFERENT cases**, which is the point
 * of having both: a unique root with no scaffold is a directory nothing
 * fills, and a scaffold on a fixed path works today and rots the moment
 * somebody moves the call back into `beforeAll`. Had they redded the same
 * case, uniqueness and the module-scope scaffold would be one decider with
 * one of them dead (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
 * shape).
 *
 * None of the five mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and both files were confirmed
 * byte-identical by sha256 afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSuiteRun } from "../lib/suite-run-reading";

const REPO_ROOT = join(import.meta.dir, "..");
const PHASE_0 = join(REPO_ROOT, "test", "phase-0.test.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The refusal `runScaffoldConformity` emits when it reads no specs. */
export const EMPTY_COLLECTION = "no specs found — consumer project";

/** One of the two specs the fixture carries, named so the case is not satisfied by any spec at all. */
export const FIXTURE_SPEC = "scaffold-verification-spec.md";

/**
 * A fixed absolute scratch path, as a source-text claim about one file.
 *
 * Text matching, and said to be: this is the reintroduction guard, not the
 * behavioural one. `AC-1` is the behavioural one and it runs the file.
 */
export function fixedFixturePaths(source: string): string[] {
  return [...source.matchAll(/"\/tmp\/[A-Za-z0-9._-]+"/g)].map(m => m[0]);
}

describe("#799: phase-0 collects from a fixture it built, not one a previous run left", () => {
  test("AC-1: a run collects the conformity criteria, with nothing pre-existing", () => {
    // Driven, not described. The defect lives in what the file collects at
    // module-evaluation time, which no amount of reading the source can
    // establish — the same call in the same place behaves differently
    // depending on a directory outside the repository.
    const home = mkdtempSync(join(tmpdir(), "rg-799-"));
    scratch.push(home);
    const r = spawnSync("bun", ["test", PHASE_0], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 170_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TMPDIR: home },
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    // The instrument, before any verdict. A run that failed to load reports
    // no failures, which is indistinguishable from a run that passed (#469),
    // so the summary has to be READ rather than assumed.
    const run = readSuiteRun(output);
    expect(run.status, `phase-0 produced no readable summary: ${output.slice(-2000)}`).toBe("MEASURED");
    if (run.status !== "MEASURED") return;
    expect(run.fail, "phase-0 itself is red, so this file is measuring the wrong thing").toBe(0);

    // The property. NOT a count comparison — the cheapest wrong fix makes
    // every run agree at zero, and this is what refuses it.
    expect(output, "the conformity collection was empty, so 56 criteria did not run").not.toContain(EMPTY_COLLECTION);
    expect(output, "the conformity collection did not reach the fixture's own specs").toContain(FIXTURE_SPEC);
  }, 180_000);

  test("AC-2: phase-0 names no fixed scratch path, so a second run cannot inherit one", () => {
    // The reintroduction guard. A unique root is what makes AC-1's premise
    // — "with nothing pre-existing" — true on every machine rather than
    // only on a fresh one, and a fixed literal is how it comes back.
    const source = readFileSync(PHASE_0, "utf-8");
    const fixed = fixedFixturePaths(source);
    expect(
      fixed,
      "test/phase-0.test.ts holds a fixed scratch path. Its conformity list is collected at module " +
        "scope, so a path a PREVIOUS run populated becomes this run's input — 15,194 tests against " +
        "15,250, with CI only ever seeing the first. Build the root with mkdtemp in the same file (#799)",
    ).toEqual([]);
  });

  test("AC-3: the scan can see a fixed path, so an empty result is not an empty scan", () => {
    // The control. `[].toEqual([])` passes over a scanner that matches
    // nothing at all, which is the third shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    expect(fixedFixturePaths('const OUTPUT = "/tmp/rungate-phase0-test";')).toEqual(['"/tmp/rungate-phase0-test"']);
    expect(fixedFixturePaths("const OUTPUT = mkdtempSync(join(tmpdir(), 'rungate-phase0-'));")).toEqual([]);
  });
});
