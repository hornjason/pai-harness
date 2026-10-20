/**
 * #529 — a consumer can add a step INSIDE a rungate-managed CI job.
 *
 * `resolveManagedWrite` preserves whole JOBS a consumer adds and refuses
 * rather than dropping one, so the ownership boundary has always been
 * job-level. That boundary cannot express "seed the tree before the suite":
 * jobs do not share a filesystem, so a consumer-owned job cannot prepare the
 * tree the test job tests. The only remaining move is to edit the managed
 * job, which works until the next re-scaffold — and the repository that filed
 * this carries the scar in its own `ci.yml`, a comment above an edited
 * `- run:` line explaining that a re-scaffold will revert it. A consumer
 * documenting that their own edit will be reverted is the feature request.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Emit the step only when `scripts/ci-setup.sh` exists at GENERATION time.**
 * One `existsSync` in the generator, a tidier file for trees that do not use
 * it, and #529 reads as done.
 *
 * It is wrong because generation happens once and the tree keeps moving. A
 * consumer who adds the script the week after scaffolding gets a `ci.yml`
 * with no extension point in it, their setup never runs, and nothing
 * anywhere says so — a green suite over a tree that was never seeded, which
 * is `.claude/rules/config-access.md`'s *Silent Default Substitution* with a
 * filesystem in the middle.
 *
 * **AC-4 is the case that does not survive it**: two trees differing in
 * exactly one file — the script — whose generated `ci.yml` must be
 * byte-identical. A battery holding only "a tree with the script gets the
 * step" would have certified the generation-time version, which is the fifth
 * shape (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * ## Three traps this file is built around
 *
 * - **The extractor collision.** `testCommandsNamedByCiWorkflow` reads the
 *   suite job's first `- run:` line that is not known setup and calls it the
 *   project's test command. A setup step spelled `- run: bash
 *   scripts/ci-setup.sh` would be read as the test command, and #621's
 *   agreement binding would report it three different ways. AC-3 drives the
 *   REAL extractor over the generated file rather than asserting the shape of
 *   the YAML, because the shape is the proxy and the reading is the property.
 * - **Vacuity (#500).** "The generated file contains a step" is satisfied by
 *   a step that does nothing. AC-5 EXECUTES the step's shell against planted
 *   trees and observes the side effect, so the absent-script case is a
 *   measurement rather than an absence.
 * - **One body patched, the other not (#765).** The generator has a sharded
 *   body and an unsharded one, and #765 records a change landing in the
 *   unsharded body only — 91 tests passed and the repo that needed it was
 *   untouched. Both bodies are generated and asserted here, from the same
 *   fixture differing only in `ci.shards`.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file alone. Counts predicted in
 * `/tmp/529-battery/predictions.md` before the battery ran, and **the
 * baseline row read first.** The predictions were written against a planned
 * twelve cases and the file shipped eleven; the per-row numbers are counts of
 * failing cases, not fractions of the total, so they stand as written.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 12 pass, 0 fail | **11 pass, 0 fail** | — |
 * | M1 **the cheapest wrong fix**: the step emitted only when the script exists at GENERATION time | 7 | **8 of 11** | a tree with no `scripts/ci-setup.sh`: the original generates an extension point, the mutant generates a job the consumer cannot reach |
 * | M2 **the defect restored**: `ciSetupStep()` returns the empty string | 6 | **8 of 11** | the same tree: the original's `test` job carries the named step, the mutant's does not |
 * | M3 the step written `- run: bash scripts/ci-setup.sh` instead of a named block scalar | 8 | **9 of 11** | the generated sharded `ci.yml`: `testCommandsNamedByCiWorkflow` reads `bun test` from the original and **`bash scripts/ci-setup.sh`** from the mutant |
 * | M4 the absent-script `else` branch deleted | 1 | **1 of 11** | a tree with no script: the original prints which of the two things happened, the mutant exits 0 in silence |
 * | M5 `[ -f ]` narrowed to `[ -x ]` | 1 | **3 of 11** | a script present at mode 0644: the original runs it, the mutant skips it |
 * | M6 the sharded body left unwired — #765's shape | 1 | **2 of 11** | a config with `ci.shards: 4`: the original's `test-shard` job carries the step, the mutant's does not |
 * | M7 the step emitted AFTER the suite instead of before | 2 | **2 of 11** | either body: the one position a setup step cannot seed the suite from |
 *
 * **Four rows came back HIGH and every extra red is the real kind** — no
 * mutant crashed, and between two and nine cases still pass in each. They
 * record three facts worth having:
 *
 * - **AC-4's anti-vacuity assertion is load-bearing.** The pair claim is
 *   "two trees differing in one file generate the same `ci.yml`", which an
 *   empty step satisfies perfectly; the `toContain(STEP_NAME)` beside it is
 *   what reds M2 and M3. Without it the pair would certify the defect.
 * - **AC-6's `ciSetupStep()` control is load-bearing twice.** *"The generator
 *   does not spell the path itself"* is green over a generator that emits
 *   nothing, so the case asserts the binding produces the path — which is the
 *   M2 extra. The two-call counter is the M1 extra: a conditional
 *   interpolation is not two unconditional ones.
 * - **The mode-bit decision reaches three cases, not one.** Under M5 a
 *   non-executable script is skipped, so the failing-script case stops
 *   failing and the two outcomes stop being distinguishable. `-x` does not
 *   merely miss a setup; it makes a broken setup look like a clean run.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * `cp` backups, never `git checkout --`, and both sources were confirmed
 * byte-identical by sha256 afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CI_SETUP_SCRIPT, ciSetupStep } from "../lib/ci-setup-step";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { testCommandsNamedByCiWorkflow } from "../lib/test-command-positions";

const REPO_ROOT = join(import.meta.dir, "..");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/**
 * A project rungate would scaffold, generated and read back.
 *
 * `shards` is the ONLY thing that differs between the two bodies, and
 * `setupScript` the only thing that differs between the two AC-4 trees — a
 * pair that varies two things measures neither (#585).
 */
function generated(opts: { shards?: number; setupScript?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-529-"));
  scratch.push(root);
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify(
      {
        project: "fixture",
        ci: { runner: "ubuntu-latest", branches: ["main"], ...(opts.shards ? { shards: opts.shards } : {}) },
        test: { command: "bun test" },
      },
      null,
      2,
    ) + "\n",
  );
  if (opts.setupScript !== undefined) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, CI_SETUP_SCRIPT), opts.setupScript);
  }
  createCiWorkflows(root, []);
  return readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
}

/**
 * The job a name opens, up to the next job at the same indent.
 *
 * Structural, never `slice(at, at + N)` (#664): a window is a guess about how
 * long a construct stays that size, and it decays silently.
 */
function job(ci: string, name: string): string {
  const anchor = `\n  ${name}:\n`;
  const at = ci.indexOf(anchor);
  if (at < 0) throw new Error(`the generated ci.yml has no \`${name}:\` job`);
  const rest = ci.slice(at + anchor.length);
  const next = /\n {2}[A-Za-z_][\w-]*:/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

const STEP_NAME = `- name: Consumer setup (${CI_SETUP_SCRIPT}, optional)`;

/** The step's shell body, dedented so bash can run it. */
function stepShell(ci: string, jobName: string): string {
  const j = job(ci, jobName);
  const at = j.indexOf(STEP_NAME);
  if (at < 0) throw new Error(`the \`${jobName}\` job carries no ${CI_SETUP_SCRIPT} step`);
  const body = j.slice(at);
  const open = body.indexOf("run: |\n");
  if (open < 0) throw new Error("the setup step has no block-scalar body");
  const lines = body.slice(open + "run: |\n".length).split("\n");
  const indent = /^\s*/.exec(lines[0])![0].length;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && /^\s*/.exec(line)![0].length < indent) break;
    out.push(line.slice(indent));
  }
  const shell = out.join("\n").trimEnd();
  if (shell.trim() === "") throw new Error("the setup step's body is empty");
  return shell;
}

describe("#529 AC-1: the sharded body carries the extension point, in the job that runs the suite", () => {
  test("the shard job runs it after install and before the suite; the aggregate does not", () => {
    const ci = generated({ shards: 4 });
    const shard = job(ci, "test-shard");

    expect(shard, "the shard job carries no consumer setup step").toContain(STEP_NAME);
    const install = shard.indexOf("- run: bun install");
    const setup = shard.indexOf(STEP_NAME);
    const suite = shard.indexOf("- run: bun test");
    expect(install, "the install step moved").toBeGreaterThan(-1);
    expect(suite, "the suite step moved").toBeGreaterThan(-1);
    expect(setup, "setup runs before the dependencies are installed").toBeGreaterThan(install);
    expect(
      setup,
      "setup runs AFTER the suite, which is the one position that cannot seed it (#529)",
    ).toBeLessThan(suite);

    // The aggregate runs no tests at all — a setup step there would run
    // against a checkout nothing uses.
    expect(job(ci, "test"), "the aggregate job carries a setup step it has no use for").not.toContain(
      STEP_NAME,
    );
  });
});

describe("#529 AC-2: the unsharded body carries it too", () => {
  test("the single test job runs it after install and before the suite", () => {
    // #765's shape, stated as a case rather than remembered: the generator
    // has two bodies and a change can land in one of them while 91 tests pass.
    const ci = generated();
    expect(ci, "this fixture generated the sharded body").not.toContain("test-shard");
    const j = job(ci, "test");
    expect(j, "the single test job carries no consumer setup step").toContain(STEP_NAME);
    expect(j.indexOf(STEP_NAME)).toBeGreaterThan(j.indexOf("- run: bun install"));
    expect(j.indexOf(STEP_NAME)).toBeLessThan(j.indexOf("- run: bun test"));
  });
});

describe("#529 AC-3: the new step is not read as the project's test command", () => {
  // The trap this file exists to avoid shipping. A setup step spelled
  // `- run: bash scripts/ci-setup.sh` is the first non-setup `- run:` in the
  // job, so every position check in the tree would start reporting it as the
  // project's test command and #621's agreement binding would go red naming
  // three spellings. Driven through the REAL extractor: the YAML's shape is a
  // proxy, and the reading is the property.
  test("the sharded body still names `bun test`", () => {
    const read = testCommandsNamedByCiWorkflow(generated({ shards: 4 }));
    expect(read).toHaveLength(1);
    expect(read[0].command).toBe("bun test");
  });

  test("the unsharded body still names `bun test`", () => {
    const read = testCommandsNamedByCiWorkflow(generated());
    expect(read).toHaveLength(1);
    expect(read[0].command).toBe("bun test");
  });
});

describe("#529 AC-4: the extension point does not depend on the script existing when the file is generated", () => {
  test("two trees differing in exactly one file generate byte-identical ci.yml", () => {
    // The case the cheapest wrong fix — a generation-time `existsSync` — does
    // not survive. Generation happens once; the tree keeps moving.
    const without = generated();
    const with_ = generated({ setupScript: "#!/usr/bin/env bash\necho seeded\n" });
    expect(with_, "the generated CI depends on whether the tree had the script yet (#529)").toBe(without);
    expect(without, "neither tree got an extension point at all").toContain(STEP_NAME);
  });
});

describe("#529 AC-5: the step is executed, and says which of the two things happened", () => {
  // Without this the cases above are satisfied by a step that does nothing
  // (#500). The shell is cut out of the GENERATED file and run.
  function run(script: string | undefined): { status: number | null; out: string; seeded: boolean } {
    const root = mkdtempSync(join(tmpdir(), "rungate-529-run-"));
    scratch.push(root);
    if (script !== undefined) {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, CI_SETUP_SCRIPT), script);
      // Deliberately NOT chmod +x. The executable bit is one byte of
      // filesystem state that `cp`, most editors and every zip-based
      // download drop, and a guard that reads it turns a missing mode bit
      // into a silently skipped setup — #492's one-byte row from the other
      // side.
      chmodSync(join(root, CI_SETUP_SCRIPT), 0o644);
    }
    // Generated from a tree that has NO script, so the step under test cannot
    // have been emitted because of the fixture it is about to run against.
    const shell = stepShell(generated(), "test");
    const r = spawnSync("bash", ["-e", "-c", shell], { cwd: root, encoding: "utf-8" });
    return {
      status: r.status,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      seeded: existsSync(join(root, "seeded.txt")),
    };
  }

  test("a tree with the script runs it, mode bit or no mode bit", () => {
    const r = run("echo from-the-consumer\ntouch seeded.txt\n");
    expect(r.status, `the step failed: ${r.out}`).toBe(0);
    expect(r.seeded, "the consumer's setup script did not run").toBe(true);
    expect(r.out).toContain("from-the-consumer");
    expect(r.out).toContain(`running ${CI_SETUP_SCRIPT}`);
  });

  test("a tree without the script says so, rather than being silent", () => {
    // `0`, `{}` and silence are indistinguishable from success. An operator
    // debugging a tree that was never seeded needs a line to search for.
    const r = run(undefined);
    expect(r.status).toBe(0);
    expect(r.seeded).toBe(false);
    expect(r.out, "the absent-script path is silent").toContain(`no ${CI_SETUP_SCRIPT} in this tree`);
    expect(r.out).not.toContain(`running ${CI_SETUP_SCRIPT}`);
  });

  test("a setup script that fails fails the step — there is no `|| true`", () => {
    // A green suite over a tree whose setup failed is the least useful thing
    // CI can produce.
    const r = run("echo about-to-fail\nexit 3\n");
    expect(r.status, "a failing setup script was swallowed").not.toBe(0);
    expect(r.out).toContain("about-to-fail");
  });

  test("the two outcomes are distinguishable, which is the whole claim", () => {
    // #585: the pair varies exactly one thing — whether the file is there —
    // and the two readings must not be the same string.
    const present = run("exit 0\n").out;
    const absent = run(undefined).out;
    expect(present).not.toBe(absent);
  });
});

describe("#529 AC-6: one declaring position", () => {
  test("the conventional path is spelled in one module, and the generator reads it", () => {
    // Two copies of the path would be two deciders that agree on every tree
    // anyone has, and a rename applied to one would leave the other.
    const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(steps, "the generator spells the path itself instead of reading the binding").not.toContain(
      CI_SETUP_SCRIPT,
    );
    expect(steps, "the generator does not call the step binding").toContain("ciSetupStep()");
    // And the binding really does produce the path, so the assertion above is
    // not satisfied by a generator that emits nothing.
    expect(ciSetupStep()).toContain(CI_SETUP_SCRIPT);
  });

  test("the step is emitted in both bodies, counted rather than assumed", () => {
    const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(
      steps.split("${ciSetupStep()}").length - 1,
      "the sharded and unsharded bodies do not both carry the extension point (#765)",
    ).toBe(2);
  });
});
