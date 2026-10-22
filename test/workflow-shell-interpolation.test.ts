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
  "workflows/ship.js:testCommand":
    "a command, not a value: the project's test command out of `rungate.json`, run as written. " +
    "`suiteCaptureCommand` takes the quoter as an argument and applies it to the PATHS around it",
  "workflows/ship.js:prodQuinn":
    "a command, not a value: `prodQuinnAssignment` returns a JavaScript statement that the " +
    "surrounding `bun -e` executes. Quoting it would make it a string literal that does nothing",
  "workflows/ship.js:testTimeout":
    "structured, not text: `projectConfig.test?.timeout || 120000`, a number, read by the agent " +
    "as the Bash tool's timeout parameter",
  "workflows/ship.js:prState":
    "structured, not text: `prState.number` is a PR number from `prReadiness`, which reads it " +
    "from the GitHub API's JSON, not from a reply",
  "workflows/ship.js:prStep":
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

  // ── workflows/ship-and-heal.js ─────────────────────────────────────
  "workflows/ship-and-heal.js:workDir":
    "refused at the source: anything that is not a plain absolute path is dropped to '' at the " +
    "assignment, and the existing `if (workDir)` branch then skips grading (#1103)",
  "workflows/ship-and-heal.js:testCommand":
    "a command, not a value: the project's test command, run as written inside `( cd … && … )`",
  "workflows/ship-and-heal.js:testTimeout":
    "structured, not text: a number, read by the agent as the Bash tool's timeout parameter",
  "workflows/ship-and-heal.js:status":
    "prose into a prompt: the ship workflow's terminal status word, reported in a summary block",
  "workflows/ship-and-heal.js:failureText":
    "prose into a prompt: the failure lines the root-cause agent is asked to explain",
  "workflows/ship-and-heal.js:rca":
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

  // ── workflows/council.js ───────────────────────────────────────────
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

/** `workflows/<file>:<binding>` for every bare interpolation in the tree. */
function liveKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const file of WORKFLOW_FILES) {
    for (const site of bareAgentInterpolations(`workflows/${file}`, sourceOf(file))) {
      const key = `workflows/${file}:${site.name}`;
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key)!.push(site.where);
    }
  }
  return keys;
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
      const unclassified = [...new Set(
        bareAgentInterpolations(rel, sourceOf(file))
          .filter(s => !(`${rel}:${s.name}` in CLASSIFIED))
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

  test("shellQuote and heredocSafe are the only ways out", () => {
    const quoted = [
      "const thing = await agent(`do work`)",
      "const p = thing.path",
      "const cmd = `git -C ${shellQuote(p)} status`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", quoted)).toEqual([]);

    // …and a binding whose every assignment is a sanitiser call carries it.
    const carried = [
      "const thing = await agent(`do work`)",
      "const safe = heredocSafe(thing.body, 'EOF')",
      "const cmd = `cat <<EOF\\n${safe}\\nEOF`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", carried)).toEqual([]);

    // Not a free pass for the NAME: a second assignment that does not
    // sanitise puts it back in the population.
    const halfSafe = [
      "const thing = await agent(`do work`)",
      "let safe = heredocSafe(thing.body, 'EOF')",
      "safe = thing.body",
      "const cmd = `cat <<EOF\\n${safe}\\nEOF`",
    ].join("\n");
    expect(bareAgentInterpolations("planted.js", halfSafe).map(f => f.name)).toEqual(["safe"]);
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
