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
  AI_REVIEW_JOB,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_RESTORE_STEP_ID,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildRestoreScript,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";

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
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
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
        PATH: process.env.PATH ?? "/usr/bin:/bin",
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
      const r = runIn(dir, buildRestoreScript(), {
        [AI_REVIEW_BASE_REF_VAR]: "refs/heads/main",
        GITHUB_TOKEN: "x",
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
      const r = runIn(dir, buildRestoreScript(), {
        [AI_REVIEW_BASE_REF_VAR]: "main",
        GITHUB_TOKEN: "x",
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
    const r = run(buildReviewRunScript(), { ...PR_ENV, [AI_REVIEW_EVENT_VAR]: "merge_group" });
    expect(r.code, "a queue entry reds even with the trigger present — the queue never drains").toBe(0);
    // Loud, not silent. A bare `exit 0` would pass this file's exit-code
    // assertion while being exactly the quiet green check #630 refuses.
    expect(r.out, "the run passed in silence").toContain("::notice");
    expect(r.out).toContain("merge_group");
  });

  test("the pass is NARROW: the same environment on a pull request still refuses", () => {
    // The control, and the one that matters most. If the merge-group branch
    // were written as a catch-all — or keyed on something a pull request also
    // satisfies — it would turn every UNMEASURED pull request green, which is
    // a far worse defect than the hang this issue is about.
    const r = run(buildReviewRunScript(), { ...PR_ENV, [AI_REVIEW_EVENT_VAR]: "pull_request" });
    expect(r.code, "the merge-group pass leaked onto pull_request").not.toBe(0);
    expect(r.err).toContain("UNMEASURED");
  });

  test("an absent event name is treated as a pull request, not as a queue entry", () => {
    // Silent Default Substitution, in the direction that matters. An unset
    // variable must not reach the branch that exits 0 — a step that failed to
    // receive its environment would otherwise report a passing review.
    const r = run(buildReviewRunScript(), PR_ENV);
    expect(r.code, "an unset event name took the passing branch").not.toBe(0);
  });
});
