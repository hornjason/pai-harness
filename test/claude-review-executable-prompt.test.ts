/**
 * The reviewer's prompt must be executable with the tools the job grants (#732).
 *
 * ## What this is about, and why it is not what the issue says
 *
 * `.github/workflows/claude-review.yml` dispatched twice, concluded **success**
 * both times, and posted nothing. The issue body names the cause as
 * `SlashCommand` sitting on the job's own denylist while the prompt is a slash
 * command. **That is measured to be wrong**, and the measurement is recorded
 * here so the next reader does not re-derive it: a slash command supplied as
 * the CLI PROMPT is expanded before the model ever sees it. Run from a scratch
 * project holding `.claude/commands/canary.md`:
 *
 * ```
 * claude -p "/canary" --disallowedTools "SlashCommand,Bash,Task,…" \
 *        --output-format json
 *   → "result":"ZARQUON", "permission_denials":[], "num_turns":1
 * ```
 *
 * Deleting that one word — which the issue calls the obvious fix — would have
 * changed nothing.
 *
 * Four things were actually blocking it. `lib/review-tool-agreement.ts` names
 * all four, and the pre-#732 fixture row below reports every one of them
 * against the real file rather than a reconstruction of it.
 *
 * ## Why one binding and not a file of assertions
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape: two deciders
 * that agree are behaviourally one. Every case here goes through
 * `reviewToolAgreement`, so there is a single thing to mutate and no second
 * place that decides what counts as a door.
 *
 * ## The cheapest wrong fix, named, and whether these cases survive it
 *
 * **Delete `SlashCommand` from the `--disallowedTools` list.** It is one word,
 * it is what the issue recommends, and it is the 5pm repair. These cases
 * survive it: nothing here reads the denylist for that entry, and all six
 * violations the pre-#732 fixture reports are still reported with the word
 * removed — measured as its own row below, at 6. A case built on "the denylist
 * no longer names SlashCommand" would have gone green over a reviewer that
 * still posts nothing.
 *
 * The second-cheapest, and the one that would have shipped without item 4:
 * **inline the prompt and keep `create_inline_comment` on the allowlist.**
 * `ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER` is the only thing in this file
 * that catches it, which is why that violation reads the TRIGGER block and not
 * the prompt.
 *
 * ## What was broken to prove it
 *
 * Measured over this file alone. Every count predicted before the battery ran,
 * and **the baseline row read before any mutation row** — an instrument that
 * has stopped reporting takes the baseline down with it, and that is the row
 * nobody checks. The counts live in the PR for #732; the rows that are
 * properties rather than numbers are cases in this file, below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMATION_ONLY_TRIGGERS,
  ENTITY_ONLY_MCP_SERVERS,
  POSTING_TOOLS,
  READING_SCRIPT,
  ReviewSourceUnreadableError,
  SUBJECT_OUTPUT_NAME,
  blockUnder,
  jobSteps,
  mcpServerOf,
  mcpToolsNamedIn,
  reviewToolAgreement,
  reviewWorkflowRegions,
  withoutComments,
  type ReviewToolViolationKind,
} from "../lib/review-tool-agreement";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "claude-review.yml");
const live = readFileSync(WORKFLOW, "utf8");

/**
 * The file as it stood when #732 was filed, kept as a fixture rather than read
 * from `git show main:…`. A row measured against a ref that moves is a claim
 * about a tree nobody can check out (`.claude/rules/parallel-sessions.md`);
 * a fixture is the tree, forever.
 */
const PRE_732 = join(import.meta.dir, "fixtures", "claude-review-pre-732.yml");
const pre732 = readFileSync(PRE_732, "utf8");

const kinds = (src: string): ReviewToolViolationKind[] =>
  reviewToolAgreement(src)
    .map(v => v.kind)
    .sort();

/**
 * Apply a mutation, refusing unless the needle occurs EXACTLY once.
 *
 * Not ceremony. Both of these files discuss their own configuration in prose:
 * `--disallowedTools "` and `${{ steps.subject.outputs.diff }}` each appeared
 * twice in the first draft of this file, once in a header comment and once in
 * the step, and `String.replace` took the comment. Two mutations measured 0
 * red while the configuration they were supposed to change was untouched —
 * `.claude/rules/checks-must-be-able-to-fail.md`'s "before you believe a 0,
 * prove the mutation changed behaviour", caught by this helper rather than by
 * a count that happened to look plausible.
 */
/** The live allowlist, verbatim, so a mutant that replaces it aborts loudly
 * when it is reworded rather than quietly measuring an unmutated file. */
const ALLOWLIST =
  '--allowedTools "mcp__github__create_pending_pull_request_review,' +
  "mcp__github__add_comment_to_pending_review," +
  'mcp__github__submit_pending_pull_request_review"';

/** The allowlist both green runs on #732 had: one tool, which this trigger
 * cannot provide. */
const INLINE_COMMENT_ALLOWLIST =
  '--allowedTools "mcp__github_inline_comment__create_inline_comment"';

/**
 * The one step that RUNS the reading script, refusing on zero or two.
 *
 * `withoutComments` is not optional here: the `setup-bun` step's comment
 * names the script in prose, so a raw-text search returns two steps for a
 * file with one. Measured — this helper threw "2 steps run the reading
 * script" before the comment strip was added, which is the loud abort doing
 * its job on its own author.
 */
function readingStep(src: string): string {
  const hits = jobSteps(src).filter(s => withoutComments(s).includes(READING_SCRIPT));
  if (hits.length !== 1) {
    throw new Error(`could not build the mutant: ${hits.length} steps run the reading script`);
  }
  return hits[0];
}

function mutateOnce(src: string, needle: string, replacement: string): string {
  const occurrences = src.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: ${JSON.stringify(needle)} appears ${occurrences} times, not once`,
    );
  }
  return src.replace(needle, replacement);
}

describe("the reviewer's prompt is executable with the tools the job grants (#732)", () => {
  /**
   * Asserted FIRST, and asserted of both inputs. Every claim below is of the
   * form "this string does not contain X", and all of them hold vacuously of
   * an empty cut. A cut that failed to find its section is an empty string and
   * an empty string is a clean bill of health.
   */
  test("AC-0: the regions are the step, the prompt and the args — bounded, and not the file", () => {
    for (const [label, src] of [
      ["live", live],
      ["pre-732", pre732],
    ] as const) {
      const r = reviewWorkflowRegions(src);
      expect(r.reviewStep, label).toContain("anthropics/claude-code-action");
      expect(r.reviewStep.length, label).toBeLessThan(src.length / 2);
      expect(r.triggerBlock, label).toContain("workflow_dispatch");
      expect(r.triggerBlock.length, label).toBeLessThan(src.length / 4);
      expect(r.claudeArgs, label).toContain("--allowedTools");
      expect(r.claudeArgs, label).toContain("--disallowedTools");
      expect(r.prompt.trim().length, label).toBeGreaterThan(0);
      // The header of both files discusses `create_inline_comment`,
      // `plugin_marketplaces` and `Task` in PROSE. If the cuts were the whole
      // document every violation below would fire off the documentation of its
      // own absence — `.claude/rules/checks-must-be-able-to-fail.md`
      // §"search the slice, not the document".
      expect(src, label).toContain("create_inline_comment");
      expect(r.prompt, label).not.toContain("EGRESS SINK");
    }
  });

  test("AC-1: the live workflow reports no door", () => {
    const violations = reviewToolAgreement(live);
    expect(
      violations,
      violations.map(v => `${v.kind}: ${v.detail}`).join("\n"),
    ).toEqual([]);
  });

  /**
   * The only row that measures against the defect rather than a reconstruction
   * of it. Six doors, and the issue body names none of them.
   */
  test("AC-2: the pre-#732 workflow reports all six doors, by name", () => {
    expect(kinds(pre732)).toEqual([
      "ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER",
      "MUTABLE_PLUGIN_MARKETPLACE",
      "NO_STEP_READS_THE_EXECUTION_OUTPUT",
      "NO_SUBJECT_REACHES_THE_AGENT",
      "PROMPT_IS_A_SLASH_COMMAND",
      "PROMPT_NAMES_NO_TOOL",
    ]);
  });

  /**
   * The fifth shape, performed rather than asserted: the repair the issue
   * recommends, applied to the real pre-#732 file. If these cases went green
   * under it they would certify the regression they were written to block.
   */
  test("AC-3: deleting SlashCommand from the denylist — the issue's own fix — changes nothing", () => {
    const cheapFix = mutateOnce(pre732, "Task,SlashCommand,ExitPlanMode", "Task,ExitPlanMode");
    expect(reviewWorkflowRegions(cheapFix).claudeArgs).not.toContain("SlashCommand");
    expect(kinds(cheapFix)).toEqual(kinds(pre732));
  });

  /**
   * The second-cheapest repair: inline the prompt and leave the allowlist
   * alone. Every prompt-shaped violation goes away and the reviewer still
   * posts nothing, because the tool it is told to use does not exist under
   * `workflow_dispatch`.
   */
  test("AC-4: inlining the prompt while keeping create_inline_comment is still caught", () => {
    const halfFix = mutateOnce(live, ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    expect(kinds(halfFix)).toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
  });

  test("AC-5: a prompt naming a denied tool is caught", () => {
    const mutant = mutateOnce(
      live,
      "mcp__github__create_pending_pull_request_review to open a",
      "mcp__github_inline_comment__create_inline_comment to open a",
    );
    expect(kinds(mutant)).toContain("PROMPT_NAMES_AN_UNGRANTED_TOOL");
  });

  /**
   * Not redundant with AC-5. An ungranted tool is one the allowlist forgot; a
   * denied one is a tool somebody deliberately took away and the prompt then
   * asked for anyway. They are different mistakes and the message has to say
   * which — "add it to the allowlist" is wrong advice for the second.
   */
  test("AC-6: the two ways a prompt's tool fails are reported as different kinds", () => {
    const denied = mutateOnce(
      live,
      '--disallowedTools "Bash,BashOutput',
      '--disallowedTools "mcp__github__submit_pending_pull_request_review,Bash,BashOutput',
    );
    expect(kinds(denied)).toContain("PROMPT_NAMES_A_DENIED_TOOL");
    expect(kinds(denied)).not.toContain("PROMPT_NAMES_AN_UNGRANTED_TOOL");
  });

  /**
   * With no fetching tool granted, the diff can only reach the agent in the
   * prompt. `${{ steps.guard.outputs.pr }}` is a step output and a PR NUMBER
   * is not the code — the near-miss that makes `SUBJECT_OUTPUT_NAME` a name
   * rather than a shape.
   */
  test("AC-7: a prompt carrying only the PR number, with no read tool, is caught", () => {
    const mutant = mutateOnce(
      live,
      `\${{ steps.subject.outputs.${SUBJECT_OUTPUT_NAME} }}`,
      "${{ steps.guard.outputs.pr }}",
    );
    expect(kinds(mutant)).toContain("NO_SUBJECT_REACHES_THE_AGENT");
  });

  test("AC-8: an allowlist with nothing that can post is caught", () => {
    const mutant = mutateOnce(live, ALLOWLIST, '--allowedTools "mcp__github__get_pull_request_diff"');
    expect(kinds(mutant)).toContain("NO_POSTING_TOOL_IS_ALLOWED");
    // …and that same mutant must NOT report a missing subject: a fetching tool
    // is granted, so the agent can see the code. Two questions, two answers.
    expect(kinds(mutant)).not.toContain("NO_SUBJECT_REACHES_THE_AGENT");
  });

  test("AC-9: reintroducing the mutable plugin marketplace is caught", () => {
    const mutant = mutateOnce(
      live,
      "          github_token: ${{ secrets.GITHUB_TOKEN }}",
      '          github_token: ${{ secrets.GITHUB_TOKEN }}\n          plugin_marketplaces: "https://github.com/anthropics/claude-code.git"',
    );
    expect(kinds(mutant)).toContain("MUTABLE_PLUGIN_MARKETPLACE");
  });

  test("AC-10: a reading step that reads the wrong output is caught", () => {
    const mutant = mutateOnce(
      live,
      "--execution-file \"$EXECUTION_FILE\"",
      "--execution-file \"$BRANCH_NAME\"",
    ).replace(/EXECUTION_FILE: \$\{\{ steps\.review\.outputs\.execution_file \}\}/, "BRANCH_NAME: x");
    expect(kinds(mutant)).toContain("NO_STEP_READS_THE_EXECUTION_OUTPUT");
  });

  /**
   * The defect the first live dispatch of this very change found in this very
   * module, posted as an inline comment on PR #746 and repaired here.
   *
   * The check was `/execution_file/.test(source)` over the WHOLE workflow.
   * The string already appears in a comment inside the Review step, so
   * deleting the reading step entirely left the check satisfied — by prose
   * about the thing it was looking for.
   * `.claude/rules/checks-must-be-able-to-fail.md` §"search the slice, not the
   * document", found by the reviewer rather than by its author, which is the
   * first evidence this job does anything.
   */
  test("AC-15: deleting the reading step is caught, though the file still says execution_file", () => {
    const step = readingStep(live);
    const withoutStep = mutateOnce(live, step, "");
    // The control, and the whole point: the prose that satisfied the first
    // draft of this check is still in the file.
    expect(withoutStep).toContain("execution_file");
    expect(
      jobSteps(withoutStep).filter(s => withoutComments(s).includes(READING_SCRIPT)),
    ).toEqual([]);
    expect(kinds(withoutStep)).toContain("NO_STEP_READS_THE_EXECUTION_OUTPUT");
  });

  test("AC-16: a reading step that is not `if: always()` is caught", () => {
    const step = readingStep(live);
    const mutant = mutateOnce(live, step, step.replace(/^\s*if: always\(\)\n/m, ""));
    expect(jobSteps(mutant).filter(s => withoutComments(s).includes(READING_SCRIPT))).toHaveLength(
      1,
    );
    expect(kinds(mutant)).toContain("NO_STEP_READS_THE_EXECUTION_OUTPUT");
  });

  /**
   * The trigger half of item 4, isolated. `ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER`
   * is about an interaction between two readings, so a case has to vary ONE of
   * them to be a measurement of it (#585). This varies the trigger and holds
   * the allowlist fixed; AC-4 varies the allowlist and holds the trigger fixed.
   */
  test("AC-11: the same allowlist under an entity trigger is NOT a violation", () => {
    const dispatchTriggered = mutateOnce(live, ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    const entityTriggered = mutateOnce(
      dispatchTriggered,
      "\non:\n  workflow_dispatch:",
      "\non:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:",
    );
    // The pair differs in the TRIGGER and in nothing else — asserted, not
    // promised, because a pair that varies two things measures neither (#585).
    expect(entityTriggered.replace("  pull_request:\n    branches: [main]\n", "")).toEqual(
      dispatchTriggered,
    );
    expect(kinds(entityTriggered)).not.toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
    expect(kinds(dispatchTriggered)).toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
  });

  /**
   * `blockUnder` is the instrument every cut above goes through. Not-found and
   * found-twice are both refusals, for `lib/source-slice.ts`'s reason: a
   * confident answer about the wrong region is worse than no answer.
   */
  test("AC-12: the cut refuses zero and two occurrences rather than guessing", () => {
    expect(() => blockUnder("a:\n  b: 1\n", "- name: Review")).toThrow(ReviewSourceUnreadableError);
    expect(() => blockUnder("- name: Review\n  a: 1\n- name: Review\n  b: 2\n", "- name: Review")).toThrow(
      ReviewSourceUnreadableError,
    );
    // A document with no Review step refuses rather than returning an empty
    // cut. The class is `lib/source-slice.ts`'s or this module's depending on
    // which cut fails first; what matters is that nothing comes back.
    expect(() => reviewWorkflowRegions("on:\n  push:\n\npermissions: {}\n")).toThrow();
  });

  /**
   * The upstream facts items 3 and 4 rest on, pinned so a reader can check
   * them and so a widening of either table is a deliberate edit.
   */
  test("AC-13: the entity-only server table names its source, and workflow_dispatch is automation", () => {
    expect(Object.keys(ENTITY_ONLY_MCP_SERVERS)).toContain("github_inline_comment");
    for (const why of Object.values(ENTITY_ONLY_MCP_SERVERS)) {
      expect(why).toMatch(/\.ts:?\d*/);
    }
    expect(AUTOMATION_ONLY_TRIGGERS).toContain("workflow_dispatch");
    expect(AUTOMATION_ONLY_TRIGGERS as readonly string[]).not.toContain("pull_request");
    expect(POSTING_TOOLS).toContain("mcp__github_inline_comment__create_inline_comment");
  });

  test("AC-14: tool tokens are read out of prose, and a built-in is not an mcp tool", () => {
    expect(mcpToolsNamedIn("use mcp__github__add_issue_comment, then Bash")).toEqual([
      "mcp__github__add_issue_comment",
    ]);
    expect(mcpToolsNamedIn("no tools here")).toEqual([]);
    expect(mcpServerOf("mcp__github_inline_comment__create_inline_comment")).toBe(
      "github_inline_comment",
    );
    expect(mcpServerOf("Bash")).toBeNull();
  });
});
