/**
 * Does the reviewer's PROMPT agree with the tools the job grants it? (#732)
 *
 * `.github/workflows/claude-review.yml` concluded **success** twice having
 * posted nothing. The issue blames the `SlashCommand` entry on the denylist.
 * That is measured to be wrong — a slash command supplied as the CLI PROMPT is
 * expanded before the model sees it, and `claude -p "/canary" --disallowedTools
 * "SlashCommand,…"` returns the command's output with `permission_denials: []`.
 * Deleting that word would have changed nothing.
 *
 * What was actually blocking it is four independent facts, none of which the
 * issue body names, and every one of which this module reports by its own name:
 *
 * 1. **`Task`.** `/code-review:code-review` says "Use a Haiku agent…", "launch
 *    5 parallel Sonnet agents…" six times, including the step-1 gate whose
 *    negative branch says "do not proceed". `Task` is on the denylist, so an
 *    agent that cannot run step 1 stops having done nothing.
 * 2. **`Bash`.** Every tool that command's frontmatter declares is `Bash(gh …)`,
 *    and its step 6 is "use the gh bash command to comment back". Also denied.
 * 3. **The posting path does not match the allowlist.** The string
 *    `create_inline_comment` does not appear in that command at all.
 * 4. **The allowed tool does not exist on this trigger.** Read from the pinned
 *    action at the SHA `lib/claude-code-action.ts` declares,
 *    `src/mcp/install-mcp-server.ts:152` — the `github_inline_comment` MCP
 *    server is installed only when `isEntityContext(context) && context.isPR`,
 *    and `src/github/context.ts:54` lists `workflow_dispatch` under
 *    `AUTOMATION_EVENT_NAMES`, not `ENTITY_EVENT_NAMES`. This workflow's only
 *    trigger is `workflow_dispatch`. So
 *    `mcp__github_inline_comment__create_inline_comment` — the single entry on
 *    the allowlist, the tool the job exists to call — **cannot exist in any run
 *    of it.** A fully working prompt would still have posted nothing.
 *
 * The fourth is the one no amount of reading the prompt finds, and it is why
 * this module takes the TRIGGERS as well as the two tool lists. A grant whose
 * server never starts is indistinguishable from a grant that was never used.
 *
 * ## Why one exported binding and not a file of assertions
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: one decider, one thing to
 * mutate. Every violation below is reachable from `reviewToolAgreement`, so a
 * mutation of it is visible to every case, and there is no second place that
 * decides what counts.
 *
 * ## Scope, stated rather than implied
 *
 * No YAML parser. This repo ships four runtime dependencies and a guard is not
 * a reason to add a fifth to a published package — the same decision
 * `test/claude-review-no-key.test.ts` records. Everything here is a cut and a
 * regex over the cut, and every cut refuses by name when it cannot find its
 * region, because a slice that missed its section is an empty string and an
 * empty string satisfies every claim of the form "X is not in here".
 */

import { structuralCut } from "./source-slice";

/** The names this module reports. One per independent door. */
export type ReviewToolViolationKind =
  | "PROMPT_IS_A_SLASH_COMMAND"
  | "PROMPT_NAMES_NO_TOOL"
  | "PROMPT_NAMES_A_DENIED_TOOL"
  | "PROMPT_NAMES_AN_UNGRANTED_TOOL"
  | "ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER"
  | "ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD"
  | "PULL_REQUEST_TARGET_TRIGGER"
  | "TRIGGERS_UNMEASURED"
  | "NO_POSTING_TOOL_IS_ALLOWED"
  | "NO_SUBJECT_REACHES_THE_AGENT"
  | "MUTABLE_PLUGIN_MARKETPLACE"
  | "NO_STEP_READS_THE_EXECUTION_OUTPUT";

export type ReviewToolViolation = {
  kind: ReviewToolViolationKind;
  detail: string;
};

/**
 * MCP servers the pinned action installs only under an ENTITY event, keyed by
 * the server segment of a tool name. Read from `install-mcp-server.ts` at the
 * pinned SHA; the value is the condition's own words so a reader can go and
 * check it rather than trust this table.
 *
 * A total record rather than a list of strings, so adding a server is a typed
 * edit at one site and the reason travels with the name.
 */
export const ENTITY_ONLY_MCP_SERVERS: Record<string, string> = {
  github_inline_comment:
    "install-mcp-server.ts:152 — `isEntityContext(context) && context.isPR && (hasGitHubMcpTools || hasInlineCommentTools)`",
  github_ci:
    "install-mcp-server.ts:177 — `(!isAgentMode || hasGitHubCITools) && isEntityContext(context) && context.isPR && hasWorkflowToken`",
  github_comment:
    "github-comment-server.ts:43 — `update_claude_comment` throws without CLAUDE_COMMENT_ID, which only tag mode sets",
};

/**
 * Events the pinned action treats as AUTOMATION rather than ENTITY —
 * `src/github/context.ts:63` `AUTOMATION_EVENT_NAMES`. A workflow triggered
 * only by these can never satisfy `isEntityContext`.
 */
export const AUTOMATION_ONLY_TRIGGERS = [
  "workflow_dispatch",
  "repository_dispatch",
  "schedule",
  "workflow_run",
] as const;

/**
 * Triggers that fire on somebody else's pull request, so the job sees a diff
 * written by a person who is not a collaborator (#631/#675).
 *
 * `pull_request_target` is here as a trigger to REFUSE, not one to guard. It
 * runs the base branch's workflow definition with a full write token against
 * the fork's code, which is this workflow's egress sink with the credential
 * handed over on purpose. There is no condition that makes it safe for a job
 * that runs an agent, so it gets its own violation rather than a guard.
 */
export const ENTITY_TRIGGERS = ["pull_request", "pull_request_target"] as const;

/**
 * The trigger names a workflow declares, parsed as YAML.
 *
 * **This was hand-rolled text matching and it should not have been.** Six
 * revisions on #1614, each correct for the case it was shown and wrong for
 * the next one, and the reviewer's round-cap assessment on round 13 named
 * the class rather than the instance: *hand-rolled regex parsing of the
 * `on:` block, patched edge case by edge case*. It was right, so the
 * instrument changed instead of the pattern. What the six revisions cost:
 *
 *   two-space-only     every other spelling read as `[]`, which made the
 *                      callers SILENT. `on: {pull_request_target: }` passed
 *                      — a WRITE token on a fork's pull request
 *   any-indentation    any indentation is any DEPTH, so every field of the
 *                      `workflow_dispatch.inputs` schema read as a trigger
 *   outermost-depth    correct for block and flow style, and still blind to
 *                      a YAML merge key, a list form and a scalar form
 *
 * `Bun.YAML` is built in, so this costs no dependency, and it answers all
 * three plus the forms nobody had thought to ask about:
 *
 *   on: {pull_request_target: }              flow
 *   on:\n    pull_request_target:            four-space
 *   on:\n  <<: *anchor                       merge key, resolved
 *   on: [push, pull_request_target]          list
 *   on: pull_request_target                  scalar
 *
 * The refusal stays and is still load-bearing: a source that will not parse,
 * or declares no `on`, yields `[]` and the caller reports
 * `TRIGGERS_UNMEASURED`. A reading that could not be taken is never a clean
 * one — and that is now the ONLY way this returns empty, because the parser
 * no longer has spellings it cannot see.
 */
export function triggerNames(source: string): string[] {
  let doc: unknown;
  try {
    doc = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(source);
  } catch {
    // A workflow that is not YAML has no readable triggers. UNMEASURED, and
    // never a silent pass — the caller turns `[]` into a reported refusal.
    return [];
  }
  if (doc === null || typeof doc !== "object") return [];
  // YAML 1.1 resolves a bare `on` to the boolean true, and parsers differ on
  // whether the key survives as "on" or "true". Read both rather than
  // depending on which one this runtime picked.
  const rec = doc as Record<string, unknown>;
  const on = rec.on ?? rec["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === "string");
  if (on !== null && typeof on === "object") return Object.keys(on as object);
  return [];
}

/**
 * The two expressions a job-level condition needs to compare before it can be
 * said to refuse a fork. Spelled out so the check names what is missing rather
 * than reporting that an `if:` "looks wrong".
 */
export const FORK_GUARD_TERMS = [
  "github.event.pull_request.head.repo.full_name",
  "github.repository",
] as const;

/**
 * The comparison itself, in either operand order, with `==` and not `!=`.
 *
 * An earlier revision of this check asked only whether both `FORK_GUARD_TERMS`
 * appeared anywhere in the job header, and said so in a comment: "this cannot
 * tell `==` from `!=`". **The reviewer this module exists to make work caught
 * that on the pull request that promoted the trigger**, and it was right —
 * `.claude/rules/checks-must-be-able-to-fail.md`, fifth shape. An inverted
 * guard contains both terms, passes a presence check, and runs the job on
 * forks ONLY, which is the precise opposite of the property the check is
 * named after. A check satisfied by a dangerously backwards version of its
 * own subject is worse than no check: it certifies the regression.
 *
 * It is also read from the `if:` block rather than the whole job header, for
 * the same reason every other cut here is bounded — a `name:` or an `env:`
 * value carrying both substrings would otherwise satisfy it.
 */
export const FORK_GUARD_COMPARISON =
  /^(?:github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository|github\.repository\s*==\s*github\.event\.pull_request\.head\.repo\.full_name)$/;

/**
 * The only other thing a disjunct of this condition is allowed to be: a guard
 * naming the event, which is how the dispatch arm earns its place beside the
 * fork comparison.
 */
export const FORK_GUARD_COMPANION_EVENTS = ["workflow_dispatch", "schedule"] as const;

/**
 * And the event it names must be one that CANNOT carry a fork's head.
 *
 * The first spelling of this was `'[a-z_]+'` — any event at all — and the
 * reviewer caught it, the third real finding about this one guard:
 *
 *     if: >-
 *       github.event_name == 'pull_request' ||
 *       github.event.pull_request.head.repo.full_name == github.repository
 *
 * On a fork's pull request the FIRST arm is true, so the job runs and the
 * comparison beside it decides nothing. That is the bypass `forkGuardDefect`
 * was written to close, reopened by the escape hatch added to let the live
 * file's dispatch arm through.
 *
 * `FORK_GUARD_COMPANION_EVENTS` is the closed set, and the membership test is
 * what the event has in common: no `github.event.pull_request` context at
 * all, so the fork comparison cannot be the predicate for it and a separate
 * arm is the only way to express the case. `pull_request` and
 * `pull_request_target` are excluded by construction rather than by being
 * listed as denied — an allowlist cannot be widened by forgetting a denial.
 */
export const FORK_GUARD_COMPANION_ARM = new RegExp(
  `^github\\.event_name\\s*==\\s*'(?:${FORK_GUARD_COMPANION_EVENTS.join("|")})'$`,
);

/**
 * Why an ANCHORED per-disjunct test and not a substring search.
 *
 * The previous revision of this check asked whether `FORK_GUARD_COMPARISON`
 * matched anywhere in the condition. **The reviewer caught that too** — the
 * second time on the same pull request, and the same shape as the `!=`
 * inversion it had already caught once. A substring search is satisfied by a
 * condition that contains the correct comparison and then neutralises it:
 *
 *     if: >-
 *       true ||
 *       github.event.pull_request.head.repo.full_name == github.repository
 *
 *     if: >-
 *       !(github.event.pull_request.head.repo.full_name == github.repository)
 *
 * Both contain `A == B`. The first runs on every fork; the second runs on
 * forks ONLY. So the fix is not a better regex for the comparison — it is
 * asking a different question: **is that comparison the governing predicate?**
 *
 * The condition is split on `||` and every arm must be either the fork
 * comparison itself or `FORK_GUARD_COMPANION_ARM`. `true`, `always()` and a
 * parenthesised negation are all arms that match neither, so each is named
 * rather than tolerated.
 *
 * **Both patterns are anchored, so each accepts exactly ONE spelling of its
 * arm and refuses every equivalent rewrite.** Say what is tolerated rather
 * than listing what is not, because the list of rewrites is open and the
 * tolerance is closed. Measured, not inferred:
 *
 *   clean    github.event_name == 'workflow_dispatch' || <fork comparison>
 *   clean    extra inner whitespace around either `==`
 *   clean    the fork comparison with its operands reversed
 *   FLAGGED  (github.event_name == 'workflow_dispatch') || (<fork comparison>)
 *   FLAGGED  github.event_name == "workflow_dispatch" || <fork comparison>
 *   FLAGGED  github.event_name == 'workflow_dispatch' && github.actor == 'x'
 *
 * Whitespace and operand order are the whole of the tolerance. A
 * parenthesised arm, a double-quoted event name and a narrowing `&&` are all
 * refused, and all three are SAFE conditions — the `&&` one runs on a strict
 * subset of what the bare arm runs on. So these are false positives, never
 * bypasses: the direction `.claude/rules/checks-must-be-able-to-fail.md`
 * says to be wrong in. The cost is a confusing refusal for somebody writing
 * a legitimate variant; the cost of the other direction is deciding whether
 * an arbitrary rewrite narrows or widens, which means evaluating GitHub's
 * expression language, and a guard that reasons about what it cannot
 * evaluate is the substring search this function replaced.
 *
 * AC-26 in `test/claude-review-executable-prompt.test.ts` holds every row of
 * that table. Two successive revisions of this comment got it wrong and
 * nothing contradicted either: the first claimed a narrowing `&&` was
 * tolerated (#1614, round 8), and the fix for that named `&&` alone while
 * parens and double quotes behaved identically (#1614, round 9). The table
 * is stated as a tolerance precisely so the next equivalent spelling nobody
 * has thought of is already covered by it.
 *
 * This is deliberately a CLOSED set. Widening it is how the check dies: the
 * next arm somebody wants is likelier to be the bypass than the exception,
 * and an allowlist that grows on request is a substring search with extra
 * steps.
 */
export function forkGuardDefect(condition: string): string | null {
  const flat = condition
    .replace(/^\s*if:\s*(?:[>|][-+]?)?/, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return "the job has no `if:` condition at all";
  const arms = flat.split("||").map(a => a.trim());
  if (!arms.some(a => FORK_GUARD_COMPARISON.test(a))) {
    return (
      "the job's condition mentions both terms but no `||` arm of it IS the " +
      "comparison — a comparison wrapped in a negation, or buried inside a " +
      "larger expression, is not the predicate that decides whether the job runs"
    );
  }
  const stray = arms.filter(
    a => !FORK_GUARD_COMPARISON.test(a) && !FORK_GUARD_COMPANION_ARM.test(a),
  );
  if (stray.length > 0) {
    return (
      `the job's condition compares the two terms, but it is one arm of a ` +
      `disjunction whose other arm is ${stray.map(a => `\`${a}\``).join(", ")} — ` +
      `an arm that can be true on a fork makes the comparison beside it decide ` +
      `nothing. The only arm that may sit beside it is ` +
      `\`github.event_name == '<e>'\` for e in ${FORK_GUARD_COMPANION_EVENTS.join(", ")} — ` +
      `events that carry no pull_request context, so the comparison cannot serve them`
    );
  }
  return null;
}

/**
 * Tools that can put a human-readable finding on a pull request. The property
 * AC-4 needs is "a comment naming the defect appears", so this is the set the
 * allowlist must intersect — enumerated, because a server-wide grant beside
 * `pull-requests: write` is the HIGH finding recorded on #732 and widening to
 * `mcp__github` would satisfy a looser check while reintroducing it.
 */
export const POSTING_TOOLS = [
  "mcp__github__create_pending_pull_request_review",
  "mcp__github__add_comment_to_pending_review",
  "mcp__github__submit_pending_pull_request_review",
  "mcp__github__create_and_submit_pull_request_review",
  "mcp__github__add_issue_comment",
  "mcp__github_inline_comment__create_inline_comment",
] as const;

/**
 * Tools that let the agent go and FETCH the thing under review. If none is
 * granted, the diff has to arrive in the prompt or the agent is reviewing
 * nothing — which is `NO_SUBJECT_REACHES_THE_AGENT`.
 */
export const SUBJECT_FETCHING_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "mcp__github__get_pull_request_diff",
  "mcp__github__get_pull_request_files",
  "mcp__github__get_file_contents",
] as const;

/**
 * The step-output name through which the code under review reaches the agent
 * when no fetching tool is granted. A convention, declared here so there is
 * one binding and the rule can say what it is looking for rather than guessing
 * from the shape of an interpolation — `${{ steps.guard.outputs.pr }}` is a
 * step output too, and a PR NUMBER is not the code. That near-miss is the
 * whole reason this is a named output and not "any interpolation".
 *
 * Narrow on purpose, and in the safe direction: an unconventional name costs a
 * refusal somebody fixes by renaming an output. The other direction credits a
 * reviewer that cannot see the diff, which is #732.
 */
export const SUBJECT_OUTPUT_NAME = "diff";

/** The script whose presence in a step makes that step the reading. */
export const READING_SCRIPT = "scripts/read-review-execution.ts";

export class ReviewSourceUnreadableError extends Error {}

/**
 * Every step of the job, as its own string: a `- ` list marker under `steps:`
 * and every line up to the next one.
 *
 * **A comment above a `- ` marker lands in the PRECEDING step, and that is
 * deliberate rather than overlooked.** An earlier draft reattached each
 * trailing comment block to the step it introduces, which reads better and
 * which this file's first measurement showed to be dead: with
 * `withoutComments` below standing between every claim and the prose,
 * restoring the misattribution is **0 of 31 red**, measured. Two deciders
 * answering one question are behaviourally one
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape), so the
 * cleverer one is gone and `withoutComments` is the single binding.
 *
 * What the misattribution broke before `withoutComments` existed is worth
 * recording, because it is the reason that function is not ceremony: the
 * `setup-bun` step's comment names `READING_SCRIPT` in prose, so a raw-text
 * `filter` returned **two** reading steps for a file with one.
 */
export function jobSteps(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex(l => l.trimStart() === "steps:");
  if (start === -1) throw new ReviewSourceUnreadableError("the job declares no steps:");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[start]);
  const steps: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && indentOf(line) <= base) break;
    if (/^\s*- /.test(line)) steps.push([]);
    if (steps.length > 0) steps[steps.length - 1].push(line);
  }
  return steps.map(s => s.join("\n"));
}

/**
 * A step with its comments removed.
 *
 * A claim about a step's CONFIGURATION must not be satisfiable by a sentence
 * ABOUT that configuration. `lib/review-tool-agreement.ts`'s own first draft
 * asked `/execution_file/.test(source)` of the whole file and was satisfied by
 * a comment in a different step — found by the reviewer this module exists to
 * repair, posted as an inline comment on PR #746.
 */
export function withoutComments(step: string): string {
  return step
    .split("\n")
    .filter(l => !l.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * The YAML block an anchor line opens: that line, plus every following line
 * indented deeper than it, stopping at the first line indented the same or
 * less. No length parameter anywhere (#664) — the region ends where the block
 * ends, which is the only boundary that cannot decay as the file grows.
 *
 * Refuses on zero or two occurrences of the anchor, for `lib/source-slice.ts`'s
 * reason: not-found and found-twice are both refusals, and a confident answer
 * about the wrong region is worse than no answer.
 */
export function blockUnder(source: string, anchor: string): string {
  const lines = source.split("\n");
  const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trimStart().startsWith(anchor));
  if (hits.length !== 1) {
    throw new ReviewSourceUnreadableError(
      `the anchor ${JSON.stringify(anchor)} opens ${hits.length} lines, not one`,
    );
  }
  const start = hits[0][1];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[start]);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) <= base) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/** Every `mcp__server__tool` token in a string, de-duplicated, in order. */
export function mcpToolsNamedIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/mcp__[a-z0-9_]+__[a-z0-9_]+/gi)) seen.add(m[0]);
  return [...seen];
}

/** The server segment of `mcp__server__tool`, or `null` for a built-in. */
export function mcpServerOf(tool: string): string | null {
  const m = /^mcp__([a-z0-9_]+)__[a-z0-9_]+$/i.exec(tool);
  return m ? m[1] : null;
}

function quotedListAfter(claudeArgs: string, flag: string): string[] | null {
  const m = new RegExp(`--${flag}\\s+"([^"]*)"`).exec(claudeArgs);
  if (!m) return null;
  return m[1]
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The regions this check is about, cut structurally. Exported so a case can
 * assert the cuts are bounded before asserting anything about their contents —
 * every claim below is of the form "X is not in here", and all of them hold
 * vacuously of an empty string.
 */
export function reviewWorkflowRegions(source: string): {
  triggerBlock: string;
  jobHeader: string;
  reviewStep: string;
  prompt: string;
  claudeArgs: string;
} {
  const triggerBlock = structuralCut(source, "\non:", { endAnchor: "\npermissions:" });
  // Everything the job declares ABOUT itself — `runs-on`, `timeout-minutes`,
  // `if:` — and none of what it runs. Cut separately from the steps because a
  // job-level condition is the only place the fork decision for an entity
  // trigger can live, and searching the whole document for it would be
  // satisfied by this file's own header discussing it.
  const jobHeader = structuralCut(source, "\njobs:", { endAnchor: "\n    steps:" });
  const reviewStep = blockUnder(source, "- name: Review");

  // The prompt is a YAML block scalar: `prompt: |` and everything indented
  // under it, or a single-line `prompt: "…"`. Cut by indentation rather than
  // by a character count (#664) — the region ends where the block ends.
  const promptBlock = blockUnder(reviewStep, "prompt:");
  const prompt = promptBlock.replace(/^\s*prompt:[ \t]*[|>]?[-+]?[ \t]*/, "").replace(/^"|"$/g, "");
  if (prompt.trim() === "") {
    throw new ReviewSourceUnreadableError("the Review step's prompt is empty");
  }

  const claudeArgs = blockUnder(reviewStep, "claude_args:");

  return { triggerBlock, jobHeader, reviewStep, prompt, claudeArgs };
}

/**
 * The one decider. Everything a case asserts about #732 comes back from here.
 *
 * `source` is the whole workflow file; the regions are cut inside, so a caller
 * cannot accidentally ask the question of the wrong slice.
 */
export function reviewToolAgreement(source: string): ReviewToolViolation[] {
  const { triggerBlock, jobHeader, reviewStep, prompt, claudeArgs } =
    reviewWorkflowRegions(source);

  const allowed = quotedListAfter(claudeArgs, "allowedTools") ?? [];
  const denied = quotedListAfter(claudeArgs, "disallowedTools") ?? [];
  const v: ReviewToolViolation[] = [];

  // 1. The headline, kept because it is still a defect even though the
  //    mechanism the issue gives for it is wrong: a `/plugin:command` prompt
  //    makes the review's instructions live in a MUTABLE git ref that nothing
  //    in this repository pins or reads.
  if (prompt.trim().startsWith("/")) {
    v.push({
      kind: "PROMPT_IS_A_SLASH_COMMAND",
      detail:
        `the prompt is ${JSON.stringify(prompt.trim().split("\n")[0])} — the instructions it ` +
        `expands to are not in this repository, so nothing here can check which tools they need`,
    });
  }

  // 2. A prompt that names no tool is the vacuous case: every agreement claim
  //    below holds trivially of it, which is exactly the shape that let two
  //    runs conclude success.
  const promptTools = mcpToolsNamedIn(prompt);
  if (promptTools.length === 0) {
    v.push({
      kind: "PROMPT_NAMES_NO_TOOL",
      detail: "the prompt names no mcp tool at all, so it cannot be checked against the allowlist",
    });
  }

  for (const tool of promptTools) {
    if (denied.some(d => tool === d || tool.startsWith(`${d}__`))) {
      v.push({
        kind: "PROMPT_NAMES_A_DENIED_TOOL",
        detail: `the prompt tells the agent to use ${tool}, which --disallowedTools denies`,
      });
    } else if (!allowed.some(a => tool === a || tool.startsWith(`${a}__`))) {
      v.push({
        kind: "PROMPT_NAMES_AN_UNGRANTED_TOOL",
        detail: `the prompt tells the agent to use ${tool}, which --allowedTools does not grant`,
      });
    }
  }

  // 3. The door nothing in the prompt can show: a grant whose server the
  //    pinned action never starts under this workflow's triggers.
  //
  //    PER-TRIGGER, not over the intersection. The first revision asked
  //    whether EVERY trigger was automation-only, which was the same question
  //    while this file had exactly one trigger — and silently became a weaker
  //    one when #631/#675 added `pull_request` beside `workflow_dispatch`.
  //    **The reviewer caught that too, on the pull request that made the
  //    change**: with a mixed trigger set the check went silent, even though
  //    a `workflow_dispatch` run of the same job still gets the automation
  //    classification and still has no entity-only server. A grant that works
  //    on one of two triggers is #732 reintroduced for the other one, and the
  //    property degraded from "never exists" to "does not exist on the
  //    intersection of all triggers" without the name or the comment moving.
  //    HOW THE TRIGGER NAMES ARE READ, and why an empty reading REFUSES
  //    (#1614, round 10). The first spelling of this was
  //    `/^\s{2}([a-z_]+):/gm` — exactly two leading spaces, block style only.
  //    Every other valid YAML spelling of the same trigger set returned `[]`,
  //    and `[]` made BOTH checks below silent rather than loud. Measured on
  //    the live file with only the `on:` block swapped:
  //
  //      on:\n  pull_request_target:            → ["pull_request_target"], caught
  //      on: {pull_request_target: }            → [], SILENT
  //      on:\n    pull_request_target:          → [], SILENT
  //
  //    A workflow granting a write token on a fork's pull request therefore
  //    passed, which is the fail-open shape
  //    `.claude/rules/checks-must-be-able-to-fail.md` calls *a detector
  //    narrower than what it detects*.
  //
  //    Two changes, and the second is the load-bearing one. Widening the
  //    pattern closes the spellings we thought of; refusing an EMPTY reading
  //    closes the ones we did not. The set of valid YAML spellings is open
  //    and the set of things this function can parse is closed, so the only
  //    safe thing to do with a block it cannot read is say so — an absent
  //    reading is UNMEASURED, never a clean one.
  const triggers = triggerNames(source);
  if (triggers.length === 0) {
    v.push({
      kind: "TRIGGERS_UNMEASURED",
      detail:
        "the `on:` block was found but no trigger name could be read out of it, so the " +
        "pull_request_target and fork-guard checks below have nothing to decide on. That is " +
        "UNMEASURED, not clean: a workflow with no readable triggers is one this check cannot " +
        "speak about. Either the block uses a YAML spelling `triggerNames` does not cover — " +
        "teach it that spelling and add a row to AC-27 — or the workflow genuinely " +
        "declares no triggers, in which case it never runs",
    });
  }
  const automationTriggers = triggers.filter(t =>
    (AUTOMATION_ONLY_TRIGGERS as readonly string[]).includes(t),
  );
  if (automationTriggers.length > 0) {
    const everyTriggerIsAutomation = automationTriggers.length === triggers.length;
    for (const tool of allowed) {
      const server = mcpServerOf(tool);
      const why = server ? ENTITY_ONLY_MCP_SERVERS[server] : undefined;
      if (why) {
        v.push({
          kind: "ALLOWED_TOOL_CANNOT_EXIST_ON_THIS_TRIGGER",
          detail:
            `--allowedTools grants ${tool}, whose MCP server is installed only under an entity ` +
            `event (${why}). ` +
            (everyTriggerIsAutomation
              ? `This workflow's triggers are ${triggers.join(", ")}, all of which the action ` +
                `classifies as automation events, so the tool never exists`
              : `This workflow also triggers on ${automationTriggers.join(", ")}, which the ` +
                `action classifies as an automation event, so a run started that way has no ` +
                `such server and the tool does not exist in it. The grant works on ` +
                `${triggers.filter(t => !automationTriggers.includes(t)).join(", ")} and ` +
                `silently does nothing on the rest`),
        });
      }
    }
  }

  // 3b. The trigger promotion's own door (#631/#675). An entity trigger means
  //     the job fires on pull requests opened by people who are not
  //     collaborators, and on a public repository that is most of them. The
  //     fork decision then has to exist somewhere a reader can point at.
  //
  //     Read from the JOB HEADER, never the document: every revision of
  //     `claude-review.yml` discusses forks in its header at length, and a
  //     whole-file search would be satisfied by the prose explaining why the
  //     guard matters — `.claude/rules/checks-must-be-able-to-fail.md`,
  //     "search the slice, not the document", which is the defect the
  //     reviewer found in this very module on #746.
  //
  //     Silent on an automation-only workflow, which is why the pre-#732
  //     fixture does not report it: a dispatch cannot be opened by a
  //     stranger, and a guard against a case that cannot arise is one more
  //     thing to keep true for nothing.
  const entityTriggers = triggers.filter(t => (ENTITY_TRIGGERS as readonly string[]).includes(t));
  if (triggers.includes("pull_request_target")) {
    v.push({
      kind: "PULL_REQUEST_TARGET_TRIGGER",
      detail:
        "the workflow triggers on pull_request_target, which runs this job with a WRITE token " +
        "against a fork's code. For a job that hands a diff to an agent that is the egress sink " +
        "this file's header describes, with the credential handed over deliberately — use " +
        "pull_request, whose fork runs are read-only",
    });
  }
  if (entityTriggers.length > 0) {
    // The `if:` block, not the job header. A `name:` or an `env:` value
    // carrying both terms would satisfy a header-wide search, and an absent
    // `if:` is reported as the missing guard it is rather than throwing.
    let condition = "";
    try {
      condition = withoutComments(blockUnder(jobHeader, "if:"));
    } catch {
      condition = "";
    }
    const missing = FORK_GUARD_TERMS.filter(term => !condition.includes(term));
    const why =
      missing.length > 0
        ? `the job's condition names neither ${missing.join(" nor ")}`
        : forkGuardDefect(condition);
    if (why !== null) {
      v.push({
        kind: "ENTITY_TRIGGER_WITHOUT_A_FORK_GUARD",
        detail:
          `the workflow triggers on ${entityTriggers.join(", ")}, so it runs on pull requests ` +
          `from forks, and ${why}. A fork run holds a read-only token and no id-token: write, ` +
          `so every step after auth fails — and a job that fails on every fork pull request is ` +
          `a red check nobody can act on`,
      });
    }
  }

  // 4. Nothing on the allowlist can write a finding anywhere a human will see.
  if (!allowed.some(a => (POSTING_TOOLS as readonly string[]).includes(a))) {
    v.push({
      kind: "NO_POSTING_TOOL_IS_ALLOWED",
      detail:
        `--allowedTools grants [${allowed.join(", ")}], none of which can post a review or a ` +
        `comment. A review that cannot be read is indistinguishable from one that found nothing`,
    });
  }

  // 5. With no fetching tool granted, the diff has to arrive IN the prompt.
  //    Interpolating a prior step's output is the only way it can.
  const canFetch = allowed.some(a => (SUBJECT_FETCHING_TOOLS as readonly string[]).includes(a));
  const promptCarriesSubject = new RegExp(
    `\\$\\{\\{\\s*steps\\.[A-Za-z0-9_-]+\\.outputs\\.${SUBJECT_OUTPUT_NAME}\\s*\\}\\}`,
  ).test(prompt);
  if (!canFetch && !promptCarriesSubject) {
    v.push({
      kind: "NO_SUBJECT_REACHES_THE_AGENT",
      detail:
        `no tool on the allowlist can fetch the code and the prompt interpolates no ` +
        `steps.*.outputs.${SUBJECT_OUTPUT_NAME}, so the agent is asked to review code it has ` +
        `no way to see`,
    });
  }

  // 6. #630 AC-16: plugin code loaded from a ref the publisher can repoint,
  //    in a file where every `uses:` is SHA-pinned.
  if (/^\s*plugin_marketplaces\s*:/m.test(reviewStep)) {
    v.push({
      kind: "MUTABLE_PLUGIN_MARKETPLACE",
      detail:
        "the Review step declares plugin_marketplaces, which loads executing code from a MUTABLE " +
        "git ref while every uses: in this file is pinned to a commit SHA (#630 AC-16)",
    });
  }

  // 7. AC-1/AC-2: something has to read what the run actually did, or a run
  //    that made zero tool calls concludes success exactly as before.
  //
  //    Asked of the STEP, not the document. The first draft of this check was
  //    `/execution_file/.test(source)` and was caught by the reviewer this
  //    very change exists to repair: the string already appears in a comment
  //    in the Review step, so the check was satisfied by prose about itself —
  //    `.claude/rules/checks-must-be-able-to-fail.md` §"search the slice, not
  //    the document", which that rule has now caught in its own subject four
  //    times. The step is located by the SCRIPT it runs rather than by its
  //    `name:`, because a name is prose and the invocation is the binding.
  const readingSteps = jobSteps(source)
    .map(withoutComments)
    .filter(s => s.includes(READING_SCRIPT));
  if (readingSteps.length !== 1) {
    v.push({
      kind: "NO_STEP_READS_THE_EXECUTION_OUTPUT",
      detail:
        `${readingSteps.length} steps run ${READING_SCRIPT}, not one. A run that made zero tool ` +
        `calls and posted nothing then concludes success — which is #732's whole subject`,
    });
  } else {
    const step = readingSteps[0];
    const missing = [
      /execution_file/.test(step) ? null : "it does not read the action's execution_file output",
      /^\s*if:\s*always\(\)\s*$/m.test(step)
        ? null
        : "it is not `if: always()`, so the interesting case — the review step reporting success — skips it",
    ].filter(Boolean);
    if (missing.length > 0) {
      v.push({
        kind: "NO_STEP_READS_THE_EXECUTION_OUTPUT",
        detail: `the step running ${READING_SCRIPT} cannot do its job: ${missing.join("; ")}`,
      });
    }
  }

  return v;
}
