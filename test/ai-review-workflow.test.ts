/**
 * ai-review-workflow.test.ts — the generated `.github/workflows/ai-review.yml`
 * (#630, wave 2: AC-7 and AC-11).
 *
 * Wave 1 shipped `lib/scaffold/ai-review-step.ts` — the auth-detect step, and
 * the tests that RUN it. Nothing wrote it into a file. This is the file, and
 * the conformity check that executes the copy on disk.
 *
 * Covers AC-1, AC-2, AC-3 (the generated workflow) and AC-4, AC-5 (the
 * conformity case). AC-6 lives in `test/release-guard.test.ts`, beside the
 * tuple it is about.
 *
 * ## Why the job carries no `if:`, and why that is asserted after presence
 *
 * A job skipped by `if:` reports `skipped`, and a skipped required check can
 * be treated as satisfied — a green required check for a review that never
 * ran. `secrets` is not available in `if:` at any level either, so the mode is
 * resolved inside `run:`.
 *
 * The assertion for that is the fifth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` waiting to happen: if the job
 * is ABSENT, "the job mapping has no `if` key" is vacuously true, and the
 * cheapest repair for a failing case — delete the job — makes it go green over
 * exactly the regression it exists to catch (#518). So presence is established
 * first, in its own assertion, and the `if` comparison only runs after it.
 *
 * ## Why the conformity cases are driven over planted fixtures too
 *
 * `runAiReviewValidation` reads THIS repository's generated file, which is the
 * right thing for it to read and the wrong thing to prove a check with: one
 * tree, one verdict, and that verdict is green. The red half is planted —
 * a workflow with a job-level `if:`, a script that never warns, a script that
 * warns unconditionally — so every refusal the check can emit is observed
 * emitting.
 *
 * ## What was broken to prove these fail, run and counted rather than asserted
 *
 * Baselines: this file 21 pass / 0 fail; `bun test test/scaffold-conformity.test.ts
 * -t AIREVIEW-1` 1 pass / 0 fail. None of the mutations is left in the tree;
 * all were run and reverted, and both files were confirmed to return to their
 * baselines afterwards.
 *
 * | Mutation | Predicted | Measured |
 * |---|---|---|
 * | `.github/workflows/ai-review.yml` deleted — the cheapest wrong fix for a red AIREVIEW-1 | 1 red | **1 of 1** — *"absent while ci.yml is present"*, so the repair makes it redder |
 * | the `::warning` line stripped out of the on-disk script | 1 red | **1 of 1** — *"emitted 0 UNMEASURED warning annotation(s), expected exactly 1"* |
 * | a job-level `if:` planted on the on-disk `ai-review` job | 1 red | **1 of 1** — *"a job skipped by a condition reports `skipped`"* |
 * | the generator's tuple entry renamed to `ai-review.yaml` | 13 red | **13 of 21** — the 8 green are the planted-fixture cases, which never read the generator's output |
 *
 * The input on which mutant and original differ, named rather than assumed:
 * for the first three it is the bytes of this repository's own
 * `.github/workflows/ai-review.yml`; for the fourth it is the filename
 * `createCiWorkflows` writes, which is the one thing holding
 * `AI_REVIEW_WORKFLOW_FILE` (what `lib/conformity.ts` reads back) to the
 * literal in the tuple `test/release-guard.test.ts` pins.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildAuthDetectScript,
  buildAuthDetectStep,
  buildDriftScript,
  buildReviewRunScript,
  buildReviewRunStep,
} from "../lib/scaffold/ai-review-step";
import { aiReviewAuthScript, aiReviewUnmeasuredViolations } from "../lib/conformity";

/** Four patterns, including a bare `*` and a `**` glob — AC-3's fixture. */
const BRANCHES = ["main", "*", "*-dev", "release/**"];
const RUNNER = "ubuntu-latest";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ── The generated file ───────────────────────────────────────────────────

let PROJECT = "";
const workflowsDir = () => join(PROJECT, ".github", "workflows");
const generated = () => readFileSync(join(workflowsDir(), AI_REVIEW_WORKFLOW_FILE), "utf-8");

beforeAll(() => {
  PROJECT = scratchDir("ai-review-workflow-");
  mkdirSync(join(PROJECT, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(PROJECT, ".claude", "rungate", "config.json"),
    JSON.stringify(
      {
        project: "ai-review-fixture",
        ci: { runner: RUNNER, bunVersion: "1.2.0", branches: BRANCHES },
      },
      null,
      2,
    ) + "\n",
  );
  createCiWorkflows(PROJECT, []);
});

/** `on` folds to the boolean `true` under YAML 1.1; accept either spelling. */
function triggersOf(doc: any): any {
  return doc.on ?? doc[true as unknown as string];
}

describe("AC-1: the scaffold writes ai-review.yml carrying the builder's step verbatim", () => {
  test("AC-1: exactly one generated workflow contains buildAuthDetectStep() byte for byte", () => {
    const files = readdirSync(workflowsDir()).sort();
    expect(files, "the scaffold wrote no ai-review.yml at all").toContain(AI_REVIEW_WORKFLOW_FILE);

    const step = buildAuthDetectStep();
    const carrying = files.filter(f =>
      readFileSync(join(workflowsDir(), f), "utf-8").includes(step),
    );
    expect(
      carrying,
      `the step must reach the file verbatim from the builder — a second copy ` +
        `in the template is a second decider\n${files.join(", ")}`,
    ).toEqual([AI_REVIEW_WORKFLOW_FILE]);
  });

  test("AC-1: the script in the file is the script the builder produces", () => {
    // The step text above could be present and the YAML still mangle it (a
    // wrong block scalar, a stray indent). This reads it back through a
    // parser, which is what GitHub does.
    const doc = Bun.YAML.parse(generated()) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps as any[];
    const auth = steps.find(s => s.id === AI_REVIEW_AUTH_STEP_ID);
    expect(auth, `no step with id ${AI_REVIEW_AUTH_STEP_ID}`).toBeDefined();
    expect(auth.run.trimEnd()).toBe(buildAuthDetectScript().trimEnd());
  });

  test("AC-1: every credential reaches the step through env:, never interpolated", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps as any[];
    const auth = steps.find(s => s.id === AI_REVIEW_AUTH_STEP_ID);
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(auth.env[secret], `${secret} is not passed through env:`).toBe(
        `\${{ secrets.${secret} }}`,
      );
      expect(auth.run, `${secret} is interpolated into the script body`).not.toContain(
        `secrets.${secret}`,
      );
    }
  });
});

describe("AC-2: the job exists, and it can never conclude `skipped`", () => {
  test("AC-2: the ai-review job is present — asserted before anything is compared", () => {
    // #518: an absent job makes every "no if key" assertion below vacuously
    // true, and deleting the job is the cheapest repair for a failing one.
    const doc = Bun.YAML.parse(generated()) as any;
    expect(Object.keys(doc.jobs ?? {})).toContain(AI_REVIEW_JOB);
    expect(typeof doc.jobs[AI_REVIEW_JOB]).toBe("object");
  });

  test("AC-2: the job mapping carries no `if` key", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const job = doc.jobs[AI_REVIEW_JOB];
    expect(Object.keys(job)).toContain("steps"); // the job is real, not a stub
    expect(
      Object.keys(job).filter(k => k === "if"),
      "a job-level `if:` makes the job report skipped, and a skipped required " +
        "check can be treated as satisfied",
    ).toEqual([]);
  });

  test("AC-2: no step inside the job carries an `if` either", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps as any[];
    expect(steps.length, "the job has no steps — nothing to skip and nothing to run")
      .toBeGreaterThan(0);
    expect(steps.filter(s => "if" in s).map(s => s.name ?? s.id ?? "(unnamed)")).toEqual([]);
  });

  test("AC-2: nothing in the file reads a credential inside a `${{ }}` condition", () => {
    const conditions = generated()
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^if\s*:/.test(l));
    expect(conditions, "an `if:` line survived the parse-level assertions").toEqual([]);
  });
});

describe("AC-3: the configured branches reach on.pull_request, quoted", () => {
  test("AC-3: the file parses with four glob branch patterns", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const triggers = triggersOf(doc);
    expect(triggers.pull_request.branches).toEqual(BRANCHES);
    expect(BRANCHES.length).toBe(4);
  });

  test("AC-3: every pattern is emitted as a double-quoted scalar", () => {
    // A bare `*` is a YAML alias indicator and `*-dev` an unresolved alias, so
    // an unquoted list is a workflow GitHub Actions refuses to parse.
    const yml = generated();
    for (const b of BRANCHES) {
      expect(yml, `${b} is not quoted`).toContain(`      - ${JSON.stringify(b)}`);
    }
  });

  test("AC-3: a project that configures no branches gets the default", () => {
    const bare = scratchDir("ai-review-default-branch-");
    mkdirSync(join(bare, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(bare, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "bare", ci: { bunVersion: "1.2.0" } }, null, 2) + "\n",
    );
    createCiWorkflows(bare, []);
    const doc = Bun.YAML.parse(
      readFileSync(join(bare, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
    ) as any;
    expect(triggersOf(doc).pull_request.branches).toEqual(["main"]);
  });
});

// ── AC-4 / AC-5: the conformity case, executed ───────────────────────────

/** A project tree carrying exactly the workflow text given. */
function plant(yml: string | null, opts: { ci?: boolean } = { ci: true }): string {
  const root = scratchDir("ai-review-conformity-");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  if (opts.ci !== false) {
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n");
  }
  if (yml !== null) {
    writeFileSync(join(root, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), yml);
  }
  return root;
}

describe("AC-4: no credential configured is UNMEASURED, not a passing review", () => {
  test("AC-4: the scaffolded project's own script emits exactly one UNMEASURED warning", () => {
    const reading = aiReviewAuthScript(PROJECT);
    expect(reading.failure, `${reading.failure}`).toBeNull();
    expect(reading.unmeasured, `${reading.unmeasured}`).toBeNull();
    const violations = aiReviewUnmeasuredViolations(reading.script!);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("AC-4: the count is one, and it is read off a real run of the generated script", () => {
    const reading = aiReviewAuthScript(PROJECT);
    const run = runAuthScript(reading.script!, {});
    const warnings = run.stdout
      .split("\n")
      .filter(l => l.startsWith("::warning") && l.includes("UNMEASURED"));
    expect(warnings.length, `expected one UNMEASURED warning\n${run.stdout}`).toBe(1);
    expect(run.code, "an unconfigured project must not fail on the first scaffold").toBe(0);
  });
});

describe("AC-5: a configured credential emits no UNMEASURED annotation", () => {
  test("AC-5: GCP_SA_KEY present means zero UNMEASURED annotations", () => {
    const reading = aiReviewAuthScript(PROJECT);
    const run = runAuthScript(reading.script!, { GCP_SA_KEY: "x" });
    const warnings = run.stdout.split("\n").filter(l => l.includes("UNMEASURED"));
    expect(warnings.length, `a resolved mode still warned\n${run.stdout}`).toBe(0);
    expect(run.code).toBe(0);
  });

  test("AC-5: a script that warns unconditionally is REFUSED by the check", () => {
    // The whole reason AC-5 exists: without it, "emits an UNMEASURED warning"
    // is satisfied by a script that emits one no matter what, and the
    // credential-free case certifies a check that reads nothing.
    const always = '#!/bin/bash\necho "::warning title=AI review UNMEASURED::UNMEASURED always"\nexit 0\n';
    const violations = aiReviewUnmeasuredViolations(always);
    expect(violations.length, "an unconditional warning was accepted").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("GCP_SA_KEY");
  });

  test("AC-4/AC-5: a script that never warns is REFUSED by the check", () => {
    const silent = "#!/bin/bash\nexit 0\n";
    const violations = aiReviewUnmeasuredViolations(silent);
    expect(violations.length, "a silent pass was accepted").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("UNMEASURED");
  });

  test("AC-4/AC-5: the check does not inherit the developer's own credentials", () => {
    // A developer with ANTHROPIC_API_KEY exported would see the credential-free
    // case resolve a mode and go green for a reason unrelated to the code.
    const probe = "#!/bin/bash\nfor v in GCP_SA_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do\n  eval \"val=\\${$v:-}\"\n  [ -n \"$val\" ] && echo \"LEAKED $v\"\ndone\nexit 0\n";
    const run = runAuthScript(probe, {});
    expect(run.stdout, "the harness passed a real credential into the clean case")
      .not.toContain("LEAKED");
  });
});

// ── AC-7: the other door into the same defect ────────────────────────────
//
// The auth-detect step makes mode `none` honest and says nothing about the
// other three. On a repository that HAS a credential those are the only
// modes reachable, so with the auth step alone a job named "AI Review"
// concludes success on every pull request, having reviewed nothing, and
// says nothing about it. Measured, not reasoned: the first run of this
// workflow on PR #641 logged `ai-review auth mode: vertex` and emitted zero
// annotations, because rungate has GCP_SA_KEY set.
//
// "No credential, so no review" and "a credential, but nothing wired to use
// it" are the same state to a required check. Both are UNMEASURED.
describe("AC-7: every mode the job can resolve says what it measured", () => {
  test("AC-7: a resolved mode emits exactly one UNMEASURED warning and exits 0", () => {
    const run = runAuthScript(buildReviewRunScript(), { AI_REVIEW_MODE: "vertex" });
    const warnings = run.stdout
      .split("\n")
      .filter(l => l.startsWith("::warning") && l.includes("UNMEASURED"));
    expect(warnings.length, `a resolved mode reviewed nothing in silence\n${run.stdout}`).toBe(1);
    expect(warnings[0]).toContain("#631");
    expect(run.code, "a tree that has not opted in must not go red").toBe(0);
  });

  test("AC-7: every credentialed mode in the ladder annotates, not just the first", () => {
    // Enumerated from the ladder rather than spot-checked: a fourth mode
    // added later with its own quiet exit would otherwise ship unobserved.
    for (const c of AI_REVIEW_AUTH_PRECEDENCE) {
      const run = runAuthScript(buildReviewRunScript(), { AI_REVIEW_MODE: c.mode });
      const warnings = run.stdout.split("\n").filter(l => l.includes("UNMEASURED"));
      expect(warnings.length, `mode ${c.mode} passed quietly\n${run.stdout}`).toBe(1);
    }
  });

  test("AC-7: mode none is silent here, because the auth step already said it", () => {
    // One state reported once. Annotating `none` in both steps would make a
    // single unmeasured review look like two.
    const run = runAuthScript(buildReviewRunScript(), { AI_REVIEW_MODE: "none" });
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code).toBe(0);
  });

  test("AC-7: an unset mode is treated as none, not as a resolved credential", () => {
    const run = runAuthScript(buildReviewRunScript(), {});
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code).toBe(0);
  });

  test("AC-7: a consumer who required a review and got none is refused", () => {
    const run = runAuthScript(buildReviewRunScript(), {
      AI_REVIEW_MODE: "vertex",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
    });
    expect(run.code, "the opt-in refusal did not fire for a missing reviewer").toBe(1);
    expect(run.stderr).toContain("::error");
    expect(run.stderr).toContain("#631");
  });

  test("AC-7: the refusal reads the variable exactly, like the auth step does", () => {
    for (const value of ["TRUE", "True", "1", "yes", "truthy", "true "]) {
      const run = runAuthScript(buildReviewRunScript(), {
        AI_REVIEW_MODE: "vertex",
        RUNGATE_REQUIRE_AI_REVIEW: value,
      });
      expect(run.code, `${JSON.stringify(value)} turned the gate on by accident`).toBe(0);
    }
  });

  test("AC-7: the step is in the generated file, verbatim, and carries no `if`", () => {
    expect(generated()).toContain(buildReviewRunStep());
    const doc = Bun.YAML.parse(generated()) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps;
    const step = steps.find((s: any) => s.id === AI_REVIEW_RUN_STEP_ID);
    expect(step, `no step with id ${AI_REVIEW_RUN_STEP_ID}:\n${generated()}`).toBeDefined();
    expect(Object.keys(step)).not.toContain("if");
  });

  test("AC-7: the mode reaches the script through env:, never interpolated into run:", () => {
    // `${{ }}` is substituted into the script text before bash sees it. The
    // mode is one of four literals we generated and is not attacker-reachable
    // today — which is exactly the reasoning that makes an exception become a
    // convention nobody can rely on.
    const doc = Bun.YAML.parse(generated()) as any;
    const step = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s.id === AI_REVIEW_RUN_STEP_ID);
    expect(step.run).not.toContain("${{");
    expect(step.env.AI_REVIEW_MODE).toContain(`steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode`);
  });

  test("AC-7: a review step that passes quietly is what this would have shipped", () => {
    // The mutant, run rather than described: strip the annotation and the
    // resolved-mode case becomes the silent green PR #641 actually produced.
    const quiet = buildReviewRunScript().replace(/^echo "::warning.*$/m, ":");
    expect(quiet, "the mutation did not apply").not.toBe(buildReviewRunScript());
    const run = runAuthScript(quiet, { AI_REVIEW_MODE: "vertex" });
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code).toBe(0);
  });
});

// ── AC-9: a reviewer that completed, with nobody reading its verdict ─────

describe("AC-9: a payload nobody adjudicates is UNMEASURED as a gate", () => {
  test("AC-9: a successful review warns that its findings are not enforced", () => {
    // The fail-open the security review named: the reviewer runs, writes a
    // payload carrying a `critical`, and no step in this job reads it, so the
    // check is green. Wiring the reader needs a way for a scaffolded consumer
    // — which has no copy of rungate's sources — to execute it, which is #675.
    // Until then the state is reported rather than exited-zero in silence.
    const run = runAuthScript(buildReviewRunScript(), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
    });
    const warnings = run.stdout.split("\n").filter(l => l.includes("UNMEASURED"));
    expect(
      warnings.length,
      `a completed review with no adjudication passed quietly\n${run.stdout}`,
    ).toBe(1);
    expect(warnings[0], "the annotation does not say where the gap is tracked").toContain("#675");
    expect(run.code, "a tree that has not opted in must not go red").toBe(0);
  });

  test("AC-9: a consumer who required a review is refused an unenforced one", () => {
    // RUNGATE_REQUIRE_AI_REVIEW means "a review I cannot read must not report
    // green". A payload nobody reads is a review nobody read, so the same
    // variable has to cover it — otherwise the opt-in buys a green check over
    // a blocking finding, which is the exact thing it was added to prevent.
    const run = runAuthScript(buildReviewRunScript(), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
    });
    expect(run.code, "the opt-in refusal did not fire for an unread payload").toBe(1);
    expect(run.stderr).toContain("#675");
  });

  test("AC-9: the two completed/not-completed states say different things", () => {
    // A pair varying ONE reading. Without this, one sentence could cover both
    // and "the reviewer never ran" would be indistinguishable from "the
    // reviewer ran and nobody read it" — different facts, different fixes.
    const base = { AI_REVIEW_MODE: "vertex" };
    const ran = runAuthScript(buildReviewRunScript(), {
      ...base,
      AI_REVIEW_ACTION_OUTCOME: "success",
    });
    const failed = runAuthScript(buildReviewRunScript(), {
      ...base,
      AI_REVIEW_ACTION_OUTCOME: "failure",
    });
    expect(ran.stdout, "one sentence for two states").not.toBe(failed.stdout);
    expect(failed.stdout).toContain("#631");
    expect(failed.stdout).not.toContain("#675");
    expect(ran.stdout).toContain("#675");
  });

  test("AC-9: the silent exit is what this would have shipped", () => {
    // The mutant, run rather than described: restore the bare `exit 0` on the
    // success path and a review carrying a critical finding is a green check
    // with nothing in the log saying so.
    const quiet = buildReviewRunScript().replace(
      /if \[ "\$\{AI_REVIEW_ACTION_OUTCOME:-\}" = success \]; then\n(?:.*\n)*?fi\n/,
      'if [ "${AI_REVIEW_ACTION_OUTCOME:-}" = success ]; then\n  exit 0\nfi\n',
    );
    expect(quiet, "the mutation did not apply").not.toBe(buildReviewRunScript());
    const run = runAuthScript(quiet, {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
    });
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code, "the mutant still refused — the mutation measured nothing").toBe(0);
  });
});

// ── AC-10: a reviewer that wrote into the tree is refused ────────────────

describe("AC-10: the drift step reads the whole worktree, not just tracked diffs", () => {
  /**
   * Run a drift script inside a real git repo, with a real commit.
   *
   * The script lives OUTSIDE the repo. Writing it in makes it an untracked
   * file of its own, which refuses every run — the clean case caught that on
   * the first draft, and without it the three refusal cases below would all
   * have passed over a script that could not see what they planted.
   */
  function runDrift(
    plant: (dir: string) => void,
    env: Record<string, string> = {},
    script: string = buildDriftScript(),
  ): Run {
    const dir = scratchDir("ai-review-drift-");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    plant(dir);
    const sh = join(scratchDir("ai-review-drift-script-"), "drift.sh");
    writeFileSync(sh, script);
    const r = Bun.spawnSync(["bash", sh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? dir,
        AI_REVIEW_MODE: "vertex",
        ...env,
      },
    });
    return {
      code: r.exitCode,
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
    };
  }

  test("AC-10: a clean tree passes", () => {
    const run = runDrift(() => {});
    expect(run.code, `a clean tree was refused:\n${run.stderr}`).toBe(0);
    expect(run.stderr).toBe("");
  });

  test("AC-10: a modified tracked file is refused", () => {
    const run = runDrift(dir => writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n"));
    expect(run.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.stderr).toContain("tracked.ts");
  });

  test("AC-10: an UNTRACKED file is refused — the case `git diff` cannot see", () => {
    // The whole reason this step was rewritten. A reviewer told to write a
    // findings file writes a NEW file, which is untracked, and neither
    // `git diff` nor `git diff --cached` reports one. The first draft of this
    // step asked exactly those two questions and would have passed here.
    const run = runDrift(dir => writeFileSync(join(dir, "ai-review-findings.json"), "{}"));
    expect(
      run.code,
      `an untracked file the reviewer planted went unnoticed:\n${run.stdout}${run.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.stderr).toContain("ai-review-findings.json");
  });

  test("AC-10: a file inside a NEW directory is refused — `--untracked-files=all`", () => {
    // Plain `--porcelain` stops at the directory name for a new directory,
    // which still refuses here — so the assertion is on the NAMED path, not
    // on the exit code. A refusal that cannot say what changed is a refusal
    // nobody can act on.
    const run = runDrift(dir => {
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "nested", "planted.ts"), "export const b = 1;\n");
    });
    expect(run.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      run.stderr,
      "the refusal named the directory but not the file inside it",
    ).toContain("nested/planted.ts");
  });

  test("AC-10: mode none does not run the check at all", () => {
    // No credential means no reviewer ran, so there is nothing to attribute a
    // dirty tree to. Refusing here would blame the reviewer for the runner.
    const run = runDrift(dir => writeFileSync(join(dir, "x.ts"), "1"), {
      AI_REVIEW_MODE: "none",
    });
    expect(run.code).toBe(0);
  });

  test("AC-10: the tracked-only reading is what this would have shipped", () => {
    // The mutant, run rather than described: the two-decider `git diff` pair
    // the first draft used. It passes over the untracked file above, which is
    // the shape the reviewer is most likely to produce.
    const mutant = buildDriftScript().replace(
      /changed=\$\(git status --porcelain --untracked-files=all[^)]*\)/,
      "changed=$(git diff --name-only; git diff --cached --name-only)",
    );
    expect(mutant, "the mutation did not apply").not.toBe(buildDriftScript());

    // The same planted file, the same fixture, one thing varied: which
    // command does the reading. The real script refuses it two cases above.
    const plant = (dir: string) => writeFileSync(join(dir, "ai-review-findings.json"), "{}");
    expect(runDrift(plant).code, "the control stopped refusing").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      runDrift(plant, {}, mutant).code,
      "the mutant refused — the mutation measured nothing",
    ).toBe(0);
  });

  test("AC-10: the step is in the generated file and carries no `if`", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const step = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s.id === AI_REVIEW_DRIFT_STEP_ID);
    expect(step, `no step with id ${AI_REVIEW_DRIFT_STEP_ID}:\n${generated()}`).toBeDefined();
    expect(Object.keys(step)).not.toContain("if");
    expect(step.run).not.toContain("${{");
  });
});

describe("AC-4: the reading refuses rather than reporting a clean tree it never read", () => {
  test("a scaffolded project with no ai-review.yml is a FAILURE, not UNMEASURED", () => {
    // The cheapest repair for a red AIREVIEW-1 is to delete the file. It has
    // to make the check redder, not greener.
    const reading = aiReviewAuthScript(plant(null));
    expect(reading.failure).not.toBeNull();
    expect(reading.failure).toContain(AI_REVIEW_WORKFLOW_FILE);
    expect(reading.script).toBeNull();
  });

  test("a project with no scaffolded CI at all is UNMEASURED, not a pass", () => {
    const reading = aiReviewAuthScript(plant(null, { ci: false }));
    expect(reading.unmeasured, "an unscaffolded project reported a verdict").not.toBeNull();
    expect(reading.failure).toBeNull();
  });

  test("a job-level `if:` is a FAILURE", () => {
    const yml =
      `name: AI Review\non:\n  pull_request:\n    branches:\n      - "main"\n\njobs:\n` +
      `  ${AI_REVIEW_JOB}:\n    if: \${{ vars.RUNGATE_AI_REVIEW == 'true' }}\n` +
      `    runs-on: "ubuntu-latest"\n    steps:\n${buildAuthDetectStep()}`;
    const reading = aiReviewAuthScript(plant(yml));
    expect(reading.failure, "a job-level if: was accepted").not.toBeNull();
    expect(reading.failure).toContain("if");
  });

  test("a renamed job is a FAILURE, not an absent-and-therefore-clean job", () => {
    const yml =
      `name: AI Review\non:\n  pull_request:\n    branches:\n      - "main"\n\njobs:\n` +
      `  review:\n    runs-on: "ubuntu-latest"\n    steps:\n${buildAuthDetectStep()}`;
    const reading = aiReviewAuthScript(plant(yml));
    expect(reading.failure).not.toBeNull();
    expect(reading.failure).toContain(AI_REVIEW_JOB);
  });

  test("a file that does not parse is a FAILURE, not an empty job list", () => {
    const reading = aiReviewAuthScript(plant("jobs:\n  ai-review:\n   - [unbalanced\n"));
    expect(reading.failure).not.toBeNull();
  });
});

// ── Running a script the way the runner does ─────────────────────────────

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute a script with an environment built from scratch.
 *
 * The local copy of `test/ai-review-scaffold.test.ts`'s runner, and it exists
 * for the same reason: inheriting `process.env` is a fixture that can satisfy
 * the assertion without the feature.
 */
function runAuthScript(script: string, env: Record<string, string>): Run {
  const dir = scratchDir("ai-review-run-");
  const sh = join(dir, "auth-detect.sh");
  writeFileSync(sh, script);
  const out = join(dir, "github_output");
  writeFileSync(out, "");
  const r = Bun.spawnSync(["bash", sh], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dir,
      GITHUB_OUTPUT: out,
      ...env,
    },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}
