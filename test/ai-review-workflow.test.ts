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
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_ADJUDICATED_TITLE,
  AI_REVIEW_ADJUDICATOR_PACKAGE,
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_CONVENTIONS_FILE,
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_EXECUTION_ARTIFACT_NAME,
  AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_EXECUTION_STAGE_STEP_ID,
  AI_REVIEW_EXECUTION_STAGE_VAR,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_PULL_REQUEST_TYPES,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildAuthDetectScript,
  buildAuthDetectStep,
  buildBaselineScript,
  buildDriftScript,
  buildExecutionStageScript,
  AI_REVIEW_OVERRIDE_VALUE,
  AI_REVIEW_OVERRIDE_VAR,
  AI_REVIEW_APP_INSTALL_401,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_APP_INSTALL_CAUSE,
  AI_REVIEW_APP_INSTALL_URL,
  buildReviewRunScript,
  buildReviewRunStep,
  vertexCiConfig,
} from "../lib/scaffold/ai-review-step";
import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import { actionRef } from "../lib/workflow-actions";
import { declaredBunVersion, setupBunWith } from "../lib/bun-version";
import { aiReviewAuthScript, aiReviewUnmeasuredViolations } from "../lib/conformity";
import { stubBunx, stubBunxAbsent } from "./helpers/stub-bunx";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * #1140: these cases are built on real `git` subprocesses and inherit bun's
 * 5000ms default, which was never derived from what they cost. The budget is
 * calibrated on the machine running the suite — see `helpers/git-fixture-budget.ts`
 * for the measurements and the headroom.
 */
setDefaultTimeout(gitFixtureTestTimeout());

/**
 * A fixture version for the adjudicator's `bunx` pin (#1013), never the
 * real one. `buildReviewRunScript` takes the generating version as an
 * argument; passing `harnessVersion()` here would make every assertion
 * below agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";


/** Four patterns, including a bare `*` and a `**` glob — AC-3's fixture. */
const BRANCHES = ["main", "*", "*-dev", "release/**"];
const RUNNER = "ubuntu-latest";

/**
 * This file's fixture declares no `ci.vertex`, so every builder call below is
 * driven with the same reading the generator used. A case that passed a
 * DIFFERENT decision would be comparing two renderings of two configurations
 * and could never notice the generator stopping at one of them.
 */
const NO_VERTEX = vertexCiConfig({ runner: RUNNER, bunVersion: "1.2.0", branches: BRANCHES });
/**
 * `setupBunWith` is read from the PROJECT the case compares against, not from
 * this repository (#1013). `declaredBunVersion` prefers `.bun-version` over
 * `ci.bunVersion`, and the fixture scaffolded below declares only the second —
 * so a reference taken here would differ from the generated file for a reason
 * that is about the two fixtures rather than about the step.
 */
function REFS(root: string) {
  return {
    checkout: actionRef("actions/checkout"),
    auth: actionRef(GOOGLE_AUTH_ACTION),
    review: actionRef(CLAUDE_CODE_ACTION),
    setupBun: actionRef("oven-sh/setup-bun"),
    uploadArtifact: actionRef("actions/upload-artifact"),
    setupBunWith: setupBunWith(declaredBunVersion(root), "    "),
  };
}

/**
 * The GENERATING version, read the way the generator reads it (#1013).
 *
 * `FIXTURE_VERSION` is right everywhere a case drives the builder alone, and
 * wrong in the one case that compares the builder's output to a REAL scaffold:
 * there the two have to agree, and a fixture would make it fail for a reason
 * that is not about the step.
 */
function harnessVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
  return String(pkg.version);
}

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

/** This repository, for the cases that read the COMMITTED workflow. */
const REPO_ROOT = join(import.meta.dir, "..");

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
  test("AC-1: exactly one generated workflow contains buildAuthDetectStep(NO_VERTEX) byte for byte", () => {
    const files = readdirSync(workflowsDir()).sort();
    expect(files, "the scaffold wrote no ai-review.yml at all").toContain(AI_REVIEW_WORKFLOW_FILE);

    const step = buildAuthDetectStep(NO_VERTEX);
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
    expect(auth.run.trimEnd()).toBe(buildAuthDetectScript(NO_VERTEX).trimEnd());
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

/**
 * AC-3 was "the configured branches reach on.pull_request, quoted", and #1136
 * removed the first half of it: `ci.branches` no longer reaches
 * `on.pull_request` in any generated workflow, because a filter there meant a
 * pull request based on a feature branch triggered this review and nothing
 * else at all — while reporting CLEAN, since an absent workflow leaves no
 * required check pending. Measured on hornjason/pai-harness: PRs #1128 and
 * #1133, both based on `feat/713-migrate-product-hooks`, had 0 workflow runs
 * against their head SHAs where same-era PRs based on `main` had 3.
 *
 * The second half survives and is still load-bearing, so it is asserted below
 * against the one list that still exists — `on.push` in ci.yml, from the same
 * fixture. A bare `*` is a YAML alias indicator and `*-dev` an unresolved
 * alias: emit either unquoted anywhere and GitHub Actions refuses to parse
 * the file. Dropping that case with the trigger would have retired a real
 * regression test on the back of an unrelated change.
 */
describe("AC-3: no base filter on on.pull_request, and the branch globs stay quoted", () => {
  test("AC-3: ai-review.yml restricts pull_request by no base branch", () => {
    const triggers = triggersOf(Bun.YAML.parse(generated()) as any);
    expect("pull_request" in triggers, "the pull_request trigger is gone entirely").toBe(true);
    // `null` is the parse of a bare `pull_request:` key — the shape wanted.
    expect(
      triggers.pull_request === null ? [] : Object.keys(triggers.pull_request),
      "ai-review.yml still filters pull_request by base branch (#1136)",
    ).not.toContain("branches");
  });

  test("AC-3: the four glob patterns still reach ci.yml's push list, quoted", () => {
    const ci = readFileSync(join(workflowsDir(), "ci.yml"), "utf-8");
    const triggers = triggersOf(Bun.YAML.parse(ci) as any);
    expect(triggers.push.branches).toEqual(BRANCHES);
    expect(BRANCHES.length).toBe(4);
    for (const b of BRANCHES) {
      expect(ci, `${b} is not quoted`).toContain(`      - ${JSON.stringify(b)}`);
    }
  });

  test("AC-3: a project that configures no branches still gets the default on push", () => {
    const bare = scratchDir("ai-review-default-branch-");
    mkdirSync(join(bare, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(bare, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "bare", ci: { bunVersion: "1.2.0" } }, null, 2) + "\n",
    );
    createCiWorkflows(bare, []);
    const ciDoc = Bun.YAML.parse(
      readFileSync(join(bare, ".github", "workflows", "ci.yml"), "utf-8"),
    ) as any;
    expect(triggersOf(ciDoc).push.branches).toEqual(["main"]);
    const aiDoc = Bun.YAML.parse(
      readFileSync(join(bare, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
    ) as any;
    // #1207 put a `types:` key under this trigger, so the parse is a mapping
    // rather than the bare `null` it used to be. The property this case is
    // about is `branches`, and that is what is asserted — reading it as
    // "the mapping must be empty" would have made the case about a key it
    // was never written to hold an opinion on.
    const bareAiPr = triggersOf(aiDoc).pull_request;
    expect(
      bareAiPr === null ? [] : Object.keys(bareAiPr),
      "a project that configures no branches got a base filter on ai-review",
    ).not.toContain("branches");
  });
});

/**
 * AC-3b (#1207): the waiver label can reach a pull request that already exists.
 *
 * `AI_REVIEW_OVERRIDE_VAR` reads the EVENT PAYLOAD. With no `types:` the
 * trigger took GitHub's defaults — `opened`, `synchronize`, `reopened` — so
 * applying `AI_REVIEW_OVERRIDE_LABEL` fired no run at all, and a re-run
 * replays the payload that predates the label. Measured on #1198: `gh run
 * rerun --failed` returned `failure` unchanged; close + reopen flipped the
 * same commit to pass. The documented escape hatch could not be exercised by
 * the action it documents.
 *
 * **The cheapest wrong fix is `types: [labeled]`, and AC-3b is the case that
 * refuses it.** `types:` replaces the default set rather than extending it, so
 * the one-word repair fixes the waiver and silently stops a REQUIRED check
 * running on ordinary pushes. That is why the assertion is over all five
 * members and not over `labeled` alone.
 *
 * Covers CRC-C4 (CODE-REVIEW-CONVERGENCE-SPEC.md) — a finding clears on its
 * own when a later commit fixes it. `synchronize` is what makes that true —
 * every push re-runs the review over the tree as it now stands, and the
 * required check's verdict comes from that run's payload alone, so a defect
 * the author has repaired is simply not found again and nobody has to
 * dismiss anything. The membership assertion below is therefore load-bearing
 * twice over, and the wrong fix it already refuses is the one that would
 * silently break this criterion too. Worth pinning now rather than later:
 * #1319 is making a round's findings cumulative, and a carried set with no
 * clearing rule is exactly how this criterion stops holding.
 */
describe("AC-3b (#1207): on.pull_request subscribes to the label events the waiver needs", () => {
  test("AC-3b: all five activity types reach ai-review.yml, defaults included", () => {
    const pr = triggersOf(Bun.YAML.parse(generated()) as any).pull_request;
    expect(pr, "the pull_request trigger is gone entirely").not.toBeNull();
    expect(
      pr.types,
      "ai-review.yml declares no types:, so `labeled` cannot reach it (#1207)",
    ).toBeDefined();
    // Set comparison, not array equality: the ORDER of activity types is not
    // a property GitHub reads, and pinning it would make a reorder red for no
    // reason. Membership in both directions is the claim.
    expect([...pr.types].sort()).toEqual([...AI_REVIEW_PULL_REQUEST_TYPES].sort());
    for (const def of ["opened", "synchronize", "reopened"]) {
      expect(
        pr.types,
        `${def} is a GitHub default and \`types:\` REPLACES the defaults — ` +
          `dropping it stops ai-review running on an ordinary push`,
      ).toContain(def);
    }
    expect(pr.types, "the waiver label still cannot fire on an existing PR").toContain("labeled");
    expect(
      pr.types,
      "removing the label cannot put the refusal back, which the annotation promises",
    ).toContain("unlabeled");
  });

  test("AC-3b: the committed workflow carries them too — the generator is not enough", () => {
    // `.github/workflows/ai-review.yml` is the file GitHub reads on THIS
    // repository. A generator fix that nobody regenerated is a fix that is
    // live for consumers at the next release and live here never.
    const pr = triggersOf(
      Bun.YAML.parse(
        readFileSync(join(REPO_ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
      ) as any,
    ).pull_request;
    expect(
      pr?.types,
      `.github/workflows/${AI_REVIEW_WORKFLOW_FILE} on disk declares no types: — regenerate it`,
    ).toBeDefined();
    expect([...pr.types].sort()).toEqual([...AI_REVIEW_PULL_REQUEST_TYPES].sort());
  });

  test("AC-3b: the control — ci.yml and gates.yml are NOT subscribed to label events", () => {
    // Without this the fix is satisfied by putting the types on the shared
    // `CI_PULL_REQUEST_TRIGGER`, which spends a full suite run on every
    // triage label anybody applies to any pull request. Only the workflow
    // that READS a label subscribes to label events.
    for (const file of ["ci.yml", "gates.yml"]) {
      const other = triggersOf(
        Bun.YAML.parse(readFileSync(join(workflowsDir(), file), "utf-8")) as any,
      ).pull_request;
      const types: string[] = other === null ? [] : (other.types ?? []);
      expect(types, `${file} now runs on every label change, which buys no coverage`).not.toContain(
        "labeled",
      );
    }
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
    const violations = aiReviewUnmeasuredViolations(reading.script!, reading.federation);
    expect(violations, violations.join("\n")).toEqual([]);
    // This fixture declares no `ci.vertex`, so the credential-free claim is
    // the one being made. Said out loud because #631 added a second claim and
    // a case that silently took the other one would assert nothing here.
    expect(reading.federation.authStep, "the unconfigured fixture emitted an auth step").toBeNull();
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
  test("AC-5: a credential present means zero UNMEASURED annotations", () => {
    // Read off the precedence list rather than named. `GCP_SA_KEY` used to be
    // this list's first entry and is no longer in it at all (#631/#677
    // AC-15): vertex resolves from `ci.vertex`, not from a key.
    const reading = aiReviewAuthScript(PROJECT);
    const run = runAuthScript(reading.script!, { [AI_REVIEW_AUTH_PRECEDENCE[0].secret]: "x" });
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
    expect(violations.join("\n")).toContain(AI_REVIEW_AUTH_PRECEDENCE[0].secret);
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
  test("AC-7: a resolved mode emits exactly one UNMEASURED warning and refuses (#1180)", () => {
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { AI_REVIEW_MODE: "vertex" });
    const warnings = run.stdout
      .split("\n")
      .filter(l => l.startsWith("::warning") && l.includes("UNMEASURED"));
    expect(warnings.length, `a resolved mode reviewed nothing in silence\n${run.stdout}`).toBe(1);
    expect(warnings[0]).toContain("#631");
    // #1180 renamed this case and inverted its last line. It read "a tree
    // that has not opted in must not go red" — and a RESOLVED mode is a tree
    // that configured a credential and ran the action, which is not the tree
    // the opt-in is about. The opt-in protects a tree with NO credential,
    // and `mode none` below is where that is still asserted.
    expect(run.code, "a credentialed tree passed a review that produced nothing").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
  });

  test("AC-7: every credentialed mode in the ladder annotates, not just the first", () => {
    // Enumerated from the ladder rather than spot-checked: a fourth mode
    // added later with its own quiet exit would otherwise ship unobserved.
    for (const c of AI_REVIEW_AUTH_PRECEDENCE) {
      const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { AI_REVIEW_MODE: c.mode });
      const warnings = run.stdout.split("\n").filter(l => l.includes("UNMEASURED"));
      expect(warnings.length, `mode ${c.mode} passed quietly\n${run.stdout}`).toBe(1);
    }
  });

  test("AC-7: mode none is silent here, because the auth step already said it", () => {
    // One state reported once. Annotating `none` in both steps would make a
    // single unmeasured review look like two.
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { AI_REVIEW_MODE: "none" });
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code).toBe(0);
  });

  // #677 AC5 supersedes the case that used to sit here, which asserted that
  // "an unset mode is treated as none". That case borrowed the justification
  // from the one above it — `none` is silent *because the auth step already
  // said it* — and the premise is false for an unset mode: an absent output
  // means the auth step did not run, or ran and could not write. Nothing
  // annotated anywhere, and the review step exited 0.
  //
  // So "the credential check never happened" was reported exactly like "the
  // check happened and found nothing", which is *Silent Default
  // Substitution* (`.claude/rules/config-access.md`) in the file that rule's
  // own UNMEASURED section is about.
  test("#677 AC5: an absent mode is UNMEASURED, not a silent none", () => {
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {});
    const warnings = run.stdout.split("\n").filter(l => l.includes("UNMEASURED"));
    expect(
      warnings.length,
      `the auth step produced no reading and the review step said nothing\n${run.stdout}`,
    ).toBe(1);
    // Named, so the annotation sends someone somewhere. "UNMEASURED" alone
    // does not distinguish this from the four states that are measured.
    expect(warnings[0]).toContain("no mode");
    expect(run.code, "a tree that has not opted in must not go red").toBe(0);
  });

  test("#677 AC5: an absent mode and an explicit none are different states", () => {
    // The pair, varying exactly one thing. Without this the case above is
    // satisfied by annotating BOTH, which would re-report one state twice
    // and undo the case directly above this block.
    const absent = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {});
    const explicit = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { AI_REVIEW_MODE: "none" });
    expect(absent.stdout).not.toBe(explicit.stdout);
    expect(explicit.stdout, "an explicit none started annotating again").not.toContain("UNMEASURED");
  });

  test("#677 AC5: a consumer who required a review and got no reading is refused", () => {
    // The whole point of distinguishing the states. Before this, a repo with
    // RUNGATE_REQUIRE_AI_REVIEW=true whose auth step failed to produce an
    // output passed the required check in silence.
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { RUNGATE_REQUIRE_AI_REVIEW: "true" });
    expect(run.code, `an absent reading passed a required review\n${run.stdout}${run.stderr}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(run.stderr).toContain("::error");
  });

  test("#677 AC5: the require switch is still read exactly", () => {
    // A gate that turns itself on by accident is the other failure. Only the
    // exact string `true` refuses; the loose readings must not.
    for (const loose of ["TRUE", "1", "truthy", "yes", ""]) {
      const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { RUNGATE_REQUIRE_AI_REVIEW: loose });
      expect(run.code, `RUNGATE_REQUIRE_AI_REVIEW=${JSON.stringify(loose)} refused`).toBe(0);
    }
  });

  test("AC-7: a consumer who required a review and got none is refused", () => {
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
    });
    expect(run.code, "the opt-in refusal did not fire for a missing reviewer").toBe(1);
    expect(run.stderr).toContain("::error");
    expect(run.stderr).toContain("#631");
  });

  test("AC-7: the refusal reads the variable exactly, like the auth step does", () => {
    // Driven on the ABSENT-mode branch since #1180, because that is where
    // the variable still decides anything. On a resolved mode the refusal is
    // now unconditional, so running this there would assert the exactness of
    // a reading nothing consults — a case green over a decider that is not
    // the decider, which is exactly the vacuity it was written against.
    //
    // The property is unchanged: a variable that turns a gate on must match
    // one exact string, or it is a gate that turns itself on by accident.
    for (const value of ["TRUE", "True", "1", "yes", "truthy", "true "]) {
      const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
        RUNGATE_REQUIRE_AI_REVIEW: value,
      });
      expect(run.code, `${JSON.stringify(value)} turned the gate on by accident`).toBe(0);
    }
    // The control: the exact string DOES turn it on, or the loop above is
    // satisfied by a branch that never refuses.
    expect(
      runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
        RUNGATE_REQUIRE_AI_REVIEW: "true",
      }).code,
      "the exact value stopped refusing, so the loop above measures nothing",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-7: the step is in the generated file, verbatim, and carries no `if`", () => {
    expect(generated()).toContain(buildReviewRunStep(NO_VERTEX, REFS(PROJECT), harnessVersion()));
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
    const quiet = buildReviewRunScript(FIXTURE_VERSION).replace(/^echo "::warning.*$/m, ":");
    expect(quiet, "the mutation did not apply").not.toBe(buildReviewRunScript(FIXTURE_VERSION));
    const run = runAuthScript(quiet, { AI_REVIEW_MODE: "vertex" });
    expect(run.stdout).not.toContain("UNMEASURED");
    // The silence is still the defect and is still what this case measures.
    // What changed with #1180 is that silence is no longer ALSO green: the
    // refusal is a second, independent signal, so the shipped-in-#641 state
    // now costs a red check as well as an unread log. Asserted rather than
    // dropped — a mutant that went green here would mean the annotation and
    // the exit code are one decider wearing two names.
    expect(
      run.code,
      "stripping the annotation also stripped the refusal, so they are one decider",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });
});

// ── AC-9: a reviewer that completed, and the verdict taken over it ───────

/** A findings payload, so these cases are about #1013 and not about #816's skip. */
const PAYLOAD = '{"findings": [], "verdict": "PASS"}';

/**
 * An execution transcript carrying a read of the conventions file (#1167).
 *
 * This harness runs the step with the SUITE's working directory, which is
 * this repository — so `REVIEW.md` is in the "checkout" these cases present,
 * and since #1167 the payload branch refuses a payload whose transcript does
 * not show the reviewer reading it.
 *
 * Supplied to the two cases below that assert something about the branch
 * BEYOND the conventions reading. It is an input they were missing, not an
 * assertion being relaxed: a real run that wrote a payload always has a
 * transcript beside it — measured across this repository's last 40 review
 * runs, and run `39835040833` is one with both — so a fixture with a payload
 * and no transcript modelled a state the runner does not produce. Neither
 * case's subject, varied input or assertion direction moves.
 *
 * `ai-review-conventions.test.ts` is where the conventions reading itself is
 * asserted, in both directions.
 */
const CONVENTIONS_TRANSCRIPT = (() => {
  const dir = scratchDir("ai-review-transcript-");
  const path = join(dir, "claude-execution-output.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: {
                // The WORKSPACE's copy, and the workspace for this harness
                // is the suite's own working directory — `runAuthScript`
                // spawns without a `cwd`, so the step inherits it, and the
                // conventions check anchors on `${PWD}`. A literal runner
                // path here would name a directory the step never sees and
                // every case in this block would red on a fixture defect.
                // Resolved, because the anchor is the physical path.
                file_path: join(realpathSync(process.cwd()), AI_REVIEW_CONVENTIONS_FILE),
              },
            },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: false, num_turns: 9 },
    ]),
  );
  return { [AI_REVIEW_EXECUTION_FILE_VAR]: path };
})();

/**
 * The adjudicator's answers, planted (#1013).
 *
 * The real command is NOT run here. It names the tree's own version and would
 * reach the npm registry from a unit test — see `test/helpers/stub-bunx.ts`.
 * What is under test in this block is not the reader (that is
 * `ai-review-verdict-contract.test.ts`, driven through the real CLI) but the
 * STEP's reading of what came back, so the answers it has to tell apart are
 * planted and the one input that separates them is the outcome line.
 */
const plantedBunx = stubBunx;

/** What the reader prints before it decides anything. One declaration, imported. */
const OUTCOME_LINE = AI_REVIEW_OUTCOME_LINE;

describe("AC-9 (#1013): the job's exit code comes from the adjudicator's reading", () => {
  test("AC-9a: a CLEAN reading passes, so the refusal below is not unconditional", () => {
    // The control. Without it a step that exited non-zero on every payload
    // would satisfy AC-9b, and "the gate fires" would be indistinguishable
    // from "the gate is stuck closed".
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`echo "${OUTCOME_LINE} CLEAN"; exit 0`),
    }, PAYLOAD);
    expect(run.stdout, "the adjudicator's own output is not in the log").toContain(OUTCOME_LINE);
    expect(run.stdout, "a clean adjudication still reported UNMEASURED").not.toContain("UNMEASURED");
    expect(run.code, `a clean reading failed the check:\n${run.stdout}\n${run.stderr}`).toBe(0);
  });

  test("AC-9b: a BLOCKED reading fails the job — #675's second half", () => {
    // The thing #675 asked for and #1013 delivered: a blocking finding makes
    // the ai-review JOB exit non-zero. Before this the step warned and exited
    // 0, so a `critical` was a green check.
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(
        `echo "${OUTCOME_LINE} BLOCKED"\n` +
          `echo "::error title=AI review findings::1 blocking finding" >&2\n` +
          `exit ${AI_REVIEW_REQUIRED_EXIT}`,
      ),
    }, PAYLOAD);
    expect(run.stdout, "the adjudicator did not run").toContain(OUTCOME_LINE);
    expect(
      run.stdout,
      "the reader's refusal annotation never reached the log, so nobody can see why",
    ).toContain("::error title=AI review findings::");
    expect(
      run.code,
      `a blocking reading reported a green check:\n${run.stdout}\n${run.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-9c: an adjudicator that produced no reading FAILS the job", () => {
    // THE FAIL-OPEN, as a case. #1013's first cut printed a warning here and
    // exited 0 unless a consumer had opted in to RUNGATE_REQUIRE_AI_REVIEW —
    // so a payload nothing adjudicated and a payload adjudicated clean were
    // the same green required check from outside the job, which is the state
    // the issue exists to end.
    //
    // No opt-in in this environment, deliberately: the refusal has to hold on
    // a tree that has configured nothing.
    const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`echo "error: package not found" >&2; exit 1`),
    }, PAYLOAD);
    expect(
      run.code,
      `a payload nothing adjudicated reported a green check:\n${run.stdout}\n${run.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      run.stderr,
      "the refusal does not name the command that failed to produce a reading",
    ).toContain(`${AI_REVIEW_ADJUDICATOR_PACKAGE}@${FIXTURE_VERSION}`);
    expect(
      run.stdout,
      "the failed command's own output was swallowed, so nobody can see why",
    ).toContain("package not found");
    // Named as UNMEASURED and not as a blocking finding: the two have the
    // same exit code and different repairs, and an operator reading only the
    // code cannot tell a registry outage from their own `critical`.
    expect(run.stderr).toContain(AI_REVIEW_UNMEASURED_TITLE);
  });

  test("AC-9d: THE PAIR — no credential warns, an unread payload does not", () => {
    // The distinction that makes AC-9c a fix rather than a blunt instrument,
    // and the one that would be lost by "UNMEASURED always fails" applied
    // without reading which UNMEASURED.
    //
    // No credential is a review NOBODY ATTEMPTED: `.claude/rules/config-
    // access.md` argues a first scaffold should say so rather than go red,
    // and RUNGATE_REQUIRE_AI_REVIEW is the opt-in for a consumer who wants
    // otherwise. An unread payload is a review that WAS attempted, whose
    // result is on disk — the job's own reading is the only thing missing, so
    // there is nothing for a consumer to opt in to.
    //
    // Varying one input at a time: both runs are `AI_REVIEW_MODE: vertex`
    // against the same script, and the pair differs only in whether a payload
    // exists and what `bunx` answers.
    const noCredential = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "",
    });
    expect(
      noCredential.code,
      "a tree that has never configured a credential went red on its first scaffold",
    ).toBe(0);
    expect(noCredential.stdout).toContain(AI_REVIEW_UNMEASURED_TITLE);

    const unread = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`exit 127`),
    }, PAYLOAD);
    expect(
      unread.code,
      "an attempted review whose result nobody read reported green",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);

    // And the opt-in is not what carried it: the same input, with the flag
    // set, reaches the same verdict. A case that only ever ran with the flag
    // on could not tell the two apart.
    const withFlag = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
      PATH: plantedBunx(`exit 127`),
    }, PAYLOAD);
    expect(withFlag.code, "the flag changed a verdict it is not supposed to reach").toBe(
      unread.code,
    );
  });

  test("AC-9e: THE CHEAPEST WRONG FIX — exit on the code alone, with no proof it ran", () => {
    // Named and RUN, not argued about. The five-minute version of this branch
    // is `bunx … ; exit $?`, and it is green on AC-9a, AC-9b and AC-9c alike
    // — once the branch fails closed, an adjudicator that exits 1 having said
    // nothing and one that refused agree by accident.
    //
    // So the input that separates them is the one where the code is a LIE in
    // the other direction: a `bunx` that exits **0** having printed nothing.
    // Original: UNMEASURED and non-zero. Mutant: exit 0 — a green required
    // check over an adjudication that never happened.
    //
    // It is not a contrived input. `scripts/ai-review-findings.ts`'s own
    // docblock records this exact shape for this exact command: under the
    // dispatcher `import.meta.main` is false, so a module guarded on it
    // "loads, runs nothing, and the dispatcher exits 0". A wrapper, a cached
    // no-op, or a future refactor that reinstates that guard all land here.
    const naive = buildReviewRunScript(FIXTURE_VERSION).replace(
      /\n *case "\$\{adjudication\}" in\n(?:.*\n)*? *esac\n/,
      '\n    exit ${adjudicated}\n',
    );
    expect(naive, "the mutation did not apply").not.toBe(buildReviewRunScript(FIXTURE_VERSION));

    const silentSuccess = { PATH: plantedBunx(`exit 0`) };
    const env = {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      ...silentSuccess,
    };

    const mutant = runAuthScript(naive, env, PAYLOAD);
    expect(
      mutant.code,
      "the mutant did not differ — this case witnesses nothing about the run-proof",
    ).toBe(0);
    expect(mutant.stdout).not.toContain("UNMEASURED");

    const original = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), env, PAYLOAD);
    expect(
      original.code,
      `an adjudicator that exited 0 having said nothing was read as CLEAN:\n${original.stdout}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);

    // And the mutant is still green on the cases a happy-path suite would
    // have written, which is WHY it is the cheap fix rather than an obvious
    // error.
    const clean = runAuthScript(naive, {
      ...env,
      PATH: plantedBunx(`echo "${OUTCOME_LINE} CLEAN"; exit 0`),
    }, PAYLOAD);
    expect(clean.code, "the mutant is not actually a plausible fix").toBe(0);
    const blocked = runAuthScript(naive, {
      ...env,
      PATH: plantedBunx(`echo "${OUTCOME_LINE} BLOCKED"; exit ${AI_REVIEW_REQUIRED_EXIT}`),
    }, PAYLOAD);
    expect(blocked.code, "the mutant is not actually a plausible fix").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
  });

  test("AC-9g: the adjudicator does not run from the checkout", () => {
    // #1013 review. `bunx` resolves `bunfig.toml`, `.npmrc`, `package.json`
    // and `node_modules` by walking UP from the working directory, and a
    // step's working directory is the tree under review. The generated job
    // runs it from the payload's own directory instead, which the prepare
    // step guarantees is under RUNNER_TEMP.
    //
    // Driven rather than grepped: the planted `bunx` reports its own `pwd`,
    // and the case asserts it is the payload's directory and not the one
    // bash was started in.
    const script = buildReviewRunScript(FIXTURE_VERSION);
    const run = runAuthScript(script, {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`echo "${OUTCOME_LINE} CLEAN"; echo "cwd=$(pwd -P)"; exit 0`),
    }, PAYLOAD);

    const cwd = /cwd=(.*)/.exec(run.stdout)?.[1];
    expect(cwd, `the planted bunx never reported a cwd:\n${run.stdout}`).toBeDefined();
    const payloadDir = /ai-review-run-[^\n]*/.exec(cwd!)?.[0];
    expect(
      payloadDir,
      `the adjudicator ran from ${cwd}, which is not the payload's directory`,
    ).toBeDefined();
    expect(run.code).toBe(0);
  });

  test("AC-9h (#1087): an adjudicated payload says so under its own title, in both directions", () => {
    // The positive reading. Every other terminal state in this step is an
    // absence — a warning under a title three conditions share, or, since
    // #1110, no annotation at all — so "a review happened" was being inferred
    // from what did NOT come back. Measured on the 22 ai-review runs between
    // #1076 merging and 03:09:36Z on 2026-10-22: 22 green, 9 adjudicated, 8
    // skipped by the action's own workflow validation, 5 green with neither.
    //
    // Both verdict directions, because the annotation is about whether a
    // verdict was READ and not about which verdict it was. A notice emitted
    // only on the clean path would be a second spelling of exit 0.
    const clean = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`echo "${OUTCOME_LINE} CLEAN"; exit 0`),
    }, PAYLOAD);
    const blocked = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`echo "${OUTCOME_LINE} BLOCKED"; exit ${AI_REVIEW_REQUIRED_EXIT}`),
    }, PAYLOAD);

    // The annotation LINE, not the string anywhere in the output: the outcome
    // line is printed verbatim a few lines earlier, so searching the whole
    // stream for it would pass on a notice that carried no reading.
    const noticeOf = (text: string) =>
      text.split("\n").find(l => l.startsWith(`::notice title=${AI_REVIEW_ADJUDICATED_TITLE}::`));

    expect(
      noticeOf(clean.stdout),
      `a clean adjudication emitted no ${AI_REVIEW_ADJUDICATED_TITLE} notice:\n${clean.stdout}`,
    ).toBeDefined();
    expect(noticeOf(clean.stdout), "the notice carries no verdict").toContain(
      `${OUTCOME_LINE} CLEAN`,
    );
    expect(clean.code).toBe(0);

    expect(
      noticeOf(blocked.stdout),
      `a blocking adjudication emitted no notice, so a red check cannot be told ` +
        `from one that broke before the verdict:\n${blocked.stdout}`,
    ).toBeDefined();
    expect(noticeOf(blocked.stdout)).toContain(`${OUTCOME_LINE} BLOCKED`);
    expect(blocked.code).toBe(AI_REVIEW_REQUIRED_EXIT);

    // The reader prints more than the outcome line — its own `::error`
    // payload goes to stderr and both streams are captured — so the lift has
    // to stop at the first newline. A value that ran past it would put a
    // second line inside a `::notice`, which GitHub reads as the end of the
    // annotation and the start of ordinary log output.
    const noisy = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(
        `echo "reading 3 findings"\n` +
          `echo "${OUTCOME_LINE} CLEAN"\n` +
          `echo "advisory: 2 findings recorded, 0 blocking"\n` +
          `exit 0`,
      ),
    }, PAYLOAD);
    const noisyNotice = noticeOf(noisy.stdout);
    expect(noisyNotice, `no notice came back:\n${noisy.stdout}`).toContain(`${OUTCOME_LINE} CLEAN`);
    expect(
      noisyNotice,
      "the annotation swallowed the line after the verdict, so it is no longer one line",
    ).not.toContain("advisory: 2 findings");
    expect(
      noisyNotice,
      "the annotation starts at the reader's first line rather than at the verdict",
    ).not.toContain("reading 3 findings");
    expect(noisy.code).toBe(0);

    // And the two titles stay tellable apart by a reader that greps, which is
    // what the fleet queries in #1087 and #1105 both do.
    expect(AI_REVIEW_ADJUDICATED_TITLE).not.toBe(AI_REVIEW_UNMEASURED_TITLE);
    expect(
      AI_REVIEW_ADJUDICATED_TITLE,
      "the adjudicated title contains the UNMEASURED one, so a substring reader conflates them",
    ).not.toContain(AI_REVIEW_UNMEASURED_TITLE);
    expect(AI_REVIEW_UNMEASURED_TITLE).not.toContain(AI_REVIEW_ADJUDICATED_TITLE);
  });

  test("AC-9i (#1087): THE PAIR and the cheapest wrong fix — only a verdict earns the title", () => {
    // Half of the fix is that the title appears. The other half, and the one
    // that makes it evidence, is that it CANNOT appear otherwise: a notice
    // emitted on every green run would be a second way to say "the job
    // finished", which is the reading #1087 is about.
    //
    // The three states that produce a green check with no verdict, each run:
    const unverdicted = {
      "no credential": runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
        AI_REVIEW_MODE: "",
      }),
      "action skipped itself, no payload": runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_ACTION_OUTCOME: "success",
      }),
      "action did not complete": runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_ACTION_OUTCOME: "failure",
      }),
    };
    for (const [state, run] of Object.entries(unverdicted)) {
      expect(
        `${run.stdout}${run.stderr}`,
        `'${state}' claimed an adjudication it never had`,
      ).not.toContain(AI_REVIEW_ADJUDICATED_TITLE);
    }

    // THE CHEAPEST WRONG FIX, run rather than described: keep the notice and
    // widen the arm that guards it to `*)`. It is the five-minute version —
    // the step already captured the adjudicator's output, so "annotate what
    // came back" looks like the same change and is green on AC-9h.
    const original = buildReviewRunScript(FIXTURE_VERSION);
    const widened = original.replace(`*"${OUTCOME_LINE}"*)`, "*)");
    expect(widened, "the mutation did not apply").not.toBe(original);

    // The input they differ on, named: a `bunx` that prints NOTHING and exits
    // 0, with a payload on disk. Nothing adjudicated it, and no exit code
    // says so — the same shape AC-9e uses, because it is the one state where
    // every cheap reading of "did it run" agrees with success.
    const silent = {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`exit 0`),
    };
    const mutantRun = runAuthScript(widened, silent, PAYLOAD);
    expect(
      `${mutantRun.stdout}${mutantRun.stderr}`,
      "the mutant did not differ — this case witnesses nothing",
    ).toContain(AI_REVIEW_ADJUDICATED_TITLE);
    expect(mutantRun.code, "the mutant is not the plausible fix it is meant to be").toBe(0);

    const originalRun = runAuthScript(original, silent, PAYLOAD);
    expect(
      `${originalRun.stdout}${originalRun.stderr}`,
      `an adjudication that never happened was annotated as one:\n${originalRun.stdout}`,
    ).not.toContain(AI_REVIEW_ADJUDICATED_TITLE);

    // Not vacuously: the original is refusing here for #1013's reason, and
    // this case would pass on a step that emitted no notice ANYWHERE. AC-9h
    // is the half that stops that, and the two are only evidence together.
    expect(originalRun.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(originalRun.stderr).toContain(AI_REVIEW_UNMEASURED_TITLE);
  });

  test("AC-9f: the two completed/not-completed states say different things", () => {
    // A pair varying ONE reading. Without this, one sentence could cover both
    // and "the reviewer never ran" would be indistinguishable from "the
    // reviewer ran and nothing adjudicated it" — different facts, different
    // fixes.
    const base = { AI_REVIEW_MODE: "vertex" };
    const ran = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      ...base,
      AI_REVIEW_ACTION_OUTCOME: "success",
      PATH: plantedBunx(`exit 127`),
    }, PAYLOAD);
    const failed = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      ...base,
      AI_REVIEW_ACTION_OUTCOME: "failure",
    });
    // Both streams on each side. The unadjudicated state refuses on stderr
    // since #1013's review and the not-completed state still warns on stdout,
    // so comparing one stream to the other would find them "different" for
    // the trivial reason that one of them is empty.
    const ranText = `${ran.stdout}${ran.stderr}`;
    const failedText = `${failed.stdout}${failed.stderr}`;
    expect(ranText, "one sentence for two states").not.toBe(failedText);
    expect(failedText).toContain("#631");
    expect(failedText).not.toContain(AI_REVIEW_ADJUDICATOR_PACKAGE);
    expect(ranText).toContain(AI_REVIEW_ADJUDICATOR_PACKAGE);

    // And the verdicts differ too, which is the half a text comparison
    // cannot see: an attempted-but-unread review refuses, a review the
    // action never completed warns and leaves the opt-in to decide.
    // Both refuse since #1180, and the pair is still a pair: what separates
    // them is the SENTENCE, which is the half the text comparison above
    // measures. The exit codes agreeing is the point — a review the action
    // never completed and a review nobody read are both "no measurement",
    // and the branch that used to leave one of them to an unset opt-in is
    // the 14-second green on PR #1154.
    expect(ran.code, "an unread payload stopped refusing").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(failed.code, "a not-completed action still passes without the opt-in").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
  });

  test("AC-9: the silent exit is what this would have shipped", () => {
    // The mutant, run rather than described: restore the bare `exit 0` on the
    // success path and a review carrying a critical finding is a green check
    // with nothing in the log saying so.
    const quiet = buildReviewRunScript(FIXTURE_VERSION).replace(
      /if \[ "\$\{AI_REVIEW_ACTION_OUTCOME:-\}" = success \]; then\n(?:.*\n)*?fi\n/,
      'if [ "${AI_REVIEW_ACTION_OUTCOME:-}" = success ]; then\n  exit 0\nfi\n',
    );
    expect(quiet, "the mutation did not apply").not.toBe(buildReviewRunScript(FIXTURE_VERSION));
    const run = runAuthScript(quiet, {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      RUNGATE_REQUIRE_AI_REVIEW: "true",
    });
    expect(run.stdout).not.toContain("UNMEASURED");
    expect(run.code, "the mutant still refused — the mutation measured nothing").toBe(0);
  });
});

// ── #803: the one remedy a correctly-credentialed failure needs ─────────

/**
 * #803: with Workload Identity Federation fully working, run 39456331887 ran
 * all nine steps and then died on
 * `401 Unauthorized - Claude Code is not installed on this repository`,
 * retried three times, exit 1. The downstream guard reported UNMEASURED and
 * nothing was falsely green — but the one thing the consumer had to do, a
 * one-click app install, was named in a third-party action's log and nowhere
 * else. No AI review had ever run on any of the three consumer repositories,
 * and this was the reason in all of them.
 *
 * The issue proposed detecting it by greping the action's step output. **A
 * later step cannot read a previous step's stdout**, so that is not reachable
 * — see `AI_REVIEW_APP_INSTALL_CAUSE` for what the API route would cost and
 * why it is not taken. What is shipped is a NAMED CAUSE attached to the
 * generic non-zero branch, which is the shape the `skipped` branch already
 * uses for the workflow-validation guard.
 *
 * So these cases check the two things a named cause has to get right: it is
 * on the state it describes and no other, and it survives the shell.
 *
 * ## What was broken to prove it
 *
 * 55 tests — this file. Every count predicted before the battery ran, in
 * `/tmp/803-battery/predictions.md`, and **the baseline row was read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 55 pass, 0 fail | **55 pass, 0 fail** | — |
 * | P1 the genuinely pre-#803 message — the cause sentence dropped | 3 | **4 of 55** | the annotation text: it names the remedy against not |
 * | P2 **the cheapest wrong fix** — the cause attached to EVERY unmeasured state | 2 | **2 of 55** | the #816 skip state's annotation: silent about the app against naming it |
 * | P3 the two quoted fragments respelled with double quotes | 2 | **2 of 55**, and **0** before the repair below | the annotation's text: `'…'` against bare |
 * | P4 a second declaring position for the install URL | 1 | **1 of 55** | the source's declaration count |
 * | P5 the require switch deleted from this branch | 2 | **3 of 55** | `RUNGATE_REQUIRE_AI_REVIEW=true`: exit 1 against exit 0 |
 * | P6 the committed workflow hand-edited inside the report script | — | **1 of 55**, and **0** before the repair below | the committed file's bytes against the generator's output |
 *
 * ### P3 came back 0, and the premise of the case was false
 *
 * The first draft of the cause sentence spelled the two fragments with
 * double quotes, and this case asserted the generated `echo "…"` would
 * break into three lines. **It does not.** Bash closes the string,
 * concatenates the adjacent segments and strips the quotes, so the
 * annotation is one line either way — the mutant and the original were
 * being compared on a property they share
 * (`.claude/rules/checks-must-be-able-to-fail.md`: before recording a 0,
 * name an input on which they differ).
 *
 * What actually differs is the delimiters around the search string, and for
 * a message whose whole content is *grep your log for this exact text* that
 * is the content and not presentation. The case asserts them now, keeps the
 * line count as a control, and the row is 2. The generator's comment
 * claiming the echo would break has been corrected too — a false
 * justification left in place is the next reader's wrong model.
 *
 * ### P1 and P2 came back LOW, and the gap was real
 *
 * Both were predicted on the assumption that mutating the report script
 * breaks something about the committed workflow. Nothing did: `AC-1` above
 * compares the AUTH step, and every other case here drives
 * `buildReviewRunScript` directly. So `.github/workflows/ai-review.yml`
 * could carry a report script the generator no longer produces and this
 * whole file would stay green. The verbatim case was added for that, and
 * P1 is 4.
 *
 * ### …and its first draft was vacuous, which P6 is the row for
 *
 * That new case first read `generated()` — the scratch project this suite
 * scaffolds in `beforeAll`. Comparing a file the test just generated to the
 * generator that produced it is the question restated (#530), and it
 * agrees whatever the committed workflow says: a hand-edit to the real file
 * was **0 of 55**. It reads this repository's committed file now, and P6 is
 * 1.
 *
 * Three findings, all in the CASES rather than the code, and none visible
 * in the diff.
 *
 * None of the mutations is left in the tree; all were run and reverted, and
 * `lib/scaffold/ai-review-step.ts`, `.github/workflows/ai-review.yml` and
 * this file were confirmed byte-identical to the measured source afterwards
 * by SHA-256, never by `git checkout --`.
 */
describe("#803: a non-zero exit with no payload names the app install", () => {
  const failed = (env: Record<string, string> = {}) =>
    runAuthScript(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "failure",
      ...env,
    });

  test("the annotation names the remedy, the URL, and the string to search for", () => {
    const run = failed();
    expect(run.stdout).toContain("UNMEASURED");
    expect(run.stdout).toContain(AI_REVIEW_APP_INSTALL_401);
    expect(run.stdout).toContain(AI_REVIEW_APP_INSTALL_URL);
    expect(
      run.stdout,
      "the annotation does not say it is a likely cause, so it reads as a detection",
    ).toContain("naming a likely cause and not reporting a measured one");
  });

  test("the search string survives the shell WITH its quotes, on one line", () => {
    // Two claims, and the second one is here because the first was written
    // on a false premise. The first draft spelled the two fragments with
    // double quotes and this case asserted the `echo` would break into
    // three lines. It does not: bash closes the string, concatenates the
    // adjacent segments and STRIPS the quotes, so the annotation is one
    // line either way and the mutation row came back 0 of 54.
    //
    // What actually differs is the quoting around the search string, and
    // for a message whose whole content is "grep your log for this exact
    // text" that is the content rather than presentation. So the case
    // asserts the delimiters, and the line count stays as the control that
    // a future respelling has not broken the annotation outright.
    const run = failed();
    expect(
      run.stdout,
      "the search string lost its delimiters, so a reader cannot tell where it ends",
    ).toContain(`'${AI_REVIEW_APP_INSTALL_401}'`);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines.length, `the annotation broke into ${lines.length} lines:\n${run.stdout}`).toBe(1);
    expect(lines[0]).toStartWith(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}::`);
    // stderr carries the #1180 refusal now and did not before. The property
    // this line is for is unchanged — the annotation does not spill across
    // streams or lines — so it is asserted as one line of the right shape
    // rather than as emptiness, which stopped being the reading.
    const errLines = run.stderr.trimEnd().split("\n");
    expect(errLines.length, `the refusal broke into ${errLines.length} lines`).toBe(1);
    expect(errLines[0]).toStartWith(`::error title=${AI_REVIEW_UNMEASURED_TITLE}::`);
  });

  test("the three other UNMEASURED states do NOT carry it — each has its own cause", () => {
    // A hint on every state is a hint on none: the skipped state's cause is
    // the workflow-validation guard and the absent state's is a step that
    // never ran, and telling all three to go and install an app would send
    // two of them somewhere useless.
    const others = [
      { label: "mode absent", env: {}, payload: undefined },
      {
        label: "exited zero, no payload (the #816 skip)",
        env: { AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "success" },
        payload: undefined,
      },
      {
        label: "payload written, nobody adjudicates it",
        env: { AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "success" },
        payload: '{"findings":[]}',
      },
    ] as const;
    for (const o of others) {
      const run = runAuthScript(buildReviewRunScript(FIXTURE_VERSION), { ...o.env }, o.payload);
      // BOTH streams. Since #1013's review the unadjudicated state refuses
      // rather than warns, so its annotation is an `::error` on stderr while
      // the other two are `::warning`s on stdout — and a search of one stream
      // would report the state that moved as carrying no annotation at all,
      // which is the non-vacuity assertion below silently going hollow.
      const annotated = `${run.stdout}${run.stderr}`;
      expect(annotated, `${o.label} carries the app-install cause`).not.toContain(
        AI_REVIEW_APP_INSTALL_URL,
      );
      // Non-vacuity: each of these really did annotate something, so the
      // absence above is a choice and not a state that printed nothing.
      expect(annotated, `${o.label} annotated nothing at all`).toContain("UNMEASURED");
    }
  });

  test("RUNGATE_REQUIRE_AI_REVIEW no longer decides this, and the remedy survives (#1180)", () => {
    // Renamed and inverted by #1180. It read "still decides whether this
    // refuses or warns", and the warn half asserted exit 0 on the default —
    // which is the measured defect: a 401 against the Claude Code GitHub App
    // produced a green required check on every repository that had not set a
    // variable, and none had.
    //
    // The switch is not special-cased into always-green or always-red; it is
    // simply not the decider here any more. What the case still has to hold
    // is that the REMEDY survives on the refusing path, because a refusal
    // that drops the install URL is a red check nobody can act on.
    const both = [failed(), failed({ RUNGATE_REQUIRE_AI_REVIEW: "true" })];
    for (const r of both) {
      expect(r.code, "a 401 against the review app still passes").toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(r.stdout, "the remedy is gone from the refusing path").toContain(
        AI_REVIEW_APP_INSTALL_URL,
      );
    }
    // And the waiver is the input that still moves it, or the equality above
    // is satisfied by a branch with one exit in it.
    expect(
      failed({ [AI_REVIEW_OVERRIDE_VAR]: AI_REVIEW_OVERRIDE_VALUE }).code,
      "the waiver does not reach this branch, so the state is a lockout",
    ).toBe(0);
  });

  test("the committed workflow carries the generator's report script verbatim", () => {
    // Added because the battery found its absence. P1 and P2 were predicted
    // 3 and 2 on the assumption that mutating the report script would also
    // break an assertion about the committed file; they came back 2 and 1,
    // because AC-1 above compares the AUTH step and nothing compared this
    // one. So the committed `ai-review.yml` could hold a report script the
    // generator no longer produces, and every test here would still pass —
    // they all drive `buildReviewRunScript(…)` directly.
    const indented = buildReviewRunScript(harnessVersion())
      .trimEnd()
      .split("\n")
      .map(l => (l ? `          ${l}` : ""))
      .join("\n");
    // THIS repository's committed file, not `generated()`. `generated()` is
    // a scratch project this suite scaffolds in `beforeAll`, so comparing it
    // to the generator is the question restated — it agrees by construction,
    // whatever the committed workflow says (#530). The battery caught that
    // too: a hand-edit to the committed file was 0 of 55 against the first
    // draft of this case.
    const committed = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE),
      "utf-8",
    );
    expect(
      committed,
      "the committed ai-review.yml's report step is not the generator's output — it was " +
        "hand-edited, or the file was not regenerated after the generator changed",
    ).toContain(indented);
  });

  test("the URL and the 401 string each have one declaring position", () => {
    // Two copies of a URL is two things to update and one that gets missed.
    const source = readFileSync(
      join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts"),
      "utf-8",
    );
    for (const literal of [AI_REVIEW_APP_INSTALL_URL, AI_REVIEW_APP_INSTALL_401]) {
      const declarations = [
        ...source.matchAll(new RegExp(`=\\s*"${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")),
      ].length;
      expect(declarations, `${literal} is declared ${declarations} times`).toBe(1);
    }
    expect(
      AI_REVIEW_APP_INSTALL_CAUSE,
      "the cause sentence carries its own copy of the URL rather than the constant",
    ).toContain(AI_REVIEW_APP_INSTALL_URL);
  });
});

/**
 * ## #1307: the witness on the UNMEASURED route
 *
 * A run that writes no findings payload leaves no trace of the DECISION not
 * to write one, and the two explanations — the prompt lets the reviewer
 * finish without writing, or the write was attempted and lost — need
 * opposite fixes. The execution file separates them and dies with the
 * runner.
 *
 * **The premise the whole step rests on, asserted here rather than claimed
 * in a docblock:** the execution file is strictly MORE than the job log.
 * The pinned action pushes every SDK message into an array and writes all of
 * them to the file, while `sanitizeSdkOutput` returns a constructed summary
 * for `system/init` and `result` and `null` for every other type — so the
 * log carries two bookends and nothing between. Measured on run
 * `39977251682`: an `init`, a `result`, and 43 turns in between appearing
 * nowhere. Had the file been the same `result` object the log already
 * prints, this step would record the same silence in a new place.
 */
describe("#1307: the execution file is preserved when no payload was written", () => {
  /** Run the real staging script against a planted runner state. */
  const stage = (opts: { payload?: string; execution?: string | "unset" }) => {
    const dir = scratchDir("ai-review-stage-");
    const sh = join(dir, "stage.sh");
    writeFileSync(sh, buildExecutionStageScript());
    const staged = join(dir, "staged.d");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      [AI_REVIEW_EXECUTION_STAGE_VAR]: staged,
      AI_REVIEW_FINDINGS_PATH: "",
      AI_REVIEW_EXECUTION_FILE: "",
    };
    if (opts.payload !== undefined) {
      const p = join(dir, "findings.json");
      writeFileSync(p, opts.payload);
      env.AI_REVIEW_FINDINGS_PATH = p;
    }
    if (opts.execution !== undefined && opts.execution !== "unset") {
      const e = join(dir, "claude-execution-output.json");
      writeFileSync(e, opts.execution);
      env.AI_REVIEW_EXECUTION_FILE = e;
    }
    // `bash -e`, because that is what Actions runs a `run:` block with and a
    // test spawning a plain shell would be exercising different code.
    const r = Bun.spawnSync(["bash", "-e", sh], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const kept = existsSync(staged) ? readdirSync(staged) : [];
    return {
      code: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      kept,
    };
  };

  test("#1307: no payload and a transcript present — the transcript is kept", () => {
    const run = stage({ execution: '[{"type":"system","subtype":"init"}]' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.kept, "the one run this step exists for staged nothing").toEqual([
      "claude-execution-output.json",
    ]);
  });

  test("#1307: a payload was written — nothing is staged, because the run is adjudicable", () => {
    // The control for the row above. Without it, a script that copied
    // unconditionally would pass that case and cost retention on every run.
    const run = stage({ payload: "[]", execution: '[{"type":"result"}]' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.kept).toEqual([]);
  });

  test("#1307: an EMPTY payload file is not a payload, and the transcript is still kept", () => {
    // `-s`, not `-e`. A zero-byte file at the findings path is the action
    // having touched it and written nothing, which is not an adjudicable
    // round — reading it as one would lose exactly the evidence wanted.
    const run = stage({ payload: "", execution: '[{"type":"result"}]' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.kept).toEqual(["claude-execution-output.json"]);
  });

  test("#1307: neither file — nothing staged, and still exit 0", () => {
    const run = stage({});
    expect(run.code, run.stderr).toBe(0);
    expect(run.kept).toEqual([]);
  });

  test("#1307: it is a recorder — an unwritable staging target warns and does not fail", () => {
    // The copy is performed and observed failing, not described. A recorder
    // that can refuse the thing it records is worse than no recorder, and
    // this is the one failure the script can actually have.
    const dir = scratchDir("ai-review-stage-ro-");
    const sh = join(dir, "stage.sh");
    writeFileSync(sh, buildExecutionStageScript());
    const e = join(dir, "claude-execution-output.json");
    writeFileSync(e, '[{"type":"result"}]');
    // A FILE where the script wants a directory: `mkdir -p` and `cp` both
    // fail against it, which is a real runner failure rather than a mocked
    // one.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const r = Bun.spawnSync(["bash", "-e", sh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        [AI_REVIEW_EXECUTION_STAGE_VAR]: blocked,
        AI_REVIEW_FINDINGS_PATH: "",
        AI_REVIEW_EXECUTION_FILE: e,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      r.exitCode,
      `a failed copy must not turn the UNMEASURED refusal into a different red\n${r.stderr.toString()}`,
    ).toBe(0);
  });

  const stepOf = (id: string) => {
    const doc = Bun.YAML.parse(generated()) as any;
    return (doc.jobs[AI_REVIEW_JOB].steps as any[]).find(s => s.id === id);
  };

  test("#1307: both steps exist — asserted before the rows that describe them", () => {
    expect(stepOf(AI_REVIEW_EXECUTION_STAGE_STEP_ID)).toBeDefined();
    expect(stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID)).toBeDefined();
  });

  test("#1307: neither step carries an `if:` — the condition lives in the shell", () => {
    // AC-2 above asserts this for the whole job. Repeated here pointed at
    // these two steps specifically, because they are the ones that wanted an
    // `if:` and the reason they do not have one is not obvious from reading
    // them.
    expect("if" in stepOf(AI_REVIEW_EXECUTION_STAGE_STEP_ID)).toBe(false);
    expect("if" in stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID)).toBe(false);
  });

  test("#1307: the upload cannot fail the job, and an empty directory is not an error", () => {
    const art = stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID);
    expect(art["continue-on-error"]).toBe(true);
    // Without `ignore`, the no-payload-no-transcript case — the commonest
    // shape on this very route — would turn an empty directory into a red.
    expect(art.with["if-no-files-found"]).toBe("ignore");
  });

  test("#1307: the artefact name is unique per run AND per attempt", () => {
    // A re-run is the commonest way to get a second upload, and #1307's own
    // evidence is a branch that failed and then passed. Two uploads under
    // one name collide.
    const name = stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID).with.name as string;
    expect(name.startsWith(AI_REVIEW_EXECUTION_ARTIFACT_NAME)).toBe(true);
    expect(name).toContain("github.run_id");
    expect(name).toContain("github.run_attempt");
  });

  test("#1307: it is pinned the way every other action in this file is", () => {
    expect(stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID).uses).toBe(
      actionRef("actions/upload-artifact"),
    );
  });

  test("#1307: the staging target is under runner.temp, never the checkout", () => {
    // The drift step refuses a reviewer that modified the tree, against a
    // baseline taken before the review. A staging directory in the workspace
    // would be read as the reviewer's write and fail every UNMEASURED run
    // for the wrong reason.
    const env = stepOf(AI_REVIEW_EXECUTION_STAGE_STEP_ID).env;
    expect(env[AI_REVIEW_EXECUTION_STAGE_VAR]).toContain("runner.temp");
    expect(stepOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID).with.path).toContain("runner.temp");
  });

  test("#1307: staging runs before the upload, and both before the report step", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const ids = (doc.jobs[AI_REVIEW_JOB].steps as any[]).map(s => s.id);
    const stageAt = ids.indexOf(AI_REVIEW_EXECUTION_STAGE_STEP_ID);
    const uploadAt = ids.indexOf(AI_REVIEW_EXECUTION_ARTIFACT_STEP_ID);
    const reportAt = ids.indexOf(AI_REVIEW_RUN_STEP_ID);
    expect(stageAt).toBeLessThan(uploadAt);
    // The load-bearing half: the report step exits non-zero on exactly the
    // runs this evidence is for, and nothing after a failed step runs
    // without the `if:` this job may not use.
    expect(uploadAt, "an upload after the report step never runs on a refusal")
      .toBeLessThan(reportAt);
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
  /**
   * Run a drift script inside a real git repo, with a real commit, AFTER a
   * real baseline reading.
   *
   * The baseline is taken BEFORE `plant` runs and the drift script after it,
   * which is the order the generated job has — and it is what makes "the
   * reviewer wrote this" mean anything. `before` plants something while the
   * baseline is still being established, which is how the credentials-file
   * case below says "this was already here".
   */
  function runDrift(
    plant: (dir: string) => void,
    env: Record<string, string> = {},
    script: string = buildDriftScript(),
    before: (dir: string) => void = () => {},
  ): Run {
    const dir = scratchDir("ai-review-drift-");
    const genv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { env: genv });
    Bun.spawnSync(["git", "init", "-q", dir], { env: genv });
    // The identity writes name `-C dir` at the CALL SITE rather than through
    // `git()`. #84's guard reads source text, so a wrapper that binds the
    // directory is invisible to it — and it is right not to guess: a
    // `git config user.*` whose target is not on the line is one refactor
    // from writing the developer's own identity into their own repo.
    Bun.spawnSync(["git", "-C", dir, "config", "user.email", "t@example.invalid"], { env: genv });
    Bun.spawnSync(["git", "-C", dir, "config", "user.name", "t"], { env: genv });
    writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    // Everything the runner already had when the reviewer started.
    before(dir);

    // The real baseline step, run rather than simulated. A hand-written
    // "before" file would be a fixture asserting its own input.
    // A scratch HOME, not the developer's. The drift step walks $HOME for
    // writes the reviewer made outside the checkout and REFUSES on anything
    // the runtime does not own (#866), so a run pointed at a real home is a
    // run whose verdict depends on what else that machine was doing.
    const home = scratchDir("ai-review-drift-home-");
    const runnerTemp = scratchDir("ai-review-drift-temp-");
    const baselineSh = join(scratchDir("ai-review-drift-baseline-"), "baseline.sh");
    writeFileSync(baselineSh, buildBaselineScript());
    const baselineOut = join(runnerTemp, "github-output");
    writeFileSync(baselineOut, "");
    const b = Bun.spawnSync(["bash", "-e", baselineSh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: baselineOut,
      },
    });
    const bErr = new TextDecoder().decode(b.stderr);
    expect(b.exitCode, `the baseline step refused, so no case below measured anything:\n${bErr}`).toBe(0);
    const beforePath = /^path=(.*)$/m.exec(readFileSync(baselineOut, "utf-8"))?.[1] ?? "";
    expect(beforePath, "the baseline step wrote no path output").not.toBe("");

    plant(dir);
    const sh = join(scratchDir("ai-review-drift-script-"), "drift.sh");
    writeFileSync(sh, script);
    const r = Bun.spawnSync(["bash", "-e", sh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_TREE_BEFORE: beforePath,
        ...env,
      },
    });
    return {
      code: r.exitCode,
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
    };
  }

  test("#843 finding 5: an EMPTY mode is compared, an explicit `none` is skipped", () => {
    // A pair that varies exactly one thing: the value of AI_REVIEW_MODE.
    // The same repository, the same post-baseline write, the same script.
    //
    // `${AI_REVIEW_MODE:-none}` substituted `none` for empty and exited 0
    // without comparing anything, so a tree that moved while the auth step's
    // output was unreadable was waved through — the Silent Default
    // Substitution #677 removed from the report step, still in place here.
    //
    // Both halves are asserted. Empty alone would be satisfied by a script
    // that stopped skipping anything at all, which would turn every
    // unconfigured consumer's drift step into a comparison nobody asked for.
    const plant = (dir: string) => writeFileSync(join(dir, "reviewer-wrote-this.ts"), "x\n");
    const empty = runDrift(plant, { AI_REVIEW_MODE: "" });
    expect(empty.code, "an unreadable mode skipped the comparison").not.toBe(0);
    expect(empty.stderr).toContain("reviewer-wrote-this.ts");

    const explicit = runDrift(plant, { AI_REVIEW_MODE: "none" });
    expect(
      explicit.code,
      "an explicit `none` now runs the comparison — no credential means no reviewer to police",
    ).toBe(0);
    expect(explicit.stderr).toBe("");

    // Measured, 56 tests, predicted before the run and baseline read first:
    //   Q1 the pre-#843 `${AI_REVIEW_MODE:-none}` restored — predicted 2,
    //      measured 1 of 56. The prediction counted the two HALVES of this
    //      case as two cases; they are one. Differing input: an empty mode
    //      over a tree with a post-baseline write.
    //   Q2 the cheapest wrong fix, the skip deleted outright — predicted 2,
    //      measured 2 of 56: this case and AC-10's `mode none does not run
    //      the check at all`.
    // The asymmetry is the thing to carry away. Q2 has two witnesses; Q1 has
    // exactly ONE, and it is this case. Nothing else in the tree can see the
    // empty-mode direction, so do not delete it as redundant with AC-10's.
  });

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

  test("AC-10: a git that could not read the tree is refused, not read as clean", () => {
    // `changed=$(git status ...)` discards git's exit code, so a git that
    // failed produces the empty string — the same value a clean tree
    // produces. The input: a directory that is not a git repository at all,
    // which is what a checkout step that silently did nothing leaves behind.
    const dir = scratchDir("ai-review-drift-nonrepo-");
    writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
    const sh = join(scratchDir("ai-review-drift-nonrepo-script-"), "drift.sh");
    writeFileSync(sh, buildDriftScript());
    // A baseline IS present. Without it the step refuses for a different and
    // correct reason, and this case would pass over a script that had stopped
    // reading git at all — two refusals, one assertion, neither isolated.
    const beforePath = join(scratchDir("ai-review-drift-nonrepo-temp-"), "before.txt");
    writeFileSync(beforePath, "");
    const r = Bun.spawnSync(["bash", "-e", sh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: scratchDir("ai-review-home-"),
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_TREE_BEFORE: beforePath,
      },
    });
    const stderr = new TextDecoder().decode(r.stderr);
    expect(r.exitCode, `an unreadable tree reported clean:\n${stderr}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(stderr, "the refusal does not say the tree was never read").toContain("UNMEASURED");
    expect(stderr, "the refusal blamed the missing baseline, not the unreadable tree").toContain(
      "git status failed",
    );
  });

  test("AC-10: a path the branch chose cannot forge a workflow command", () => {
    // The path in the refusal came out of the branch under review, so it is
    // a string an attacker picks. git quotes a path containing a newline, so
    // the reachable character here is `%` — which GitHub decodes in an
    // annotation body, making `%0A` in a filename a line break in the
    // rendered message. One encoder, applied where the value is captured.
    const run = runDrift(dir => writeFileSync(join(dir, "a%0Ab.json"), "{}"));
    expect(run.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    const lines = run.stderr.split("\n").filter(l => l.length > 0);
    expect(lines.length, `the refusal spans ${lines.length} lines:\n${run.stderr}`).toBe(1);
    expect(lines[0], "the percent was not encoded").toContain("a%250Ab.json");
    expect(lines[0], "the raw sequence survived into the annotation").not.toContain("a%0Ab");
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
    // The anchor is the drift step's call into the shared reader (#853); it
    // used to be an inline `git status`. What is mutated is unchanged: which
    // command does the reading.
    const mutant = buildDriftScript().replace(
      /after=\$\(read_tree\)/,
      "after=$(git diff --name-only; git diff --cached --name-only)",
    );
    expect(
      mutant,
      "could not build the mutant: the status reading appears 0 times in the script",
    ).not.toBe(buildDriftScript());

    // The same planted file, the same fixture, one thing varied: which
    // command does the reading. The real script refuses it two cases above.
    const plant = (dir: string) => writeFileSync(join(dir, "ai-review-findings.json"), "{}");
    expect(runDrift(plant).code, "the control stopped refusing").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      runDrift(plant, {}, mutant).code,
      "the mutant refused — the mutation measured nothing",
    ).toBe(0);
  });

  /**
   * #631. The confirmed defect this baseline closes, reproduced and measured.
   *
   * `google-github-actions/auth` defaults `create_credentials_file: true` and
   * writes that file into `$GITHUB_WORKSPACE` — the checkout root — removing
   * it only in a POST step, which runs after every ordinary step. So in
   * vertex mode the file is present when the drift step reads the tree, and
   * the previous total reading reported "The reviewer modified the tree it
   * was reviewing" on EVERY credentialed run, naming a file the reviewer did
   * not create. Permanently red in exactly the mode this issue is about.
   *
   * Workload Identity Federation does not remove the file. It removes the KEY
   * MATERIAL in it, which is a different and smaller problem.
   */
  test("AC-10/#631: the credentials file the auth step wrote is not the reviewer's doing", () => {
    const run = runDrift(
      () => {},
      {},
      buildDriftScript(),
      dir => writeFileSync(join(dir, "gha-creds-0123456789abcdef.json"), '{"type":"external_account"}'),
    );
    expect(
      run.code,
      `the drift gate accused the reviewer of the auth step's own file:\n${run.stderr}`,
    ).toBe(0);
  });

  test("AC-10/#631: a reviewer's file is still refused while that one is present", () => {
    // The control for the case above, and the thing that stops it reading as
    // "the gate stopped refusing". One input varies: who wrote the file.
    const run = runDrift(
      dir => writeFileSync(join(dir, "planted-by-the-reviewer.json"), "{}"),
      {},
      buildDriftScript(),
      dir => writeFileSync(join(dir, "gha-creds-0123456789abcdef.json"), '{"type":"external_account"}'),
    );
    expect(run.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.stderr).toContain("planted-by-the-reviewer.json");
    expect(
      run.stderr,
      "the refusal named the credentials file, which was there before the reviewer ran",
    ).not.toContain("gha-creds");
  });

  test("AC-10/#631: an absent baseline is UNMEASURED, not a tree that did not change", () => {
    // "Nobody looked before" and "nothing changed" must not be one answer.
    const dir = scratchDir("ai-review-drift-nobaseline-");
    const sh = join(scratchDir("ai-review-drift-nobaseline-script-"), "drift.sh");
    writeFileSync(sh, buildDriftScript());
    const r = Bun.spawnSync(["bash", "-e", sh], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: scratchDir("ai-review-home-"),
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_TREE_BEFORE: join(dir, "does-not-exist.txt"),
      },
    });
    const stderr = new TextDecoder().decode(r.stderr);
    expect(r.exitCode, `a missing baseline passed:\n${stderr}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(stderr).toContain("UNMEASURED");
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
      `    runs-on: "ubuntu-latest"\n    steps:\n${buildAuthDetectStep(NO_VERTEX)}`;
    const reading = aiReviewAuthScript(plant(yml));
    expect(reading.failure, "a job-level if: was accepted").not.toBeNull();
    expect(reading.failure).toContain("if");
  });

  test("a renamed job is a FAILURE, not an absent-and-therefore-clean job", () => {
    const yml =
      `name: AI Review\non:\n  pull_request:\n    branches:\n      - "main"\n\njobs:\n` +
      `  review:\n    runs-on: "ubuntu-latest"\n    steps:\n${buildAuthDetectStep(NO_VERTEX)}`;
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
/**
 * `payload` plants a findings file and points the script at it.
 *
 * Since #816 the report step distinguishes "the action exited zero and wrote
 * a payload" from "the action exited zero and wrote nothing" — the second is
 * the workflow-validation self-skip, which was reading as a completed review.
 * So a case about the ADJUDICATION gap has to supply a payload, or it is
 * really a case about the skip wearing the wrong name.
 */
function runAuthScript(
  script: string,
  env: Record<string, string>,
  payload?: string,
): Run {
  const dir = scratchDir("ai-review-run-");
  const sh = join(dir, "auth-detect.sh");
  writeFileSync(sh, script);
  const out = join(dir, "github_output");
  writeFileSync(out, "");
  const planted: Record<string, string> = {};
  if (payload !== undefined) {
    const findings = join(dir, "ai-review-findings.json");
    writeFileSync(findings, payload);
    planted.AI_REVIEW_FINDINGS_PATH = findings;
    // #1167, and attached to the PAYLOAD rather than offered separately:
    // the two travel together on a runner. A payload exists only if the
    // reviewer executed, and a reviewer that executed leaves a transcript —
    // measured across this repository's last 40 review runs, where
    // `AI_REVIEW_EXECUTION_FILE` is set on all five that ran the agent and
    // empty only on the skips, which write no payload. A fixture with one
    // and not the other modelled a state the runner does not produce, and
    // since #1167 the payload branch reads the transcript for the
    // conventions load.
    //
    // `...env` still wins, so a case about a different transcript sets its
    // own; `ai-review-conventions.test.ts` is where that reading is the
    // subject, with its own workspace.
    Object.assign(planted, CONVENTIONS_TRANSCRIPT);
  }
  const r = Bun.spawnSync(["bash", "-e", sh], {
    env: {
      // `bunx` is stubbed absent by DEFAULT (#1013). A case that supplies a
      // payload and does not plant one would otherwise run the real command,
      // which names this tree's version and reaches the npm registry — slow,
      // offline-hostile, and a reading of what npm served today rather than
      // of the script. `...env` still wins, so the AC-9 cases plant their
      // own. Measured: before this default, `#803`'s case was fetching
      // `rungate@0.0.0-fixture` from the network on every run.
      PATH: stubBunxAbsent(),
      HOME: process.env.HOME ?? dir,
      GITHUB_OUTPUT: out,
      ...planted,
      ...env,
    },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}
