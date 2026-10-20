/**
 * scaffold/ai-review-step.ts — the ai-review job's auth-detect step (#630).
 *
 * One module, one decider. The generated bash is the ONLY place the mode is
 * resolved: there is deliberately no TypeScript `resolveAuthMode(env)` beside
 * it, because two deciders answering the same question about the same input
 * are behaviourally one decider, and no behavioural test can tell them apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape). The
 * tests run the script.
 *
 * ## The two traps this step exists to avoid
 *
 * 1. **`secrets` is not available in an `if:` expression** at job or step
 *    level — `${{ secrets.X != '' }}` fails workflow validation outright.
 *    `vars` is available in both, which makes a `vars`-based condition the
 *    tempting fix and the second trap.
 * 2. **A job or step skipped by `if:` reports `skipped`, and a skipped
 *    required check can be treated as satisfied.** So nothing here is
 *    conditional from the outside: the step always runs, and it branches
 *    inside `run:` where it can emit an annotation and choose an exit code.
 *
 * ## The credential-less branch
 *
 * A tree with no credential has not passed an AI review; it has not had one.
 * Those are different states and only one of them is reportable, so mode
 * `none` emits a GitHub warning annotation naming the state UNMEASURED. `0`,
 * `{}`, `null` and `SKIP` are indistinguishable from success; `UNMEASURED`
 * is not. See `.claude/rules/config-access.md`.
 *
 * Whether UNMEASURED should also FAIL the job is the consumer's call, because
 * the honest default for a tree that has never configured a credential is not
 * a red pipeline on the first scaffold. `vars.RUNGATE_REQUIRE_AI_REVIEW` is
 * how a consumer opts in, and it is matched against the exact string `true`
 * — not `TRUE`, not `1`, not a prefix. A loose reading of a variable that
 * turns a gate on is a gate that turns itself on by accident.
 */

/**
 * The exit code every refusal in the generated script routes through.
 *
 * Declared once, interpolated once, and asserted to be the only non-zero exit
 * in this file by `test/ai-review-scaffold.test.ts`. The test builds a mutant
 * copy of this module with it set to 0 and requires the refusal case to stop
 * refusing — a later branch that inlined its own literal would survive that
 * mutation and the case would go green having witnessed nothing.
 */
export const AI_REVIEW_REQUIRED_EXIT = 1;

/** The four states the step can resolve. Exactly one is reached per run. */
export type AiReviewAuthMode = "vertex" | "oauth" | "api-key" | "none";

export const AI_REVIEW_MODES: readonly AiReviewAuthMode[] = [
  "vertex",
  "oauth",
  "api-key",
  "none",
];

export interface AiReviewCredential {
  /** The repository secret the runner interpolates into the step's env. */
  secret: string;
  /** The mode resolved when that secret is the first non-empty one. */
  mode: Exclude<AiReviewAuthMode, "none">;
  /** What the mode authenticates against, for the step's own log line. */
  describes: string;
}

/**
 * The credentials, in the order the script tries them.
 *
 * Vertex first: it is the only one that bills a GCP project the consumer
 * already owns, and a tree carrying both a service-account key and a personal
 * OAuth token means the organisation credential, not the individual's.
 */
export const AI_REVIEW_AUTH_PRECEDENCE: readonly AiReviewCredential[] = [
  { secret: "GCP_SA_KEY", mode: "vertex", describes: "Vertex AI" },
  { secret: "CLAUDE_CODE_OAUTH_TOKEN", mode: "oauth", describes: "a Claude Code OAuth token" },
  { secret: "ANTHROPIC_API_KEY", mode: "api-key", describes: "the Anthropic API" },
];

/** The repository variable a consumer sets to make UNMEASURED a failure. */
export const AI_REVIEW_REQUIRE_VAR = "RUNGATE_REQUIRE_AI_REVIEW";

/** The exact value of that variable which turns the refusal on. */
export const AI_REVIEW_REQUIRE_VALUE = "true";

/** The step's `id:`, so a later step can read `steps.<id>.outputs.mode`. */
export const AI_REVIEW_AUTH_STEP_ID = "ai-review-auth";

/**
 * The generated workflow's filename and its one job name.
 *
 * Declared here rather than at either use site. `lib/scaffold/steps.ts` writes
 * the file and `lib/conformity.ts` reads it back and executes the step inside
 * it; two string literals that agree today are one decider too many, and a
 * generator and a checker that disagree about a filename is a checker that
 * reports a clean tree it never opened.
 */
export const AI_REVIEW_WORKFLOW_FILE = "ai-review.yml";

/** The single job in that file. Carries no `if:` — see the header. */
export const AI_REVIEW_JOB = "ai-review";

export const AI_REVIEW_AUTH_STEP_NAME = "Detect AI review credentials";

/** The annotation title, shared by the warning and the refusal. */
export const AI_REVIEW_UNMEASURED_TITLE = "AI review UNMEASURED";

/** The review step's `id:`. Separate from the auth step, so each has one job. */
export const AI_REVIEW_RUN_STEP_ID = "ai-review-run";

export const AI_REVIEW_RUN_STEP_NAME = "Run the AI review";

const SECRET_NAMES = AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret);

// ── The model pin (#685 AC-6) ───────────────────────────

/**
 * The model-family names that are aliases rather than identifiers.
 *
 * One declaration, so there is one thing to mutate. An alias re-points at a
 * different model the day its owner moves it, which means the gate a consumer
 * measured is not the gate they keep — and nothing in the workflow records
 * that it changed. An exact identifier is the only form that pins.
 */
export const MODEL_FAMILY_ALIASES: readonly string[] = ["opus", "sonnet", "haiku", "fable"];

/**
 * An EXACT model identifier: a family plus at least one version segment.
 *
 * This is the thing the guard must NOT refuse, and it is the whole reason
 * `modelAliasViolations` tokenises instead of searching for the family word.
 * `claude-opus-5-5` CONTAINS the string `opus`, so a substring guard would be
 * green today — the generated workflow names no model at all — and would make
 * Phase 1 (#631) unshippable the moment it tried to pin one. A check that
 * blocks the change it exists to protect looks identical, in a green suite, to
 * a check that is satisfied.
 */
export const EXACT_MODEL_PATTERN = /^claude-(?:[a-z]+)-\d+(?:-\d+)*$/;

/** Anything that could be a model identifier: letters, digits, `.`, `_`, `-`. */
const TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*/g;

/**
 * The part of a workflow that can actually select a model: everything that is
 * not a comment.
 *
 * Measured on `.github/workflows/claude-review.yml`, which pins
 * `claude-sonnet-5` correctly at its one value position and explains WHY in a
 * comment — a comment that necessarily names the alias it is warning about.
 * Scanning the whole document reported that file as two violations, both of
 * them the documentation of the fix. A document that quotes the thing it
 * demands is `.claude/rules/checks-must-be-able-to-fail.md`'s "search the
 * slice, not the document", and a guard that cries on the explanation of its
 * own rule is one somebody switches off.
 *
 * The boundary is a TEST, not this comment — narrowing a detector is the
 * change most likely to buy green with blindness, so `AC-6g` asserts that a
 * value on a line which ALSO carries a comment is still caught.
 */
export function modelAliasScanSlice(workflowText: string): string {
  return workflowText
    .split("\n")
    .map(line => {
      const m = /(^|\s)#/.exec(line);
      return m === null ? line : line.slice(0, m.index + m[1].length);
    })
    .join("\n");
}

/**
 * Every bare family alias in a generated workflow, named.
 *
 * Returns the offending TOKENS rather than a count: "1 violation" does not
 * send anybody to a line. The rule, per token:
 *
 *   - matches `EXACT_MODEL_PATTERN`            → pinned, allowed
 *   - any `-`-delimited segment IS a family    → an alias, refused
 *   - otherwise                                → not about a model
 *
 * Segment equality rather than substring is what keeps `opusculum` and
 * `sonnets-and-haikus` out of the report. A guard that cries on ordinary prose
 * is a guard somebody switches off, and then it is not a guard.
 */
export function modelAliasViolations(workflowText: string): string[] {
  const found: string[] = [];
  for (const [token] of modelAliasScanSlice(workflowText).matchAll(TOKEN)) {
    const lower = token.toLowerCase();
    if (EXACT_MODEL_PATTERN.test(lower)) continue;
    if (lower.split("-").some(seg => MODEL_FAMILY_ALIASES.includes(seg))) {
      found.push(token);
    }
  }
  return found;
}

/**
 * The bash the auth-detect step runs.
 *
 * No `set -e`: `[ -n ... ]` returning false is the ordinary control flow here,
 * and a shell that exits on it would resolve `vertex` for every tree. `-u` is
 * safe because every variable is read through `${X:-}` — an unset GitHub
 * secret interpolates to the empty string, so absent and empty have to be the
 * same case anyway.
 */
export function buildAuthDetectScript(): string {
  const branches = AI_REVIEW_AUTH_PRECEDENCE.map((c, i) => {
    const keyword = i === 0 ? "if" : "elif";
    return `${keyword} [ -n "\${${c.secret}:-}" ]; then\n  mode=${c.mode}`;
  }).join("\n");

  const warning =
    `No Claude credential is configured ` +
    `(${SECRET_NAMES.join(", ")}), so no AI review ran on this pull request. ` +
    `This check is UNMEASURED, not a passing review. ` +
    `Set the repository variable ${AI_REVIEW_REQUIRE_VAR} to ` +
    `'${AI_REVIEW_REQUIRE_VALUE}' to make an unmeasured review fail instead.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and no credential ` +
    `is configured, so this pull request has no AI review. Failing rather than ` +
    `reporting a green check for a review that never happened.`;

  return `# Generated by rungate — lib/scaffold/ai-review-step.ts. Do not edit.
#
# Resolves exactly one of ${AI_REVIEW_MODES.length} modes: ${AI_REVIEW_MODES.join(", ")}.
# The decision is here and not in an \`if:\` expression on purpose — \`secrets\`
# is unavailable in \`if:\`, and a skipped step can satisfy a required check.
set -uo pipefail

mode=none
${branches}
fi

echo "ai-review auth mode: \${mode}"
if [ -n "\${GITHUB_OUTPUT:-}" ]; then
  echo "mode=\${mode}" >> "\${GITHUB_OUTPUT}"
fi

if [ "\${mode}" != none ]; then
  exit 0
fi

echo "::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${warning}"

if [ "\${${AI_REVIEW_REQUIRE_VAR}:-}" = "${AI_REVIEW_REQUIRE_VALUE}" ]; then
  echo "::error title=${AI_REVIEW_UNMEASURED_TITLE}::${refusal}" >&2
  exit ${AI_REVIEW_REQUIRED_EXIT}
fi

exit 0
`;
}

/**
 * The step, as YAML, ready to be indented under a job's `steps:`.
 *
 * Every credential reaches the script through `env:` and nowhere else. That
 * is not style: an expression is interpolated into the script text before
 * bash sees it, so a `${{ secrets.X }}` inside `run:` is a value a crafted
 * secret could break out of, and `${{ vars.X }}` inside `run:` is a shell
 * injection a repository variable can carry.
 */
export function buildAuthDetectStep(indent = "      "): string {
  const env = [
    ...AI_REVIEW_AUTH_PRECEDENCE.map(c => `${c.secret}: \${{ secrets.${c.secret} }}`),
    `${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
  ];

  const lines = [
    `- name: ${AI_REVIEW_AUTH_STEP_NAME}`,
    `  id: ${AI_REVIEW_AUTH_STEP_ID}`,
    `  env:`,
    ...env.map(e => `    ${e}`),
    `  run: |`,
    ...buildAuthDetectScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}

/**
 * The bash the review step runs once a credential has resolved.
 *
 * ## Why this step exists before the reviewer it will hold does
 *
 * The auth-detect step makes `none` honest. It does nothing for the other
 * three, and on a repository that HAS a credential those are the only modes
 * reachable — so without this, a job named "AI Review" concludes success on
 * every pull request, having reviewed nothing, and says nothing about it.
 *
 * That is the defect #630 is named after, reached by the other door. "No
 * credential, so no review" and "a credential, but nothing wired to use it"
 * are the same state as far as a required check is concerned: UNMEASURED.
 * The first was already said out loud. This says the second.
 *
 * #631 replaces the body of this step with the review that actually runs.
 * Until it does, the step reports what it is rather than passing quietly,
 * and `AI_REVIEW_REQUIRE_VAR` refuses here for the same reason it refuses
 * there — a consumer who asked for a review and did not get one has not had
 * a review, and which half of the job failed to produce it is not their
 * problem.
 *
 * No `if:`, at step level or any other. The mode arrives through `env:` like
 * every other value in this file: it is one of four literals we generated,
 * not user input, but a `${{ }}` inside `run:` is interpolated before bash
 * sees it and the convention does not get to have exceptions for the cases
 * we think are safe.
 */
export function buildReviewRunScript(): string {
  const pending =
    `A credential resolved, but no review step is wired into this job yet ` +
    `(#631), so no AI review ran on this pull request. This check is ` +
    `UNMEASURED, not a passing review.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and no review ` +
    `step is wired into this job yet (#631), so this pull request has no AI ` +
    `review. Failing rather than reporting a green check for a review that ` +
    `never happened.`;

  const absent =
    `The credential-detection step produced no mode output, so this job does ` +
    `not know whether a credential was configured and no AI review ran on ` +
    `this pull request. This check is UNMEASURED, not a passing review. ` +
    `The step may not have run, or may have failed before writing its ` +
    `output. Set the repository variable ${AI_REVIEW_REQUIRE_VAR} to ` +
    `'${AI_REVIEW_REQUIRE_VALUE}' to make an unmeasured review fail instead.`;

  const absentRefusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and the ` +
    `credential-detection step produced no mode output, so this pull ` +
    `request has no AI review and this job cannot say why. Failing rather ` +
    `than reporting a green check for a review that never happened.`;

  return `# Generated by rungate — lib/scaffold/ai-review-step.ts. Do not edit.
#
# Mode \`none\` has already annotated itself in the previous step. Annotating
# it again here would report one state as two.
#
# An ABSENT mode is a different state and is annotated here, because nothing
# else has (#677). \`none\` means the auth step ran and found no credential;
# empty means the auth step did not run, or could not write its output. The
# previous form read \`\${AI_REVIEW_MODE:-none}\`, which collapsed the two —
# so "the credential check never happened" exited 0 in total silence, which
# is the Silent Default Substitution this file's own header is about.
set -uo pipefail

if [ -z "\${AI_REVIEW_MODE:-}" ]; then
  echo "::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${absent}"
  if [ "\${${AI_REVIEW_REQUIRE_VAR}:-}" = "${AI_REVIEW_REQUIRE_VALUE}" ]; then
    echo "::error title=${AI_REVIEW_UNMEASURED_TITLE}::${absentRefusal}" >&2
    exit ${AI_REVIEW_REQUIRED_EXIT}
  fi
  exit 0
fi

if [ "\${AI_REVIEW_MODE}" = none ]; then
  exit 0
fi

echo "::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${pending}"

if [ "\${${AI_REVIEW_REQUIRE_VAR}:-}" = "${AI_REVIEW_REQUIRE_VALUE}" ]; then
  echo "::error title=${AI_REVIEW_UNMEASURED_TITLE}::${refusal}" >&2
  exit ${AI_REVIEW_REQUIRED_EXIT}
fi

exit 0
`;
}

/** The review step, as YAML, ready to be indented under a job's `steps:`. */
export function buildReviewRunStep(indent = "      "): string {
  const lines = [
    `- name: ${AI_REVIEW_RUN_STEP_NAME}`,
    `  id: ${AI_REVIEW_RUN_STEP_ID}`,
    `  env:`,
    `    AI_REVIEW_MODE: \${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode }}`,
    `    ${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
    `  run: |`,
    ...buildReviewRunScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}
