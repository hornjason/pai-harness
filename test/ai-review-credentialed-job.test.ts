/**
 * ai-review-credentialed-job.test.ts — the reviewer that actually runs (#631).
 *
 * Covers AC-1, AC-2, AC-3, AC-6, AC-6b, and the `model pin` / `no conditional`
 * / `mode exclusivity` cases the issue's AC-7 and AC-8 name by pattern.
 *
 * #630 shipped the auth-detect step and the UNMEASURED branch for mode `none`.
 * It said nothing about the other three modes, so a repository WITH a
 * credential got a green "AI Review" check having reviewed nothing. This file
 * is about the steps that close that door: a SHA-pinned vertex auth step and a
 * SHA-pinned `anthropics/claude-code-action`, each credential reaching the
 * action only in its own mode, one pinned model, and a prompt that names the
 * findings payload through the module's own constants.
 *
 * ## Why the generated FILE and not only the builder
 *
 * Every AC here is a claim about `.github/workflows/ai-review.yml`, so the
 * fixture scaffolds a project and reads the file back through a YAML parser —
 * which is what GitHub does. Asserting on the builder's string alone would be
 * asserting that a template literal contains what the template literal
 * contains (`.claude/rules/checks-must-be-able-to-fail.md`, third shape), and
 * would not notice a block scalar that mangles the prompt.
 *
 * ## Why presence is asserted before anything is compared
 *
 * An absent step makes "no `if:` on the review step" vacuously true, and
 * deleting the step is the cheapest repair for a failing case — so it would
 * certify the regression it exists to catch (#518). Presence is its own
 * assertion in every block below.
 *
 * ## Why the interpolation cases MUTATE the module
 *
 * AC-6b says the prompt names the findings path and key by interpolating the
 * exported constants. `expect(prompt).toContain(AI_REVIEW_FINDINGS_PATH)` is
 * satisfied by a prompt with the value typed into it a second time — the
 * assertion passes over exactly the duplication the AC forbids. So the cases
 * build a copy of `lib/scaffold/ai-review-step.ts` with the constant changed,
 * import it from a temp directory, and require the rendered prompt to move
 * with it. The input on which the mutant and the original differ, named rather
 * than assumed: the constant's own value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_ACTION,
  AI_REVIEW_ACTION_SHA,
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_FINDINGS_PATH,
  AI_REVIEW_JOB,
  AI_REVIEW_MODEL,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_VERTEX_AUTH_ACTION,
  AI_REVIEW_VERTEX_AUTH_SHA,
  AI_REVIEW_VERTEX_AUTH_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildReviewPrompt,
  buildReviewRunStep,
} from "../lib/scaffold/ai-review-step";

const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

const SHA40 = /^[0-9a-f]{40}$/;

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
const generated = () =>
  readFileSync(join(PROJECT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8");

/** The parsed `ai-review` job's step list, with presence established first. */
function steps(): any[] {
  const doc = Bun.YAML.parse(generated()) as any;
  expect(Object.keys(doc.jobs ?? {}), "the ai-review job is gone").toContain(AI_REVIEW_JOB);
  const list = doc.jobs[AI_REVIEW_JOB].steps;
  expect(Array.isArray(list), "the job declares no steps").toBe(true);
  return list as any[];
}

function step(id: string): any {
  const found = steps().find(s => s && s.id === id);
  expect(found, `no step with id ${id} in the generated job:\n${generated()}`).toBeDefined();
  return found;
}

beforeAll(() => {
  PROJECT = scratchDir("ai-review-credentialed-");
  mkdirSync(join(PROJECT, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(PROJECT, ".claude", "rungate", "config.json"),
    JSON.stringify(
      { project: "ai-review-fixture", ci: { runner: "ubuntu-latest", bunVersion: "1.2.0" } },
      null,
      2,
    ) + "\n",
  );
  createCiWorkflows(PROJECT, []);
});

// ── The mutant ───────────────────────────────────────────────────────────
//
// A copy of the module with one constant replaced, written OUTSIDE the repo
// and imported from there. Running it from there also re-proves what
// `test/ai-review-scaffold.test.ts` asserts: the module has no relative
// imports, so a mutant cannot die on module resolution and read as a refusal.

interface Mutant {
  buildReviewPrompt: () => string;
  buildReviewRunStep: (indent?: string) => string;
}

let mutantSeq = 0;

async function mutate(name: string, from: string, to: string): Promise<Mutant> {
  const needle = `export const ${name} = ${JSON.stringify(from)}`;
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(
      `could not build the mutant: \`${needle}\` appears ${count} times in ` +
        `lib/scaffold/ai-review-step.ts`,
    );
  }
  const mutated = source.replace(needle, `export const ${name} = ${JSON.stringify(to)}`);
  const dir = scratchDir("ai-review-mutant-");
  const path = join(dir, `ai-review-step-${mutantSeq++}.ts`);
  writeFileSync(path, mutated);
  return (await import(path)) as Mutant;
}

// ── AC-1: vertex, authenticated by a pinned action and used by a pinned one ──

describe("AC-1: the job authenticates vertex and runs the review, both SHA-pinned", () => {
  test("AC-1: the vertex auth step is a SHA-pinned google-github-actions/auth", () => {
    const auth = step(AI_REVIEW_VERTEX_AUTH_STEP_ID);
    expect(AI_REVIEW_VERTEX_AUTH_SHA, "the pin is not a 40-character commit sha").toMatch(SHA40);
    expect(auth.uses, "the vertex auth step is not pinned to a commit").toBe(
      `${AI_REVIEW_VERTEX_AUTH_ACTION}@${AI_REVIEW_VERTEX_AUTH_SHA}`,
    );
    // A tag pin is a mutable pin: the same tag can point at new code tomorrow,
    // and this job holds a service-account key while it runs.
    expect(auth.uses).not.toMatch(/@v\d/);
  });

  test("AC-1: the review step is a SHA-pinned anthropics/claude-code-action", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    expect(AI_REVIEW_ACTION_SHA, "the pin is not a 40-character commit sha").toMatch(SHA40);
    expect(run.uses).toBe(`${AI_REVIEW_ACTION}@${AI_REVIEW_ACTION_SHA}`);
    expect(run.uses).not.toMatch(/@v\d/);
  });

  test("AC-1: use_vertex is enabled for the vertex mode and no other", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    const withBlock = run.with ?? {};
    expect(Object.keys(withBlock), "the review action is handed no inputs at all").toContain(
      "use_vertex",
    );
    // The mode the auth step resolved is the single decider. Reading
    // `secrets.GCP_SA_KEY` here instead would be a second reading of the same
    // question — two deciders that always agree are behaviourally one.
    expect(String(withBlock.use_vertex)).toBe(
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'vertex' }}`,
    );
  });

  test("AC-1: the file carries exactly the three vertex markers the AC counts", () => {
    const marker =
      /google-github-actions\/auth@[0-9a-f]{40}|anthropics\/claude-code-action@[0-9a-f]{40}|use_vertex/;
    const hits = generated()
      .split("\n")
      .filter(l => marker.test(l));
    expect(
      hits.length,
      `expected one pinned auth line, one pinned action line and one use_vertex ` +
        `input:\n${hits.join("\n")}`,
    ).toBe(3);
  });
});

// ── AC-2 / AC-3: each mode's own credential, and only its own ────────────

const CREDENTIAL_INPUT: Record<string, string> = {
  oauth: "claude_code_oauth_token",
  "api-key": "anthropic_api_key",
};

describe("AC-2/AC-3: each resolved mode supplies its own repository secret", () => {
  test("AC-2: mode oauth supplies claude_code_oauth_token from CLAUDE_CODE_OAUTH_TOKEN", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    expect(run.with?.claude_code_oauth_token).toBe(
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'oauth' && ` +
        `secrets.CLAUDE_CODE_OAUTH_TOKEN || '' }}`,
    );
  });

  test("AC-3: mode apikey supplies anthropic_api_key from ANTHROPIC_API_KEY", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    expect(run.with?.anthropic_api_key).toBe(
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'api-key' && ` +
        `secrets.ANTHROPIC_API_KEY || '' }}`,
    );
  });

  test("AC-8: mode exclusivity — a credential input names its own mode and its own secret", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    for (const { secret, mode } of AI_REVIEW_AUTH_PRECEDENCE) {
      const input = CREDENTIAL_INPUT[mode];
      if (input === undefined) continue; // vertex travels as a GCP credential file
      const value = String(run.with?.[input] ?? "");
      expect(value, `${input} is not passed to the action`).not.toBe("");
      expect(value, `${input} is not gated on its own mode`).toContain(`== '${mode}'`);
      expect(value, `${input} does not read ${secret}`).toContain(`secrets.${secret}`);
      for (const other of AI_REVIEW_AUTH_PRECEDENCE) {
        if (other.secret === secret) continue;
        expect(value, `${input} also carries ${other.secret}`).not.toContain(
          `secrets.${other.secret}`,
        );
      }
    }
  });

  test("AC-8: exactly one input per secret — no second spelling anywhere in the file", () => {
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      const lines = generated()
        .split("\n")
        .filter(l => l.includes(`secrets.${secret}`));
      // One in the auth step's env:, and for the two action-borne credentials
      // one in the action's with:. GCP_SA_KEY also reaches the auth action.
      expect(lines.length, `${secret} is read on ${lines.length} lines:\n${lines.join("\n")}`).toBe(
        2,
      );
    }
  });
});

// ── AC-8: no conditional, anywhere, at any level ─────────────────────────

describe("AC-8: no conditional survives — the job can never conclude skipped", () => {
  test("AC-8: no conditional on the job or on any step", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    const job = doc.jobs[AI_REVIEW_JOB];
    expect(Object.keys(job), "the job is a stub").toContain("steps");
    expect(Object.keys(job).filter(k => k === "if")).toEqual([]);
    expect(steps().filter(s => "if" in s).map(s => s.id ?? s.name ?? "(unnamed)")).toEqual([]);
  });

  test("AC-8: the three steps this issue adds or keeps are all present and unconditional", () => {
    for (const id of [
      AI_REVIEW_AUTH_STEP_ID,
      AI_REVIEW_VERTEX_AUTH_STEP_ID,
      AI_REVIEW_ACTION_STEP_ID,
      AI_REVIEW_RUN_STEP_ID,
    ]) {
      expect(Object.keys(step(id)), `${id} carries a condition`).not.toContain("if");
    }
  });

  test("AC-8: an action that cannot authenticate does not red the job by itself", () => {
    // `continue-on-error` is what replaces the `if:` this job may not have.
    // With no credential the action fails; the reporting step turns that into
    // UNMEASURED, and only `RUNGATE_REQUIRE_AI_REVIEW=true` makes it fatal.
    for (const id of [AI_REVIEW_VERTEX_AUTH_STEP_ID, AI_REVIEW_ACTION_STEP_ID]) {
      expect(step(id)["continue-on-error"], `${id} fails the job unconditionally`).toBe(true);
    }
    const report = step(AI_REVIEW_RUN_STEP_ID);
    expect(report["continue-on-error"], "the reporting step cannot refuse").not.toBe(true);
    expect(report.env?.AI_REVIEW_ACTION_OUTCOME).toBe(
      `\${{ steps.${AI_REVIEW_ACTION_STEP_ID}.outcome }}`,
    );
  });
});

// ── AC-6 / AC-7: one model, pinned, declared once ────────────────────────

describe("AC-6: exactly one pinned model identifier, declared once in the module", () => {
  test("AC-6: the model reaches the action, and the file names it once", () => {
    const run = step(AI_REVIEW_ACTION_STEP_ID);
    expect(String(run.with?.claude_args ?? ""), "the model is not handed to the action").toContain(
      `--model ${AI_REVIEW_MODEL}`,
    );
    const hits = generated().split(AI_REVIEW_MODEL).length - 1;
    expect(hits, `${AI_REVIEW_MODEL} appears ${hits} times in the generated workflow`).toBe(1);
  });

  test("AC-6: the identifier is assigned exactly once in this module", () => {
    const decls = source.match(/AI_REVIEW_MODEL\s*=/g) || [];
    expect(decls.length, "a second assignment is a second model to forget to update").toBe(1);
    expect(source).toContain("export const AI_REVIEW_MODEL");
  });

  test("AC-7: model pin — no bare opus, sonnet or haiku alias reaches the action", () => {
    // An alias floats: the same workflow run on two days reviews with two
    // different models, and nothing in the file records which.
    const alias = /(?:^|[^a-z0-9-])(opus|sonnet|haiku)(?![a-z0-9-])/i;
    const offenders = generated()
      .split("\n")
      .filter(l => alias.test(l.replace(AI_REVIEW_MODEL, "")));
    expect(offenders, `a floating model alias reached the workflow:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  test("AC-7: model pin — planting an alias turns the detector red", () => {
    // #492: an absence assertion over a file that never had the string is
    // vacuous. The detector above is run against a planted alias, so a zero
    // means "looked and found none" rather than "never looked".
    const alias = /(?:^|[^a-z0-9-])(opus|sonnet|haiku)(?![a-z0-9-])/i;
    const planted = generated().replace(`--model ${AI_REVIEW_MODEL}`, "--model opus");
    expect(planted, "the plant did not apply").not.toBe(generated());
    const offenders = planted
      .split("\n")
      .filter(l => alias.test(l.replace(AI_REVIEW_MODEL, "")));
    expect(offenders.length, "the alias detector cannot see a planted alias").toBe(1);
  });

  test("AC-6: the pin is an exact version, not a family name", () => {
    // Either spelling is a pin: a dated snapshot (`claude-sonnet-4-20250514`)
    // or a current-generation exact id (`claude-opus-5-5`). What is refused is
    // an alias with no version in it at all.
    expect(AI_REVIEW_MODEL).toMatch(/^claude-[a-z]+(?:-\d+)+(?:-\d{8})?$/);
  });
});

// ── AC-6b: the prompt names the payload through the constants ────────────

describe("AC-6b: the review prompt interpolates the findings path and key", () => {
  test("AC-6b: both constants are exported and assigned exactly once", () => {
    for (const name of ["AI_REVIEW_FINDINGS_PATH", "AI_REVIEW_FINDINGS_KEY"]) {
      expect(source, `${name} is not exported`).toContain(`export const ${name}`);
      expect((source.match(new RegExp(`${name}\\s*=`, "g")) || []).length, `${name} is assigned twice`)
        .toBe(1);
    }
  });

  test("AC-6b: the prompt the action receives names both", () => {
    const prompt = String(step(AI_REVIEW_ACTION_STEP_ID).with?.prompt ?? "");
    expect(prompt.length, "the action is handed no prompt").toBeGreaterThan(100);
    expect(prompt).toContain(AI_REVIEW_FINDINGS_PATH);
    expect(prompt).toContain(AI_REVIEW_FINDINGS_KEY);
  });

  test("AC-6b: changing the path constant moves the prompt — no second spelling", async () => {
    const mutant = await mutate("AI_REVIEW_FINDINGS_PATH", AI_REVIEW_FINDINGS_PATH, "mutant.json");
    expect(mutant.buildReviewPrompt()).toContain("mutant.json");
    expect(
      mutant.buildReviewPrompt(),
      `the prompt still names ${AI_REVIEW_FINDINGS_PATH} after the constant changed — ` +
        `the path is typed into the prompt a second time`,
    ).not.toContain(AI_REVIEW_FINDINGS_PATH);
    expect(mutant.buildReviewRunStep()).toContain("mutant.json");
  });

  test("AC-6b: changing the key constant moves the prompt — no second spelling", async () => {
    const mutant = await mutate(
      "AI_REVIEW_FINDINGS_KEY",
      AI_REVIEW_FINDINGS_KEY,
      "mutantFindingsKey",
    );
    const prompt = mutant.buildReviewPrompt();
    expect(prompt).toContain("mutantFindingsKey");
    // The word may appear in ordinary prose; what must not appear is the key
    // as the payload's JSON member, which is how the reader finds it.
    expect(
      prompt,
      `the prompt still asks for "${AI_REVIEW_FINDINGS_KEY}" as a JSON member after the ` +
        `constant changed — the key is typed into the prompt a second time`,
    ).not.toContain(`"${AI_REVIEW_FINDINGS_KEY}"`);
  });

  test("AC-6b: the prompt reaches the generated file through the builder, verbatim", () => {
    expect(generated()).toContain(buildReviewRunStep());
    const prompt = String(step(AI_REVIEW_ACTION_STEP_ID).with?.prompt ?? "");
    expect(
      prompt.trimEnd(),
      "the block scalar mangled the prompt on the way into the file",
    ).toBe(buildReviewPrompt().trimEnd());
  });

  test("AC-6b: no `${{` expression is interpolated into the prompt", () => {
    // An expression is substituted into the text before the action sees it,
    // so a repository variable in the prompt is content an attacker can set.
    expect(buildReviewPrompt()).not.toContain("${{");
  });
});
