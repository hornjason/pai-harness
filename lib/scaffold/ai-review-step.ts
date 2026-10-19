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

/**
 * The outcome step's `id:`. Separate from the auth step, so each has one job.
 *
 * This is the `run:` step that reads what the review action did and decides
 * whether the job may conclude. It is NOT the step that runs the review —
 * that is `AI_REVIEW_ACTION_STEP_ID` below.
 */
export const AI_REVIEW_RUN_STEP_ID = "ai-review-run";

export const AI_REVIEW_RUN_STEP_NAME = "Report the AI review outcome";

/** The checkout step's `id:`. */
export const AI_REVIEW_CHECKOUT_STEP_ID = "ai-review-checkout";
export const AI_REVIEW_CHECKOUT_STEP_NAME = "Check out the pull request";

/** The Vertex auth step's `id:`. */
export const AI_REVIEW_VERTEX_AUTH_STEP_ID = "ai-review-vertex-auth";
export const AI_REVIEW_VERTEX_AUTH_STEP_NAME = "Authenticate to Vertex AI";

/** The step that actually runs the reviewer. */
export const AI_REVIEW_ACTION_STEP_ID = "ai-review-action";
export const AI_REVIEW_ACTION_STEP_NAME = "Run the AI review";

/**
 * An action the generated job runs, pinned.
 *
 * `version` is a comment on the emitted line and nothing reads it. `sha` is
 * the pin — a tag or a branch moves under the consumer without a commit in
 * their tree, and a review job is the last place that should be true.
 */
export interface AiReviewAction {
  repo: string;
  /** A 40-character lowercase commit sha. Asserted, not promised. */
  sha: string;
  /** The tag the sha was taken from, emitted as a trailing comment. */
  version: string;
}

/**
 * Every action the generated review job runs, in emission order.
 *
 * Declared once here and read by `buildReviewRunStep`, so there is one
 * position to mutate and one position to bump. A literal typed into the step
 * builder beside this table would be a second decider and would survive any
 * change to the first (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * fourth shape).
 *
 * The shas are the ones `.github/workflows/claude-review.yml` has been
 * running in this repository, rather than resolved fresh and unverified.
 */
export const AI_REVIEW_CHECKOUT_ACTION: AiReviewAction = {
  repo: "actions/checkout",
  sha: "d23441a48e516b6c34aea4fa41551a30e30af803",
  version: "v6",
};

export const AI_REVIEW_VERTEX_AUTH_ACTION: AiReviewAction = {
  repo: "google-github-actions/auth",
  sha: "c200f3691d83b41bf9bbd8638997a462592937ed",
  version: "v2",
};

export const AI_REVIEW_ACTION: AiReviewAction = {
  repo: "anthropics/claude-code-action",
  sha: "f27be6b65a4652f08a2ba3cff79114829b588967",
  version: "v1",
};

export const AI_REVIEW_ACTIONS: readonly AiReviewAction[] = [
  AI_REVIEW_CHECKOUT_ACTION,
  AI_REVIEW_VERTEX_AUTH_ACTION,
  AI_REVIEW_ACTION,
];

/** Where a mode's credential enters the job, and under which input name. */
export interface AiReviewCredentialInput {
  mode: Exclude<AiReviewAuthMode, "none">;
  /** The step the input is passed to. */
  stepId: string;
  /** The action input name. */
  input: string;
  /** The repository secret the value is read from. */
  secret: string;
}

/**
 * The input each credentialed mode populates — a TOTAL record, so a fourth
 * mode added to `AiReviewAuthMode` is a build error here rather than a mode
 * that resolves at runtime and reaches the action with nothing.
 */
const CREDENTIAL_INPUT_BY_MODE: Record<
  Exclude<AiReviewAuthMode, "none">,
  { stepId: string; input: string }
> = {
  vertex: { stepId: AI_REVIEW_VERTEX_AUTH_STEP_ID, input: "credentials_json" },
  oauth: { stepId: AI_REVIEW_ACTION_STEP_ID, input: "claude_code_oauth_token" },
  "api-key": { stepId: AI_REVIEW_ACTION_STEP_ID, input: "anthropic_api_key" },
};

/**
 * Every credential the job can pass, derived from the auth ladder.
 *
 * Derived rather than re-listed: the secret names live in
 * `AI_REVIEW_AUTH_PRECEDENCE` and nowhere else, so the step that RESOLVES a
 * mode and the step that USES it cannot disagree about which secret that mode
 * is named after.
 */
export const AI_REVIEW_CREDENTIAL_INPUTS: readonly AiReviewCredentialInput[] =
  AI_REVIEW_AUTH_PRECEDENCE.map(c => ({
    mode: c.mode,
    secret: c.secret,
    ...CREDENTIAL_INPUT_BY_MODE[c.mode],
  }));

/**
 * What the reviewer is asked to do.
 *
 * The same plugin and prompt `.github/workflows/claude-review.yml` runs here,
 * so a consumer's generated job is the job this repository has evidence for
 * rather than a guess. The tool list is a delay rather than a defence, and is
 * kept for the same reason that file keeps it.
 */
export const AI_REVIEW_PLUGIN_MARKETPLACE = "https://github.com/anthropics/claude-code.git";
export const AI_REVIEW_PLUGIN = "code-review@claude-code-plugins";
export const AI_REVIEW_PROMPT =
  "/code-review:code-review --comment ${{ github.repository }}/pull/${{ github.event.pull_request.number }}";
export const AI_REVIEW_CLAUDE_ARGS =
  '--allowedTools "mcp__github_inline_comment__create_inline_comment" ' +
  '--disallowedTools "Bash,BashOutput,KillShell,Task,SlashCommand,ExitPlanMode,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch" ' +
  "--max-turns 25";

const SECRET_NAMES = AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret);

/** `steps.<auth>.outputs.mode == '<mode>'` — the only thing anything is keyed on. */
function modeIs(mode: AiReviewAuthMode): string {
  return `steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode == '${mode}'`;
}

/**
 * A credential value, keyed on the resolved mode.
 *
 * `${{ <mode test> && secrets.X || '' }}` hands the action the secret in one
 * mode and the empty string in every other. The secret is in a VALUE
 * position, never a deciding one — the decision is the auth step's resolved
 * mode output, which is the whole of #631 AC-1. A `${{ secrets.X != '' }}`
 * condition is not merely discouraged here: `secrets` is unavailable in `if:`
 * at all, and a step skipped by `if:` reports `skipped`, which a required
 * check can treat as satisfied.
 */
function credentialValue(c: AiReviewCredentialInput): string {
  return `\${{ ${modeIs(c.mode)} && secrets.${c.secret} || '' }}`;
}

function inputsFor(stepId: string): string[] {
  return AI_REVIEW_CREDENTIAL_INPUTS.filter(c => c.stepId === stepId).map(
    c => `${c.input}: ${credentialValue(c)}`,
  );
}

function usesLine(action: AiReviewAction): string {
  return `uses: ${action.repo}@${action.sha} # ${action.version}`;
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
 * The bash the outcome step runs once the review action has had its turn.
 *
 * ## Why a `run:` step reads the action's outcome instead of an `if:`
 *
 * The auth-detect step makes `none` honest. It does nothing for the other
 * three, and on a repository that HAS a credential those are the only modes
 * reachable — so without something here, a job named "AI Review" concludes
 * success on every pull request and says nothing about what it measured.
 *
 * The review action now runs for real, which creates the mirror problem: in
 * mode `none` it has no credential and will fail, and a red pipeline on a
 * tree that has never configured a credential is exactly the default
 * `.claude/rules/config-access.md` argues against. The ordinary fix is an
 * `if:` on the action — and that is the one thing this job may not have,
 * because a skipped step reports `skipped` and a skipped required check can
 * be treated as satisfied.
 *
 * So the action carries `continue-on-error: true` and this step judges it:
 *
 * - mode `none` — the auth step has already annotated UNMEASURED. Saying it
 *   again here would report one state as two, so this exits quietly.
 * - a credentialed mode whose review SUCCEEDED — the review happened. Quiet.
 * - a credentialed mode whose review did not succeed — a credential
 *   resolved and no review came of it, which is UNMEASURED and is annotated
 *   as such. `AI_REVIEW_REQUIRE_VAR` decides whether it is also fatal, read
 *   as the exact string `true` and at no other value, exactly as the auth
 *   step reads it.
 *
 * Nothing is interpolated into the script body. The mode and the outcome are
 * values we generated, not user input, but a `${{ }}` inside `run:` is
 * substituted before bash sees it and the convention does not get to have
 * exceptions for the cases we think are safe.
 */
export function buildReviewRunScript(): string {
  const pending =
    `A credential resolved, but the review step did not complete (#631), so ` +
    `no AI review ran on this pull request. This check is UNMEASURED, not a ` +
    `passing review.`;

  const refusal =
    `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and the review ` +
    `step did not complete (#631), so this pull request has no AI review. ` +
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

if [ "\${AI_REVIEW_OUTCOME:-}" = success ]; then
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

/**
 * The credentialed half of the job, as YAML, ready to be indented under a
 * job's `steps:` — checkout, Vertex auth, the review action, and the step
 * that reads what the review did.
 *
 * Every action is pinned to a 40-character commit sha read off
 * `AI_REVIEW_ACTIONS`, and every credential is keyed on the auth step's
 * resolved mode rather than on a secret expression. No step carries an `if:`.
 */
export function buildReviewRunStep(indent = "      "): string {
  const lines = [
    `- name: ${AI_REVIEW_CHECKOUT_STEP_NAME}`,
    `  id: ${AI_REVIEW_CHECKOUT_STEP_ID}`,
    `  ${usesLine(AI_REVIEW_CHECKOUT_ACTION)}`,
    `  with:`,
    `    fetch-depth: 1`,
    // Without this, checkout writes GITHUB_TOKEN into .git/config — a second
    // credential sitting in the tree the reviewer reads. The review needs the
    // files, not the ability to push.
    `    persist-credentials: false`,
    ``,
    `- name: ${AI_REVIEW_VERTEX_AUTH_STEP_NAME}`,
    `  id: ${AI_REVIEW_VERTEX_AUTH_STEP_ID}`,
    // Not an `if:`. In oauth, api-key and none the credential below resolves
    // to the empty string and this action refuses — which is correct and is
    // not the job's verdict, so it is tolerated here and judged by the
    // outcome step rather than skipped by a condition that reports `skipped`.
    `  continue-on-error: true`,
    `  ${usesLine(AI_REVIEW_VERTEX_AUTH_ACTION)}`,
    `  with:`,
    ...inputsFor(AI_REVIEW_VERTEX_AUTH_STEP_ID).map(l => `    ${l}`),
    ``,
    `- name: ${AI_REVIEW_ACTION_STEP_NAME}`,
    `  id: ${AI_REVIEW_ACTION_STEP_ID}`,
    `  continue-on-error: true`,
    `  ${usesLine(AI_REVIEW_ACTION)}`,
    `  with:`,
    `    use_vertex: \${{ ${modeIs("vertex")} }}`,
    ...inputsFor(AI_REVIEW_ACTION_STEP_ID).map(l => `    ${l}`),
    `    plugin_marketplaces: "${AI_REVIEW_PLUGIN_MARKETPLACE}"`,
    `    plugins: "${AI_REVIEW_PLUGIN}"`,
    `    prompt: "${AI_REVIEW_PROMPT}"`,
    `    claude_args: >-`,
    `      ${AI_REVIEW_CLAUDE_ARGS}`,
    ``,
    `- name: ${AI_REVIEW_RUN_STEP_NAME}`,
    `  id: ${AI_REVIEW_RUN_STEP_ID}`,
    `  env:`,
    `    AI_REVIEW_MODE: \${{ steps.${AI_REVIEW_AUTH_STEP_ID}.outputs.mode }}`,
    `    AI_REVIEW_OUTCOME: \${{ steps.${AI_REVIEW_ACTION_STEP_ID}.outcome }}`,
    `    ${AI_REVIEW_REQUIRE_VAR}: \${{ vars.${AI_REVIEW_REQUIRE_VAR} }}`,
    `  run: |`,
    ...buildReviewRunScript().trimEnd().split("\n").map(l => (l ? `    ${l}` : "")),
  ];

  return lines.map(l => (l ? `${indent}${l}` : "")).join("\n") + "\n";
}
