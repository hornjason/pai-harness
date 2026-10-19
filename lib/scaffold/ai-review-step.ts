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

/** The reporting step's `id:`. Separate from the auth step, so each has one job. */
export const AI_REVIEW_RUN_STEP_ID = "ai-review-run";

export const AI_REVIEW_RUN_STEP_NAME = "Report whether the AI review ran";

// ── The reviewer that actually runs (#631) ───────────────────────────────

/**
 * The vertex auth step's `id:`, and the action it runs.
 *
 * SHA-pinned, like everything else this job uses. A tag is a mutable pin: the
 * same `@v3` can point at new code tomorrow, and this step is handed a GCP
 * service-account key. The tag the sha was read from is a trailing comment on
 * the generated line, so a reader can see what it was without the pin floating.
 */
export const AI_REVIEW_VERTEX_AUTH_STEP_ID = "ai-review-vertex-auth";

export const AI_REVIEW_VERTEX_AUTH_STEP_NAME = "Authenticate to Vertex AI";

export const AI_REVIEW_VERTEX_AUTH_ACTION = "google-github-actions/auth";

export const AI_REVIEW_VERTEX_AUTH_SHA = "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093";

export const AI_REVIEW_VERTEX_AUTH_VERSION = "v3";

/** The review action's `id:`, and the action it runs. Also SHA-pinned. */
export const AI_REVIEW_ACTION_STEP_ID = "ai-review-action";

export const AI_REVIEW_ACTION_STEP_NAME = "Run the AI review";

export const AI_REVIEW_ACTION = "anthropics/claude-code-action";

export const AI_REVIEW_ACTION_SHA = "5eb090f3c3afd701a0672cd32981197ca27688f6";

export const AI_REVIEW_ACTION_VERSION = "v1";

/**
 * The one model identifier this job reviews with.
 *
 * Exact, and declared once. A bare family alias — `opus`, `sonnet`, `haiku` —
 * floats: two runs of the same workflow on two days review with two different
 * models and nothing in the file records which, so a review that got worse is
 * indistinguishable from a tree that got worse.
 *
 * It carries no `-YYYYMMDD` suffix because the current generation has none:
 * the exact ids ARE `claude-opus-5-5` and friends, and appending a date
 * produces a model identifier that does not resolve. On Vertex the current
 * generation uses the bare first-party id, which is what this job needs.
 */
export const AI_REVIEW_MODEL = "claude-opus-5-5";

/**
 * Where the reviewer writes its findings, workspace-relative.
 *
 * One spelling, interpolated into the prompt that asks for it and into the
 * step that looks for it. #295 is the trap: a reader that looked for a key no
 * writer ever produced found an empty list on every run, and an absent key
 * reads as an empty list reads as clean.
 */
export const AI_REVIEW_FINDINGS_PATH = "ai-review-findings.json";

/**
 * The JSON member the findings array travels under.
 *
 * `lib/scaffold/ai-review-findings.ts` reads the payload and already imports
 * `AI_REVIEW_REQUIRED_EXIT` from this module; the key belongs here with it, so
 * the prompt that asks for it and the reader that reads it cannot drift. This
 * module deliberately has no relative imports (the mutant copy in
 * `test/ai-review-scaffold.test.ts` runs from a temp directory), so the
 * dependency can only point this way.
 */
export const AI_REVIEW_FINDINGS_KEY = "findings";

/** The severities the reader recognises, and the verdict words it accepts. */
const AI_REVIEW_BLOCKING_SEVERITIES = ["critical", "high"] as const;
const AI_REVIEW_PASSIVE_SEVERITIES = ["medium", "low", "info"] as const;
const AI_REVIEW_VERDICTS = ["PASS", "BLOCK"] as const;

const SECRET_NAMES = AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret);

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
 * The instructions the review action is handed.
 *
 * Two things in it are not prose and must not be re-typed anywhere: the path
 * the payload is written to and the JSON member the findings travel under.
 * Both are interpolated from the exported constants, because the step that
 * reads the payload reads the same two constants — #295 is what happens when
 * a reader looks for a key no writer was ever asked to produce, and an absent
 * key reads as an empty list reads as a clean review.
 *
 * The agent is told to write a verdict, and told that its verdict does not
 * decide anything. The blocking decision is computed from the severities by
 * `lib/scaffold/ai-review-findings.ts`, which refuses a verdict that
 * contradicts its own payload. An agent grading its own gate is the shape
 * this repository distrusts most.
 *
 * No `${{ }}` anywhere in here. An expression is substituted into the input
 * before the action sees it, so a repository variable inside the prompt is
 * text an attacker who can set a variable controls.
 */
export function buildReviewPrompt(): string {
  const blocking = AI_REVIEW_BLOCKING_SEVERITIES.join(", ");
  const passive = AI_REVIEW_PASSIVE_SEVERITIES.join(", ");

  return `Review the changes on this branch for correctness defects: bugs that
produce a wrong result, a crash, or data loss on some input you can name.
Read the diff and the files around it before you conclude anything.

Write the result to \`${AI_REVIEW_FINDINGS_PATH}\` in the workspace root, as a
single JSON object shaped exactly like this:

{
  "${AI_REVIEW_FINDINGS_KEY}": [
    {
      "severity": "one of: ${blocking}, ${passive}",
      "file": "repo-relative path",
      "line": 1,
      "summary": "one sentence stating the defect",
      "failure_scenario": "concrete inputs or state, then the wrong output"
    }
  ],
  "verdict": "${AI_REVIEW_VERDICTS.join(" or ")}"
}

Rules for the payload, each of which a later step enforces:

- Severities ${blocking} block the pull request. Severities ${passive} do not.
  A severity outside that list makes the whole review unreadable, so use no
  other word.
- Found nothing: write an empty ${AI_REVIEW_FINDINGS_KEY} list and the verdict
  ${AI_REVIEW_VERDICTS[0]}. An empty payload is a result; a missing file is not.
- Your verdict does not decide whether the run blocks. A later step computes
  that from the severities and refuses a verdict that disagrees with them, so
  a ${AI_REVIEW_VERDICTS[0]} over a blocking finding fails the job rather than
  passing it.
- Write the file even if you can say nothing useful. A job with no payload has
  not passed a review, it has not had one.

Do not post review comments, do not push commits, and do not edit any file in
the tree other than the payload above.
`;
}

/**
 * The bash that reports whether the review action actually completed.
 *
 * ## Why this step exists beside the action
 *
 * The action runs with `continue-on-error`, and it has to: this job may carry
 * no `if:` at any level, so the action runs even in mode `none`, where it has
 * no credential and fails. Without `continue-on-error` every unconfigured
 * consumer gets a red pipeline on the first scaffold; with it and nothing
 * else, an action that died for any reason at all is a green check.
 *
 * So the step's outcome comes back through `env:` and is reported here. "No
 * credential, so no review" and "a credential, and the reviewer did not
 * finish" are the same state as far as a required check is concerned, and
 * #631 wired the reviewer that makes the second one reachable: UNMEASURED.
 *
 * Mode `none` is silent here because the auth step has already annotated it.
 * Annotating it in both places would report one state as two.
 *
 * Whether the payload itself is readable is a different question with a
 * different answer, and it is asked once, by the findings reader — not here.
 * Two deciders answering one question about one input are behaviourally one.
 *
 * No `if:`, at step level or any other. The mode and the outcome arrive
 * through `env:` like every other value in this file: they are literals we
 * generated, not user input, but a `${{ }}` inside `run:` is interpolated
 * before bash sees it and the convention does not get to have exceptions for
 * the cases we think are safe.
 */
export function buildReviewRunScript(): string {
  const pending =
    `The review action (#631) did not complete, so no AI review ran on this ` +
    `pull request and nothing was written to ${AI_REVIEW_FINDINGS_PATH}. This ` +
    `check is UNMEASURED, not a passing review.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and the review ` +
    `action (#631) did not complete, so this pull request has no AI review. ` +
    `Failing rather than reporting a green check for a review that never ` +
    `happened.`;

  return `# Generated by rungate — lib/scaffold/ai-review-step.ts. Do not edit.
#
# Mode \`none\` has already annotated itself in the auth step. Annotating it
# again here would report one state as two.
set -uo pipefail

if [ "\${AI_REVIEW_MODE:-none}" = none ]; then
  exit 0
fi

if [ "\${AI_REVIEW_ACTION_OUTCOME:-}" = success ]; then
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

/** Indent a block of YAML lines, leaving blank lines blank. */
function indented(lines: string[], indent: string): string {
  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}

/**
 * The review steps, as YAML, ready to be indented under a job's `steps:`.
 *
 * Three steps, in the order they have to run: authenticate to Vertex, run the
 * reviewer, say whether it ran. Every credential is gated on the mode the
 * auth step resolved rather than on the secret itself — the auth step is the
 * single decider, and a second `secrets.X != ''` reading here would be a
 * decider that always agrees with it and can never be told apart from it.
 *
 * `use_vertex` is an input, not a condition. Nothing in this job is allowed an
 * `if:`: a step skipped by `if:` reports `skipped`, and a skipped required
 * check can be treated as satisfied.
 */
export function buildReviewRunStep(indent = "      "): string {
  const modeIs = (mode: string) =>
    `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == '${mode}'`;
  const credential = (mode: string, secret: string) =>
    `\${{ ${modeIs(mode)} && secrets.${secret} || '' }}`;

  const vertexAuth = [
    `- name: ${AI_REVIEW_VERTEX_AUTH_STEP_NAME}`,
    `  id: ${AI_REVIEW_VERTEX_AUTH_STEP_ID}`,
    // Not a condition: the job may carry none. In every other mode the key is
    // empty, the action fails, and the reporting step below says so.
    `  continue-on-error: true`,
    `  uses: ${AI_REVIEW_VERTEX_AUTH_ACTION}@${AI_REVIEW_VERTEX_AUTH_SHA} # ${AI_REVIEW_VERTEX_AUTH_VERSION}`,
    `  with:`,
    `    credentials_json: ${credential("vertex", "GCP_SA_KEY")}`,
  ];

  const review = [
    `- name: ${AI_REVIEW_ACTION_STEP_NAME}`,
    `  id: ${AI_REVIEW_ACTION_STEP_ID}`,
    `  continue-on-error: true`,
    `  uses: ${AI_REVIEW_ACTION}@${AI_REVIEW_ACTION_SHA} # ${AI_REVIEW_ACTION_VERSION}`,
    `  env:`,
    // Vertex needs a project and a region; neither is a secret, and neither
    // is inferable from the service-account key by the reviewer.
    `    ANTHROPIC_VERTEX_PROJECT_ID: \${{ vars.ANTHROPIC_VERTEX_PROJECT_ID }}`,
    `    CLOUD_ML_REGION: \${{ vars.CLOUD_ML_REGION }}`,
    `  with:`,
    `    use_vertex: \${{ ${modeIs("vertex")} }}`,
    `    claude_code_oauth_token: ${credential("oauth", "CLAUDE_CODE_OAUTH_TOKEN")}`,
    `    anthropic_api_key: ${credential("api-key", "ANTHROPIC_API_KEY")}`,
    `    claude_args: --model ${AI_REVIEW_MODEL} --allowedTools Read,Grep,Glob,Write`,
    `    prompt: |`,
    ...buildReviewPrompt().trimEnd().split("\n").map(l => (l ? `      ${l}` : "")),
  ];

  const report = [
    `- name: ${AI_REVIEW_RUN_STEP_NAME}`,
    `  id: ${AI_REVIEW_RUN_STEP_ID}`,
    `  env:`,
    `    AI_REVIEW_MODE: \${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode }}`,
    `    AI_REVIEW_ACTION_OUTCOME: \${{ steps.${AI_REVIEW_ACTION_STEP_ID}.outcome }}`,
    `    ${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
    `  run: |`,
    ...buildReviewRunScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return indented(vertexAuth, indent) + indented(review, indent) + indented(report, indent);
}
