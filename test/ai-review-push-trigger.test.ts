/**
 * #1469: `ai-review` has to REPORT on a push to the default branch, and
 * adding the trigger alone turns one problem into a worse one.
 *
 * ## Why the trigger
 *
 * `PROTECT-1` (`lib/branch-protection.ts`) reads a repository's protection
 * and refuses in both directions on a user-owned account whose required
 * contexts do not run on push:
 *
 * - `required_status_checks.strict = true` serialises every swarm's pull
 *   requests, measured at ~2.5 min per PR on a real consumer, and merge
 *   queues are unavailable on a user-owned repo.
 * - `strict = false` is refused as a RECOMMENDATION while any required
 *   context is missing from `push:` to the default branch, because push-CI
 *   is the only thing left that catches the semantic conflict.
 *
 * Measured on this tree on 2026-10-24, with the exact calls:
 *
 *     readPushCi(<origin/main>, ["test","ai-review"], "main")
 *       -> { onPush: ["test"], missing: ["ai-review"] }
 *     readPushCi(<this branch>, ["test","ai-review"], "main")
 *       -> { onPush: ["test","ai-review"], missing: [] }
 *
 * and `gh api repos/hornjason/pai-harness/branches/main/protection` reports
 * `contexts: ["test","ai-review"]`, `strict: false`. So `ai-review` was the
 * single entry blocking the reading, which is what AC-3 below binds.
 *
 * **This file does not decide `strict`, and nothing here recommends it.**
 * Setting `strict: true` on 2026-10-23 reddened PROTECT-1 inside the managed
 * pre-push hook and refused every session's push, repo-wide, with no commit
 * anywhere to revert. That decision is the owner's; what this change does is
 * make it decidable.
 *
 * ## What the job can DO on a push: nothing, and that is MEASURED
 *
 * Read from `anthropics/claude-code-action` at the SHA
 * `lib/claude-code-action.ts` pins, the same way #867 established it for
 * `merge_group`: `parseGitHubContext()` in `src/github/context.ts` switches
 * on `context.eventName`, and the `default:` branch throws
 * `Unsupported event type: <name>`. The switch's arms at that SHA are
 * `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
 * `pull_request_review_comment`, `workflow_dispatch`, `repository_dispatch`,
 * `schedule` and `workflow_run`. **`push` is not among them.**
 *
 * So this is #867's distinction, met a second time: an argument about what
 * the job can DO on an event is not an argument about whether it REPORTS on
 * one. The job reports. It annotates `::warning` and names the state
 * UNMEASURED, because nothing read the commit.
 *
 * ## The failure mode this file is mostly about
 *
 * A `push` payload has no `github.event.pull_request`, so every binding that
 * reads one resolves to the empty string. Three steps refuse on that and two
 * of the three refuse with `AI_REVIEW_REQUIRED_EXIT`:
 *
 * | Step | Before this change, on a push | After |
 * |---|---|---|
 * | restore untrusted paths | empty base ref -> refuse, job RED | says there is no base and exits 0 |
 * | count the review rounds | empty head ref -> refuse, job RED | blank round outputs, exits 0 |
 * | carry forward prior findings | UNMEASURED, naming a lookup that never applied | declares ABSENT |
 * | report whether the review ran | falls through to the action's outcome and refuses | its own branch, naming the event |
 * | persist the ledger | already exits 0 on an empty PR number | unchanged, asserted here |
 * | disarm auto-merge | already exits 0 when nothing was waived | unchanged, asserted here |
 * | record the changed paths | already exits 0 on an empty base remote | unchanged, asserted here |
 *
 * The last three rows are the point of auditing rather than patching: they
 * are steps that read a pull-request value and were already safe, and a case
 * that only exercised the four changed ones would be claiming an audit it
 * had not done. They are asserted by EXECUTION, not by reading the source.
 *
 * ## The cheapest wrong fix, named
 *
 * Give the restore step `|| github.ref_name` as a third alternative for its
 * base ref. One token, the refusal stops firing, and the step then fetches
 * `origin/<branch>` — a ref that may already have moved past the commit
 * being built — and overwrites the checkout's untrusted paths with it. The
 * step reports success having done something nobody asked for.
 *
 * Do the cases here survive it? **Yes, non-vacuously.** AC-4 asserts the
 * restore step exits 0 on a push *with no base ref supplied at all* and says
 * so in its annotation; under the wrong fix the expression would supply one
 * and the script would attempt a fetch against a remote that does not exist
 * in the fixture, which is non-zero. AC-10 additionally reads the committed
 * workflow and asserts the binding is still the two-alternative one.
 *
 * ## What was broken to prove it, predicted before the battery ran
 *
 * Over `test/ai-review-push-trigger.test.ts` +
 * `test/ai-review-merge-group.test.ts` + `test/merge-group-trigger.test.ts`
 * (43 tests). **The baseline row was read before any mutation row** — an
 * instrument that has stopped reporting takes the baseline down with it, and
 * that is the row nobody mutates anything to produce. `bun` writes its
 * summary to stderr, so the reader takes both streams.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 43 pass, 0 fail | **43 pass, 0 fail** | — |
 * | M1: the `push: branches:` block removed from `lib/scaffold/steps.ts` | 3 | **3 of 43** | a generated tree: the original's `on:` block carries `push:` and `readPushCi` returns `missing: []`, the mutant's does not and returns `missing: ["ai-review"]` |
 * | M2: `aiReviewPushBranch` short-circuited to `return ""` | 7 | **8 of 43** | `AI_REVIEW_EVENT=push` into any of the four scripts: the restore script exits 0 on the original and refuses on the mutant, and `buildRestoreScript()` contains the test string once against zero times |
 *
 * **M1's set, named rather than counted:** the two AC-1 cases and AC-3. AC-2
 * stays GREEN on purpose — it reads this repository's COMMITTED workflow,
 * which a mutation of the generator does not touch, and that split is why
 * both cases exist. The AC-4..AC-10 cases drive the scripts and are
 * indifferent to the trigger.
 *
 * **M2 came back HIGH, and the extra red is the real kind.** The prediction
 * missed *"AC-8: the refusal is NARROW — any other value of the flag still
 * reports"*, on the belief that a push with the flag UNSET would fall
 * through to a route that warns and exits 0. Measured: it does not. With the
 * branch gone, `AI_REVIEW_EVENT=push` reaches the action-outcome reading and
 * refuses with *"The review action (#631) did not complete"* **whatever the
 * flag holds** — `push` and `pull_request` produce byte-identical stderr and
 * exit 1 under the mutant. So the fact that row records is that the branch
 * is load-bearing for the DEFAULT path and not only the flagged one: without
 * it every commit that lands reds `ai-review` on main, for a cause the job
 * did not measure. The mutant is not broken — 35 cases still pass, the file
 * parses, and every red is about the removed branch.
 *
 * Neither mutation is left in the tree; both were run and reverted, and
 * `lib/scaffold/steps.ts` and `lib/scaffold/ai-review-step.ts` were confirmed
 * byte-identical to the measured sources afterwards by sha256 — never by
 * `git checkout --`, which eats an uncommitted rewrite.
 *
 * ## What this does NOT establish
 *
 * - **That GitHub reaches any of it.** No push run of the new trigger exists
 *   until this merges; every case here runs the generated script directly
 *   with `AI_REVIEW_EVENT` set. That proves the script's behaviour and not
 *   that the runner hands it that event name. The escape is asserted one
 *   layer out, in AC-10, which reads the committed `env:` bindings.
 * - **That `ai-review` on push adds any safety.** It does not, and the
 *   generator's own comment says so: the semantic-conflict net PROTECT-1
 *   argues for is `test`, which has run on push since the first scaffold.
 *   This trigger makes a required context REPORT; it reviews nothing.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPushCi } from "../lib/branch-protection";
import {
  AI_REVIEW_AT_CAP_OUTPUT,
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_BASE_REMOTE_VAR,
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_PATH_VAR,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_CHANGED_FILES_PATH_VAR,
  AI_REVIEW_DISARM_WAIVED_VAR,
  AI_REVIEW_EVENT_VAR,
  AI_REVIEW_INTENT_NONE,
  AI_REVIEW_INTENT_OUTPUT,
  AI_REVIEW_JOB,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_PUSH_EVENT,
  AI_REVIEW_QUEUE_EVENT,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_RESTORE_STEP_ID,
  AI_REVIEW_ROUND_OUTPUT,
  AI_REVIEW_WORKFLOW_FILE,
  buildCarryScript,
  buildChangedFilesScript,
  buildDisarmScript,
  buildPersistScript,
  buildRestoreScript,
  buildReviewRunScript,
  buildRoundsScript,
} from "../lib/scaffold/ai-review-step";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { stubBunxAbsent } from "./helpers/stub-bunx";

/** A fixture version for the adjudicator's `bunx` pin, never the real one. */
const FIXTURE_VERSION = "0.0.0-fixture";

/**
 * A default branch that is NOT `main`.
 *
 * The whole of AC-1's non-hardcoding half. This scaffold ships into other
 * people's repositories, and a `branches: [main]` literal in the generator
 * would emit a trigger that never fires on a consumer whose default branch
 * is called something else — present and inert, which reads as handled.
 */
const FIXTURE_BRANCH = "trunk-1469";

/** Generate the four workflows into a throwaway tree and hand them back. */
function generate(branches: string[] = [FIXTURE_BRANCH]): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "rg-1469-gen-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({
        project: "fixture",
        repo: "fixture/fixture",
        ci: { bunVersion: "1.3.14", shards: 4, branches },
        test: { command: "bun test" },
      }),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    createCiWorkflows(root, [], { force: true });

    const dir = join(root, ".github", "workflows");
    const out: Record<string, string> = {};
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".yml") || name.endsWith(".yaml")) out[name] = readFileSync(join(dir, name), "utf8");
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The `on:` block only — everything from `on:` to the next top-level key. */
function triggerBlock(yml: string): string {
  const at = yml.indexOf("\non:");
  if (at < 0) return "";
  const rest = yml.slice(at + 1);
  const end = rest.search(/\n(?=[A-Za-z])/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The committed workflow this repository ships, parsed. */
function committed(): any {
  return Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
  );
}

function runIn(dir: string, script: string, env: Record<string, string>) {
  const path = join(dir, "script.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", "-e", path], {
    cwd: dir,
    env: { PATH: stubBunxAbsent(), HOME: dir, ...env },
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

function run(script: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "rg-1469-"));
  try {
    return runIn(dir, script, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#1469 AC-1: the generator emits the push trigger, from the consumer's own branch list", () => {
  test("ai-review.yml declares push: with a branches: filter", () => {
    const block = triggerBlock(generate()["ai-review.yml"]);
    // The slice control. An empty string contains nothing, which is
    // indistinguishable from a clean result.
    expect(block.length, "the on: block could not be sliced out").toBeGreaterThan(10);

    expect(
      block,
      "ai-review.yml has no push: trigger — PROTECT-1 reads the workflows directory and " +
        "will keep reporting ai-review missing from push-CI, which refuses BOTH strict readings",
    ).toMatch(/^\s{2}push:$/m);
    expect(block, "the push trigger carries no branches: filter").toMatch(/^\s{4}branches:$/m);
  });

  test("the branch list is the consumer's, not a literal", () => {
    // Reds on a hardcoded `main`. This scaffold ships to other people's
    // repositories and a literal would emit a trigger that never fires.
    const block = triggerBlock(generate()["ai-review.yml"]);
    expect(block, `the push filter does not name the configured default branch ${FIXTURE_BRANCH}`)
      .toContain(`"${FIXTURE_BRANCH}"`);
    expect(block, "the push filter names `main`, which this fixture never configured")
      .not.toContain('"main"');

    // Two branches, so a reader that takes only the first is caught.
    const two = triggerBlock(generate([FIXTURE_BRANCH, "release-1469"])["ai-review.yml"]);
    expect(two).toContain(`"${FIXTURE_BRANCH}"`);
    expect(two, "only the first configured branch reached the filter").toContain('"release-1469"');
  });

  test("the queue trigger is unchanged and still carries no filter", () => {
    // #867's property, restated because this change inserts a `branches:`
    // key two lines below `merge_group:`. A filter attached to the queue
    // trigger matches nothing — the queue ref is `gh-readonly-queue/...` —
    // so it would be present and inert, which reads as handled.
    const lines = triggerBlock(generate()["ai-review.yml"]).split("\n");
    const at = lines.findIndex(l => l.trim() === `${AI_REVIEW_QUEUE_EVENT}:`);
    expect(at, "merge_group: is no longer on its own line").toBeGreaterThan(-1);
    const next = lines.slice(at + 1).find(l => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(next ?? "", "a branches: filter was attached to merge_group:").not.toMatch(/^\s+branches:/);
    expect(triggerBlock(generate()["ai-review.yml"]), "the pull_request trigger was replaced")
      .toContain("pull_request:");
  });
});

describe("#1469 AC-2: the committed workflow carries it, not only the generator", () => {
  test("this repository's own ai-review.yml was regenerated", () => {
    // A generator that emits the trigger into a temp directory while this
    // repo's copy stays stale satisfies AC-1 and changes nothing about this
    // repository, which is the only tree PROTECT-1 reads here.
    const on = committed().on;
    expect(on, "the committed workflow has no on: block").toBeDefined();
    expect(on.push, "the committed ai-review.yml has no push trigger").toBeDefined();
    expect(on.push.branches, "the committed push trigger has no branches filter").toEqual(["main"]);
    expect(on.pull_request, "the pull_request trigger was lost").toBeDefined();
    expect(AI_REVIEW_QUEUE_EVENT in on, "the merge_group trigger was lost").toBe(true);
  });
});

describe("#1469 AC-3: the reading this exists to move", () => {
  test("PROTECT-1's push-CI reading stops naming ai-review, and the control still does", () => {
    // Bound to the PURPOSE rather than to the syntax. A case that only
    // greps for `push:` is satisfied by a trigger PROTECT-1's own parser
    // cannot see — it reads the branch list too, and a filter naming a
    // different branch would leave the context missing while the grep
    // passes.
    const files = generate();
    const root = mkdtempSync(join(tmpdir(), "rg-1469-pushci-"));
    try {
      const dir = join(root, ".github", "workflows");
      mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);

      const contexts = ["test", AI_REVIEW_JOB];
      expect(readPushCi(root, contexts, FIXTURE_BRANCH)).toEqual({
        onPush: contexts,
        missing: [],
        unmeasured: null,
      });

      // THE CONTROL, and it is what stops the assertion above being true of
      // any tree at all: the same reading over the same files with
      // ai-review.yml's push block removed still reports it missing. A
      // reader that credited every context regardless would pass both.
      const stripped = files["ai-review.yml"].replace(/\n {2}push:\n {4}branches:\n(?: {6}-[^\n]*\n)+/, "\n");
      expect(stripped, "the strip did not remove anything — the control is vacuous")
        .not.toEqual(files["ai-review.yml"]);
      writeFileSync(join(dir, "ai-review.yml"), stripped);
      expect(readPushCi(root, contexts, FIXTURE_BRANCH)).toEqual({
        onPush: ["test"],
        missing: [AI_REVIEW_JOB],
        unmeasured: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#1469 AC-4: the restore step on a push", () => {
  test("a push with NO base ref exits 0 and says nothing was restored", () => {
    // Before this change the same input refused with AI_REVIEW_REQUIRED_EXIT
    // and reddened the check on every commit that lands.
    const r = run(buildRestoreScript(), { [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT });
    expect(r.code, `a push reddened the restore step: ${r.err}`).toBe(0);
    expect(r.out, "the step passed in silence").toContain("::warning");
    expect(r.out, "the annotation does not name the event it declined on").toContain(AI_REVIEW_PUSH_EVENT);
    expect(
      r.err,
      "the step ALSO refused on stderr — two verdicts for one run, and the red one wins",
    ).toBe("");
  });

  test("the pass is NARROW: an empty base ref on a pull request still refuses", () => {
    // The control that matters most. A branch keyed on anything a pull
    // request also satisfies would skip the restore on every pull request,
    // handing the reviewer the branch's own copy of the instructions it is
    // being reviewed against.
    for (const event of ["pull_request", AI_REVIEW_QUEUE_EVENT, "", "Push", "push ", "pushes"]) {
      const r = run(buildRestoreScript(), {
        [AI_REVIEW_BASE_REF_VAR]: "",
        ...(event === "" ? {} : { [AI_REVIEW_EVENT_VAR]: event }),
      });
      expect(r.code, `event '${event}' took the push branch and skipped the restore`).not.toBe(0);
      expect(r.err).toContain("UNMEASURED");
    }
  });
});

describe("#1469 AC-5: the rounds step on a push", () => {
  test("a push with no head ref blanks the outputs and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-1469-rounds-"));
    try {
      const outFile = join(dir, "github-output");
      writeFileSync(outFile, "");
      const r = runIn(dir, buildRoundsScript(), {
        [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT,
        GITHUB_OUTPUT: outFile,
      });
      expect(r.code, `a push reddened the rounds step: ${r.err}`).toBe(0);

      // The OUTPUTS, not the exit code. An exit code is satisfied by a
      // branch that writes nothing, and a downstream step reading an absent
      // `round` cannot tell that from a step that never ran.
      const written = readFileSync(outFile, "utf8");
      expect(written).toContain(`${AI_REVIEW_ROUND_OUTPUT}=\n`);
      expect(written).toContain(`${AI_REVIEW_AT_CAP_OUTPUT}=\n`);
      expect(
        written,
        "the intent output was not declared, so the reviewer's prompt cannot tell " +
          "'there was no pull request' from 'the intent could not be read'",
      ).toContain(`${AI_REVIEW_INTENT_OUTPUT}=${AI_REVIEW_INTENT_NONE}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pass is NARROW: a pull request with no head ref still refuses", () => {
    const r = run(buildRoundsScript(), { [AI_REVIEW_EVENT_VAR]: "pull_request", GITHUB_OUTPUT: "/dev/null" });
    expect(r.code, "the push branch leaked onto pull_request").toBe(AI_REVIEW_REQUIRED_EXIT);
  });
});

describe("#1469 AC-6: the carry-forward step on a push", () => {
  test("a push declares ABSENT, which is a reading, not a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-1469-carry-"));
    try {
      const carry = join(dir, "carried.txt");
      const r = runIn(dir, buildCarryScript(), {
        [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT,
        [AI_REVIEW_CARRY_PATH_VAR]: carry,
      });
      expect(r.code, `a push reddened the carry step: ${r.err}`).toBe(0);
      expect(readFileSync(carry, "utf8")).toContain(`${AI_REVIEW_CARRY_STATE_KEY}=${AI_REVIEW_CARRY_ABSENT}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pass is NARROW: a pull request with no number is still UNMEASURED", () => {
    // ABSENT and UNMEASURED are the distinction this step exists to draw, so
    // a branch that turned the second into the first would be a regression
    // wearing a fix.
    const dir = mkdtempSync(join(tmpdir(), "rg-1469-carry-pr-"));
    try {
      const carry = join(dir, "carried.txt");
      const r = runIn(dir, buildCarryScript(), {
        [AI_REVIEW_EVENT_VAR]: "pull_request",
        [AI_REVIEW_CARRY_PATH_VAR]: carry,
      });
      expect(r.code).toBe(0);
      expect(readFileSync(carry, "utf8")).toContain(`${AI_REVIEW_CARRY_STATE_KEY}=${AI_REVIEW_CARRY_UNMEASURED}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1469 AC-7: the report step reaches a measured verdict on a push", () => {
  const PR_ENV = {
    AI_REVIEW_MODE: "vertex",
    // What the action leaves behind: it threw on the unsupported event name
    // before it could run, so the step is a failure with no payload.
    AI_REVIEW_ACTION_OUTCOME: "failure",
  };

  test("on push the check passes, and SAYS it reviewed nothing", () => {
    const r = run(buildReviewRunScript(FIXTURE_VERSION), {
      ...PR_ENV,
      [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT,
    });
    expect(r.code, `a push to the default branch reds ai-review: ${r.out}${r.err}`).toBe(0);
    expect(r.out, "the run passed in silence").toContain("::warning");
    expect(
      r.out,
      "the push is ALSO annotated ::notice — an unmeasured ref reported at two " +
        "severities at once, and GitHub shows the quieter one",
    ).not.toContain("::notice");
    expect(r.out).toContain(AI_REVIEW_PUSH_EVENT);
    expect(r.out, "the annotation does not name the state").toContain("UNMEASURED");
    expect(
      r.out,
      "the annotation claims the merge-queue argument, which does not hold here: " +
        "a direct push was reviewed by nothing and this step cannot tell it from a merge",
    ).not.toContain(AI_REVIEW_QUEUE_EVENT);
  });

  test("the pass is NARROW: only the exact string push takes it", () => {
    // Every row reds on a looser comparison. `pull_request` and the four
    // spellings red on a prefix, a case-insensitive match or a substring
    // test; `merge_group` is expected to pass by its OWN branch and is here
    // as the instrument control — a table in which every row refuses would
    // be satisfied by a script that refuses everything.
    const script = buildReviewRunScript(FIXTURE_VERSION);
    for (const [event, expected] of [
      ["pull_request", "refuse"],
      ["pull_request_target", "refuse"],
      ["workflow_dispatch", "refuse"],
      ["Push", "refuse"],
      ["push ", "refuse"],
      ["pushes", "refuse"],
      [AI_REVIEW_QUEUE_EVENT, "pass"],
      [AI_REVIEW_PUSH_EVENT, "pass"],
    ] as Array<[string, "pass" | "refuse"]>) {
      const r = run(script, { ...PR_ENV, [AI_REVIEW_EVENT_VAR]: event });
      if (expected === "pass") {
        expect(r.code, `event '${event}' should have reported and did not: ${r.err}`).toBe(0);
      } else {
        expect(r.code, `event '${event}' took the push branch — an unmeasured run reported green`).not.toBe(0);
        expect(r.err).toContain("UNMEASURED");
      }
    }
  });

  test("an absent event name is NOT treated as a push", () => {
    // Silent Default Substitution, in the direction that matters: a step
    // that never received its environment must not report a passing review.
    const r = run(buildReviewRunScript(FIXTURE_VERSION), PR_ENV);
    expect(r.code, "an unset event name took the passing branch").not.toBe(0);
  });
});

describe("#1469 AC-8: the fail-closed flag is not inert on a push", () => {
  test("a push refuses when RUNGATE_REQUIRE_AI_REVIEW is set", () => {
    // #939's defect, which was the merge_group branch sitting above every
    // refusal that reads the flag. A new branch written the same way would
    // reintroduce it on a new event.
    const r = run(buildReviewRunScript(FIXTURE_VERSION), {
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "failure",
      [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT,
      [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE,
    });
    expect(r.code, `the fail-closed flag is inert on a push\n${r.out}${r.err}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err, "the refusal was not annotated as an error").toContain("::error");
    expect(r.err, "the refusal does not say which event it refused on").toContain(AI_REVIEW_PUSH_EVENT);
    expect(r.err, "the refusal does not name the knob that caused it").toContain(AI_REVIEW_REQUIRE_VAR);
    // Reds on the cheapest wrong fix for a red push — deleting the branch or
    // moving it below the readings — which refuses with the generic tail.
    // The exit code is identical under that fix, so only the message sees it.
    expect(
      r.err,
      "the refusal reports a cause this job did not measure — the push fell through " +
        "to a reading rather than being refused by its own branch",
    ).not.toContain("has not reported");
  });

  test("the refusal is NARROW: any other value of the flag still reports", () => {
    const script = buildReviewRunScript(FIXTURE_VERSION);
    for (const [label, value] of [
      ["unset", undefined],
      ["empty", ""],
      ["TRUE", "TRUE"],
      ["1", "1"],
      ["yes", "yes"],
      ["false", "false"],
      ["true with a trailing space", "true "],
    ] as Array<[string, string | undefined]>) {
      const r = run(script, {
        AI_REVIEW_MODE: "vertex",
        AI_REVIEW_ACTION_OUTCOME: "failure",
        [AI_REVIEW_EVENT_VAR]: AI_REVIEW_PUSH_EVENT,
        ...(value === undefined ? {} : { [AI_REVIEW_REQUIRE_VAR]: value }),
      });
      expect(r.code, `${AI_REVIEW_REQUIRE_VAR}=${label} reddened main on every push\n${r.err}`).toBe(0);
    }
  });
});

describe("#1469 AC-9: the PR-reading steps this change did NOT touch, measured", () => {
  // The audit half. Each of these reads a pull-request value and was already
  // safe on an empty one; asserting that by EXECUTION is the difference
  // between an audit and a claim that one happened. A later change that
  // turns any of them into a refusal reds here.

  test("the ledger step exits 0 when no pull request number reached it", () => {
    const r = run(buildPersistScript(), { [AI_REVIEW_LEDGER_PR_VAR]: "" });
    expect(r.code, `the ledger step reds a push: ${r.err}`).toBe(0);
  });

  test("the disarm step exits 0 when nothing was waived", () => {
    // On a push the report step short-circuits before any waiver branch, so
    // the waived marker is never written. The step's own refusal for "waived
    // but no pull request" is therefore unreachable here — and must stay
    // reachable, which the second row asserts.
    const r = run(buildDisarmScript(), { [AI_REVIEW_DISARM_WAIVED_VAR]: "" });
    expect(r.code, `the disarm step reds a push: ${r.err}`).toBe(0);

    const contradiction = run(buildDisarmScript(), {
      [AI_REVIEW_DISARM_WAIVED_VAR]: "true",
      // No pull request number: a state nothing can produce, which the step
      // refuses rather than resolving by picking the harmless half.
    });
    expect(
      contradiction.code,
      "a waiver with no pull request stopped refusing — the push branch widened something it should not",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("the changed-files step exits 0 when the restore published no base", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-1469-cf-"));
    try {
      const r = runIn(dir, buildChangedFilesScript(), {
        [AI_REVIEW_CHANGED_FILES_PATH_VAR]: join(dir, "changed.txt"),
        [AI_REVIEW_BASE_REMOTE_VAR]: "",
      });
      expect(r.code, `the changed-files step reds a push: ${r.err}`).toBe(0);
      expect(r.err, "the step wrote no list and said nothing about it").toContain("::warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1469 AC-10: the committed job hands the event name to every step that needs it", () => {
  test("the restore step reads github.event_name, and its base ref gained no third alternative", () => {
    const step = (committed().jobs[AI_REVIEW_JOB].steps as any[]).find(s => s?.id === AI_REVIEW_RESTORE_STEP_ID);
    expect(step, "the committed workflow has no restore step").toBeDefined();
    expect(String(step.env?.[AI_REVIEW_EVENT_VAR] ?? "")).toBe("${{ github.event_name }}");

    // The cheapest wrong fix, refused in the committed file rather than only
    // in the script: `|| github.ref_name` would make the refusal stop firing
    // and fetch a ref that may have moved past the commit being built.
    const binding = String(step.env?.[AI_REVIEW_BASE_REF_VAR] ?? "");
    expect(binding, "a third base-ref alternative was added — a push would restore from an invented ref")
      .toBe("${{ github.event.pull_request.base.ref || github.event.merge_group.base_ref }}");
  });

  test("no step gained an `if:`, so the check cannot report skipped", () => {
    // #867's standing rule, restated because a step-level `if:` is the
    // obvious way to keep the review action off a push and it is the wrong
    // one: a skipped required check can be configured as satisfied.
    const job = committed().jobs[AI_REVIEW_JOB];
    expect(job.if, "a job-level if: would report `skipped`").toBeUndefined();
    for (const step of job.steps as any[]) {
      expect(step.if, `step ${step.id ?? step.name} carries an if:`).toBeUndefined();
    }
  });

  test("the push test is spelled exactly once per generated script", () => {
    // One site to mutate. A second copy in any one script would survive a
    // battery aimed at the first and hold the case up —
    // `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape.
    for (const [name, script] of [
      ["report", buildReviewRunScript(FIXTURE_VERSION)],
      ["rounds", buildRoundsScript()],
      ["carry", buildCarryScript()],
      ["restore", buildRestoreScript()],
    ] as const) {
      const hits = script.split("\n").filter(l => /^if \[ "\$\{AI_REVIEW_EVENT:-\}" = push \]; then$/.test(l));
      expect(hits.length, `${name} spells the push test ${hits.length} times, not once`).toBe(1);
    }
  });
});
