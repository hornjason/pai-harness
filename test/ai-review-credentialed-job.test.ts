/**
 * Covers #631 AC-1, AC-2, AC-3, AC-4, AC-7, AC-8 — the credentialed half of
 * the generated ai-review job.
 *
 * #630 made mode `none` honest. This file is about the other three branches:
 * what the generated job hands the review action once a mode resolves. A job
 * that detects `vertex` and hands the action an Anthropic API key, or that
 * detects `oauth` and also populates the vertex inputs, authenticates against
 * the wrong provider — and the consumer sees an infrastructure error where a
 * review should be.
 *
 * ## Three things this file does deliberately
 *
 * 1. **Every `uses:` is ENUMERATED, not named.** Asserting that checkout, the
 *    Vertex auth and the review action are each pinned says nothing about a
 *    fourth action added later with a floating tag. The enumeration is checked
 *    against a raw count of `uses:` lines in the same text, because a parse
 *    that silently dropped a step would otherwise report a clean job it never
 *    read (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * 2. **The per-mode claims are EVALUATED, not matched.** "no other credential
 *    input is populated in that mode" is a statement about what the expression
 *    resolves to, and `toContain` over the YAML cannot make it. `evaluate()`
 *    below is a reader for the two expression shapes this generator emits, and
 *    it THROWS on anything else — a shape it does not recognise reading as
 *    empty would report a credential unpopulated for the wrong reason, which
 *    is the fail-open this whole suite exists to avoid.
 *
 * 3. **"No `secrets.` expression" is read as the issue reads it.** #631 AC-1
 *    says the hand-off is "gated on the auth step's resolved mode vertex
 *    rather than on a secret expression", while AC-2 and AC-3 of the same
 *    issue REQUIRE the review action to receive its credential from
 *    `secrets.CLAUDE_CODE_OAUTH_TOKEN` and `secrets.ANTHROPIC_API_KEY`. A
 *    credential value must therefore name its secret; what is forbidden is a
 *    secret in a DECIDING position. So this file asserts the stronger
 *    checkable property: no secret appears next to a comparison operator, and
 *    every `secrets.` the generator emits sits in a credential input value
 *    keyed on the resolved mode and nowhere else.
 */

import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_ACTIONS,
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_CHECKOUT_STEP_ID,
  AI_REVIEW_CREDENTIAL_INPUTS,
  AI_REVIEW_MODES,
  AI_REVIEW_VERTEX_AUTH_STEP_ID,
  buildReviewRunStep,
  type AiReviewAuthMode,
} from "../lib/scaffold/ai-review-step";

const TEXT = buildReviewRunStep();

/** The emitted steps, parsed. `buildReviewRunStep` returns a `steps:` body. */
const STEPS: any[] = (Bun.YAML.parse(`steps:\n${TEXT}`) as any).steps;

function byId(id: string): any {
  const step = STEPS.find(s => s && s.id === id);
  expect(step, `no emitted step with id ${id}:\n${TEXT}`).toBeDefined();
  return step;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The two expression shapes this generator emits, and nothing else.
 *
 * Returns what the input resolves to for `mode`: the empty string when the
 * runner would hand the action nothing. A credential value resolves to a
 * marker naming its secret rather than to the secret itself, so a case
 * asserting WHICH credential arrived cannot be satisfied by any other one.
 */
function evaluate(raw: unknown, mode: AiReviewAuthMode): string {
  const expr = String(raw);
  const keyed = expr.match(
    /^\$\{\{ steps\.([a-z0-9-]+)\.outputs\.mode == '([a-z-]+)' && secrets\.([A-Z0-9_]+) \|\| '' \}\}$/,
  );
  if (keyed) {
    expect(keyed[1], "a credential is keyed on a step that is not the auth step").toBe(
      AI_REVIEW_AUTH_STEP_ID,
    );
    expect(
      AI_REVIEW_MODES as readonly string[],
      `keyed on ${keyed[2]}, which is not a mode`,
    ).toContain(keyed[2]);
    return mode === keyed[2] ? `<${keyed[3]}>` : "";
  }
  const bare = expr.match(/^\$\{\{ steps\.([a-z0-9-]+)\.outputs\.mode == '([a-z-]+)' \}\}$/);
  if (bare) {
    expect(bare[1]).toBe(AI_REVIEW_AUTH_STEP_ID);
    return mode === bare[2] ? "true" : "false";
  }
  throw new Error(
    `unrecognised expression ${JSON.stringify(expr)} — this reader refuses rather than ` +
      `reporting it as unpopulated, because an unread shape reading as empty is a ` +
      `credential reported absent for the wrong reason`,
  );
}

/** Every credential-bearing input in the job, as `[label, rawValue]`. */
function credentialInputs(): Array<[string, unknown]> {
  return AI_REVIEW_CREDENTIAL_INPUTS.map(c => {
    const step = byId(c.stepId);
    expect(step.with, `${c.stepId} passes no inputs at all`).toBeDefined();
    return [`${c.stepId}.${c.input}`, step.with[c.input]] as [string, unknown];
  });
}

// ── AC-1 / AC-4: every action is pinned, enumerated rather than named ────

describe("AC-1/AC-4: every action the review job runs is pinned to a sha", () => {
  test("AC-4: the enumeration reaches every `uses:` the emitted text contains", () => {
    // Vacuity guard. Zero `uses:` steps would satisfy "all of them are
    // pinned", and a parse that dropped one would too.
    const parsed = STEPS.filter(s => s && typeof s.uses === "string");
    const raw = (TEXT.match(/^\s*uses:/gm) || []).length;
    expect(raw, "the emitted job runs no action at all").toBeGreaterThanOrEqual(3);
    expect(parsed.length, `parsed ${parsed.length} \`uses:\` steps of ${raw} in the text`).toBe(raw);
  });

  test("AC-4: every `uses:` is a 40-character lowercase hex sha, none tagged", () => {
    for (const step of STEPS.filter(s => s && typeof s.uses === "string")) {
      const at = step.uses.lastIndexOf("@");
      expect(at, `${step.uses} carries no ref at all`).toBeGreaterThan(0);
      const ref = step.uses.slice(at + 1);
      expect(
        ref,
        `${step.uses} (step ${step.id}) is not pinned — a tag or branch moves under the ` +
          `consumer without a commit in their tree`,
      ).toMatch(SHA);
    }
  });

  test("AC-4: the declared action table agrees with what is emitted", () => {
    // One decider for the pins. A literal typed into the step builder beside
    // the table would survive any change to the table.
    expect(AI_REVIEW_ACTIONS.length).toBeGreaterThanOrEqual(3);
    const emitted = STEPS.filter(s => s && typeof s.uses === "string").map(s => s.uses);
    for (const a of AI_REVIEW_ACTIONS) {
      expect(a.sha, `${a.repo} is declared with a ref that is not a sha`).toMatch(SHA);
      expect(emitted, `${a.repo} is declared but never used`).toContain(`${a.repo}@${a.sha}`);
    }
    expect(emitted.length, "an action is emitted that the table does not declare").toBe(
      AI_REVIEW_ACTIONS.length,
    );
  });

  test("AC-1: the Vertex auth step and the review step are the actions named", () => {
    expect(byId(AI_REVIEW_VERTEX_AUTH_STEP_ID).uses.split("@")[0]).toBe(
      "google-github-actions/auth",
    );
    expect(byId(AI_REVIEW_ACTION_STEP_ID).uses.split("@")[0]).toBe(
      "anthropics/claude-code-action",
    );
    expect(byId(AI_REVIEW_CHECKOUT_STEP_ID).uses.split("@")[0]).toBe("actions/checkout");
  });
});

// ── AC-2 / AC-7: the gate is the resolved mode, and there is no `if:` ────

describe("AC-2/AC-7: the hand-off is gated on the mode, never on a condition", () => {
  test("AC-1: use_vertex is the auth step's resolved mode compared to vertex", () => {
    const value = byId(AI_REVIEW_ACTION_STEP_ID).with.use_vertex;
    expect(String(value)).toBe(
      `\${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == 'vertex' }}`,
    );
    expect(evaluate(value, "vertex")).toBe("true");
    for (const mode of AI_REVIEW_MODES.filter(m => m !== "vertex")) {
      expect(evaluate(value, mode), `use_vertex was true in mode ${mode}`).toBe("false");
    }
  });

  test("AC-7: no emitted step carries an `if:` key, measured over every step", () => {
    expect(STEPS.length, "no steps were parsed at all").toBeGreaterThanOrEqual(3);
    for (const step of STEPS) {
      expect(Object.keys(step), `step ${step.id} carries an \`if:\``).not.toContain("if");
    }
    // …and over the text, because a key the parser folded away is a key the
    // runner still honours.
    expect(TEXT, "an `if:` key is present in the emitted text").not.toMatch(/^\s*if:/m);
  });

  test("AC-1: nothing in the emitted steps decides anything from a secret", () => {
    expect(TEXT).not.toMatch(/secrets\.[A-Z0-9_]+\s*(!=|==|<|>)/);
    expect(TEXT).not.toMatch(/(!=|==|&&|\|\|)\s*secrets\.[A-Z0-9_]+\s*(!=|==)/);
  });

  test("AC-1: every emitted `secrets.` sits in a credential input keyed on the mode", () => {
    const secretLines = TEXT.split("\n").filter(l => l.includes("secrets."));
    expect(secretLines.length, "no credential reaches the job at all").toBeGreaterThanOrEqual(
      AI_REVIEW_CREDENTIAL_INPUTS.length,
    );
    const allowed = new Set(AI_REVIEW_CREDENTIAL_INPUTS.map(c => c.input));
    for (const line of secretLines) {
      const key = line.trim().split(":")[0];
      expect(allowed, `\`secrets.\` appears outside a credential input: ${line.trim()}`).toContain(
        key,
      );
      // The value has to be the keyed shape; `evaluate` throws on any other.
      evaluate(line.trim().slice(key.length + 1).trim(), "none");
    }
  });
});

// ── AC-2 / AC-3 / AC-8: one mode, one credential ─────────────────────────

describe("AC-2/AC-3/AC-8: each resolved mode populates only its own credential", () => {
  test("the credential table covers every credentialed mode in the ladder", () => {
    // Enumerated from the ladder rather than spot-checked: a fourth mode
    // added later with no input wired would otherwise ship unobserved.
    expect(AI_REVIEW_CREDENTIAL_INPUTS.map(c => c.mode)).toEqual(
      AI_REVIEW_AUTH_PRECEDENCE.map(c => c.mode),
    );
    expect(AI_REVIEW_CREDENTIAL_INPUTS.map(c => c.secret)).toEqual(
      AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret),
    );
  });

  test("the inputs the per-mode cases read are really present", () => {
    // Vacuity guard: an absent input evaluates to "" in every mode, which
    // would satisfy "no other credential is populated" for all of them.
    const inputs = credentialInputs();
    expect(inputs.length).toBe(AI_REVIEW_CREDENTIAL_INPUTS.length);
    for (const [label, value] of inputs) {
      expect(value, `${label} is not passed to its step`).toBeDefined();
    }
  });

  for (const credential of AI_REVIEW_CREDENTIAL_INPUTS) {
    test(`AC-2/AC-3: mode ${credential.mode} populates ${credential.input} and nothing else`, () => {
      const populated = credentialInputs()
        .filter(([, value]) => evaluate(value, credential.mode) !== "")
        .map(([label]) => label);
      expect(
        populated,
        `mode ${credential.mode} reached the action with more than its own credential`,
      ).toEqual([`${credential.stepId}.${credential.input}`]);

      const step = byId(credential.stepId);
      expect(evaluate(step.with[credential.input], credential.mode)).toBe(
        `<${credential.secret}>`,
      );
    });

    test(`AC-2/AC-3: ${credential.secret} occurs at exactly one position`, () => {
      // Two positions is two sources, and "from no other source" is the
      // claim. It is also how a credential ends up in a log.
      expect(
        occurrences(TEXT, credential.secret),
        `${credential.secret} appears more than once in the emitted job`,
      ).toBe(1);
    });
  }

  test("AC-8: mode none reaches the action with no credential populated", () => {
    const populated = credentialInputs()
      .filter(([, value]) => evaluate(value, "none") !== "")
      .map(([label]) => label);
    expect(populated, "a credential-less tree still handed the action a credential").toEqual([]);
  });
});
