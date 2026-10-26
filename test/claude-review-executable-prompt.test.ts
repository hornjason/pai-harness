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
  FORK_GUARD_COMPANION_EVENTS,
  forkGuardDefect,
  FORK_GUARD_TERMS,
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

/** The allowlist both green runs on #732 had: one tool, which an automation
 * trigger cannot provide. */
const INLINE_COMMENT_ALLOWLIST =
  '--allowedTools "mcp__github_inline_comment__create_inline_comment"';

/**
 * The trailing lines of the `on:` block, exactly: the `pull_request` trigger
 * #631/#675 added and the blank line before `permissions:`. Removing it is how
 * AC-4 and AC-11 reach a dispatch-only tree now that the live one is not.
 *
 * Spelled as the whole region rather than `"  pull_request:\n"` on purpose. The
 * shorter needle also occurs inside the comment above it, and `mutateOnce`
 * would abort — which is the helper working, but a confusing way to find out.
 */
const PULL_REQUEST_TRIGGER = "\n  pull_request:\n\npermissions:";

/** The whole `workflow_dispatch` key and its inputs, so a case can take it
 * away rather than add a second trigger beside it. */
const DISPATCH_TRIGGER =
  "  workflow_dispatch:\n    inputs:\n      pr:\n" +
  '        description: "Pull request number to review"\n' +
  "        required: true\n        type: number\n";

/** What AC-11 and AC-22 put in its place: an entity trigger, alone. */
const ENTITY_TRIGGER = "  pull_request:\n    branches: [main]\n";

/**
 * The live workflow with its entity trigger taken away — `workflow_dispatch`
 * and nothing else, which is what this file measured against before #631/#675.
 *
 * Two cases below are about a door that only exists on an automation-only
 * trigger, so they need a tree that has one. Deriving it from `live` by a
 * single mutation keeps them measuring the live allowlist and the live prompt;
 * a second checked-in fixture would drift away from both and go green on a
 * workflow nobody runs.
 */
function dispatchOnly(src: string): string {
  const stripped = mutateOnce(src, PULL_REQUEST_TRIGGER, "\n\npermissions:");
  // The premise, asserted rather than assumed: this really is automation-only
  // now, and it really was not before. Without the second half the helper
  // could silently become a no-op and both cases below would keep passing
  // while measuring the wrong tree.
  const triggersOf = (s: string) =>
    [...reviewWorkflowRegions(s).triggerBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1]);
  expect(triggersOf(stripped)).toEqual(["workflow_dispatch"]);
  expect(triggersOf(src)).toContain("pull_request");
  return stripped;
}

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
    const halfFix = mutateOnce(dispatchOnly(live), ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    expect(kinds(halfFix)).toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
  });

  /**
   * The promotion #631/#675 made, as a reading rather than a claim: the live
   * file's triggers are no longer automation-only, so the door AC-4 measures
   * is one the live tree does not have.
   *
   * Worth its own case because it is the only thing standing between "the
   * trigger moved" and AC-4 going green for the wrong reason — if `live` were
   * somehow still dispatch-only, `dispatchOnly` would abort and AC-4 would
   * fail, but nothing else here would say which direction the file moved in.
   */
  test("AC-17: the live workflow runs on pull_request, so the entity server exists", () => {
    const triggers = [
      ...reviewWorkflowRegions(live).triggerBlock.matchAll(/^\s{2}([a-z_]+):/gm),
    ].map(m => m[1]);
    expect(triggers).toContain("pull_request");
    expect(triggers).toContain("workflow_dispatch");
    // And the consequence, stated where a reader will see it: the allowlist
    // may now legally grant the inline-comment tool. It still does not —
    // AC-1 holds the live file at zero violations either way — but the reason
    // is the enumeration argument in the workflow's own comment, not a server
    // that cannot start.
    // The entity server now starts on the `pull_request` path — but the
    // grant is still caught, because `workflow_dispatch` is still declared
    // and a run started THAT way still has no such server. See AC-22.
    const entityAllowed = mutateOnce(live, ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    expect(kinds(entityAllowed)).toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
  });

  /**
   * The precision regression the trigger promotion introduced, and the second
   * finding THE REVIEWER raised on the pull request that introduced it.
   *
   * Check 3 used to ask whether EVERY trigger was automation-only. While this
   * file had one trigger that was the same question. With `pull_request` and
   * `workflow_dispatch` side by side it is a strictly weaker one — the check
   * went silent on a mixed set, even though a dispatch run of the same job
   * still has no entity-only server. "Never exists on any trigger" quietly
   * became "does not exist on the intersection of all triggers", with the
   * name and the comment unchanged.
   *
   * The pair below varies ONE thing — whether a second, automation trigger is
   * declared — and nothing else (#585).
   */
  test("AC-22: an entity-only tool is caught per TRIGGER, not over the intersection", () => {
    const mixed = mutateOnce(live, ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    const entityOnly = mutateOnce(mixed, DISPATCH_TRIGGER, "");
    // The control: the pair differs in the dispatch trigger and in nothing
    // else, and the entity trigger is present in both.
    for (const src of [mixed, entityOnly]) {
      expect(
        [...reviewWorkflowRegions(src).triggerBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1]),
      ).toContain("pull_request");
    }
    expect(
      [...reviewWorkflowRegions(entityOnly).triggerBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(
        m => m[1],
      ),
    ).not.toContain("workflow_dispatch");

    // Mixed: caught, because the dispatch path cannot reach the tool.
    expect(kinds(mixed)).toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");
    // Entity ONLY: not a violation. Every declared trigger can start the
    // server, so the grant is reachable on all of them. Without this half the
    // fix could have been "always report", which refuses a correct workflow.
    expect(kinds(entityOnly)).not.toContain("ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER");

    // The message has to say WHICH trigger cannot reach it — "add it to the
    // allowlist" and "drop the dispatch trigger" are different repairs.
    const detail = reviewToolAgreement(mixed)
      .filter(x => x.kind === "ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER")
      .map(x => x.detail)
      .join(" ");
    expect(detail).toContain("workflow_dispatch");
  });

  /**
   * The door the promotion opened, and the reason this case exists at all:
   * the fork decision for `pull_request` moved into a JOB-level `if:`, and
   * for one draft nothing in this file could see it. A guard nothing asserts
   * is a guard the next edit deletes for free.
   *
   * The mutation is the deletion, performed. `FORK_GUARD_TERMS` is two
   * strings and the check reports which one is missing, so removing the
   * condition is caught by name rather than by a bare empty-list assertion.
   */
  test("AC-18: deleting the job's fork condition is caught, now the trigger is an entity one", () => {
    const condition =
      "    if: >-\n" +
      "      github.event_name == 'workflow_dispatch' ||\n" +
      "      github.event.pull_request.head.repo.full_name == github.repository\n";
    const unguarded = mutateOnce(live, condition, "");
    // The control, and the whole point of cutting the job header rather than
    // searching the file: the header's prose about forks is still there, and
    // a whole-document check would read it as the guard.
    expect(unguarded).toContain("github.event.pull_request.head.repo.full_name");
    expect(reviewToolAgreement(unguarded).map(v => v.kind)).toContain(
      "ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD",
    );
    // …and the same deletion on a dispatch-only tree is NOT a violation. One
    // variable differs between the pair — the trigger — so this measures the
    // interaction rather than the deletion (#585).
    expect(kinds(dispatchOnly(unguarded))).not.toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
  });

  /**
   * The wrong fix for AC-18, performed. This one is not hypothetical: the
   * first revision of the check asked only whether both `FORK_GUARD_TERMS`
   * appeared in the job header, and THE REVIEWER THIS MODULE EXISTS TO MAKE
   * WORK caught it on the pull request that promoted the trigger — an
   * inverted guard contains both terms, passes a presence check, and runs the
   * job on forks ONLY.
   *
   * That is the fifth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`: a case that fails today
   * for a true reason and stops failing under the cheapest repair, certifying
   * the regression it was written to block. The repair here is one character.
   */
  test("AC-20: an INVERTED fork condition is caught, though it names both terms", () => {
    const inverted = mutateOnce(
      live,
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    // The control: a presence check over the job header would see no
    // difference at all between this and the live file.
    for (const term of FORK_GUARD_TERMS) {
      expect(reviewWorkflowRegions(inverted).jobHeader).toContain(term);
    }
    expect(kinds(inverted)).toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
    // The operand order is NOT the thing being checked — a reviewer who
    // writes the comparison the other way round is correct and must not be
    // refused for it.
    const swapped = mutateOnce(
      live,
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.repository == github.event.pull_request.head.repo.full_name",
    );
    expect(kinds(swapped)).not.toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
  });

  /**
   * AC-23 is the reviewer's SECOND finding about this guard, on the same pull
   * request. AC-20 fixed `!=` by matching the comparison anywhere in the `if:`,
   * and "anywhere" was the remaining hole: a condition can contain the correct
   * comparison and neutralise it with an arm beside it. `true ||` runs on every
   * fork while reading as a guard.
   *
   * The control is the live file, which is ITSELF a disjunction — so this
   * cannot be fixed by refusing `||`, and a case that only asserts the bypass
   * is caught would also pass against a check that refuses every condition.
   */
  test("AC-23: a neutralising arm beside the comparison is caught; the live disjunction is not", () => {
    const anchor =
      "    if: >-\n" +
      "      github.event_name == 'workflow_dispatch' ||\n" +
      "      github.event.pull_request.head.repo.full_name == github.repository\n";
    for (const neutraliser of ["true", "always()", "github.event_name != 'push'"]) {
      const bypass = mutateOnce(
        live,
        anchor,
        "    if: >-\n" +
          `      ${neutraliser} ||\n` +
          "      github.event.pull_request.head.repo.full_name == github.repository\n",
      );
      // The control for THIS row: the comparison is still present verbatim, so
      // the substring check AC-20 shipped sees nothing wrong with any of them.
      expect(reviewWorkflowRegions(bypass).jobHeader).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(kinds(bypass)).toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
    }
    // …and the live file's own `||` stays clean, or the check above is just
    // refusing disjunctions and would catch the bypass for the wrong reason.
    expect(kinds(live)).not.toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
  });

  /**
   * AC-25 is the reviewer's THIRD finding about this one guard, and it is a
   * finding about AC-23's own fix. The companion arm was first spelled
   * `'[a-z_]+'` — any event — to let the live file's dispatch arm through, and
   * `github.event_name == 'pull_request'` is true on exactly the fork pull
   * request the guard exists to refuse. The escape hatch reopened the hole.
   *
   * So the set is closed, and this case is the reason it must stay closed:
   * widening it by one plausible-looking event is a one-character edit that
   * turns the guard off.
   */
  test("AC-25: only an event with no pull_request context may sit beside the comparison", () => {
    const anchor =
      "    if: >-\n" +
      "      github.event_name == 'workflow_dispatch' ||\n" +
      "      github.event.pull_request.head.repo.full_name == github.repository\n";
    const withArm = (arm: string) =>
      mutateOnce(
        live,
        anchor,
        "    if: >-\n" +
          `      github.event_name == '${arm}' ||\n` +
          "      github.event.pull_request.head.repo.full_name == github.repository\n",
      );
    // An arm that CAN be true on a fork's pull request is the bypass.
    for (const unsafe of ["pull_request", "pull_request_target", "issue_comment"]) {
      expect(kinds(withArm(unsafe)), `'${unsafe}' must not be accepted beside the comparison`)
        .toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
    }
    // …and every member of the declared set still is, or this is just a
    // check that refuses companion arms and the live file passes by luck.
    for (const safe of FORK_GUARD_COMPANION_EVENTS) {
      expect(kinds(withArm(safe)), `'${safe}' is in the declared set and must be accepted`)
        .not.toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
    }
    // The set is non-empty, or both loops above are vacuous.
    expect(FORK_GUARD_COMPANION_EVENTS.length).toBeGreaterThan(0);
    // And the events this is all about are NOT in it, asserted over the
    // declared constant rather than only through behaviour.
    expect(FORK_GUARD_COMPANION_EVENTS as readonly string[]).not.toContain("pull_request");
    expect(FORK_GUARD_COMPANION_EVENTS as readonly string[]).not.toContain("pull_request_target");
  });

  /**
   * AC-26: the fourth and fifth findings on this one guard, both about the
   * PROSE rather than the code, and the second was caused by the fix for the
   * first.
   *
   * Round 8 of #1614 read the docblock on `forkGuardDefect` claiming an `&&`
   * inside an arm "is left alone" and found it false — both patterns are
   * anchored. I rewrote the comment to say `&&` is refused. Round 9 then
   * pointed out that a parenthesised arm and a double-quoted event name are
   * refused identically, so the new sentence named one member of a class and
   * read as though it were the whole class.
   *
   * `.claude/rules/...` has the rule for exactly this and I did not apply it:
   * when a finding names one site, sweep for the shape. So this case asserts
   * the TOLERANCE, which is closed, instead of enumerating the refusals,
   * which are open — whitespace and operand order are accepted and nothing
   * else is. An equivalent spelling nobody has thought of is then already
   * covered, and the table in the docblock is this table.
   *
   * Every refusal here is a false POSITIVE and none is a bypass: each listed
   * condition is safe, and the `&&` row is strictly SAFER than the bare arm.
   * The defect was never the behaviour. It was a comment making a specific,
   * checkable claim with no assertion behind it — the shape
   * `.claude/rules/checks-must-be-able-to-fail.md` names in *In practice*.
   */
  test("AC-26: the guard tolerates whitespace and operand order, and nothing else", () => {
    const FORK = "github.event.pull_request.head.repo.full_name == github.repository";
    const COMPANION = "github.event_name == 'workflow_dispatch'";

    // TOLERATED. These are the control, and they are load-bearing: without
    // them the refusals below cannot be told from "the disjunction form is
    // refused outright", which would flag everything and look identical.
    const tolerated: [string, string][] = [
      ["the live spelling", `${COMPANION} || ${FORK}`],
      ["extra inner whitespace", `github.event_name  ==  'workflow_dispatch' || ${FORK}`],
      [
        "the fork comparison with its operands reversed",
        `${COMPANION} || github.repository == github.event.pull_request.head.repo.full_name`,
      ],
    ];
    for (const [name, condition] of tolerated) {
      expect(forkGuardDefect(condition), `${name} must be accepted`).toBeNull();
    }

    // REFUSED, and every one of them is a SAFE condition. If you are making
    // one of these pass, update the table in forkGuardDefect's docblock in
    // the same commit — that table and this list are the same claim.
    const refused: [string, string][] = [
      ["each arm parenthesised", `(${COMPANION}) || (${FORK})`],
      ["only the fork arm parenthesised", `${COMPANION} || (${FORK})`],
      ["a double-quoted event name", `github.event_name == "workflow_dispatch" || ${FORK}`],
      ["a narrowing && in the companion arm", `${FORK} || ${COMPANION} && github.actor == 'x'`],
      [
        "a narrowing && in a parenthesised companion arm",
        `${FORK} || (${COMPANION} && github.actor == 'x')`,
      ],
      ["a narrowing && on the fork comparison itself", `${FORK} && github.actor == 'x'`],
    ];
    for (const [name, condition] of refused) {
      expect(
        forkGuardDefect(condition),
        `${name} is a SAFE condition and is refused on purpose — the patterns are anchored ` +
          `and this function does not evaluate GitHub's expression language.`,
      ).not.toBeNull();
    }

    // Both halves non-empty, or one loop is vacuous and says nothing.
    expect(tolerated.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  /** AC-24: the other spelling in the same finding — negation, not addition. */
  test("AC-24: a comparison wrapped in a negation is not a governing predicate", () => {
    const negated = mutateOnce(
      live,
      "    if: >-\n" +
        "      github.event_name == 'workflow_dispatch' ||\n" +
        "      github.event.pull_request.head.repo.full_name == github.repository\n",
      "    if: >-\n" +
        "      !(github.event.pull_request.head.repo.full_name == github.repository)\n",
    );
    expect(reviewWorkflowRegions(negated).jobHeader).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(kinds(negated)).toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
  });

  /**
   * The second half of the same finding: the terms have to sit in the `if:`,
   * not merely somewhere in the job header. A `name:` carrying both
   * substrings satisfied the first revision.
   */
  test("AC-21: the terms must be in the condition, not anywhere in the job header", () => {
    const decorative = mutateOnce(
      live,
      "    if: >-\n" +
        "      github.event_name == 'workflow_dispatch' ||\n" +
        "      github.event.pull_request.head.repo.full_name == github.repository\n",
      "    name: >-\n" +
        "      github.event.pull_request.head.repo.full_name == github.repository\n",
    );
    expect(reviewWorkflowRegions(decorative).jobHeader).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(kinds(decorative)).toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
  });

  /**
   * `pull_request_target` is the trigger somebody reaches for when fork PRs
   * skip and they want them reviewed. It is the one change to this file that
   * trades the whole of #677 away in a single word: the base branch's
   * workflow, a full write token, and the fork's code in the same job.
   */
  test("AC-19: swapping pull_request for pull_request_target is refused by name", () => {
    const target = mutateOnce(live, "\n  pull_request:\n", "\n  pull_request_target:\n");
    expect(kinds(target)).toContain("PULL_REQUEST_TARGET_TRIGGER");
    // And it is refused REGARDLESS of the job's condition, which is the
    // property that matters: the guard is still in place in the mutant above
    // and the trigger is refused anyway. "Add a condition" is the repair for
    // the other violation and it is wrong advice for this one — no condition
    // makes this trigger safe for a job that hands a fork's diff to an agent
    // holding a write token.
    const targetUnguarded = mutateOnce(
      target,
      "      github.event.pull_request.head.repo.full_name == github.repository\n",
      "",
    );
    expect(kinds(targetUnguarded)).toContain("PULL_REQUEST_TARGET_TRIGGER");
    expect(kinds(targetUnguarded)).toContain("ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD");
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
    const dispatchTriggered = mutateOnce(dispatchOnly(live), ALLOWLIST, INLINE_COMMENT_ALLOWLIST);
    // The dispatch trigger is REPLACED, not joined. An earlier revision of
    // this case added `pull_request` beside `workflow_dispatch` and asserted
    // the mixed set was clean — which was true only while check 3 asked about
    // the intersection of all triggers, and is false now that it asks per
    // trigger (AC-22). A dispatch run of a mixed-trigger job still has no
    // entity server, so the grant is still unreachable on that path.
    const entityTriggered = mutateOnce(dispatchTriggered, DISPATCH_TRIGGER, ENTITY_TRIGGER);
    // The pair differs in the TRIGGER and in nothing else — asserted, not
    // promised, because a pair that varies two things measures neither (#585).
    expect(entityTriggered.replace(ENTITY_TRIGGER, DISPATCH_TRIGGER)).toEqual(dispatchTriggered);
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
