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
 *
 * ## #631: every step measured, each level in its own words, and the
 * ## credential inputs read off the parsed file
 *
 * Three readings were widened here, and the sub-issue's own cases are the
 * `#631 AC-…` describes below.
 *
 * - **Every step, not the one we came for.** The step-level refusal reads the
 *   whole list and NAMES the offending steps. The fixture plants the
 *   condition on a step other than the first, because a reader narrowed to
 *   `steps[0]` or to the auth step is the shape a first-step fixture cannot
 *   tell apart from a correct one.
 * - **One level per sentence.** A job-level `if:` and a step-level `if:` are
 *   different defects with different repairs, so they refuse in different
 *   words and neither sentence claims the other's level.
 * - **`aiReviewCredentialGuards` reads the file.** Each credential input on
 *   an action must carry exactly one comparison against
 *   `steps.ai-review-auth.outputs.mode` and name exactly one mode's secret.
 *   A job that hands no action a credential is UNMEASURED BY NAME — an empty
 *   list of guarded inputs is not a guarded job.
 * - **The instrument before the count.** A credential-free run that printed
 *   NOTHING is reported as that, not as "expected exactly 1 warning": a run
 *   with no output is indistinguishable from one that never happened (#60).
 *
 * ### What was broken to prove these fail, run and counted rather than asserted
 *
 * Over this file (49 tests). Every count was predicted before the battery
 * ran, and **the baseline row was read first** — an instrument that has
 * stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 49 pass, 0 fail | **49 pass, 0 fail** | — |
 * | the step-level filter narrowed to `steps[0]` | 6 | **6 of 49** | the three-step fixture with the `if:` on step 2: the original refuses naming `step 2 (Second)`, the mutant returns the auth script and no failure at all |
 * | both levels collapsed into one generic refusal | 6 | **6 of 49** | the same fixture and its job-level twin: the original's two sentences name their own levels, the mutant returns one sentence naming neither |
 * | `credentialGuardViolations` short-circuited to `return []` | 6 | **6 of 49** | `api_key_credential: ${{ secrets.ANTHROPIC_API_KEY }}` — the original reports one violation naming 0 comparisons, the mutant reports none |
 * | the no-inputs UNMEASURED branch removed | 2 | **2 of 49** | the scaffolded fixture project's own file, which hands no action a credential: the original names UNMEASURED, the mutant returns zero inputs and zero violations, which reads as a guarded job |
 * | the empty-output instrument branch removed | 1 | **1 of 49** | `#!/bin/bash\nexit 0` — the original says the step printed nothing at all, the mutant says it "emitted 0 UNMEASURED warning annotation(s), expected exactly 1", which is a count taken off no output |
 *
 * **The first row was 5 before the distinctness case established presence.**
 * `null !== "the job carries a job-level if:"` is a difference, so "the two
 * sentences are not the same sentence" was GREEN over a reader that had
 * stopped refusing one of the two levels entirely — #518, found by the count
 * missing low and by nothing else. It asserts both readings are non-null
 * first, and the row is 6.
 *
 * **The cheapest wrong fix, named: delete the `with:` block that AIREVIEW-2
 * refused.** The symptom is a credential input the check will not accept, and
 * removing the input makes it stop. The cases survive it non-vacuously — a
 * job that hands no action a credential is UNMEASURED, not clean, and
 * *"a job that hands no action a credential is UNMEASURED, not clean"* is the
 * case that says so.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `lib/conformity.ts` was confirmed byte-identical to the measured source
 * afterwards by checksum.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildAuthDetectScript,
  buildAuthDetectStep,
  buildReviewRunScript,
  buildReviewRunStep,
} from "../lib/scaffold/ai-review-step";
import {
  aiReviewAuthScript,
  aiReviewCredentialGuards,
  aiReviewUnmeasuredViolations,
} from "../lib/conformity";

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
    // The instrument first (#60): a run that printed NOTHING yields zero
    // warnings and zero of anything else, and an empty reading is
    // indistinguishable from a clean one. Assert the execution produced
    // output, and that the output is this script's own, before counting it.
    expect(run.stdout.trim(), "the generated script produced no output at all").not.toBe("");
    expect(run.stdout, `no mode line in the output\n${run.stdout}`).toContain(
      "ai-review auth mode: none",
    );
    const warnings = run.stdout
      .split("\n")
      .filter(l => l.startsWith("::warning") && l.includes("UNMEASURED"));
    expect(warnings.length, `expected one UNMEASURED warning\n${run.stdout}`).toBe(1);
    expect(run.code, "an unconfigured project must not fail on the first scaffold").toBe(0);
  });

  test("AC-4: a run that printed nothing is UNMEASURED to the check, not a clean run", () => {
    // The same instrument reading, inside the binding the conformity case
    // uses. Without it `warnings.length !== 1` reports "expected exactly 1"
    // for a script that never executed, which names the wrong defect.
    const violations = aiReviewUnmeasuredViolations("#!/bin/bash\nexit 0\n");
    expect(violations.join("\n")).toContain("printed nothing");
    expect(violations.join("\n")).toContain("UNMEASURED");
  });
});

describe("AC-5: a configured credential emits no UNMEASURED annotation", () => {
  test("AC-5: GCP_SA_KEY present means zero UNMEASURED annotations", () => {
    const reading = aiReviewAuthScript(PROJECT);
    const run = runAuthScript(reading.script!, { GCP_SA_KEY: "x" });
    // "zero UNMEASURED lines" is satisfied by a script that printed nothing
    // at all, which is what a step that failed to run looks like. The mode
    // line is the control that says this reading is of a real execution.
    expect(run.stdout, `the credentialed run printed nothing\n${run.stdout}`).toContain(
      "ai-review auth mode: vertex",
    );
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

// ── #631 AC-1 / AC-2: every step is measured, and each level says so ─────
//
// `steps.filter(s => "if" in s)` reads the whole list today. The cheapest way
// for it to stop doing that is a reader that looks at the step it cares about
// — the auth step, or `steps[0]` — so the fixture plants the condition on a
// step OTHER than the first, which is the only input that tells the two apart.
//
// The pair discipline is #585's: the conditional fixture is DERIVED from the
// clean one by inserting a single line, and the derivation is asserted, so the
// two halves cannot drift into differing in anything but the condition.

const IF_CONDITION = "${{ vars.RUNGATE_AI_REVIEW == 'true' }}";

/** A step with a `run:` and nothing else — a body for the list to have. */
function plainStep(name: string): string {
  return `      - name: ${name}\n        run: echo ${JSON.stringify(name)}\n`;
}

/** A workflow whose ai-review job carries exactly these step blocks. */
function jobYaml(steps: string[], opts: { jobIf?: string } = {}): string {
  return (
    `name: AI Review\non:\n  pull_request:\n    branches:\n      - "main"\n\njobs:\n` +
    `  ${AI_REVIEW_JOB}:\n` +
    (opts.jobIf ? `    if: ${opts.jobIf}\n` : "") +
    `    runs-on: "ubuntu-latest"\n    steps:\n` +
    steps.join("")
  );
}

/** The same document with one `if:` line inserted under the named step. */
function withIfOnStep(yml: string, stepName: string): string {
  const lines = yml.split("\n");
  const at = lines.findIndex(l => l.trim() === `- name: ${stepName}`);
  expect(at, `no step named ${stepName} in the fixture`).toBeGreaterThan(-1);
  lines.splice(at + 1, 0, `        if: ${IF_CONDITION}`);
  const derived = lines.join("\n");
  // The derivation, asserted rather than trusted: one line longer, and
  // identical once the inserted line is taken back out.
  expect(derived.split("\n").length).toBe(yml.split("\n").length + 1);
  const back = derived.split("\n");
  back.splice(at + 1, 1);
  expect(back.join("\n"), "the derivation changed something other than the condition").toBe(yml);
  return derived;
}

const THREE_STEPS = () =>
  jobYaml([buildAuthDetectStep(), plainStep("Second"), plainStep("Third")]);

describe("#631 AC-1: an `if:` on ANY step is refused, not only on the first", () => {
  test("AC-1: the clean three-step fixture is accepted — the control", () => {
    // Without this, every refusal below could be about the fixture rather
    // than about the condition planted into it.
    const reading = aiReviewAuthScript(plant(THREE_STEPS()));
    expect(reading.failure, `${reading.failure}`).toBeNull();
    expect(reading.unmeasured).toBeNull();
    expect(reading.script, "the control fixture produced no auth script").not.toBeNull();
  });

  test("AC-1: a condition on the SECOND step is refused", () => {
    const reading = aiReviewAuthScript(plant(withIfOnStep(THREE_STEPS(), "Second")));
    expect(reading.failure, "an `if:` on step 2 was accepted").not.toBeNull();
    expect(reading.failure).toContain("Second");
    expect(reading.script, "a refused reading still handed back a script").toBeNull();
  });

  test("AC-1: a condition on the LAST step is refused, and the refusal names it", () => {
    const reading = aiReviewAuthScript(plant(withIfOnStep(THREE_STEPS(), "Third")));
    expect(reading.failure, "an `if:` on the last step was accepted").not.toBeNull();
    expect(reading.failure).toContain("Third");
    expect(reading.failure).not.toContain("Second");
  });

  test("AC-1: two conditional steps are both named, and the count is the list's", () => {
    const two = withIfOnStep(withIfOnStep(THREE_STEPS(), "Second"), "Third");
    const reading = aiReviewAuthScript(plant(two));
    expect(reading.failure).toContain("Second");
    expect(reading.failure).toContain("Third");
    expect(reading.failure).toContain("2 step");
  });
});

describe("#631 AC-2: a job-level and a step-level `if:` refuse in their own words", () => {
  // One condition, two positions. Varying only the placement is what makes
  // the comparison a measurement of the LEVEL and not of the text (#585).
  const jobLevel = () => aiReviewAuthScript(plant(jobYaml([buildAuthDetectStep()], { jobIf: IF_CONDITION })));
  const stepLevel = () =>
    aiReviewAuthScript(plant(withIfOnStep(THREE_STEPS(), "Second")));

  test("AC-2: both refuse", () => {
    expect(jobLevel().failure, "a job-level if: was accepted").not.toBeNull();
    expect(stepLevel().failure, "a step-level if: was accepted").not.toBeNull();
  });

  test("AC-2: the two sentences are not the same sentence", () => {
    // Presence before comparison (#518). `null !== "…"` is a difference, so
    // without these two lines a reader that stopped refusing one of the two
    // levels entirely would satisfy "the sentences differ" — measured: this
    // case was green under the `steps[0]`-only mutant until they were added.
    const job = jobLevel().failure;
    const step = stepLevel().failure;
    expect(job, "the job-level reading refused nothing").not.toBeNull();
    expect(step, "the step-level reading refused nothing").not.toBeNull();
    expect(job).not.toBe(step);
  });

  test("AC-2: the job-level refusal names the job level and only the job level", () => {
    const f = jobLevel().failure!;
    expect(f, "the job-level refusal does not say which level it is about").toContain("job-level");
    expect(f, "the job-level refusal also claims a step-level condition").not.toContain(
      "step-level",
    );
  });

  test("AC-2: the step-level refusal names the step level and only the step level", () => {
    const f = stepLevel().failure!;
    expect(f, "the step-level refusal does not say which level it is about").toContain(
      "step-level",
    );
    expect(f, "the step-level refusal also claims a job-level condition").not.toContain(
      "job-level",
    );
  });
});

// ── #631 AC-3: the credential inputs on the review action ────────────────
//
// A credential handed to an action unguarded, or guarded by somebody else's
// mode, is a secret flowing in a run the auth step resolved a different mode
// for. The reading is taken off the PARSED FILE: a builder that composes the
// expression correctly and a file that drifted from it look identical from
// the builder's side, which is the whole argument for AIREVIEW-1 existing.

const SHA = "0".repeat(40);

/** An action step handed the given `with:` inputs, quoted. */
function actionStep(name: string, uses: string, inputs: Record<string, string>): string {
  const lines = Object.entries(inputs).map(([k, v]) => `          ${k}: ${JSON.stringify(v)}\n`);
  return `      - name: ${name}\n        uses: ${uses}@${SHA}\n        with:\n${lines.join("")}`;
}

/** `mode == '<mode>' && secrets.<SECRET> || ''` — the guarded form. */
function guarded(mode: string, secret: string): string {
  return `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == '${mode}' && secrets.${secret} || '' }}`;
}

/** A workflow whose review action is handed every credential, correctly. */
function guardedJob(overrides: Record<string, string> = {}): string {
  const inputs: Record<string, string> = {};
  for (const c of AI_REVIEW_AUTH_PRECEDENCE) {
    inputs[`${c.mode.replace("-", "_")}_credential`] = guarded(c.mode, c.secret);
  }
  return jobYaml([
    buildAuthDetectStep(),
    actionStep("Run the AI review", "anthropics/claude-code-action", { ...inputs, ...overrides }),
  ]);
}

describe("#631 AC-3: every credential input is guarded by its own mode, once", () => {
  test("AC-3: the scaffolded project's own file is read, and never silently empty", () => {
    // The real measurement, over the file `createCiWorkflows` just wrote.
    // Today that job hands no action a credential — the credentialed job is
    // its own sub-issue — so the honest reading is UNMEASURED BY NAME, which
    // is what this asserts: zero inputs and no unmeasured sentence would be
    // `0`, `{}` and `SKIP` wearing a pass (.claude/rules/config-access.md).
    const reading = aiReviewCredentialGuards(PROJECT);
    expect(reading.failure, `${reading.failure}`).toBeNull();
    if (reading.inputs.length === 0) {
      expect(reading.unmeasured, "no credential inputs and no UNMEASURED reading").not.toBeNull();
      expect(reading.unmeasured).toContain("UNMEASURED");
      return;
    }
    expect(reading.unmeasured).toBeNull();
    expect(reading.violations, reading.violations.join("\n")).toEqual([]);
  });

  test("AC-3: a correctly guarded job reads clean, with every credential seen", () => {
    // The non-vacuity control for the case above: a reading that refused
    // everything, or that found nothing anywhere, would also report `[]`.
    const reading = aiReviewCredentialGuards(plant(guardedJob()));
    expect(reading.unmeasured, `${reading.unmeasured}`).toBeNull();
    expect(reading.violations, reading.violations.join("\n")).toEqual([]);
    expect(reading.inputs.map(i => i.secrets.join("+")).sort()).toEqual(
      AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret).sort(),
    );
  });

  test("AC-3: an unguarded credential is refused", () => {
    const reading = aiReviewCredentialGuards(
      plant(guardedJob({ api_key_credential: "${{ secrets.ANTHROPIC_API_KEY }}" })),
    );
    expect(reading.violations.join("\n"), "a bare secret was accepted").toContain(
      "api_key_credential",
    );
    expect(reading.violations.join("\n")).toContain("0 comparison");
  });

  test("AC-3: a credential guarded TWICE is refused — exactly one comparison", () => {
    const twice =
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'api-key' && ` +
      `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode != 'none' && secrets.ANTHROPIC_API_KEY || '' }}`;
    const reading = aiReviewCredentialGuards(plant(guardedJob({ api_key_credential: twice })));
    expect(reading.violations.join("\n")).toContain("2 comparison");
  });

  test("AC-3: a credential guarded by ANOTHER mode is refused", () => {
    const reading = aiReviewCredentialGuards(
      plant(guardedJob({ api_key_credential: guarded("oauth", "ANTHROPIC_API_KEY") })),
    );
    const text = reading.violations.join("\n");
    expect(text, "a mode/secret mismatch was accepted").toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("oauth");
    expect(text).toContain("api-key");
  });

  test("AC-3: an input naming a second mode's secret is refused", () => {
    const both =
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'api-key' && ` +
      `secrets.ANTHROPIC_API_KEY || secrets.CLAUDE_CODE_OAUTH_TOKEN }}`;
    const reading = aiReviewCredentialGuards(plant(guardedJob({ api_key_credential: both })));
    const text = reading.violations.join("\n");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("AC-3: a guard that compares something other than the auth step's mode is refused", () => {
    // `secrets` is unavailable in `if:`, so the tempting guard is a `vars`
    // comparison — which is a different question answered in the same shape.
    const reading = aiReviewCredentialGuards(
      plant(
        guardedJob({
          api_key_credential: "${{ vars.AI_REVIEW_MODE == 'api-key' && secrets.ANTHROPIC_API_KEY || '' }}",
        }),
      ),
    );
    expect(reading.violations.join("\n")).toContain("0 comparison");
  });

  test("AC-3: a job that hands no action a credential is UNMEASURED, not clean", () => {
    const reading = aiReviewCredentialGuards(
      plant(jobYaml([buildAuthDetectStep(), actionStep("Checkout", "actions/checkout", { ref: "main" })])),
    );
    expect(reading.unmeasured, "an action with no credential read as guarded").not.toBeNull();
    expect(reading.unmeasured).toContain("UNMEASURED");
    expect(reading.violations).toEqual([]);
  });

  test("AC-3: the reading comes off the file, so editing the file changes it", () => {
    // Two trees, one builder. The only thing that differs is the bytes on
    // disk, so a reading taken off the builder cannot tell them apart.
    const clean = aiReviewCredentialGuards(plant(guardedJob()));
    const edited = aiReviewCredentialGuards(
      plant(guardedJob().replace(`== 'api-key' && secrets.ANTHROPIC_API_KEY`, `&& secrets.ANTHROPIC_API_KEY`)),
    );
    expect(clean.violations).toEqual([]);
    expect(edited.violations.length, "an edit to the file on disk was not read").toBeGreaterThan(0);
  });

  test("AC-3: an absent file is a FAILURE here too, not an absence of inputs", () => {
    const reading = aiReviewCredentialGuards(plant(null));
    expect(reading.failure, "a deleted workflow read as no credentials to guard").not.toBeNull();
    expect(reading.unmeasured).toBeNull();
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
