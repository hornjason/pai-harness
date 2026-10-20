/**
 * #211 SC-F — `bun scripts/test-clean-env.ts` could not run at all.
 *
 * AGENTS.md's command table lists it as "Test as CI sees it". On this tree it
 * exits 2 without running a single test:
 *
 *     [clean-env] refused: could not read the "test" job's checkout —
 *                 job "test" has no actions/checkout step
 *     [clean-env] the CI checkout is read from the workflow, not assumed.
 *
 * The refusal is correct about what it looked at. `ci.yml` shards four ways:
 * `test-shard` has the `actions/checkout@v4` step and runs
 * `bun test --shard=${{ matrix.shard }}/4`, and `test` is an aggregate with
 * `needs: test-shard` that runs no tests and checks nothing out. A reader
 * that only knows `test` reports "no actions/checkout step" for a workflow
 * that checks out four times.
 *
 * ## The binding already existed. The script did not use it.
 *
 * #735 added `suiteJobName` to `lib/ci-checkout.ts` for exactly this, and its
 * docblock says so — *"One exported binding, because the same question is
 * asked by `scripts/contract-parity.ts`. Two readers that agree today are one
 * decider too many."*
 *
 * `lib/test-command-positions.ts:201` uses it. `test/test-clean-env.test.ts:78`
 * uses it. **`scripts/test-clean-env.ts` did not** — it carried
 * `const CI_JOB = "test"`.
 *
 * So the test file named after the script asked the question the right way
 * while the script asked it the wrong way, and the test was green over a
 * command that refuses on the first line. That is the fourth shape with the
 * two deciders in different files, and the reason this case drives the REAL
 * script rather than calling `suiteJobName` again: a case that calls the
 * binding is testing the binding, which was never broken.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Change the constant to `"test-shard"`.** One word, the command runs, and
 * it is wrong in both directions: a consumer generated with `ci.shards` unset
 * has no `test-shard` job at all, so the script would then refuse on every
 * unsharded tree — the exact failure, mirrored. `suiteJobName` answers for
 * both layouts because it reads the workflow.
 *
 * AC-3 is the case that survives it: it drives the script against a
 * single-job workflow and requires the checkout to resolve there too.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

import { parseCheckoutModel, suiteJobName } from "../lib/ci-checkout";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO = join(import.meta.dir, "..");
const CI_YAML = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf-8");

/** The sharded shape, reduced to what `suiteJobName` and the parser read. */
const SHARDED = `name: CI
on:
  push:
jobs:
  test-shard:
    runs-on: "ubuntu-latest"
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - run: bun test --shard=\${{ matrix.shard }}/4
  test:
    runs-on: "ubuntu-latest"
    needs: test-shard
    steps:
      - name: Every shard passed
        run: echo ok
`;

/** The same workflow before sharding: one job, named `test`, with a checkout. */
const SINGLE = `name: CI
on:
  push:
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - uses: actions/checkout@v4
      - run: bun test
`;

describe("#211 SC-F AC-1: the script resolves the job that actually checks out", () => {
  test("the live ci.yml resolves to a job with a checkout", () => {
    // Establish the subject before asserting about it: a workflow that failed
    // to load is an empty string, and an empty string has no jobs.
    expect(CI_YAML.length).toBeGreaterThan(200);
    expect(CI_YAML).toContain("actions/checkout");

    const job = suiteJobName(CI_YAML);
    const { model, why } = parseCheckoutModel(CI_YAML, job);
    expect(model, `the suite job "${job}" has no readable checkout — ${why}`).not.toBeNull();
    expect(model!.jobName).toBe(job);
  });

  test("the hardcoded name this used to carry does NOT resolve", () => {
    // The control. Without it, the case above is satisfied on a tree where
    // `test` happens to be the right answer, and would have passed on the
    // broken script too.
    const { model, why } = parseCheckoutModel(CI_YAML, "test");
    expect(model, "ci.yml is not sharded, so this case is no longer witnessing anything").toBeNull();
    expect(why).toContain("no actions/checkout step");
  });
});

describe("#211 SC-F AC-2: the real script no longer refuses before running", () => {
  test("`bun scripts/test-clean-env.ts <one file>` runs the file instead of exiting 2", () => {
    // Spawned, not imported. The defect was a module-scope constant in the
    // script, and an in-process call to the library resolves it correctly —
    // which is exactly why the existing suite was green over a broken
    // command. Targeted at one tiny test file so this does not run the whole
    // suite inside the suite.
    let output = "";
    let code = 0;
    try {
      output = execSync(
        `bun scripts/test-clean-env.ts --no-ci-checkout test/behavioral-cache.test.ts 2>&1`,
        { cwd: REPO, encoding: "utf-8", timeout: 180_000 },
      );
    } catch (e: any) {
      output = (e.stdout || "") + (e.stderr || "");
      code = e.status ?? 1;
    }
    // `--no-ci-checkout` skips the clone, so this case is about the refusal
    // path only when the checkout IS modelled; what it proves here is that
    // the script reaches the runner at all.
    expect(output, `the script refused instead of running:\n${output}`).not.toContain("has no actions/checkout step");
    expect(code, `exit ${code}, output:\n${output}`).toBe(0);
  }, 240_000);

  test("with the CI checkout modelled, the script resolves it rather than refusing", () => {
    // The case that was failing. `CLEAN_ENV_REFUSE_EXIT` is 2 and the refusal
    // is the first thing the script does, so a red here is unambiguous.
    let output = "";
    let code = 0;
    try {
      output = execSync(
        `bun scripts/test-clean-env.ts test/behavioral-cache.test.ts 2>&1`,
        { cwd: REPO, encoding: "utf-8", timeout: 300_000 },
      );
    } catch (e: any) {
      output = (e.stdout || "") + (e.stderr || "");
      code = e.status ?? 1;
    }
    expect(output, `the CI-shaped checkout still refuses:\n${output}`).not.toContain("has no actions/checkout step");
    expect(code, `exit ${code}, output:\n${output}`).toBe(0);
  }, 360_000);
});

describe("#211 SC-F AC-3: both layouts resolve, which the cheapest fix does not give", () => {
  test("a sharded workflow resolves to test-shard", () => {
    expect(suiteJobName(SHARDED)).toBe("test-shard");
    expect(parseCheckoutModel(SHARDED, suiteJobName(SHARDED)).model).not.toBeNull();
  });

  test("an UNSHARDED workflow still resolves to test", () => {
    // The case the cheapest wrong fix fails. Hardcoding "test-shard" makes
    // the live tree work and breaks every consumer generated without shards —
    // the same defect, mirrored, and invisible from this repo.
    expect(suiteJobName(SINGLE)).toBe("test");
    expect(parseCheckoutModel(SINGLE, suiteJobName(SINGLE)).model).not.toBeNull();
  });

  test("the script names no job literal of its own", () => {
    // One binding. A literal `"test"` or `"test-shard"` beside the call would
    // be a second decider that agrees today, and no behavioural case could
    // tell which one the run used.
    const raw = readFileSync(join(REPO, "scripts", "test-clean-env.ts"), "utf-8");
    expect(raw).toContain("suiteJobName");

    // Search the CODE, not the document. The first version of this case
    // scanned the raw source and went red on the comment explaining the fix,
    // which quotes the constant it removed — a document naming the thing it
    // forbids, which is the trap `.claude/rules/checks-must-be-able-to-fail.md`
    // records and the second instance of it in this session.
    const code = stripJsComments(raw);
    expect(code.length, "the stripper returned nothing — an empty string hardcodes no job either").toBeGreaterThan(400);
    expect(code).toContain("suiteJobName");

    const literals = code.match(/CI_JOB\s*=\s*"(test|test-shard)"/g) || [];
    expect(literals, `the script still hardcodes a job name: ${literals.join(", ")}`).toEqual([]);
  });
});
