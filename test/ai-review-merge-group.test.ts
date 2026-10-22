/**
 * #867: `ai-review` has to be satisfiable as a required check under a merge
 * queue, and adding the trigger alone does not achieve that.
 *
 * `test/merge-group-trigger.test.ts` covers the trigger itself (SC-A, SC-C,
 * SC-D) across every generated workflow. This file covers the three ways the
 * fix can be half-done — the ways that leave the queue broken while the YAML
 * reads as correct.
 *
 * ## What was MEASURED about the action, not assumed (SC-E, SC-F)
 *
 * Read from `anthropics/claude-code-action` at the SHA `lib/claude-code-action.ts`
 * pins (`5eb090f3c3afd701a0672cd32981197ca27688f6`, `v1`), not from its README:
 *
 * - `src/github/context.ts` → `parseGitHubContext()` switches on
 *   `context.eventName` and its `default:` branch is
 *   `throw new Error("Unsupported event type: " + eventName)`. `merge_group`
 *   appears in neither `ENTITY_EVENT_NAMES` nor `AUTOMATION_EVENT_NAMES`, so
 *   **the action throws on a merge group before it does anything else.** It is
 *   still absent from both lists on the action's `main` today, and `v1` is the
 *   latest release, so there is no version to bump to that would change this.
 * - `src/entrypoints/prepare.ts` calls `parseGitHubContext()` FIRST, then
 *   `detectMode()`, and only then `setupGitHubToken()`.
 * - The workflow-validation guard (SC-F) lives in `src/github/token.ts`: it is
 *   raised as `WorkflowValidationSkipError` from the app-token exchange when
 *   the response carries error code `workflow_not_found_on_default_branch`.
 *
 * **SC-F, answered.** The guard does NOT fire on every queue entry, and on
 * this pinned SHA it cannot fire on a queue entry at all, for two independent
 * reasons. First, `parseGitHubContext()` throws before `setupGitHubToken()` is
 * ever reached. Second, even if it were reached, the guard keys on the
 * workflow FILE being absent from the default branch — not on the candidate
 * ref being ahead of it, which a queue ref always is by construction. A queue
 * entry whose pull requests do not touch `ai-review.yml` presents a file
 * identical to the default branch's copy. So SC-F's worry — a guard that
 * refuses every queue entry — is not what happens; what happens is the
 * unsupported-event throw, which is why the job cannot review on this event
 * and must say so rather than pretend.
 *
 * ## The verdict this produces, and why it is not a green check for nothing
 *
 * The job reports `success` on `merge_group` without having reviewed. That is
 * the shape #630 exists to refuse, so it is load-bearing that the reasoning is
 * different here:
 *
 * - A pull request cannot ENTER a merge queue without satisfying its required
 *   checks. If `ai-review` is required — which is the entire premise of #867 —
 *   then it already ran, on that exact head commit, and reported green.
 * - So the queue entry's honest verdict is "already reviewed", not "never
 *   reviewed". #630's defect was a FIRST review silently not happening; this
 *   is a second review that cannot happen and does not need to.
 * - It is narrow and unforgeable: the branch is taken on `github.event_name`,
 *   which the runner sets, and not on a repository variable or an input.
 * - It is loud. A `::notice::` names the event and the reason, so the run says
 *   what it did rather than exiting 0 in silence.
 *
 * ## The cheapest wrong fix, named
 *
 * Add `merge_group:` to the `on:` block and stop. The queue then does not
 * hang — it goes RED on every entry, at the untrusted-path restore step, which
 * refuses when the base ref is empty and `github.event.pull_request.base.ref`
 * is empty on a merge group. Every case in the SC-E describe below stays red
 * under that fix.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_EVENT_VAR,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_RESTORE_STEP_ID,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildRestoreScript,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunxAbsent } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin (#1013), never the
 * real one. `buildReviewRunScript` takes the generating version as an
 * argument; passing `harnessVersion()` here would make every assertion
 * below agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";


/**
 * The workflow this repository actually commits, parsed.
 *
 * The committed file and not a generated fixture, because the thing a merge
 * queue reads is the file on the ref — a generator that emits the trigger into
 * a temp directory while this repo's own copy stays stale would satisfy a
 * fixture-based case and still hang the queue here. `merge-group-trigger.test.ts`
 * holds the generator-side reading; this is the other half.
 */
function aiReviewWorkflow(): any {
  return Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
  );
}

/** Run one generated script in `dir` under a chosen environment. */
function runIn(dir: string, script: string, env: Record<string, string>) {
  const path = join(dir, "script.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", path], {
    cwd: dir,
    env: { PATH: stubBunxAbsent(), HOME: dir, ...env },
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

/** Run one generated script under a chosen environment, as the runner would. */
function run(script: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "rg-867-"));
  try {
    return runIn(dir, script, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A work tree with a real `origin` carrying `main`, so the restore script's
 * fetch refspec is exercised rather than described.
 */
function gitFixture(): { dir: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-867-git-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        PATH: stubBunxAbsent(),
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };

  mkdirSync(work, { recursive: true });
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--initial-branch=main", work]);
  // One of the untrusted paths, so the restore loop has something to do and a
  // silently empty loop cannot be mistaken for a working restore.
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude", "rule.md"), "base\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "origin", "main"]);
  return { dir: work, origin };
}

describe("#867 SC-B: the check reports the same context name on both events", () => {
  // A merge queue satisfies a required context by NAME. GitHub derives the
  // check name from the job, so a job keyed differently — or carrying a `name:`
  // that interpolates the event — would report `ai-review (merge group)` on the
  // queue and leave the required `ai-review` unreported. That is the identical
  // hang with extra steps, and it is invisible in a diff that only adds a
  // trigger.
  test("one job, keyed ai-review, with no event-dependent name", () => {
    const doc = aiReviewWorkflow();
    expect(Object.keys(doc.jobs), "the workflow no longer has exactly one job").toEqual([AI_REVIEW_JOB]);

    const job = doc.jobs[AI_REVIEW_JOB];
    // A `name:` here would override the context derived from the key. Absent
    // is correct; present-and-constant would also work, so the assertion is
    // on what it must NOT be rather than on absence alone.
    if (job.name !== undefined) {
      expect(String(job.name), "the job name varies with the event").not.toContain("${{");
    }
  });

  test("the job carries no `if:`, so the queue cannot read it as skipped", () => {
    // The standing rule of this job, restated for the event that makes it
    // matter most: a skipped required check can be configured as satisfied,
    // and on a queue entry that would merge an unreviewed ref.
    const job = aiReviewWorkflow().jobs[AI_REVIEW_JOB];
    expect(job.if, "a job-level if: would report `skipped` to the queue").toBeUndefined();
    for (const step of job.steps as any[]) {
      expect(step.if, `step ${step.id ?? step.name} carries an if:`).toBeUndefined();
    }
  });
});

describe("#867 SC-E: the PR-shaped readings resolve on a merge group", () => {
  // THE cheapest wrong fix's landing place. `github.event.pull_request.base.ref`
  // is empty on a merge group, and the restore step refuses on an empty base
  // ref — correctly, because an unrestored head is the input it exists to
  // replace. So a trigger added without this binding turns the silent hang
  // into a red check on every queue entry.
  test("the restore step reads a base ref that both events supply", () => {
    const step = (aiReviewWorkflow().jobs[AI_REVIEW_JOB].steps as any[]).find(
      s => s?.id === AI_REVIEW_RESTORE_STEP_ID,
    );
    expect(step, "the committed workflow has no restore step").toBeDefined();
    const binding = String(step.env?.[AI_REVIEW_BASE_REF_VAR] ?? "");
    expect(binding, "the base ref is still pull-request-only — every queue entry would refuse")
      .toContain("github.event.merge_group.base_ref");
    expect(binding, "the pull request reading was dropped").toContain("github.event.pull_request.base.ref");
  });

  // The two payloads spell the ref differently: a pull request's
  // `base.ref` is a bare branch name (`main`), a merge group's `base_ref` is
  // fully qualified (`refs/heads/main`). The fetch refspec builds
  // `+refs/heads/<ref>:refs/remotes/origin/<ref>`, so the qualified form would
  // produce `refs/heads/refs/heads/main` and fail the fetch — a red queue
  // again, one layer further in.
  test("a fully-qualified merge-group base ref is normalised before it is used", () => {
    // Run against a REAL remote, not against the error message. An assertion
    // that only greps the failure text for `refs/heads/refs/heads/` passes
    // before the fix as well as after — the unfixed script fails its fetch for
    // want of a remote and echoes the ref it was handed, which contains no
    // doubled prefix. Measured: that form of this case was green on the
    // unfixed tree. So the fetch has to actually be attempted and succeed.
    const { dir, origin } = gitFixture();
    try {
      // #989: the step publishes the base ref for the drift step and
      // refuses without somewhere to publish it.
      const outFile = join(dir, "github-output");
      writeFileSync(outFile, "");
      const r = runIn(dir, buildRestoreScript(), {
        [AI_REVIEW_BASE_REF_VAR]: "refs/heads/main",
        GITHUB_TOKEN: "x",
        GITHUB_OUTPUT: outFile,
      });
      expect(
        r.code,
        `the qualified ref was passed through to the refspec — the fetch from ${origin} failed: ${r.err}`,
      ).toBe(0);
      expect(r.out, "the restore did not report the base it restored from").toContain("origin/main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bare pull-request base ref still works, so normalisation is not a rewrite", () => {
    // The other direction. Stripping must be conditional on the prefix being
    // there; a blind `cut`/`basename` would mangle a bare `main` or a branch
    // with a slash in its name, and only this case would see it.
    const { dir } = gitFixture();
    try {
      // #989: the step publishes the base ref for the drift step and
      // refuses without somewhere to publish it.
      const outFile = join(dir, "github-output");
      writeFileSync(outFile, "");
      const r = runIn(dir, buildRestoreScript(), {
        [AI_REVIEW_BASE_REF_VAR]: "main",
        GITHUB_TOKEN: "x",
        GITHUB_OUTPUT: outFile,
      });
      expect(r.code, `a bare base ref stopped working: ${r.err}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty base ref still refuses, on both events", () => {
    // The normalisation must not become a way to continue with nothing. This
    // is the control: if stripping were implemented as a silent default, this
    // case would go green and the refusal would be gone.
    const r = run(buildRestoreScript(), { [AI_REVIEW_BASE_REF_VAR]: "" });
    expect(r.code, "an empty base ref was accepted").not.toBe(0);
    expect(r.err).toContain("UNMEASURED");
  });
});

describe("#867 SC-E/SC-F: the report step reaches a measured verdict on a queue entry", () => {
  const PR_ENV = {
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "failure",
    [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE,
  };

  test("the report step is handed the event name", () => {
    const step = (aiReviewWorkflow().jobs[AI_REVIEW_JOB].steps as any[]).find(
      s => s?.id === AI_REVIEW_RUN_STEP_ID,
    );
    expect(step, "the committed workflow has no report step").toBeDefined();
    expect(String(step.env?.[AI_REVIEW_EVENT_VAR] ?? "")).toBe("${{ github.event_name }}");
  });

  test("on merge_group the check passes, and SAYS it reviewed nothing", () => {
    // #939 narrowed the subject of this case. It was written with `PR_ENV`,
    // which sets ${AI_REVIEW_REQUIRE_VAR} — and so it asserted that a
    // consumer who had explicitly asked to be failed on an unreviewed ref was
    // passed anyway. That was the defect, asserted as the contract. The
    // passing verdict is the DEFAULT, so the default is what this case now
    // holds; the flagged consumer is `#939` below.
    const r = run(buildReviewRunScript(FIXTURE_VERSION), {
      ...PR_ENV,
      [AI_REVIEW_REQUIRE_VAR]: "",
      [AI_REVIEW_EVENT_VAR]: "merge_group",
    });
    expect(r.code, "a queue entry reds even with the trigger present — the queue never drains").toBe(0);
    // Loud, not silent. A bare `exit 0` would pass this file's exit-code
    // assertion while being exactly the quiet green check #630 refuses.
    // `::warning` and not `::notice` since #939: nothing read this ref, and an
    // unmeasured result is named as unmeasured rather than reported as clean.
    expect(r.out, "the run passed in silence").toContain("::warning");
    expect(
      r.out,
      "the queue entry is still annotated `::notice` as well — an unmeasured ref " +
        "reported at two severities at once, and GitHub shows the quieter one",
    ).not.toContain("::notice");
    expect(r.out).toContain("merge_group");
  });

  test("the pass is NARROW: the same environment on a pull request still refuses", () => {
    // The control, and the one that matters most. If the merge-group branch
    // were written as a catch-all — or keyed on something a pull request also
    // satisfies — it would turn every UNMEASURED pull request green, which is
    // a far worse defect than the hang this issue is about.
    const r = run(buildReviewRunScript(FIXTURE_VERSION), { ...PR_ENV, [AI_REVIEW_EVENT_VAR]: "pull_request" });
    expect(r.code, "the merge-group pass leaked onto pull_request").not.toBe(0);
    expect(r.err).toContain("UNMEASURED");
  });

  test("an absent event name is treated as a pull request, not as a queue entry", () => {
    // Silent Default Substitution, in the direction that matters. An unset
    // variable must not reach the branch that exits 0 — a step that failed to
    // receive its environment would otherwise report a passing review.
    const r = run(buildReviewRunScript(FIXTURE_VERSION), PR_ENV);
    expect(r.code, "an unset event name took the passing branch").not.toBe(0);
  });
});

/**
 * #939: the `merge_group` short-circuit sat ABOVE every
 * `RUNGATE_REQUIRE_AI_REVIEW` refusal in the same script, so the one knob
 * whose entire purpose is "refuse rather than pass when the review did not
 * happen" was inert on the one event where the review is KNOWN not to have
 * run. A guard that cannot fail.
 *
 * The fix is not the one the issue proposes literally. The issue says move
 * the branch below the refusals; measured, that is worse. On `merge_group`
 * the action throws `Unsupported event type` before producing an outcome, so
 * none of the readings below the branch can hold: a queue entry falling
 * through reaches the `pending` tail and is refused with a message that
 * names a cause this job did not measure ("the review action has not
 * reported yet"), losing the one cause it did measure. The branch keeps its
 * position; the flag check moved INTO it.
 *
 * ## Not a second decider
 *
 * "Has this consumer asked to be failed on an unreviewed ref" is spelled four
 * times in `buildReviewRunScript` already, once per reading. This is the
 * fifth spelling of the SAME decider, not a second one: same variable, same
 * `=` against the same `AI_REVIEW_REQUIRE_VALUE`, same
 * `AI_REVIEW_REQUIRED_EXIT`. `#939 fence` below is what keeps that true — it
 * runs every no-verdict route the script has through one table, so a sixth
 * branch added above without the check reds here rather than reintroducing
 * this issue.
 *
 * ## Routed through the constant, and which case reds on a literal
 *
 * The refusal emits `exit ${AI_REVIEW_REQUIRED_EXIT}`, not `exit 1`. A
 * literal would survive `test/ai-review-scaffold.test.ts`'s mutant — which
 * rewrites the constant to 0 — and the refusal case would then pass having
 * witnessed nothing. The case that reds on a literal is **AC-6b "no refusal
 * inlines a non-zero exit literal"** in that file: it reads every `exit` out
 * of the module source and requires `0` or the interpolated constant.
 * Measured on this branch by writing `exit 1` into the new refusal: AC-6b
 * failed with ``exit 1` bypasses AI_REVIEW_REQUIRED_EXIT`, and the three
 * cases below stayed green — which is exactly why they delegate to it rather
 * than restating it with a sixth local mutant harness. The exit assertions
 * here read `AI_REVIEW_REQUIRED_EXIT` rather than the number `1`, so they
 * follow the constant if it ever changes.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A real merge queue.** No merge queue exists on this account (#770), so
 *   `merge_group` cannot fire on any of the three repositories. Everything
 *   here runs the generated script directly with the event name set, which
 *   proves the script's behaviour and NOT that GitHub reaches it. #867's
 *   SC-G remains open and this does not close it. The escape is asserted one
 *   layer out instead: "the report step is handed the event name" above
 *   reads the committed workflow's `env:` binding to `github.event_name`.
 * - **`AI_REVIEW_MODE=none`.** That route exits 0 here regardless of the
 *   flag, and the fence below excludes it. It is NOT an instance of this
 *   defect: the refusal for a missing credential belongs to the auth step,
 *   which refuses before this step runs
 *   (`test/ai-review-scaffold.test.ts` AC-6, "the string true with no
 *   credential exits non-zero"). Re-asserting it here would be the second
 *   decider this file is about. That the auth step's refusal actually stops
 *   the job — rather than being skipped past — is asserted by "the job
 *   carries no `if:`" above.
 * - **The batch argument itself.** The refusal message claims a merge queue
 *   builds a tree no reviewer has read. That is reasoning about GitHub's
 *   semantics, not a measurement, and nothing here tests it.
 * - **Whether a consumer SHOULD set the flag.** Unchanged default: with the
 *   flag unset the queue drains, which is the case above.
 */
describe("#939: the merge_group pass is a default, and the fail-closed flag overrides it", () => {
  const QUEUE_ENV = {
    AI_REVIEW_MODE: "vertex",
    // What the action leaves behind on this event: it threw on the unsupported
    // event name before it could run, so the step is a failure with no
    // findings payload and no execution file.
    AI_REVIEW_ACTION_OUTCOME: "failure",
    [AI_REVIEW_EVENT_VAR]: "merge_group",
  };

  test("#939: a queue entry refuses when RUNGATE_REQUIRE_AI_REVIEW is set", () => {
    const r = run(buildReviewRunScript(FIXTURE_VERSION), {
      ...QUEUE_ENV,
      [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE,
    });

    // Reds on the tree this was written against: the branch exited 0 with an
    // empty stderr whatever the flag held.
    expect(
      r.code,
      `the fail-closed flag is still inert on ${"merge_group"}\n${r.out}${r.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.err, "the refusal was not annotated as an error").toContain("::error");

    // Reds on the cheapest wrong fix — deleting the branch, or moving it
    // below the readings — which refuses with the generic `pending` tail. The
    // exit code is identical under that fix, so the code assertion above
    // cannot see it; only the message can. It must name the event it refused
    // on and the knob that made it refuse.
    expect(r.err, "the refusal does not say which event it refused on").toContain("merge_group");
    expect(r.err, "the refusal does not name the knob that caused it").toContain(AI_REVIEW_REQUIRE_VAR);
    expect(
      r.err,
      "the refusal reports a cause this job did not measure — the queue entry " +
        "fell through to a reading rather than being refused by its own branch",
    ).not.toContain("has not reported");
  });

  test("#939: the refusal is NARROW — any other value of the flag still drains the queue", () => {
    // The control, and the one that matters most here. A merge queue that
    // reds on every entry never drains, and the repair for that is to stop
    // requiring the check — strictly worse than the fail-open this fixes. So
    // the refusal must key on exactly the same string the other four
    // readings do. Each row reds on a looser comparison: `!= false` reds on
    // `false`, a case-insensitive match reds on `TRUE`, a truthiness test
    // reds on `1` and `yes`, an unquoted/trimmed compare reds on `true `.
    const script = buildReviewRunScript(FIXTURE_VERSION);
    for (const [label, value] of [
      ["unset", undefined],
      ["empty", ""],
      ["TRUE", "TRUE"],
      ["True", "True"],
      ["1", "1"],
      ["yes", "yes"],
      ["false", "false"],
      ["true with a trailing space", "true "],
    ] as Array<[string, string | undefined]>) {
      const r = run(script, {
        ...QUEUE_ENV,
        ...(value === undefined ? {} : { [AI_REVIEW_REQUIRE_VAR]: value }),
      });
      expect(r.code, `${AI_REVIEW_REQUIRE_VAR}=${label} hung the merge queue\n${r.err}`).toBe(0);
    }
  });

  test("#939 fence: no route through the report step exits 0 while the flag is set", () => {
    // Today only the first row reds without the fix; the rest already
    // refused, so they are instrument control — they prove the table reaches
    // each route rather than testing one route five times. The fence is for
    // the NEXT branch: a short-circuit added above these, for any future
    // event the action cannot parse, reds here instead of shipping #939
    // again.
    //
    // `AI_REVIEW_MODE=none` is deliberately absent — see WHAT THIS DOES NOT
    // COVER. Every row below leaves the job with no verdict on the ref.
    const script = buildReviewRunScript(FIXTURE_VERSION);
    const dir = mkdtempSync(join(tmpdir(), "rg-939-"));
    try {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, '{"findings":[]}\n');
      const unreadable = join(dir, "no-such-execution-file.json");

      const routes: Array<[string, Record<string, string>]> = [
        ["a merge_group queue entry", QUEUE_ENV],
        ["no mode output at all", { [AI_REVIEW_EVENT_VAR]: "pull_request" }],
        [
          "the action failed",
          { [AI_REVIEW_EVENT_VAR]: "pull_request", AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "failure" },
        ],
        [
          "the action succeeded and wrote no payload",
          { [AI_REVIEW_EVENT_VAR]: "pull_request", AI_REVIEW_MODE: "vertex", AI_REVIEW_ACTION_OUTCOME: "success" },
        ],
        [
          "the action succeeded, wrote no payload, and named an unreadable execution file",
          {
            [AI_REVIEW_EVENT_VAR]: "pull_request",
            AI_REVIEW_MODE: "vertex",
            AI_REVIEW_ACTION_OUTCOME: "success",
            [AI_REVIEW_EXECUTION_FILE_VAR]: unreadable,
          },
        ],
        [
          "the action wrote a findings payload nobody adjudicated",
          {
            [AI_REVIEW_EVENT_VAR]: "pull_request",
            AI_REVIEW_MODE: "vertex",
            AI_REVIEW_ACTION_OUTCOME: "success",
            [AI_REVIEW_FINDINGS_PATH_VAR]: findings,
          },
        ],
      ];

      // The coverage control. Two assertions that both read an empty list
      // agree with each other and with nothing else; this is what reds if a
      // rewrite empties the table.
      expect(routes.length, "the route table is empty, so this case measured nothing").toBe(6);

      for (const [label, env] of routes) {
        const r = runIn(dir, script, { ...env, [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE });
        expect(
          r.code,
          `${AI_REVIEW_REQUIRE_VAR} is '${AI_REVIEW_REQUIRE_VALUE}' and ${label} ` +
            `exited 0 — a green check for a ref nothing reviewed\n${r.out}${r.err}`,
        ).toBe(AI_REVIEW_REQUIRED_EXIT);
        expect(r.err, `${label} refused without saying so on stderr`).toContain("::error");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
