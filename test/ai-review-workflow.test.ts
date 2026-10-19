/**
 * ai-review-workflow.test.ts — the generated `.github/workflows/ai-review.yml`
 * (#630, wave 2: AC-7 and AC-11).
 *
 * Wave 1 shipped `lib/scaffold/ai-review-step.ts` — the auth-detect step, and
 * the tests that RUN it. Nothing wrote it into a file. This is the file, and
 * the conformity check that executes the copy on disk.
 *
 * Covers AC-1, AC-2 (the generated workflow) and AC-4, AC-5 (the conformity
 * case). AC-6 lives in `test/release-guard.test.ts`, beside the tuple it is
 * about.
 *
 * Covers SC-2106, SC-2107, SC-2108, SC-2109, SC-2110, SC-2111
 * (HARNESS-STANDARD.md) — #631's AC-7, AC-8, AC-8f, AC-8g and AC-8h.
 *
 * #630's AC-3 — "the configured branches reach `on.pull_request`, quoted" —
 * is GONE rather than merely unasserted, and deliberately: #631 AC-8g takes
 * the `pull_request` trigger away entirely, so there is no longer a branch
 * list in this file for it to be about. The glob-quoting behaviour it
 * exercised is still measured over `ci.yml` and `gates.yml` by
 * `test/scaffold-ci-config.test.ts`, and the claim that replaces it here is
 * the opposite one: a configured branch list must NOT reach this workflow.
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
 * ## #631: four more invariants, and why they are four bindings
 *
 * The expansion must not quietly regress what #630 bought, so AC-7, AC-8,
 * AC-8f and AC-8g are asked by four exported bindings — `bareModelAliasViolations`,
 * `credentialIsolation`, `findingsStepViolations` and the `triggerViolations`
 * / `unpinnedUsesViolations` pair. One binding per question, because #484's
 * lesson is that two questions folded into one assertion are satisfied by
 * either, and because a mutation of one has to be readable as a count against
 * the cases that are about it and no others.
 *
 * Every red half is DERIVED from the live generated workflow rather than
 * written out beside it (#585). `credentialIsolation` is the one of the four
 * that can decline to return a verdict at all, and the pair of cases over it
 * is why: with #631's review action wired, all three credentials reach it and
 * the reading is MEASURED and clean, while the same workflow with its
 * hand-overs blanked reports UNMEASURED and names the reason. "No violations"
 * is true of both, which is what makes it useless as the whole answer — so
 * the live case asserts WHICH credentials were carried before it asserts that
 * none of them was unguarded.
 *
 * The #631 mutation counts are recorded in `specs/HARNESS-STANDARD.md`.
 *
 * ## What was broken to prove these fail, run and counted rather than asserted
 *
 * Baselines: this file 21 pass / 0 fail at #630, 51 pass / 0 fail at #631;
 * `bun test test/scaffold-conformity.test.ts -t AIREVIEW-1` 1 pass / 0 fail.
 * None of the mutations is left in the tree; all were run and reverted, and
 * both files were confirmed to return to their baselines afterwards.
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
import {
  AI_REVIEW_CHECKOUT_ACTION,
  AI_REVIEW_CHECKOUT_SHA,
  AI_REVIEW_CHECKOUT_VERSION,
  AI_REVIEW_FINDINGS_PATH,
  AI_REVIEW_FINDINGS_STEP_ID,
  AI_REVIEW_FINDINGS_STEP_NAME,
  AI_REVIEW_MODEL_ALIASES,
  buildFindingsVerdictStep,
  buildReviewCheckoutStep,
  createCiWorkflows,
} from "../lib/scaffold/steps";
import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_RUN_STEP_NAME,
  AI_REVIEW_WORKFLOW_FILE,
  buildAuthDetectScript,
  buildAuthDetectStep,
  buildReviewRunScript,
  buildReviewRunStep,
} from "../lib/scaffold/ai-review-step";
import { aiReviewAuthScript, aiReviewUnmeasuredViolations } from "../lib/conformity";

/**
 * Four patterns, including a bare `*` and a `**` glob.
 *
 * #630's AC-3 asserted these reached `on.pull_request.branches` quoted. #631
 * AC-8g takes the trigger away, so they are kept here as the input to the
 * opposite claim: a configured branch list must NOT reach a file that cannot
 * fire on a branch event. The quoting of glob patterns is still measured,
 * over `ci.yml` and `gates.yml`, by `test/scaffold-ci-config.test.ts`.
 */
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

// ── #631 AC-7 / AC-8 / AC-8f / AC-8g: the expanded job's invariants ──────
//
// Four questions, four exported bindings, one binding each. They are separate
// because #484's lesson is that two questions folded into one assertion are
// satisfied by either — and because a mutation of one of them has to be
// readable as a count against the cases that are about it and no others.
//
// Every red half below is DERIVED from the live generated workflow rather
// than written out beside it (#585): a pair of hand-written literals can
// carry a second difference the comparison was never meant to vary, and the
// next edit touches one of them.

/** A 40-hex commit sha, which is the only ref a `uses:` here may carry. */
const SHA_PIN = /^[0-9a-f]{40}$/;

/**
 * Every `uses:` line in a workflow, with the action and the ref split out.
 *
 * Line-based rather than parsed on purpose: a `uses:` the YAML parser cannot
 * reach — a malformed step, a commented-out one somebody is about to restore
 * — is still a line a reader takes as the project's convention, and the claim
 * AC-8g makes is about the file.
 */
export function usesLines(yml: string): Array<{ line: number; action: string; ref: string }> {
  const out: Array<{ line: number; action: string; ref: string }> = [];
  yml.split("\n").forEach((raw, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(raw);
    if (!m) return;
    const at = m[1].lastIndexOf("@");
    out.push({
      line: i + 1,
      action: at < 0 ? m[1] : m[1].slice(0, at),
      ref: at < 0 ? "" : m[1].slice(at + 1),
    });
  });
  return out;
}

/** AC-8g: every `uses:` is pinned to a commit sha, not to a movable tag. */
export function unpinnedUsesViolations(yml: string): string[] {
  return usesLines(yml)
    .filter(u => !SHA_PIN.test(u.ref))
    .map(
      u =>
        `line ${u.line}: ${u.action} is pinned to ${JSON.stringify(u.ref)}, which is not a ` +
        `commit sha — a tag is a mutable pin and this job hands a credential to the runner`,
    );
}

/**
 * AC-7: no bare `opus`, `sonnet` or `haiku` alias anywhere in the file.
 *
 * The boundary is `-` as well as word characters, so `claude-opus-5-5` is NOT
 * an alias and `--model opus` is. A detector that matched the substring would
 * refuse every pinned identifier, which is the opposite check wearing the
 * same name — so the pinned form has a case of its own below.
 */
export function bareModelAliasViolations(yml: string): string[] {
  const out: string[] = [];
  const lines = yml.split("\n");
  for (const alias of AI_REVIEW_MODEL_ALIASES) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${alias}(?![A-Za-z0-9_-])`);
    lines.forEach((line, i) => {
      if (re.test(line)) {
        out.push(
          `line ${i + 1} names the bare alias \`${alias}\`, which re-points the day the ` +
            `provider moves it: ${line.trim()}`,
        );
      }
    });
  }
  return out;
}

/**
 * AC-8g: the trigger is manual dispatch and nothing else.
 *
 * Both halves are asserted, because they fail in different directions: a file
 * that declares no `workflow_dispatch` cannot be run at all, and a file that
 * declares `pull_request` beside it hands the reviewer's comment tool to
 * anyone who can open a pull request. The text search is deliberate rather
 * than redundant — `pull_request` inside a job-level `if:`, a comment or an
 * expression is not a trigger and is still the thing being kept out.
 */
export function triggerViolations(yml: string): string[] {
  const out: string[] = [];
  let doc: any;
  try {
    doc = Bun.YAML.parse(yml);
  } catch (e) {
    return [`the workflow does not parse as YAML: ${(e as Error).message}`];
  }
  const triggers = triggersOf(doc);
  if (triggers === undefined || triggers === null) {
    out.push("the workflow declares no `on:` triggers at all, so nothing can ever run it");
  } else {
    const keys = typeof triggers === "string" ? [triggers] : Object.keys(triggers);
    if (!keys.includes("workflow_dispatch")) {
      out.push(
        `the workflow does not declare workflow_dispatch (declares: ${keys.join(", ") || "none"})`,
      );
    }
    const extra = keys.filter(k => k !== "workflow_dispatch");
    if (extra.length > 0) {
      out.push(
        `the workflow declares ${extra.join(", ")} beside workflow_dispatch — manual ` +
          `dispatch only is the control, not a default`,
      );
    }
  }
  if (yml.includes("pull_request")) {
    out.push(
      "`pull_request` appears in the generated file. The reviewer's comment tool is an " +
        "egress sink, so an automatic trigger hands it to anyone who can open a pull request",
    );
  }
  return out;
}

/**
 * AC-8f: the findings step is in the job, and it is after the review step.
 *
 * Presence is established for BOTH steps before either index is compared.
 * `indexOf` returns -1 for an absent step and `-1 < n` is true, so a
 * comparison alone would read the deletion of the review step as correct
 * ordering — the #518 shape, where one side of a comparison has been removed
 * and the comparison duly reports a distinction.
 */
export function findingsStepViolations(yml: string): string[] {
  const out: string[] = [];
  let doc: any;
  try {
    doc = Bun.YAML.parse(yml);
  } catch (e) {
    return [`the workflow does not parse as YAML: ${(e as Error).message}`];
  }
  const job = doc?.jobs?.[AI_REVIEW_JOB];
  if (!job || typeof job !== "object") {
    return [`the workflow has no job named ${AI_REVIEW_JOB}`];
  }
  const steps: any[] = Array.isArray(job.steps) ? job.steps : [];
  const at = (id: string) => steps.findIndex(s => s && typeof s === "object" && s.id === id);
  const run = at(AI_REVIEW_RUN_STEP_ID);
  const findings = at(AI_REVIEW_FINDINGS_STEP_ID);

  if (run < 0) {
    out.push(
      `no step with id ${AI_REVIEW_RUN_STEP_ID} — the step the findings step has to follow ` +
        `is absent, so its position cannot be read`,
    );
  }
  if (findings < 0) {
    out.push(
      `no step with id ${AI_REVIEW_FINDINGS_STEP_ID} — a job that never reads ` +
        `${AI_REVIEW_FINDINGS_PATH} has not reported what the review found, it has not ` +
        `looked`,
    );
  }
  if (run >= 0 && findings >= 0 && findings < run) {
    out.push(
      `the findings step is at index ${findings} and the review step at index ${run}: a ` +
        `payload read before the reviewer writes it is always absent`,
    );
  }
  return out;
}

/** What `credentialIsolation` could establish about a generated workflow. */
export interface CredentialIsolationReading {
  reading: "MEASURED" | "UNMEASURED";
  /** Named when, and only when, the reading is UNMEASURED. */
  reasons: string[];
  /**
   * The secrets that reached a step outside the auth detector, in precedence
   * order. The reading and this list are two projections of one walk, so they
   * cannot disagree — and it is what stops `violations: []` being read as a
   * verdict on a job that handed nothing over. An empty violation list over
   * three carried credentials and an empty violation list over zero are
   * different facts, and only the first one is a pass.
   */
  carried: string[];
  violations: string[];
}

/**
 * AC-8: each resolved mode reaches the action with only its own credential.
 *
 * Asked structurally, not by input name. The names of the review action's
 * inputs belong to `lib/scaffold/ai-review-step.ts`; re-typing them here
 * would be a second decider that agrees with that one until the day it does
 * not. The property that does not depend on them: every `${{ }}` expression
 * outside the auth-detect step that reads `secrets.X` must be guarded by the
 * mode `X` resolves to, so a key can only be handed over in the one mode that
 * authenticates with it.
 *
 * A workflow in which no step outside the auth detector reads any credential
 * is UNMEASURED, not clean — `0`, `{}` and silence are indistinguishable from
 * success where UNMEASURED is not (`.claude/rules/config-access.md`). That was
 * this repository's own state through #630, when the job resolved a mode and
 * had nothing to hand it to; since #631 wired the review action it is the
 * reading of a job that has LOST its reviewer, which is the regression the
 * withholding exists to keep legible.
 */
export function credentialIsolation(yml: string): CredentialIsolationReading {
  let doc: any;
  try {
    doc = Bun.YAML.parse(yml);
  } catch (e) {
    return {
      reading: "UNMEASURED",
      reasons: ["WORKFLOW_UNPARSEABLE"],
      carried: [],
      violations: [`the workflow does not parse as YAML: ${(e as Error).message}`],
    };
  }
  const job = doc?.jobs?.[AI_REVIEW_JOB];
  const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
  const violations: string[] = [];
  const carried: string[] = [];

  for (const step of steps) {
    if (!step || typeof step !== "object" || step.id === AI_REVIEW_AUTH_STEP_ID) continue;
    const text = JSON.stringify(step);
    for (const expr of text.match(/\$\{\{[^}]*\}\}/g) ?? []) {
      for (const c of AI_REVIEW_AUTH_PRECEDENCE) {
        if (!expr.includes(`secrets.${c.secret}`)) continue;
        if (!carried.includes(c.secret)) carried.push(c.secret);
        const guard = `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == '${c.mode}'`;
        if (!expr.includes(guard)) {
          violations.push(
            `step ${step.id ?? step.name ?? "(unnamed)"} hands over ${c.secret} in an ` +
              `expression that is not guarded by \`${guard}\`, so a mode that does not ` +
              `authenticate with it still receives it: ${expr}`,
          );
        }
      }
    }
  }

  if (carried.length === 0) {
    return {
      reading: "UNMEASURED",
      reasons: ["NO_CREDENTIAL_REACHES_A_STEP"],
      carried,
      violations: [],
    };
  }
  return { reading: "MEASURED", reasons: [], carried, violations };
}

// ── The derivations the red halves are built from ────────────────────────

/** Append a step to the job, which is where the generated steps list ends. */
function plantStep(yml: string, step: string): string {
  return `${yml.trimEnd()}\n${step.trimEnd()}\n`;
}

/** The index of the findings step's `- name:` line in the generated text. */
function findingsStepAt(yml: string): number {
  return yml.indexOf(`      - name: ${AI_REVIEW_FINDINGS_STEP_NAME}`);
}

/**
 * The generated workflow with every credential hand-over blanked, and the
 * auth detector left exactly as it is.
 *
 * The input the UNMEASURED branch is about, DERIVED rather than written out
 * beside the real one (#585): it differs from `generated()` in one thing — no
 * expression outside the auth step reads a secret — so a case over the pair
 * is a measurement of that and nothing else. The guard shape is deliberately
 * not re-typed here; every `${{ }}` carrying `secrets.` goes, whatever it is
 * guarded by, because a derivation that knew the guard would stop deriving
 * the day the guard changed.
 */
function withoutCredentialHandovers(yml: string): string {
  const authAt = yml.indexOf(`        id: ${AI_REVIEW_AUTH_STEP_ID}`);
  expect(authAt, "the auth step is not where the derivation expects it").toBeGreaterThan(-1);
  const after = yml.indexOf("      - name: ", authAt);
  expect(after, "no step follows the auth step — nothing to blank").toBeGreaterThan(-1);
  return yml.slice(0, after) + yml.slice(after).replace(/\$\{\{[^}]*secrets\.[^}]*\}\}/g, "''");
}

describe("AC-8g: the trigger is manual dispatch, and `pull_request` is nowhere", () => {
  test("AC-8g: the generated workflow declares workflow_dispatch and nothing else", () => {
    const violations = triggerViolations(generated());
    expect(violations, violations.join("\n")).toEqual([]);
    // Presence before comparison: an empty trigger map would satisfy "declares
    // nothing but workflow_dispatch" without declaring workflow_dispatch.
    expect(Object.keys(triggersOf(Bun.YAML.parse(generated()) as any))).toEqual([
      "workflow_dispatch",
    ]);
  });

  test("AC-8g: restoring the pull_request trigger turns the case red", () => {
    const mutant = generated().replace("on:\n  workflow_dispatch:\n", 'on:\n  pull_request:\n    branches:\n      - "main"\n');
    expect(mutant, "the mutation did not apply").not.toBe(generated());
    const violations = triggerViolations(mutant);
    expect(violations.join("\n")).toContain("workflow_dispatch");
    expect(violations.join("\n")).toContain("egress sink");
  });

  test("AC-8g: ADDING pull_request beside workflow_dispatch is also red", () => {
    // "Manual dispatch ONLY" is the claim. A detector that only noticed the
    // removal of workflow_dispatch would pass the cheapest way back in.
    const mutant = generated().replace(
      "on:\n  workflow_dispatch:\n",
      'on:\n  workflow_dispatch:\n  pull_request:\n    branches:\n      - "main"\n',
    );
    expect(mutant, "the mutation did not apply").not.toBe(generated());
    const violations = triggerViolations(mutant);
    expect(violations.length, violations.join("\n")).toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("beside workflow_dispatch");
  });

  test("AC-8g: a configured branch list does not reach this file at all", () => {
    // The fixture configures four patterns, including a bare `*`. They belong
    // to ci.yml and gates.yml; a branch filter on a trigger that cannot fire
    // on a branch event is configuration that reads as a control and is not.
    expect(BRANCHES.length).toBe(4);
    for (const b of BRANCHES) {
      expect(generated(), `${b} reached the ai-review workflow`).not.toContain(
        `      - ${JSON.stringify(b)}`,
      );
    }
  });
});

describe("AC-8g: every `uses:` in the generated workflow is SHA-pinned", () => {
  test("AC-8g: there is at least one `uses:`, and every one of them is a sha", () => {
    // Presence first, in its own assertion. Zero `uses:` lines make "every
    // one is pinned" vacuously true, and deleting the checkout is the
    // cheapest repair for a red pin (#518).
    const uses = usesLines(generated());
    expect(uses.length, `the generated workflow carries no \`uses:\` at all`).toBeGreaterThan(0);
    const violations = unpinnedUsesViolations(generated());
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("AC-8g: the checkout is the pin, and the tag it was read from is a comment", () => {
    expect(generated()).toContain(
      `uses: ${AI_REVIEW_CHECKOUT_ACTION}@${AI_REVIEW_CHECKOUT_SHA} # ${AI_REVIEW_CHECKOUT_VERSION}`,
    );
    expect(SHA_PIN.test(AI_REVIEW_CHECKOUT_SHA)).toBe(true);
  });

  test("AC-8g: de-pinning that one `uses:` to its tag turns the case red", () => {
    const mutant = generated().replace(
      `@${AI_REVIEW_CHECKOUT_SHA}`,
      `@${AI_REVIEW_CHECKOUT_VERSION}`,
    );
    expect(mutant, "the mutation did not apply").not.toBe(generated());
    const violations = unpinnedUsesViolations(mutant);
    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toContain(AI_REVIEW_CHECKOUT_ACTION);
  });

  test("AC-8g: a `uses:` with no ref at all is refused, not read as unpinned-but-fine", () => {
    const mutant = generated().replace(`@${AI_REVIEW_CHECKOUT_SHA}`, "");
    expect(mutant, "the mutation did not apply").not.toBe(generated());
    expect(unpinnedUsesViolations(mutant).length).toBe(1);
  });

  test("AC-8g: the checkout does not persist a second credential into the tree", () => {
    // Without this, checkout writes GITHUB_TOKEN into .git/config — a
    // credential sitting in the tree the reviewing agent walks.
    expect(buildReviewCheckoutStep()).toContain("persist-credentials: false");
    expect(generated()).toContain("persist-credentials: false");
  });
});

describe("AC-7: no bare model alias reaches the generated workflow", () => {
  test("AC-7: the generated workflow names no bare opus, sonnet or haiku", () => {
    const violations = bareModelAliasViolations(generated());
    expect(violations, violations.join("\n")).toEqual([]);
    expect(AI_REVIEW_MODEL_ALIASES.length).toBe(3);
  });

  test("AC-7: planting one turns the guarding case red", () => {
    for (const alias of AI_REVIEW_MODEL_ALIASES) {
      const mutant = plantStep(
        generated(),
        `      - name: Planted reviewer\n        id: planted-${alias}\n        run: |\n          echo --model ${alias}\n`,
      );
      expect(mutant, "the mutation did not apply").not.toBe(generated());
      // The mutant has to be a workflow, not a broken string: a detector
      // proven only against garbage proves nothing about a real file.
      expect(() => Bun.YAML.parse(mutant)).not.toThrow();
      const violations = bareModelAliasViolations(mutant);
      expect(violations.length, `${alias} was not caught\n${violations.join("\n")}`).toBe(1);
      expect(violations[0]).toContain(alias);
    }
  });

  test("AC-7: a PINNED dated identifier is not an alias — the control", () => {
    // The cheapest wrong detector is a substring match, which refuses every
    // pinned id and so is green on an empty file and red on a correct one.
    for (const pinned of ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
      const mutant = plantStep(
        generated(),
        `      - name: Planted reviewer\n        id: planted-pinned\n        run: |\n          echo --model ${pinned}\n`,
      );
      const violations = bareModelAliasViolations(mutant);
      expect(violations, `${pinned} was refused as a bare alias`).toEqual([]);
    }
  });
});

describe("AC-8f: the findings verdict step is in the job, after the review step", () => {
  test("AC-8f: the step is present and the builder's text reaches the file verbatim", () => {
    const violations = findingsStepViolations(generated());
    expect(violations, violations.join("\n")).toEqual([]);
    expect(generated()).toContain(buildFindingsVerdictStep(PROJECT));
  });

  test("AC-8f: it runs the findings reader against the one declared payload path", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const step = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s.id === AI_REVIEW_FINDINGS_STEP_ID);
    expect(step, `no step with id ${AI_REVIEW_FINDINGS_STEP_ID}`).toBeDefined();
    expect(step.run).toContain(AI_REVIEW_FINDINGS_PATH);
    expect(step.run).toContain("ai-review-findings.ts");
    // The mode arrives through env:, like every other value in this job.
    expect(step.run).not.toContain("${{");
    expect(step.env.AI_REVIEW_MODE).toContain(`steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode`);
    expect(Object.keys(step)).not.toContain("if");
  });

  test("AC-8f: removing the step turns the case red", () => {
    const at = findingsStepAt(generated());
    expect(at, "the findings step is not where the derivation expects it").toBeGreaterThan(-1);
    // It is the last step, which is the assumption this derivation rests on,
    // so it is asserted rather than relied upon.
    expect(generated().lastIndexOf("      - name: ")).toBe(at);
    const mutant = generated().slice(0, at);
    expect(() => Bun.YAML.parse(mutant)).not.toThrow();
    const violations = findingsStepViolations(mutant);
    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toContain(AI_REVIEW_FINDINGS_STEP_ID);
  });

  test("AC-8f: moving it BEFORE the review step turns the case red too", () => {
    const at = findingsStepAt(generated());
    const block = generated().slice(at);
    const body = generated().slice(0, at);
    const runAt = body.indexOf(`      - name: ${AI_REVIEW_RUN_STEP_NAME}`);
    expect(runAt, "the review step is not where the derivation expects it").toBeGreaterThan(-1);
    const mutant = body.slice(0, runAt) + block + body.slice(runAt);
    expect(mutant, "the mutation did not apply").not.toBe(generated());
    expect(() => Bun.YAML.parse(mutant)).not.toThrow();
    const violations = findingsStepViolations(mutant);
    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toContain("always absent");
  });

  test("AC-8f: deleting the REVIEW step is refused, not read as correct ordering", () => {
    // `indexOf` returns -1 for an absent step and -1 < n is true, so a bare
    // comparison would report the deletion as a job in the right order.
    const body = generated().slice(0, findingsStepAt(generated()));
    const runAt = body.indexOf(`      - name: ${AI_REVIEW_RUN_STEP_NAME}`);
    const mutant = body.slice(0, runAt) + generated().slice(findingsStepAt(generated()));
    expect(() => Bun.YAML.parse(mutant)).not.toThrow();
    const violations = findingsStepViolations(mutant);
    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toContain(AI_REVIEW_RUN_STEP_ID);
  });
});

describe("AC-8: the expanded job keeps what #630 bought", () => {
  test("AC-8: the UNMEASURED annotation still names all three secrets", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const auth = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s.id === AI_REVIEW_AUTH_STEP_ID);
    const run = runAuthScript(auth.run, {});
    const warnings = run.stdout
      .split("\n")
      .filter(l => l.startsWith("::warning") && l.includes("UNMEASURED"));
    expect(warnings.length, run.stdout).toBe(1);
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(warnings[0], `the annotation does not name ${secret}`).toContain(secret);
    }
    expect(run.code, "an unconfigured project must not go red on the first scaffold").toBe(0);
  });

  test("AC-8: all three credentials reach the action, each guarded by its own mode", () => {
    // Presence before comparison (#518): `violations: []` is true of a job
    // that hands over nothing at all, so what the credentials DID is asserted
    // first and the absence of a violation only after it. The order matters —
    // reversed, the cheapest repair for a red hand-over is to delete it, and
    // this case would go green over exactly that.
    const reading = credentialIsolation(generated());
    expect(reading.carried, "no credential reaches the review action at all").toEqual(
      AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret),
    );
    expect(reading.reading).toBe("MEASURED");
    expect(reading.reasons).toEqual([]);
    expect(reading.violations, reading.violations.join("\n")).toEqual([]);
  });

  test("AC-8: a job that hands over nothing is UNMEASURED, not clean", () => {
    // The state #630 shipped and #631 left behind: a mode resolves and no
    // step uses it. An empty violation list there is byte-indistinguishable
    // from the case above, and those are different facts
    // (`.claude/rules/config-access.md`), so the reading withholds instead.
    // Derived from the live workflow, so the two differ in one thing.
    const stripped = withoutCredentialHandovers(generated());
    expect(stripped, "the derivation did not apply").not.toBe(generated());
    expect(() => Bun.YAML.parse(stripped)).not.toThrow();
    const reading = credentialIsolation(stripped);
    expect(reading.carried).toEqual([]);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.reasons).toEqual(["NO_CREDENTIAL_REACHES_A_STEP"]);
    expect(reading.violations).toEqual([]);
  });

  test("AC-8: a credential guarded by its own mode reads MEASURED and clean", () => {
    const guard = `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'oauth'`;
    const mutant = plantStep(
      generated(),
      `      - name: Planted reviewer\n        id: planted-review\n        with:\n` +
        `          claude_code_oauth_token: \${{ ${guard} && secrets.CLAUDE_CODE_OAUTH_TOKEN || '' }}\n`,
    );
    const reading = credentialIsolation(mutant);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.violations, reading.violations.join("\n")).toEqual([]);
  });

  test("AC-8: the same credential handed over under another mode is refused", () => {
    const guard = `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'vertex'`;
    const mutant = plantStep(
      generated(),
      `      - name: Planted reviewer\n        id: planted-review\n        with:\n` +
        `          anthropic_api_key: \${{ ${guard} && secrets.ANTHROPIC_API_KEY || '' }}\n`,
    );
    const reading = credentialIsolation(mutant);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.violations.length, reading.violations.join("\n")).toBe(1);
    expect(reading.violations[0]).toContain("ANTHROPIC_API_KEY");
    expect(reading.violations[0]).toContain("'api-key'");
  });

  test("AC-8: an UNGUARDED credential is refused — the whole point", () => {
    const mutant = plantStep(
      generated(),
      `      - name: Planted reviewer\n        id: planted-review\n        with:\n` +
        `          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}\n`,
    );
    const reading = credentialIsolation(mutant);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.violations.length, reading.violations.join("\n")).toBe(1);
  });

  test("AC-8: the auth detector's own env: is not read as an unguarded hand-over", () => {
    // The control. The auth step is where the three secrets are READ, which is
    // the one place they may appear ungated — a detector that refused it would
    // be red on every correct workflow and so could never be switched on.
    const doc = Bun.YAML.parse(generated()) as any;
    const auth = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s.id === AI_REVIEW_AUTH_STEP_ID);
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      expect(auth.env[secret]).toBe(`\${{ secrets.${secret} }}`);
    }
    expect(credentialIsolation(generated()).violations).toEqual([]);
  });

  test("AC-8: the expanded job still carries no `if:` at job or step level", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const job = doc.jobs[AI_REVIEW_JOB];
    expect(Object.keys(job)).toContain("steps");
    expect(Object.keys(job).filter(k => k === "if")).toEqual([]);
    const steps = job.steps as any[];
    expect(steps.length, "the job has no steps").toBeGreaterThan(3);
    expect(steps.filter(s => "if" in s).map(s => s.name ?? s.id ?? "(unnamed)")).toEqual([]);
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

// ── AC-8h: the record, read as data ─────────────────────────────────────

/** The heading the #631 battery is recorded under, and its table. */
const RECORD_HEADING = "## The AI review job grew four steps";

describe("AC-8h: the mutation counts are recorded, baseline first", () => {
  test("AC-8h: the recorded #631 mutation rows parse, with the baseline row first", () => {
    const spec = readFileSync(join(import.meta.dir, "..", "specs", "HARNESS-STANDARD.md"), "utf-8");
    // Search the slice, not the document: a table anywhere else in a
    // 11,000-line spec would satisfy every assertion below.
    const from = spec.indexOf(RECORD_HEADING);
    expect(from, `${RECORD_HEADING} is not in the spec`).toBeGreaterThan(-1);
    const rest = spec.slice(from + RECORD_HEADING.length);
    const to = rest.indexOf("\n## ");
    const section = to < 0 ? rest : rest.slice(0, to);
    expect(section.length, "the section sliced out empty").toBeGreaterThan(0);

    const rows = section
      .split("\n")
      .filter(l => /^\| /.test(l) && !/^\|\s*-+/.test(l) && !/^\| Row \|/.test(l))
      .map(l => l.split("|").slice(1, -1).map(c => c.trim()));
    expect(rows.length, `the battery table has ${rows.length} rows`).toBe(13);

    // The baseline is read first, and it is the row nobody mutates anything
    // to produce — an instrument that stopped reporting takes it down too.
    const [baseline, ...mutations] = rows;
    expect(baseline[0]).toContain("baseline");
    const declared = [...readFileSync(import.meta.path, "utf-8").matchAll(/^\s*test\(/gm)].length;
    for (const cell of baseline.slice(1)) {
      expect(cell, `the baseline row says ${cell}`).toContain(`${declared} pass, 0 fail`);
    }

    for (const row of mutations) {
      const predicted = Number(row[1].replace(/\D/g, ""));
      const measured = Number(/(\d+) of (\d+)/.exec(row[2])?.[1] ?? NaN);
      const outOf = Number(/(\d+) of (\d+)/.exec(row[2])?.[2] ?? NaN);
      expect(Number.isFinite(predicted), `row ${row[0]} has no predicted count`).toBe(true);
      expect(Number.isFinite(measured), `row ${row[0]} has no measured count`).toBe(true);
      expect(measured, `row ${row[0]} measured 0 — read the instrument`).toBeGreaterThan(0);
      expect(outOf, `row ${row[0]} is counted against a different suite size`).toBe(declared);
    }
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
