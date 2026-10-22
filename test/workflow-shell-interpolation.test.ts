/**
 * #1103: every value a `workflows/*.js` prompt interpolates that could hold
 * agent text is classified, and the population is COMPUTED rather than typed.
 *
 * ## What this file got wrong the first time
 *
 * #1100 shipped this census with a six-name `TAINTED` array and a headline
 * claim: bare interpolations of agent-derived bindings, held at zero. It
 * reported zero. Three agent-derived branch bindings were bare while it did —
 * `branchToReuse`, `pushTarget`, `shipBranch` — and the file had never heard
 * of them.
 *
 * The array was enumerated by the same work that quoted the six, so it
 * contained exactly the sites that had been fixed. **A census whose membership
 * is written down by the fix cannot fail on the day it ships: it measures the
 * fix, not the property.** The positive control it carried guarded a RENAME
 * leaving the sweep scanning for an absent symbol. Nothing guarded an
 * OMISSION, and omission is the one that happened.
 *
 * So the population now comes out of `lib/workflow-taint.ts`, which derives it
 * from the tree: `agent` and `parallel` are the spawners, any function calling
 * one is a spawner, a binding initialised from a spawner call is a seed, and a
 * top-level binding mentioning a seed is a member. Nobody types the names.
 *
 * ## What this file still owns, and why that is not the same mistake
 *
 * The table below says, for each derived name, why it is allowed to reach a
 * template literal unsanitised. That is a list, and lists go stale — the
 * difference is which direction the silence runs. A name nobody classified is
 * a FAILURE here, not an absence, so a new binding reds. That is the property
 * the array could not have.
 *
 * It ratchets in both directions. An entry whose name no longer appears is
 * also a failure: an exemption outliving its site is a sentence a reviewer
 * reads and believes about code that is gone.
 *
 * ## Why prose counts
 *
 * A classification is required for interpolations in prompt PROSE as well as
 * in commands. "This line is only prose" is a judgement a checker cannot make,
 * a prompt line is one edit away from being a command, and the agent reading
 * it may paste it into a shell either way. The cost is one line of
 * classification; #1103 is what the other policy costs.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { remedyMessage } from "../lib/check-remedy";
import { agentDerivedNames, bareAgentInterpolations } from "../lib/workflow-taint";

const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_DIR = join(REPO_ROOT, "workflows");

/**
 * Why each derived binding is allowed to reach a template literal unsanitised.
 *
 * Keyed `workflows/<file>:<binding>`. Four kinds of answer, and the kind
 * matters more than the wording:
 *
 * - **refused at the source** — a decider upstream of every interpolation
 *   rejects the value's shape, so what arrives here cannot be hostile. The
 *   strongest answer, and the one #1103 asked for.
 * - **a command, not a value** — the binding IS shell or JavaScript that this
 *   file composed. Quoting it would turn a command into an argument.
 * - **prose into a prompt** — the value is shown to an agent in a sentence and
 *   is not a word in any command on the page.
 * - **structured, not text** — a number, or a value this file serialises with
 *   `JSON.stringify`, whose own quoting is the barrier.
 */
const CLASSIFIED: Record<string, string> = {
  // ── workflows/ship.js ──────────────────────────────────────────────
  "workflows/ship.js:branchToReuse":
    "refused at the source: `reusablePriorBranch` runs `isSafeBranchName` on `prior.branch` and " +
    "returns null for anything else, so this holds a safe branch name or nothing (#1103)",
  "workflows/ship.js:pushTarget":
    "refused at the source: it is `HEAD:${branchToReuse}` or the literal 'HEAD', and " +
    "`branchToReuse` passed `isSafeBranchName` before this line (#1103)",
  "workflows/ship.js:shipBranch":
    "refused at the source: `isSafeBranchName(shipBranch)` aborts the run ~350 lines above the " +
    "first of its three interpolations, and both arms of the `||` are covered — `branchToReuse` " +
    "by `reusablePriorBranch`, `commitResult.branch` by that abort",
  "workflows/ship.js:gitAddForCommit":
    "a command, not a value: `gitDerivedStaging` composes a `git add` line, already quoting the " +
    "paths inside it. Quoting the whole would hand the shell one long filename",
  "workflows/ship.js:SELECTED_TESTS_COMMAND":
    "a command, not a value: `selectedTestsCommand` builds it and is given `shellQuote` to quote " +
    "its own arguments with",
  "workflows/ship.js:testCommand×3":
    "a command, not a value: the project's test command out of `rungate.json`, run as written. " +
    "`suiteCaptureCommand` takes the quoter as an argument and applies it to the PATHS around it",
  "workflows/ship.js:prodQuinn":
    "a command, not a value: `prodQuinnAssignment` returns a JavaScript statement that the " +
    "surrounding `bun -e` executes. Quoting it would make it a string literal that does nothing",
  "workflows/ship.js:testTimeout×3":
    "structured, not text: `projectConfig.test?.timeout || 120000`, a number, read by the agent " +
    "as the Bash tool's timeout parameter",
  "workflows/ship.js:prState":
    "structured, not text: `prState.number` is a PR number from `prReadiness`, which reads it " +
    "from the GitHub API's JSON, not from a reply",
  "workflows/ship.js:prStep×3":
    "structured, not text: `prStep.prNumber` and `prStep.detail` are reported into prompt prose " +
    "about what the PR step did; neither is a word in a command",
  "workflows/ship.js:acCoverage":
    "structured, not text: interpolated as `JSON.stringify(acCoverage)`, whose own escaping is " +
    "the barrier, into a `bun -e` argument",
  "workflows/ship.js:scopeResult":
    "structured, not text: `JSON.stringify(scopeResult)` inside a refusal sentence",
  "workflows/ship.js:goalData":
    "prose into a prompt: the issue title, goal and criteria, shown to the agent under '## Issue'",
  "workflows/ship.js:discovery":
    "prose into a prompt: AC ids, counts and file lists, shown to the agent. The one argument " +
    "that reaches a shell goes through `acPayloadShellArgument`, which is that payload's quoter",
  "workflows/ship.js:scopeDenied":
    "prose into a prompt: the out-of-bounds file list, rendered as markdown bullets",
  "workflows/ship.js:quinnLocalResult":
    "prose into a prompt: Quinn's failure lines, shown to the agent that has to address them",
  "workflows/ship.js:localApiClause":
    "prose into a prompt: `localEnvClause` composes a sentence about where the local API is",
  "workflows/ship.js:localUiClause":
    "prose into a prompt: `localEnvClause` composes a sentence about where the local UI is",
  "workflows/ship.js:headSha":
    "prose into a prompt: every interpolation is wrapped in `describeShaValue`, which " +
    "`JSON.stringify`s anything that is not a SHA, inside a `reason:` sentence",
  "workflows/ship.js:testedSha":
    "prose into a prompt: same `describeShaValue` wrapper, same `reason:` sentences",
  "workflows/ship.js:reviewCurrency":
    "prose into a prompt: `.reason` is a sentence this file composed in `reviewIsCurrent`",
  "workflows/ship.js:suiteCurrencyVerdict":
    "prose into a prompt: `.reason` is a sentence this file composed in `suiteCurrency`",
  "workflows/ship.js:containerProbe":
    "prose into a prompt: `.detail` is composed by `containerProbeTarget` from its own literals " +
    "plus a host that passed `CONTAINER_HOST` and a port that passed an integer range check",

  // ── workflows/ship.js, block-scoped agent replies ──────────────────
  // Reported wherever they are interpolated, whatever their scope: these come
  // straight out of an agent call, and gating the REPORT on top-level the way
  // propagation is gated would have made a whole class of them silent
  // (#1113).
  "workflows/ship.js:verifyResult":
    "prose into a prompt: the verify gate's failure lines, joined into a sentence. Reached by " +
    "`'…' + …`, not by a template — the concatenation shape the scanner could not see (#1113)",
  "workflows/ship.js:result×4":
    "prose into a prompt: `result.result` or the sentence 'did not report a result'",
  "workflows/ship.js:evidenceQuality":
    "prose into a prompt: `.reason`, a sentence this file composed in `dryRunEvidenceQuality`",
  "workflows/ship.js:established":
    "prose into a prompt: `.refusal`, composed by this file when the run ref could not be made",
  "workflows/ship.js:reread×1":
    "prose into a prompt: `.refusal`, composed by this file",
  "workflows/ship.js:waveBase":
    "prose into a prompt: `.refusal`, composed by this file",
  "workflows/ship.js:integrated":
    "prose into a prompt: `.detail`, composed by this file when a wave did not integrate",
  "workflows/ship.js:kept×1":
    "prose into a prompt: `.detail`, composed by this file about preserved work",
  "workflows/ship.js:ciStep×1":
    "prose into a prompt: `.reason`, composed by this file from CI's own verdict",
  "workflows/ship.js:persistResult":
    "prose into a prompt: `.error`, or the sentence 'no receipt returned'",
  "workflows/ship.js:suiteResult":
    "structured, not text: the suite verdict word, or the literal 'unset'",
  "workflows/ship.js:reReviewed":
    "prose into a prompt: wrapped in `describeShaValue`, in a sentence about the re-review",
  "workflows/ship.js:ready×1":
    "prose into a prompt: sub-issue titles, joined into a sentence. Nested one level inside a " +
    "`log()` message, which the direct-argument exemption deliberately does not reach",
  "workflows/ship.js:envCheck":
    "prose into a prompt: container host readings, nested one level inside a `log()` message — " +
    "same deliberate reach of the direct-argument rule",

  // ── workflows/ship.js, helper parameters ───────────────────────────
  // Not top-level bindings: parameters that a member was passed into, which
  // the analysis follows one hop because a value crossing a function boundary
  // changes its name and that is what function boundaries are for. These
  // fifteen are what that hop added on this tree.
  "workflows/ship.js:o×5":
    "a command, not a value: `o.suiteCapture` and `o.recorder` are the suite and recorder command " +
    "lines, composed by `suiteCaptureCommand` and `recorderCommand` with the quoter passed in",
  "workflows/ship.js:prompt×1":
    "prose into a prompt: `timedAgent`'s own prompt argument, concatenated with the timing " +
    "instruction before being handed to `agent`. It IS the prompt",
  "workflows/ship.js:healContext":
    "prose into a prompt: a paragraph about what the previous attempt got wrong",
  "workflows/ship.js:context":
    "prose into a prompt: the regression context sentence, or nothing",
  "workflows/ship.js:prior×1":
    "prose into a prompt: `prior.behindCount` in the refusal sentence `reusablePriorBranch` " +
    "composes. `prior.branch` itself now passes `isSafeBranchName` before it is used at all",
  "workflows/ship.js:record×2":
    "a command, not a value: `prodQuinnAssignment` composes a JavaScript statement for `bun -e`",
  "workflows/ship.js:currency":
    "prose into a prompt: wrapped in `describeShaValue`, in a `reason:` sentence",
  "workflows/ship.js:measuredSha":
    "prose into a prompt: wrapped in `describeSuiteShaValue`, in a `reason:` sentence",
  "workflows/ship.js:v×2":
    "structured, not text: `describeShaValue`'s own argument — `v.length` for an array, and " +
    "`JSON.stringify(v)` for everything that reaches the final line",
  "workflows/ship.js:r×3":
    "prose into a prompt: evidence-quality reasons, joined into a sentence about what was not " +
    "measured",
  "workflows/ship.js:reading":
    "structured, not text: `JSON.stringify(reading.verdict)` inside a refusal sentence",
  "workflows/ship.js:reply×2":
    "structured, not text: `JSON.stringify(reply.outcome)` inside a refusal sentence",
  "workflows/ship.js:existingPR":
    "structured, not text: `JSON.stringify(existingPR)` inside a refusal sentence",
  "workflows/ship.js:results":
    "structured, not text: `typeof results`, which is one of eight words",
  "workflows/ship.js:status×2":
    "structured, not text: `String(status)` in a readiness sentence",

  // ── workflows/ship-and-heal.js ─────────────────────────────────────
  "workflows/ship-and-heal.js:workDir":
    "refused at the source: anything that is not a plain absolute path is dropped to '' at the " +
    "assignment, and the existing `if (workDir)` branch then skips grading (#1103)",
  "workflows/ship-and-heal.js:testCommand×2":
    "a command, not a value: the project's test command, run as written inside `( cd … && … )`",
  "workflows/ship-and-heal.js:testTimeout×3":
    "structured, not text: a number, read by the agent as the Bash tool's timeout parameter",
  "workflows/ship-and-heal.js:status×1":
    "prose into a prompt: the ship workflow's terminal status word, reported in a summary block",
  "workflows/ship-and-heal.js:failureText":
    "prose into a prompt: the failure lines the root-cause agent is asked to explain",
  "workflows/ship-and-heal.js:rca×4":
    "prose into a prompt: the root-cause agent's own analysis, quoted back to the fixer",

  // ── workflows/prove.js ─────────────────────────────────────────────
  "workflows/prove.js:COMMIT_SHA":
    "prose into a prompt: `deployCheck.commitSHA || 'unknown'`, shown under '## Fix Commit'",
  "workflows/prove.js:issueData":
    "prose into a prompt: the issue title and the first 2000 characters of its body",
  "workflows/prove.js:beforeContext":
    "prose into a prompt: the before-state paragraph, or a sentence saying there was none",
  "workflows/prove.js:containerConfig":
    "prose into a prompt: a host that is shown as a URL to probe, with 'CONFIG_MISSING' standing " +
    "in when the project configured none",
  "workflows/prove.js:quinnResults":
    "prose into a prompt: `.verdict`, rendered as one bullet of the proof comment",
  "workflows/prove.js:proveEvidence":
    "structured, not text: `JSON.stringify(proveEvidence, null, 2)`, written as the evidence file",
  "workflows/prove.js:screenshotUploadResult":
    "prose into a prompt: markdown image links, concatenated under an '## Evidence Screenshots' " +
    "heading. Also a concatenation rather than a template",
  "workflows/prove.js:verdict":
    "structured, not text: `cr.verdict`, one of the gate's verdict words, as a markdown bullet",
  "workflows/prove.js:chainMode":
    "structured, not text: `String(chainMode).includes('CHAIN')` picks between two literal " +
    "sentences, so the value itself never reaches the string",
  "workflows/prove.js:safeProofComment":
    "a command, not a value: the proof comment already through `heredocSafe` for the delimiter " +
    "this very literal opens. Classified per site rather than carried by the name, because " +
    "heredoc-safety is a fact about ONE heredoc and a name can travel to another (#1113)",

  // ── workflows/verify.js ────────────────────────────────────────────
  // Both are `container.*` out of the project's resolved config, named as
  // words in a `podman` command. verify.js has no `shellQuote` and cannot
  // import one (#69). Left classified rather than fixed because the value is
  // the project's own configuration rather than anything an agent reported —
  // the weakest entry in this table, and the one to revisit first if
  // consumers start writing that config from a template.
  "workflows/verify.js:CONTAINER_NAME":
    "a command, not a value: `container.name` from the resolved config, named in `podman ps` " +
    "and `podman exec`",
  "workflows/verify.js:CONTAINER_APP_ROOT":
    "a command, not a value: `container.appRoot` from the resolved config, the path `podman " +
    "exec … test -f` checks under",

  // ── workflows/council.js ───────────────────────────────────────────
  "workflows/council.js:codebaseResearch":
    "prose into a prompt: a researcher agent's findings, quoted under '## Codebase Research'. " +
    "Destructured out of `await parallel([…])`, which is how the destructuring blind spot in " +
    "`bindings()` showed up at all (#1113)",
  "workflows/council.js:externalResearch":
    "prose into a prompt: the same, under '## External Research'",
  "workflows/council.js:round1Transcript":
    "prose into a prompt: the council's own round-1 positions, quoted back to the next round",
  "workflows/council.js:round2Transcript":
    "prose into a prompt: the council's round-2 responses, quoted back to the next round",
  "workflows/council.js:round3Transcript":
    "prose into a prompt: the council's final positions, quoted into the synthesis",
};

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith(".js"))
  .sort();
const sourceOf = (f: string) => readFileSync(join(WORKFLOW_DIR, f), "utf-8");

/**
 * The exemption covering one site, in the two key forms, or `null`.
 *
 * `workflows/<file>:<binding>` exempts every interpolation of that name in
 * that file. `workflows/<file>:<binding>:<line>` exempts exactly one line.
 * The narrow form exists because a name-scoped exemption on a generic
 * identifier pre-approves the NEXT binding to take the name: the derivation
 * keys by name, so two different bindings called `result` are one entry to
 * this whole census, and a sentence written about the safe one would silently
 * cover the other. `genericNameRule` below makes the narrow form compulsory
 * where that risk is real rather than leaving it to taste.
 */
function exemptionFor(
  rel: string,
  site: { name: string; where: string },
  siteCount: (name: string) => number,
): string | null {
  const line = site.where.slice(site.where.lastIndexOf(":") + 1);
  const counted = CLASSIFIED[`${rel}:${site.name}×${siteCount(site.name)}`];
  return (
    CLASSIFIED[`${rel}:${site.name}:${line}`] ??
    counted ??
    CLASSIFIED[`${rel}:${site.name}`] ??
    null
  );
}

/** Distinct lines on which `name` is interpolated bare in `file`. */
function siteCounter(file: string): (name: string) => number {
  const byName = new Map<string, Set<string>>();
  for (const s of bareAgentInterpolations(`workflows/${file}`, sourceOf(file))) {
    if (!byName.has(s.name)) byName.set(s.name, new Set());
    byName.get(s.name)!.add(s.where.slice(s.where.lastIndexOf(":") + 1));
  }
  return (name: string) => byName.get(name)?.size ?? 0;
}

/**
 * Every key form a live site could legitimately be exempted by.
 *
 * All three: the file-wide `…:<binding>`, the line-pinned
 * `…:<binding>:<line>` and the count-pinned `…:<binding>×<n>`, so the
 * staleness check below reads a CLASSIFIED entry as live when the site it
 * names still exists at whichever granularity it was written in.
 */
function liveKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const file of WORKFLOW_FILES) {
    const count = siteCounter(file);
    for (const site of bareAgentInterpolations(`workflows/${file}`, sourceOf(file))) {
      const line = site.where.slice(site.where.lastIndexOf(":") + 1);
      for (const key of [
        `workflows/${file}:${site.name}`,
        `workflows/${file}:${site.name}:${line}`,
        `workflows/${file}:${site.name}×${count(site.name)}`,
      ]) {
        if (!keys.has(key)) keys.set(key, []);
        keys.get(key)!.push(site.where);
      }
    }
  }
  return keys;
}

/**
 * Which names may NOT take a file-wide exemption, derived rather than listed.
 *
 * Two signals, both properties of the tree: a short name (`o`, `r`, `result`)
 * is one the next author will reach for without checking, and a name bound in
 * more than one workflow file is demonstrably not unique to one binding. A
 * hand-written list of "generic" names would be the same enumeration problem
 * this check exists to stop.
 */
const GENERIC_MAX_LENGTH = 6;
function genericNames(): Set<string> {
  const filesByName = new Map<string, Set<string>>();
  for (const file of WORKFLOW_FILES) {
    for (const site of bareAgentInterpolations(`workflows/${file}`, sourceOf(file))) {
      if (!filesByName.has(site.name)) filesByName.set(site.name, new Set());
      filesByName.get(site.name)!.add(file);
    }
  }
  return new Set(
    [...filesByName]
      .filter(([name, files]) => name.length <= GENERIC_MAX_LENGTH || files.size > 1)
      .map(([name]) => name),
  );
}

describe("#1103: every agent-derived interpolation in a workflow prompt is classified", () => {
  test("the derivation still finds agent-derived bindings at all", () => {
    // The way a computed census dies silently: the derivation stops matching
    // and every file below reports clean over an empty set. Measured at 76
    // members in ship.js when written; asserted as a floor.
    const members = agentDerivedNames(sourceOf("ship.js"));
    expect(
      members.size,
      "no agent-derived binding was found in ship.js — the derivation in lib/workflow-taint.ts " +
        "has stopped matching, and every row below is now scanning for nothing",
    ).toBeGreaterThan(40);
  });

  for (const file of WORKFLOW_FILES) {
    test(`workflows/${file}`, () => {
      const rel = `workflows/${file}`;
      // Hoisted: building it per site re-parses the file once per
      // interpolation, which took ship.js past the 5s case budget.
      const count = siteCounter(file);
      const unclassified = [...new Set(
        bareAgentInterpolations(rel, sourceOf(file))
          .filter(s => !exemptionFor(rel, s, count))
          .map(s => `${s.where} — \${${s.name}}  (${s.expression})`),
      )];

      expect(
        unclassified,
        remedyMessage({
          root: REPO_ROOT,
          check: "SHELL-QUOTE-1",
          violations: unclassified,
          fix:
            "this binding can hold text an agent wrote, and it reaches a template literal without " +
            "passing shellQuote or heredocSafe. Do ONE of three things, in this order of " +
            "preference. (1) Refuse the value at its source — a shape check where it is assigned " +
            "beats quoting it at every use site, because a quoted bad value is inert rather than " +
            "correct. (2) Wrap the interpolation: ${shellQuote(<name>)}. (3) If it is genuinely " +
            "safe, add a line to CLASSIFIED in this file saying WHICH of the four kinds it is — " +
            "refused at the source, a command not a value, prose into a prompt, or structured not " +
            "text. Do not widen the derivation to make it disappear: it was narrowed to 38 names " +
            "precisely so that a new one is visible.",
        }),
      ).toEqual([]);
    });
  }

  test("a generic name is exempted by site count, not file-wide", () => {
    const generic = genericNames();
    const tooBroad = Object.keys(CLASSIFIED)
      .filter(k => {
        // `workflows/<file>:<name>`, `…:<name>:<line>`, `…:<name>×<n>`. Decode
        // rather than taking the last `:` segment: `result×4` is not a name,
        // and reading it as one made this row pass by accident.
        const after = k.slice(k.indexOf(":") + 1);
        const pinned = /:\d+$/.test(after) || /×\d+$/.test(after);
        if (pinned) return false;
        return generic.has(after);
      })
      .sort();
    expect(
      tooBroad,
      remedyMessage({
        root: REPO_ROOT,
        check: "SHELL-QUOTE-1",
        violations: tooBroad,
        fix:
          "this exemption is file-wide on a name that is short or bound in more than one " +
          "workflow file. The derivation keys by NAME, so a second binding that takes this name " +
          "inherits a sentence written about the first one and the census stays quiet about it. " +
          "Pin it: `workflows/<file>:<binding>×<n>` states how many sites the sentence was " +
          "written about and reds when a site is added, which is the cheap form — a line shift " +
          "does not change a count. `workflows/<file>:<binding>:<line>` pins one site exactly, " +
          "for when the sites genuinely differ in kind.",
      }),
    ).toEqual([]);
  });

  test("no classification outlives the site it describes", () => {
    // Both directions, deliberately. An exemption left behind after its line
    // is gone is a sentence a reviewer reads and believes about code that no
    // longer exists — and it is also how the next real binding of the same
    // name arrives pre-approved.
    const live = liveKeys();
    const stale = Object.keys(CLASSIFIED).filter(k => !live.has(k)).sort();
    expect(
      stale,
      remedyMessage({
        root: REPO_ROOT,
        check: "SHELL-QUOTE-1",
        violations: stale,
        fix:
          "this CLASSIFIED entry names a binding that no longer reaches a template literal " +
          "unsanitised — it was quoted, renamed, or deleted. Remove the entry. Keeping it means " +
          "the next binding that happens to take the name inherits an exemption nobody wrote " +
          "for it.",
      }),
    ).toEqual([]);
  });
});

describe("#1103: the census can fail, and fails on the thing that got past it", () => {
  // The planted sources below are deliberately tiny. A fixture the size of
  // ship.js would make a passing row mean "something in there matched".

  test("a NEW agent-derived binding interpolated bare is found — the #1103 witness", () => {
    // AC-2, and the case that would have caught #1103 itself. Nothing in this
    // source is named in any list: the derivation reaches `stray` through
    // `thing`, which it reaches through `agent(`.
    const planted = [
      "const thing = await agent(`do work`)",
      "const stray = thing.worktreePath",
      "const cmd = `git -C ${stray} rev-parse HEAD`",
    ].join("\n");

    const found = bareAgentInterpolations("planted.js", planted);
    expect(found.map(f => f.name)).toEqual(["stray"]);
  });

  test("a block-scoped agent reply reaching a top-level binding is found", () => {
    // The exact shape of #1103, and the shape the first draft of the
    // derivation missed: `priorBranchResult` is a top-level `let` whose agent
    // value arrives from a `const` inside an `if` block. A derivation that
    // only reads top-level declarations returns nothing here.
    const planted = [
      "let prior = null",
      "if (!prior) {",
      "  const reply = await agent(`find the branch`)",
      "  prior = { branch: reply.priorBranch }",
      "}",
      "const target = prior.branch ? `HEAD:${prior.branch}` : 'HEAD'",
      "const cmd = `git push -u origin ${target}`",
    ].join("\n");

    // Both: `${prior.branch}` inside the ternary and `${target}` in the push.
    // The run has two places to fix and the census names both of them.
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name).sort()).toEqual([
      "prior",
      "target",
    ]);
  });

  test("the control: an edit that changes no risk does not red", () => {
    // AC-3. `WORK_DIR`, `ISSUE` and `REPO` come from the run's arguments and
    // no agent can move them. If renaming their use sites could redden this
    // check, it has drifted back into the raw count of every interpolation
    // that #1100 rejected for exactly that reason.
    const planted = [
      "const WORK_DIR = args.workDir",
      "const out = `bun run ${WORK_DIR}/thing.ts --issue ${ISSUE} --repo ${REPO}`",
      "const renamed = `bun run ${WORK_DIR}/other.ts --issue ${ISSUE}`",
    ].join("\n");

    expect(bareAgentInterpolations("planted.js", planted)).toEqual([]);
  });

  test("shellQuote is the only way out, and heredocSafe deliberately is not", () => {
    const quoted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "const cmd = `git -C ${shellQuote(p)} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", quoted)).toEqual([]);

    // `shellQuote` is context-free: its output is one shell word wherever it
    // lands. `heredocSafe` is not — it makes a value safe inside a heredoc
    // opened with the delimiter it was GIVEN, and a name carrying that
    // property to a site that opens no heredoc, or opens a different one, is
    // marked safe for a context it never reached (#1113). So it is reported
    // and classified per site rather than carried by the name.
    const heredoc = [
      "const thing = await agent(`do work`)",
      "const safe = heredocSafe(thing.body, 'EOF')",
      "const cmd = `cat <<EOF\\n${safe}\\nEOF`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", heredoc).map(f => f.name)).toEqual(["safe"]);

    // The case that cost the exemption: the same binding reaching a command
    // that opens no heredoc at all. Under the old rule this was silent.
    const travelled = [
      "const thing = await agent(`do work`)",
      "const safe = heredocSafe(thing.body, 'EOF')",
      "const cmd = `git -C ${safe} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", travelled).map(f => f.name)).toEqual(["safe"]);
  });

  test("a concatenated command is a sink too", () => {
    // A template literal is not the only way to build a string, and
    // `'git -C ' + workDir` reached the same shell invisibly — a sink SHAPE
    // the scanner could not see, which is the same class of silence as the
    // comment regex and the destructuring (#1113).
    const planted = [
      "const thing = await agent(`do work`)",
      "const workDir = thing.workDir",
      "const cmd = 'git -C ' + workDir + ' status'",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["workDir"]);

    // Arithmetic is not a command: a `+` with no string literal in it is not
    // a sink, or every `${i + 1}` in these files would be one.
    const arithmetic = [
      "const thing = await agent(`do work`)",
      "const n = thing.count",
      "const total = n + 1",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", arithmetic)).toEqual([]);

    // And a concatenated MESSAGE is still a message.
    const message = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log('staged into ' + p)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", message)).toEqual([]);
  });

  test("a destructured agent reply is a binding — the invisible one", () => {
    // `bindings()` only emitted for `dec.id.type === "Identifier"`, so this
    // whole shape bound nothing and the checker said nothing (#1113). Object,
    // nested, array, rename and default all reach the same place.
    const planted = [
      "const { branch } = await agent(`find the branch`)",
      "const cmd = `git push origin HEAD:${branch}`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["branch"]);

    const renamed = [
      "const { worktreePath: wt } = await agent(`build it`)",
      "const cmd = `git -C ${wt} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", renamed).map(f => f.name)).toEqual(["wt"]);

    const array = [
      "const [first] = await parallel([() => agent(`a`)])",
      "const cmd = `echo ${first}`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", array).map(f => f.name)).toEqual(["first"]);
  });

  test("a block-scoped agent reply is reported where it is interpolated", () => {
    // Members are top-level only, and that restriction is about PROPAGATION —
    // measured at 200 names if widened. Whether to REPORT a value that came
    // straight out of an agent call is a different question, and gating it on
    // the same flag made a whole class of them silent (#1113).
    const planted = [
      "if (cond) {",
      "  const reply = await agent(`do work`)",
      "  const cmd = `git -C ${reply.worktreePath} status`",
      "}",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["reply"]);
  });

  test("a template nested inside a log() call is not exempt by proximity", () => {
    // The exemption was a byte range, so anything between a `log(` call's
    // first and last byte was a message — including a command built inside
    // it. It is the DIRECT arguments that are messages (#1113).
    const planted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log(`ran ${build(`git -C ${p} status`)}`)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["p"]);

    // And the direct argument itself is still exempt, including when the
    // message is assembled with `+`.
    const message = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log(`staged into ${p}`)",
      "log('prefix: ' + `and ${p}`)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", message)).toEqual([]);

    // `log.foo()` and `logger.warn()` are not this exemption: the callee has
    // to BE the name, not merely be rooted at it.
    const memberCall = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log.verbose(`staged into ${p}`)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", memberCall).map(f => f.name)).toEqual(["p"]);
  });

  test("a bullet inside a prompt is not a comment — the regex this replaced thought it was", () => {
    // #1100 skipped any line matching /^\s*(\/\/|\*|\/\*)/ as a comment. These
    // prompts are markdown-ish, so a line beginning `*` is a BULLET, and a
    // path line can begin `//`. Both hid a real interpolation. In a tree the
    // distinction is free: a comment is not a node.
    const planted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "const prompt = `Steps:",
      "* run it in ${p}",
      "// ${p} is the one to use",
      "`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toHaveLength(2);

    // And a REAL comment is still absent, because it is not in the tree.
    const commented = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "// the commit still ran `cd ${p}`",
      "const x = 1",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", commented)).toEqual([]);
  });

  test("spacing and member access are the same interpolation", () => {
    // `${ commitDir }` and `${commitDir.path}` were both invisible to a
    // scanner looking for the literal string "${commitDir}".
    const planted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "const a = `git -C ${ p } status`",
      "const b = `git -C ${p.root} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toHaveLength(2);
  });

  test("log() and refuse() are skipped by ENCLOSING CALL, not by word order", () => {
    const planted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log(`staged files into ${p}`)",
      "refuse(`cannot collect into ${p}`)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toEqual([]);

    // The line-wise version of this exemption exempted every line of a
    // multi-line literal AFTER the one holding `log(`. The AST version does
    // not, because the command below is not inside the call.
    const mixed = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "log(`a message",
      "spanning lines`)",
      "const cmd = `git -C ${p} add -A`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", mixed).map(f => f.name)).toEqual(["p"]);
  });

  test("extraction into a helper renames the binding and does NOT lose it", () => {
    // The second live instance of #1103, and the one that defeats a list
    // without anybody omitting anything: `commitDir` is classified, the
    // interpolation is bare, and at the interpolation site the binding is
    // called `dir`. The list was still correct and simply stopped applying.
    //
    // A value crossing a function boundary and changing its name is what
    // function boundaries are FOR, so the taint crosses with it: a member
    // passed as an argument taints the parameter it binds to, over that
    // function's body and no further.
    const planted = [
      "const thing = await agent(`do work`)",
      "const commitDir = thing.worktreePath",
      "function workflowProbeCommand(dir) {",
      "  return `if [ ! -d ${dir} ]; then echo PROBE_FAILED; exit 1; fi`",
      "}",
      "const probe = `${workflowProbeCommand(commitDir)}`",
    ].join("\n");

    const found = bareAgentInterpolations("planted.js", planted);
    // Both ends of the hop, which is the right answer: the call site passes an
    // unsanitised member into a string, and the body puts it in a command.
    // Either one is a place to fix it, and reporting only the second would
    // send a reader into the helper for a decision the caller can make.
    expect(found.map(f => `${f.where} ${f.name}`).sort()).toEqual([
      "planted.js:4 dir",
      "planted.js:6 commitDir",
    ]);
  });

  test("the quoter travels as an argument, and its alias is still the quoter", () => {
    // The mirror image, and the reason the row above does not drown in noise.
    // `suiteCaptureCommand(projectRoot, cmd, workDir, shellQuote)` is this
    // repo's idiom for a helper that must quote without importing (#69).
    // Inside it the sanitiser is called `quote`, and a check that only knows
    // the name `shellQuote` reads every correctly quoted site as bare.
    const planted = [
      "const thing = await agent(`do work`)",
      "const dirFromAgent = thing.worktreePath",
      "function capture(root, quote) {",
      "  return `( cd ${quote(root)} && bun test )`",
      "}",
      "const cmd = capture(dirFromAgent, shellQuote)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toEqual([]);

    // And the alias is not a blanket pass for the parameter: used WITHOUT the
    // quoter it is still a bare interpolation.
    const unquoted = planted.replace("${quote(root)}", "${root}");
    expect(bareAgentInterpolations("planted.js", unquoted).map(f => f.name)).toEqual(["root"]);
  });

  test("a quoter alias is one function's parameter, not a name (#1114)", () => {
    // The alias was a flat set of parameter NAMES, so once any function
    // anywhere bound `shellQuote` to a `quote`, the name `quote` was a
    // sanitiser in every file — and an unrelated helper with its own `quote`,
    // bound to anything at all, got a free pass while the census reported
    // clean. Latent when it was found, which is the kind of hole that goes
    // live on somebody else's unrelated commit.
    const planted = [
      "const thing = await agent(`do work`)",
      "const dirFromAgent = thing.worktreePath",
      "function real(root, quote) { return `( cd ${quote(root)} && bun test )` }",
      "function fake(root, quote) { return `( cd ${quote(root)} && bun test )` }",
      "const identity = x => x",
      "const a = real(dirFromAgent, shellQuote)",
      "const b = fake(dirFromAgent, identity)",
    ].join("\n");

    // `real`'s site is quoted; `fake`'s is not, and sharing a parameter name
    // with `real` must not make it so.
    const found = bareAgentInterpolations("planted.js", planted);
    expect(found.map(f => `${f.where} ${f.name}`)).toEqual(["planted.js:4 root"]);
  });

  test("an alias is unanimous across call sites, not won by the first", () => {
    // `sanitised` above has always used "every assignment, not the first";
    // the alias used the first call site, and that asymmetry was the bug. A
    // function called twice, once with the quoter and once without, quotes on
    // neither occasion.
    const planted = [
      "const thing = await agent(`do work`)",
      "const dirFromAgent = thing.worktreePath",
      "function maybe(root, quote) { return `( cd ${quote(root)} && bun test )` }",
      "const identity = x => x",
      "const a = maybe(dirFromAgent, shellQuote)",
      "const b = maybe(dirFromAgent, identity)",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["root"]);

    // The control: unanimous call sites still make it the quoter, or the
    // repo's own `suiteCaptureCommand` idiom reds everywhere and the census
    // becomes noise people dismiss.
    const unanimous = planted.replace("const b = maybe(dirFromAgent, identity)", "const b = maybe(dirFromAgent, shellQuote)");
    expect(bareAgentInterpolations("planted.js", unanimous)).toEqual([]);

    // …and a call site that omits the argument is a call site that does not
    // pass the quoter.
    const omitted = planted.replace("const b = maybe(dirFromAgent, identity)", "const b = maybe(dirFromAgent)");
    expect(bareAgentInterpolations("planted.js", omitted).map(f => f.name)).toEqual(["root"]);
  });

  test("an already-quoted argument does not taint the parameter it binds to", () => {
    // `workflowProbeCommand(shellQuote(commitDir))` is the shape #1112 adds.
    // Without this the helper's interior reds, and the cheapest way to green
    // it would be to UNQUOTE the call site.
    const planted = [
      "const thing = await agent(`do work`)",
      "const commitDir = thing.worktreePath",
      "function probe(quotedDir) { return `test -d ${quotedDir} || exit 1` }",
      "const cmd = `${probe(shellQuote(commitDir))}`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toEqual([]);

    // The control, and the whole reason the exemption is narrow: drop the
    // quoting at the call site and both ends report again.
    const unquoted = planted.replace("probe(shellQuote(commitDir))", "probe(commitDir)");
    expect(bareAgentInterpolations("planted.js", unquoted).map(f => f.name).sort()).toEqual([
      "commitDir",
      "quotedDir",
    ]);
  });

  test("a helper called with something no agent touched taints nothing", () => {
    // The control for the hop. If passing ANY argument tainted the parameter,
    // every helper in the file would be in the population and the
    // classification table would be the file.
    const planted = [
      "const WORK_DIR = args.workDir",
      "function probe(dir) { return `test -d ${dir}` }",
      "const cmd = `${probe(WORK_DIR)}`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted)).toEqual([]);
  });

  test("a wrapper around agent() is a spawner too, without being named", () => {
    // `timedAgent`, `briefedAgent`, `runImplement` and the rest are never
    // listed anywhere. Naming the wrappers is the omission trap one level up,
    // so the derivation finds them by what they call.
    const planted = [
      "function timedAgent(p, o) { return agent(p, o) }",
      "function runImplement(x) { return timedAgent(x, {}) }",
      "const built = await runImplement('go')",
      "const cmd = `git -C ${built.worktreePath} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", planted).map(f => f.name)).toEqual(["built"]);
  });
});
