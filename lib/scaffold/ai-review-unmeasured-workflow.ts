/**
 * The workflow that runs the unmeasured classifier automatically (#1488).
 *
 * #1486 shipped the classifier — `lib/ai-review-unmeasured.ts` — and a
 * recorder somebody has to type, `scripts/record-ai-review-unmeasured.ts`.
 * It works: #1470's ledger comment carries five `"unmeasured": "declined"`
 * beside five intact `"findings": null`. What it does not do is run, and the
 * evidence it reads has a deadline. Actions logs expire, so every round whose
 * log ages out loses its discriminator permanently. The classifier makes the
 * question answerable; until this file it did not make it answered.
 *
 * ## Why this is a second workflow and not a step in the ai-review job
 *
 * The persist step runs MID-JOB, between the reviewer and the adjudicator,
 * and `gh run view --job <id> --log` on a running job answers
 *
 * ```
 * run <id> is still in progress; logs will be available when it is complete
 * ```
 *
 * There is no moment inside that job at which the log exists to be read. Two
 * older readings agree and are now corroboration rather than the argument:
 * `AI_REVIEW_APP_INSTALL_CAUSE`'s docblock (*"A later step cannot read a
 * previous step's stdout"*, #803), and `test/ai-review-payload-reading.test.ts`
 * AC-6, which refuses the action's skip prose anywhere in the generated
 * script because *"the check cannot tell a grep from a mention"*.
 *
 * `workflow_run: completed` fires after the job ends, which is the first
 * moment the log is served.
 *
 * ## It is not a required check and it must never look like one
 *
 * A `workflow_run` workflow reports no status to the pull request, so it
 * cannot gate anything and cannot hang a merge queue. That is why it is the
 * one generated workflow with no `merge_group` trigger —
 * `test/merge-group-trigger.test.ts` narrows its population to the workflows
 * that CAN be required, and `test/ai-review-unmeasured-workflow.test.ts`
 * AC-7 asserts this file is outside it for the stated reason rather than by
 * being forgotten.
 *
 * ## The subscription is DERIVED, not spelled twice
 *
 * `workflow_run.workflows` matches on a workflow's `name:`. Two literals
 * reading `AI Review` in two files is two deciders agreeing, and a rename of
 * one would leave this workflow subscribed to a workflow that no longer
 * exists — firing never, which is indistinguishable from firing and finding
 * nothing to classify. So `AI_REVIEW_WORKFLOW_NAME` is declared here, the
 * generated `ai-review.yml` renders its `name:` from it, and AC-8 asserts
 * the subscription names the workflow the generator actually produced.
 */

/**
 * The `name:` of the workflow that produces the rounds this one classifies.
 *
 * Declared HERE rather than in `lib/scaffold/steps.ts` beside the file it
 * titles, because the subscriber is the side that breaks silently: a
 * workflow whose `workflows:` list names nothing never runs, and a workflow
 * that never runs emits no annotation, no log and no check.
 */
export const AI_REVIEW_WORKFLOW_NAME = "AI Review";

/** The file this module generates, under `.github/workflows/`. */
export const AI_REVIEW_UNMEASURED_WORKFLOW_FILE = "ai-review-unmeasured.yml";

/** The one job in it. */
export const AI_REVIEW_UNMEASURED_JOB = "record-unmeasured";

/**
 * The CLI command the step runs.
 *
 * Spelled once, and `lib/cli-commands.ts` must register it or the generated
 * workflow invokes a command `bin/rungate.ts` will refuse — which is #675's
 * defect, a documented interface with nothing behind it.
 */
export const AI_REVIEW_UNMEASURED_COMMAND = "record-ai-review-unmeasured";

/** `owner/name` of the repository whose ledger comments are being patched. */
export const AI_REVIEW_UNMEASURED_REPO_VAR = "AI_REVIEW_UNMEASURED_REPO";

/** The head commit of the run that just finished. */
export const AI_REVIEW_UNMEASURED_SHA_VAR = "AI_REVIEW_UNMEASURED_HEAD_SHA";

/**
 * The step's `run:` body.
 *
 * Exported so `test/ai-review-unmeasured-workflow.test.ts` executes THIS
 * text, rather than a paraphrase of it, against a planted ledger and a stub
 * `gh`. A test that asserts on a string the job never runs is the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` opens with.
 *
 * ## Every line of it is about one of two conflations
 *
 * **An absent sha is UNMEASURED, not "no rounds to classify".** A
 * `workflow_run` payload with no `head_sha` is a reading that could not be
 * taken. Exiting 0 silently here would report the same thing as a run that
 * read forty rounds and found them all already recorded.
 *
 * **The recorder's own exit code is this step's.** It exits non-zero when it
 * REFUSED a pull request — an unlocatable fence, a body that would not read
 * back, a failed PATCH — and those are the cases where a round's reading was
 * taken and then dropped, with the log now one day closer to expiry. A
 * `continue-on-error` or a `|| true` here would convert each of them into a
 * green check, which is this feature's own defect reintroduced in its
 * delivery mechanism.
 *
 * Note what is NOT here: no filter on the finished run's conclusion. A
 * declined run SUCCEEDS — the action exits zero on its own
 * workflow-validation guard — so `if: failure()` would skip exactly the
 * population #1455 is about, and `conclusion == 'success'` would admit it by
 * accident rather than on purpose. The classifier reads the log; nothing
 * upstream of it gets to pre-judge which runs are worth reading.
 */
export function buildRecordUnmeasuredScript(version: string): string {
  return `set -u
if [ -z "\${${AI_REVIEW_UNMEASURED_SHA_VAR}}" ]; then
  echo "::warning title=AI review unmeasured UNMEASURED::The workflow_run payload carried no head_sha, so no pull request could be resolved and no round was classified. This is UNMEASURED — not a run with nothing to classify. The two are the same green check from outside, which is the conflation this workflow exists to undo."
  exit 0
fi
# The FULL log of each round's own run, never --log-failed: the skip line is
# emitted by a step that SUCCEEDS, so --log-failed returns 0 bytes on a
# declined run. Never the clock either. Both readings are measured in
# lib/ai-review-unmeasured.ts and both are wrong.
#
# --write, because a reading taken and not stored is a log fetched one day
# before it expired and thrown away.
bunx rungate@${version} ${AI_REVIEW_UNMEASURED_COMMAND} \\
  --repo "\${${AI_REVIEW_UNMEASURED_REPO_VAR}}" \\
  --head-sha "\${${AI_REVIEW_UNMEASURED_SHA_VAR}}" \\
  --write
`;
}

export interface UnmeasuredWorkflowOptions {
  /** The `runs-on:` value, already JSON-quoted by the caller. */
  runsOn: string;
  /** The pinned `oven-sh/setup-bun` action reference. */
  setupBun: string;
  /**
   * The `with:` body of that step, at ten spaces.
   *
   * `setupBunWith` renders the project's single bun declaration and nothing
   * else; the `- uses:` line around it is the caller's, exactly as it is for
   * the other three generated workflows. Taking the composed block instead
   * would put a second renderer of that declaration in the tree, which is
   * the defect #622 removed.
   */
  setupBunWith: string;
  /** The published harness version the step runs through `bunx`. */
  version: string;
}

/**
 * The whole `ai-review-unmeasured.yml` body.
 *
 * No `actions/checkout`. The step reads nothing out of the repository — it
 * talks to the GitHub API about a repository it is told the name of — and a
 * `workflow_run` workflow that checks out code is the shape that turns a
 * fork's pull request into code execution with a write token.
 */
export function buildAiReviewUnmeasuredWorkflow(opts: UnmeasuredWorkflowOptions): string {
  const script = buildRecordUnmeasuredScript(opts.version)
    .trimEnd()
    .split("\n")
    .map(line => (line === "" ? "" : `          ${line}`))
    .join("\n");

  return `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
#
# WHICH KIND of unmeasured each unmeasured AI review round was (#1488).
#
# 48 of 117 rounds across the 45 most recent pull requests recorded
# \`findings: null\` — a round nobody read — and nothing said whether that was
# the action declining on its own workflow-validation guard (#1455), a run
# that reviewed and wrote no payload (#1478), or a payload that did not
# parse. Three facts that cost the same and are fixed differently, and a row
# that cannot tell them apart is a row nobody can act on.
#
# The evidence is the finished run's FULL job log, and it is only readable
# from OUTSIDE the run: the persist step that writes the round runs mid-job,
# and the Actions log endpoint refuses a job that is still running. Hence a
# second workflow on \`workflow_run: completed\` rather than a step.
#
# THIS WORKFLOW REPORTS NO STATUS TO THE PULL REQUEST. A \`workflow_run\`
# workflow cannot be a required check and cannot hang a merge queue, which is
# why — alone among the generated workflows — it declares no \`merge_group\`
# trigger. Do not add one: it would fire with no \`workflow_run\` context.
#
# IT WRITES, SO READ WHAT IT CAN REACH. The only write is a PATCH of the
# AI-review ledger comment on the pull request carrying the finished run's
# head commit. It checks out no code, which is what keeps a fork's pull
# request from reaching a write token through it.
name: AI Review Unmeasured

on:
  workflow_run:
    # The NAME of the producing workflow, which is the only thing
    # \`workflow_run\` matches on. Generated from one constant shared with the
    # file it names, because a subscription to a renamed workflow fires never
    # and firing never looks exactly like finding nothing to classify.
    workflows: ["${AI_REVIEW_WORKFLOW_NAME}"]
    types: [completed]

permissions:
  contents: read
  # Read the finished run's full job log. The whole reading.
  actions: read
  # PATCH the findings ledger comment with the discriminator (#1486).
  pull-requests: write

jobs:
  ${AI_REVIEW_UNMEASURED_JOB}:
    runs-on: ${opts.runsOn}
    steps:
      - uses: ${opts.setupBun}
        with:
${opts.setupBunWith}
      - name: Record which kind of unmeasured each round was
        env:
          ${AI_REVIEW_UNMEASURED_REPO_VAR}: \${{ github.repository }}
          ${AI_REVIEW_UNMEASURED_SHA_VAR}: \${{ github.event.workflow_run.head_sha }}
          # The recorder shells out to \`gh\`. No secret is involved: the
          # run's own token carries exactly the three permissions above.
          GH_TOKEN: \${{ github.token }}
        run: |
${script}
`;
}
