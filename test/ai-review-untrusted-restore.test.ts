/**
 * #836: the ai-review drift check blamed the reviewer for the harness's own
 * untrusted-path restore.
 *
 * ## What was wrong, measured on a real run
 *
 * PR #815, run 39500604342. The baseline step reads the tree at 21:28:21.
 * `anthropics/claude-code-action` restores `.claude`, `.mcp.json`,
 * `.claude.json`, `.gitmodules`, `.ripgreprc`, `CLAUDE.md`,
 * `CLAUDE.local.md` and `.husky` from `origin/main` at 21:28:36. The
 * reviewer starts at 21:28:41 and the drift step compares the two readings
 * at 21:35:45, correctly reporting a difference and incorrectly attributing
 * it to the only thing that ran in between:
 *
 *   > ##[error]The reviewer modified the tree it was reviewing:  M
 *   > .claude/rules/self-referential-tests.md
 *
 * That file is one the pull request legitimately owned. Every PR touching
 * `.claude/` failed a check about something the reviewer never did, with a
 * message pointing away from the cause — so the natural responses are to
 * debug the reviewer or relax its write deny, and both are wrong.
 *
 * ## The fix is an ORDER, which is why the instrument here is a PAIR
 *
 * The harness now performs the same restore itself, in a step whose id is
 * strictly before the baseline step's. The restore's edits land in the
 * baseline, where they cancel, exactly as `google-github-actions/auth`'s
 * credentials file already does. Nothing is excluded and no pattern is
 * widened.
 *
 * A single fixture that restores early and reports no drift proves nothing:
 * a tree nobody changed also reports no drift. So AC-2 and its control vary
 * exactly ONE thing — whether the restore runs before or after the baseline
 * — over the same repository, the same edit and the same scripts
 * (`.claude/rules/checks-must-be-able-to-fail.md`, #585's pair discipline).
 * The late half must be RED, naming the restored file, or the early half is
 * green for a reason that has nothing to do with the fix.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Respell `AI_REVIEW_WORKSPACE_WRITE_DENY` as `Edit(**)`.** What an
 * operator sees is "the reviewer modified the tree", so the 5pm repair is to
 * tighten the deny, and `Edit(**)` reads as the strictly safer spelling of
 * the same rule. Measured against the real CLI it is the spelling that also
 * blocks writes to an `--add-dir` path — which is where the findings payload
 * lives — so the repair converts a false drift failure into a reviewer that
 * silently writes nothing. `permission_denials_count: 2` on the run above is
 * the deny WORKING; the drift report was never about it. AC-6 applies that
 * respelling to a copy of the source and observes it refused.
 *
 * ## What was broken to prove it
 *
 * 26 tests — this file plus `test/ai-review-write-scope.test.ts`, which is
 * counted with it because M2 is about a constant both reason over. Every
 * count predicted before the battery ran, in `/tmp/836-battery/`, and **the
 * baseline row was read before any mutation row.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 26 pass, 0 fail | **26 pass, 0 fail** | — |
 * | M1 the genuinely pre-#836 tree — the step removed from the generator AND the committed workflow | 4 | **4 of 26** | the step id list: `ai-review-restore-untrusted` present against absent |
 * | M2 **the cheapest wrong fix** — the deny respelled `Edit(**)` | 2 | **2 of 26** | the constant's own value |
 * | M3 the step present but emitted AFTER the baseline | 2 | **2 of 26** | the step ORDER; the block text is unchanged, so AC-7 stays green |
 * | M4 the `git rm -rfq --ignore-unmatch` dropped, bare `git checkout` left | 1 | **2 of 26** | a PR commit adding a file inside `.claude/`: the original deletes it, the mutant leaves it for the reviewer |
 * | M5 the fetch-failure refusal's `exit` removed | 1 | **2 of 26** | `AI_REVIEW_BASE_REF=no-such-branch-9401` |
 * | M6 the empty-base-ref refusal's `exit` removed | 1 | **2 of 26**, and it was **1** before the repair below | `AI_REVIEW_BASE_REF=""` |
 * | M7 `.claude` dropped from `AI_REVIEW_UNTRUSTED_PATHS` | 4 | **4 of 26** | the fixture's restored file: back to `BASE` against left as the PR's edit |
 * | M8 the test's own control neutered — the late-restore case restores EARLY | 1 | **1 of 26** | the order the pair varies |
 * | M9 `stepIds` short-circuited to `return []` | 3 | **3 of 26**, and it was **2** before the repair below | the committed workflow text |
 *
 * ### M4 and M5 came back 2 against a predicted 1, and the extra red is the real kind
 *
 * Both mutate text that `buildRestoreScript` emits, so the committed
 * workflow stops being what the generator produces and AC-7's byte-identity
 * case goes red with them. Squarely about the mutated behaviour — AC-7's
 * whole subject is that the committed file came out of the generator — and
 * not a crashing mutant: 24 cases still pass. Every generator-script row
 * carries that +1, which is why it is stated once here rather than filed as
 * noise nine times.
 *
 * ### M6 came back 1, and the one red was the WRONG one
 *
 * The AC-3 refusal case stayed GREEN with the empty-base-ref refusal
 * removed. With an empty ref the script carries on, builds
 * `refs/remotes/origin/`, and the FETCH refusal exits non-zero — so the
 * case was satisfied by the decider it was not pointed at, while its
 * `toContain` assertion still found the message the `echo` above the
 * deleted `exit` still printed. Two deciders that agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape), and the
 * only thing that surfaced it was a row predicted 1 coming back 1 with the
 * wrong name beside it.
 *
 * Repaired by that section's second option — keep both, give each an input
 * only it reaches. The empty-ref case now asserts the refusal happened
 * BEFORE any fetch, which only the early refusal can satisfy. The row is 2.
 *
 * ### M9 came back 2 against a predicted 3, and that one was vacuous
 *
 * AC-7's uniqueness case compared `new Set(ids).size` to `ids.length`. Over
 * a reader returning nothing that is `0 === 0` — an assertion holding
 * vacuously, in a file whose subject is assertions that hold vacuously. It
 * asserts non-emptiness first now, and the row is 3.
 *
 * None of the mutations is left in the tree; all were run and reverted, and
 * `lib/scaffold/ai-review-step.ts`, `.github/workflows/ai-review.yml` and
 * this file were confirmed byte-identical to the measured source afterwards
 * by SHA-256, never by `git checkout --`.
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-6, AC-7 of #836.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_RESTORE_STEP_ID,
  AI_REVIEW_SETUP_BUN_STEP_ID,
  AI_REVIEW_RESTORE_STEP_NAME,
  AI_REVIEW_UNTRUSTED_PATHS,
  AI_REVIEW_WORKSPACE_WRITE_DENY,
  buildBaselineScript,
  buildDriftScript,
  buildRestoreScript,
  buildReviewRunStep,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";
import { actionRef } from "../lib/workflow-actions";
import { BUN_VERSION_FILE, declaredBunVersion, setupBunWith } from "../lib/bun-version";
import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * #1140: these cases are built on real `git` subprocesses and inherit bun's
 * 5000ms default, which was never derived from what they cost. The budget is
 * calibrated on the machine running the suite — see `helpers/git-fixture-budget.ts`
 * for the measurements and the headroom.
 */
setDefaultTimeout(gitFixtureTestTimeout());

const REPO_ROOT = join(import.meta.dir, "..");
const SOURCE = readFileSync(join(REPO_ROOT, "lib/scaffold/ai-review-step.ts"), "utf-8");
const COMMITTED = readFileSync(join(REPO_ROOT, ".github/workflows/ai-review.yml"), "utf-8");

const VERTEX: VertexCiDecision = {
  config: {
    project: "fixture-project",
    region: "global",
    workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/g",
  },
  reason: "fixture",
} as VertexCiDecision;

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

// ── AC-1: the restore runs before the baseline ───────────────────────────

/**
 * The step ids of a job, in file order.
 *
 * Read off the parsed YAML rather than by `indexOf` over the text: the step
 * scripts quote each other's ids in comments and error messages, so a
 * character offset finds a mention and reports it as a position
 * (`.claude/rules/checks-must-be-able-to-fail.md`, #297).
 */
function stepIds(yaml: string): string[] {
  const doc = Bun.YAML.parse(yaml) as any;
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`could not read the ${AI_REVIEW_JOB} job's steps out of the workflow`);
  }
  return steps.map((s: any) => String(s?.id ?? ""));
}

/** The generator's own output, wrapped in just enough YAML to parse. */
function generatedJob(): string {
  const steps = buildReviewRunStep(
    VERTEX,
    {
      checkout: actionRef("actions/checkout"),
      auth: actionRef(GOOGLE_AUTH_ACTION),
      review: actionRef(CLAUDE_CODE_ACTION),
      setupBun: actionRef("oven-sh/setup-bun"),
      setupBunWith: setupBunWith(declaredBunVersion(join(import.meta.dir, "..")), "    "),
    },
    // A fixture version for the adjudicator's `bunx` pin (#1013). This file is
    // about what the restore step restores, and the pin is not part of it.
    "0.0.0-fixture",
  );
  return `name: fixture\non:\n  pull_request:\njobs:\n  ${AI_REVIEW_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
}

describe("AC-1: the restore is a harness-owned step, strictly before the baseline", () => {
  for (const [label, yaml] of [
    ["the generator's own output", generatedJob()],
    ["the committed workflow", COMMITTED],
  ] as const) {
    test(`${label} orders restore before baseline`, () => {
      const ids = stepIds(yaml);
      const at = (id: string) => {
        const i = ids.indexOf(id);
        // Present BEFORE compared. `undefined < n` and a missing step both
        // read as "earlier" in a naive comparison, which is #518's shape:
        // a comparison where one side was deleted reads as a distinction.
        expect(i, `${label} has no step with id ${id}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      expect(at(AI_REVIEW_RESTORE_STEP_ID)).toBeLessThan(at(AI_REVIEW_BASELINE_STEP_ID));
      expect(at(AI_REVIEW_BASELINE_STEP_ID)).toBeLessThan(at(AI_REVIEW_DRIFT_STEP_ID));
    });

    test(`${label} installs bun after the restore and before the baseline`, () => {
      // #1013 review. `setup-bun` reads the bun declaration out of the
      // CHECKOUT, and the bun it installs then runs the findings adjudicator
      // in a credentialed job — so a step that runs before the restore lets
      // the branch under review choose its own reviewer's interpreter.
      // Restoring the file (the case below) buys nothing without this order.
      //
      // The upper bound is #836's, the same one the restore has: anything
      // written into the workspace after the baseline is taken lands in the
      // REVIEWER's column in the drift reading.
      const ids = stepIds(yaml);
      const at = (id: string) => {
        const i = ids.indexOf(id);
        expect(i, `${label} has no step with id ${id}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      expect(
        at(AI_REVIEW_SETUP_BUN_STEP_ID),
        `${label} installs bun before the restore, so the pull request's own ` +
          `${BUN_VERSION_FILE} selects the runtime`,
      ).toBeGreaterThan(at(AI_REVIEW_RESTORE_STEP_ID));
      expect(
        at(AI_REVIEW_SETUP_BUN_STEP_ID),
        `${label} installs bun after the baseline, so its footprint is attributed to the reviewer`,
      ).toBeLessThan(at(AI_REVIEW_BASELINE_STEP_ID));
    });
  }

  test("the step is the harness's own `run:`, not a third-party action", () => {
    const doc = Bun.YAML.parse(COMMITTED) as any;
    const step = (doc.jobs[AI_REVIEW_JOB].steps as any[]).find(
      s => s?.id === AI_REVIEW_RESTORE_STEP_ID,
    );
    expect(step, "the committed workflow has no restore step").toBeDefined();
    expect(step.name).toBe(AI_REVIEW_RESTORE_STEP_NAME);
    expect(step.uses, "the restore is delegated to an action this repo does not own").toBeUndefined();
    expect(String(step.run)).toContain("git checkout");
    // No `if:` anywhere in this job, by the job's own standing rule: a step
    // skipped by `if:` reports `skipped`, and a skipped required check can
    // be treated as satisfied.
    expect(step.if, "the restore carries a condition").toBeUndefined();
    // Both events since #867: the job runs on `merge_group` too, and
    // `pull_request.base.ref` is empty there — which this step refuses. The
    // merge-group reading is asserted in test/ai-review-merge-group.test.ts
    // alongside the normalisation the two spellings need.
    expect(step.env?.[AI_REVIEW_BASE_REF_VAR]).toBe(
      "${{ github.event.pull_request.base.ref || github.event.merge_group.base_ref }}",
    );
  });

  test("#1013 review: the bun declaration is restored, and under the name bun-version.ts declares", () => {
    // `lib/scaffold/ai-review-step.ts` has no relative imports — 27 suites
    // copy it into an `mkdtemp` — so it spells this filename as a literal
    // and cannot read `BUN_VERSION_FILE`. That is a second declaring
    // position for one name, and this is the repair: the literal is compared
    // to the constant, so the two cannot drift apart in silence. A rename in
    // `lib/bun-version.ts` turns this red instead of quietly leaving the
    // ai-review job restoring a file nothing writes.
    expect(
      AI_REVIEW_UNTRUSTED_PATHS,
      `the ai-review job no longer restores ${BUN_VERSION_FILE} from the base, so the branch ` +
        `under review chooses which bun runs the findings adjudicator in a credentialed job`,
    ).toContain(BUN_VERSION_FILE);
  });

  test("every path the action restores is a path this step restores", () => {
    // The log line is quoted in the constant's docblock, and this reads the
    // quote rather than a second list typed here: a hand-copied set would be
    // a second declaring position that agrees with the first by construction.
    const flat = SOURCE.replace(/\n \* {0,3}>? ?/g, " ");
    const quoted = /Restoring ([^\n]+?) from origin\/main/.exec(flat);
    expect(quoted, "the action's own log line is no longer recorded beside the list").not.toBeNull();
    const actionSet = quoted![1]
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    expect(actionSet.length, "the quoted log line parsed to nothing").toBeGreaterThan(5);
    for (const p of actionSet) {
      expect(
        AI_REVIEW_UNTRUSTED_PATHS,
        `${p} is restored by the action and not by this step, so it is restored AFTER the baseline — which is the defect`,
      ).toContain(p);
    }
  });
});

// ── The fixture: a real repository, a real origin, the real scripts ──────

type Run = { code: number; stdout: string; stderr: string };

const GIT_ENV = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const file = join(scratchDir("ai-review-restore-sh-"), "step.sh");
  writeFileSync(file, script);
  const r = Bun.spawnSync(["bash", "-e", file], {
    cwd,
    // A scratch HOME, not the developer's. #843 finding 1 added a
    // `find "$HOME"` to the drift step, so a suite pointed at a real home
    // walks it on every case — non-hermetic, and slow in proportion to
    // something no test controls. That reading has its own file,
    // `test/ai-review-outside-reading.test.ts`, against a home it builds.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratchDir("ai-review-restore-home-"), ...env },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/** The file this repository's own run reported, so the fixture is the case. */
const RESTORED_FILE = ".claude/rules/self-referential-tests.md";

/**
 * A checkout shaped like the one `actions/checkout` leaves on a pull request:
 * detached at the head commit, an `origin` remote, and NO
 * `refs/remotes/origin/<base>` — `fetch-depth: 1` fetches the one ref it was
 * asked for and nothing else. The restore step's fetch is therefore
 * load-bearing: delete it and the `git cat-file` below finds no base.
 */
function checkout(): { work: string } {
  const work = scratchDir("ai-review-restore-work-");
  const origin = scratchDir("ai-review-restore-origin-");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", work, ...a], { env: GIT_ENV() });

  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { env: GIT_ENV() });
  Bun.spawnSync(["git", "-C", work, "config", "user.email", "t@example.invalid"], { env: GIT_ENV() });
  Bun.spawnSync(["git", "-C", work, "config", "user.name", "t"], { env: GIT_ENV() });

  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };
  write("tracked.ts", "export const a = 1;\n");
  write(RESTORED_FILE, "BASE\n");
  write("CLAUDE.md", "BASE\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  Bun.spawnSync(["git", "init", "-q", "--bare", origin], { env: GIT_ENV() });
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  // The pull request's own commit: it edits a file inside the restored set,
  // which is exactly what PR #815 did.
  write(RESTORED_FILE, "THE PULL REQUEST'S OWN EDIT\n");
  git("add", "-A");
  git("commit", "-qm", "head");

  // What the checkout leaves behind, and nothing more.
  git("checkout", "-q", "--detach", "HEAD");
  git("update-ref", "-d", "refs/remotes/origin/main");
  const probe = Bun.spawnSync(["git", "-C", work, "rev-parse", "--verify", "-q", "refs/remotes/origin/main"], {
    env: GIT_ENV(),
  });
  expect(
    probe.exitCode,
    "the fixture already has origin/main, so the restore step's fetch is not load-bearing in it",
  ).not.toBe(0);

  return { work };
}

/**
 * #989 gave this step a second job: publishing the base ref the drift step
 * classifies against. It refuses without somewhere to publish it — the same
 * shape the credential step uses for its deny rule — so the fixture supplies
 * a real `GITHUB_OUTPUT` and reads the ref back out of it.
 */
function runRestore(work: string): Run & { baseRemote: string } {
  const out = join(scratchDir("ai-review-restore-out-"), "github-output");
  writeFileSync(out, "");
  const run = sh(buildRestoreScript(), work, {
    [AI_REVIEW_BASE_REF_VAR]: "main",
    GITHUB_OUTPUT: out,
  });
  const baseRemote = /^base_remote=(.*)$/m.exec(readFileSync(out, "utf-8"))?.[1] ?? "";
  return { ...run, baseRemote };
}

function runBaseline(work: string): { run: Run; path: string } {
  const runnerTemp = scratchDir("ai-review-restore-temp-");
  const out = join(runnerTemp, "github-output");
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), work, { RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: out });
  const path = /^path=(.*)$/m.exec(readFileSync(out, "utf-8"))?.[1] ?? "";
  return { run, path };
}

/**
 * `baseRemote` defaults to the ref the restore step publishes. #989 made the
 * drift step refuse UNMEASURED without it rather than compare against
 * nothing, so a fixture that omitted it would be exercising that refusal and
 * not the comparison.
 */
function runDrift(work: string, before: string, baseRemote = "refs/remotes/origin/main"): Run {
  return sh(buildDriftScript(), work, {
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_TREE_BEFORE: before,
    AI_REVIEW_BASE_REMOTE: baseRemote,
  });
}

// ── AC-2: restored before the baseline, the drift reading is clean ───────

describe("AC-2: the restore lands in the baseline, where it cancels", () => {
  test("restore THEN baseline: no drift, exit 0", () => {
    const { work } = checkout();
    const restored = runRestore(work);
    expect(restored.code, `the restore step refused:\n${restored.stderr}`).toBe(0);

    // The restore really did something, asserted before anything is
    // concluded from the drift reading. Without this the case is green over
    // a restore that is a no-op, which is the whole population of ways a
    // fixture reaches its assertion without the feature (#500).
    expect(readFileSync(join(work, RESTORED_FILE), "utf-8")).toBe("BASE\n");
    const status = Bun.spawnSync(["git", "-C", work, "status", "--porcelain"], { env: GIT_ENV() });
    expect(
      new TextDecoder().decode(status.stdout),
      "the restore left the tree identical to the head commit, so there is nothing for the baseline to absorb",
    ).toContain(RESTORED_FILE);

    const { run: baseline, path } = runBaseline(work);
    expect(baseline.code, `the baseline step refused:\n${baseline.stderr}`).toBe(0);
    expect(path).not.toBe("");

    const drift = runDrift(work, path);
    expect(drift.code, `the drift step refused a tree the reviewer never touched:\n${drift.stderr}`).toBe(0);
    expect(drift.stderr).toBe("");
  });

  test("baseline THEN restore — the defect verbatim — is named as a RESTORE, not as the reviewer", () => {
    // REPOINTED by #989, and the reason is worth stating rather than just
    // editing the expectation.
    //
    // This case used to assert the drift step REFUSES a restore that landed
    // after the baseline, as the control proving #836's reorder is
    // load-bearing. #989 made the drift step classify a changed path by
    // content against the base branch, and the bytes a late restore leaves
    // ARE the base's — so it is now acquitted, correctly: the reviewer did
    // not write them, and saying it did is the misattribution #824 and #851
    // each measured at length.
    //
    // The order is still load-bearing and is still asserted — by
    // `${label} orders restore before baseline` above, over both the
    // generated and the committed workflow. That is the direct reading of
    // the property; this was a behavioural proxy for it, and a proxy that
    // has stopped tracking its subject is a case that passes for the wrong
    // reason. #836's actual subject is what the reviewer READS, which the
    // drift step never measured.
    //
    // What it asserts now is not weaker: the classification must fire, must
    // name the file, and must not call it a reviewer write. Removing the
    // classification turns this red again, in the other direction.
    const { work } = checkout();
    const { run: baseline, path } = runBaseline(work);
    expect(baseline.code, `the baseline step refused:\n${baseline.stderr}`).toBe(0);

    const restored = runRestore(work);
    expect(restored.code, `the restore step refused:\n${restored.stderr}`).toBe(0);

    const drift = runDrift(work, path);
    expect(drift.code, `a restore was blamed on the reviewer:\n${drift.stderr}`).toBe(0);
    expect(drift.stderr, "the restored file is reported as a reviewer write").not.toContain(
      "The reviewer modified the tree it was reviewing",
    );
    expect(
      drift.stdout,
      "the classification did not fire, or fired without naming the file — so this case is green over a tree nothing looked at",
    ).toContain(RESTORED_FILE);
  });

  test("a path the pull request INTRODUCED is removed, not left for the reviewer", () => {
    // `git checkout <base> -- <dir>` alone writes the base's files over the
    // head's and leaves anything the head added inside that directory. The
    // reviewer would then read a rule the base never had, which is the
    // property the restore exists for rather than a tidiness concern.
    const { work } = checkout();
    const added = ".claude/rules/introduced-by-the-pull-request.md";
    writeFileSync(join(work, added), "PR-ONLY\n");
    Bun.spawnSync(["git", "-C", work, "add", "-A"], { env: GIT_ENV() });
    Bun.spawnSync(["git", "-C", work, "commit", "-qm", "add a rule"], { env: GIT_ENV() });

    const restored = runRestore(work);
    expect(restored.code, `the restore step refused:\n${restored.stderr}`).toBe(0);
    expect(
      existsSync(join(work, added)),
      "a file the pull request added inside the restored set survived the restore",
    ).toBe(false);
  });
});

// ── AC-3: a write after the baseline is still refused ────────────────────

describe("AC-3: the drift check still catches the reviewer", () => {
  test("a new file written after the baseline is refused, and the refusal names it", () => {
    const { work } = checkout();
    expect(runRestore(work).code).toBe(0);
    const { run: baseline, path } = runBaseline(work);
    expect(baseline.code, `the baseline step refused:\n${baseline.stderr}`).toBe(0);

    const wrote = "the-reviewer-wrote-this.ts";
    writeFileSync(join(work, wrote), "export const x = 1;\n");

    const drift = runDrift(work, path);
    expect(drift.code, "a file written after the baseline was not reported").not.toBe(0);
    expect(drift.stderr).toContain(wrote);
  });

  /**
   * Two refusals, two cases, and the split is a finding rather than a style
   * choice.
   *
   * The first draft asserted both in one case, and the battery caught it:
   * removing the empty-ref refusal's `exit` was **0 red** on that case.
   * With an empty ref the script carries on, builds
   * `refs/remotes/origin/` and asks git to fetch `+refs/heads/:...`, which
   * fails — so the FETCH refusal exits non-zero and the case is satisfied by
   * the decider it was not pointed at. Two deciders that agree, with no
   * behavioural test able to tell them apart
   * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
   *
   * The fix is the second option that section offers: keep both, and give
   * each an input only it reaches. The empty-ref case asserts the refusal
   * happens BEFORE any fetch is attempted — a property only the early
   * refusal has — and the fetch case asserts the tree is left unrestored.
   */
  test("an empty base ref is refused BEFORE any fetch is attempted", () => {
    // An unrestored head is the input the step exists to replace, so a
    // failure here is UNMEASURED and not clean. Silence, `0` and `{}` are
    // indistinguishable from success (`.claude/rules/config-access.md`).
    const { work } = checkout();
    const noRef = sh(buildRestoreScript(), work, { [AI_REVIEW_BASE_REF_VAR]: "" });
    expect(noRef.code, "an empty base ref was accepted").not.toBe(0);
    expect(noRef.stderr).toContain("the pull request base ref is empty");
    expect(
      noRef.stderr,
      "the empty ref reached the fetch, so this case is satisfied by the fetch refusal " +
        "and says nothing about the one it names",
    ).not.toContain("could not fetch the pull request base");
  });

  test("a base branch that does not exist is refused, and the tree is left unrestored", () => {
    const { work } = checkout();
    const missing = sh(buildRestoreScript(), work, {
      [AI_REVIEW_BASE_REF_VAR]: "no-such-branch-9401",
    });
    expect(missing.code, "a base branch that does not exist was accepted").not.toBe(0);
    // "the base", not "the pull request base": since #867 this step also runs
    // on a merge group, where there is no pull request to name.
    expect(missing.stderr).toContain("could not fetch the base");
    expect(
      missing.stderr,
      "the refusal came from the empty-ref branch, not the fetch",
    ).not.toContain("the pull request base ref is empty");
    expect(readFileSync(join(work, RESTORED_FILE), "utf-8")).toBe(
      "THE PULL REQUEST'S OWN EDIT\n",
    );
  });
});

// ── AC-4 / AC-6: the write deny, measured, and the wrong fix refused ─────

/**
 * The four spellings #836 measured against the real CLI, as data.
 *
 * Keyed by the rule text; the value is what the measurement observed. The
 * absolute form is keyed by its placeholder because its text depends on the
 * runner's workspace path, and `absoluteForm` below maps a real one onto it.
 */
const MEASURED: Record<string, { checkout: "BLOCKED" | "WROTE"; addDir: "BLOCKED" | "WROTE" }> = {
  "Edit(./**)": { checkout: "BLOCKED", addDir: "WROTE" },
  "Edit(**)": { checkout: "BLOCKED", addDir: "BLOCKED" },
  "Edit(*)": { checkout: "WROTE", addDir: "WROTE" },
  "Edit(<abs>/**)": { checkout: "BLOCKED", addDir: "BLOCKED" },
};

/** `Edit(/abs/path/**)` reads as the measured `<abs>` row. */
function measuredKey(deny: string): string {
  return /^Edit\(\/{1,2}[^)]*\)$/.test(deny) ? "Edit(<abs>/**)" : deny;
}

/**
 * The ONE decider for whether a write-deny spelling is usable.
 *
 * Two requirements, and a spelling has to meet both. It must stop the
 * reviewer editing the tree it is reviewing, which is the control's whole
 * purpose; and it must leave the findings payload writable, because the
 * payload lives under `RUNNER_TEMP` and is reached with `--add-dir` — a deny
 * that covers it turns every review into an UNMEASURED with no file.
 *
 * An unmeasured spelling is refused rather than assumed good. `Write(path)`
 * is accepted by the CLI and never consulted, so "it looks right" is exactly
 * the reading this cannot trust.
 */
export function writeDenyViolations(deny: string): string[] {
  const row = MEASURED[measuredKey(deny)];
  if (row === undefined) {
    return [
      `${deny} has never been measured against the CLI. A path rule the CLI accepts and ` +
        `never consults reads as a scoped grant and is worth nothing — measure it and ` +
        `add a row to the table beside AI_REVIEW_WORKSPACE_WRITE_DENY.`,
    ];
  }
  const out: string[] = [];
  if (row.checkout !== "BLOCKED") {
    out.push(`${deny} does not block a write inside the checkout, which is the only thing it is for`);
  }
  if (row.addDir !== "WROTE") {
    out.push(
      `${deny} also blocks a write to an --add-dir path, which is where the findings payload ` +
        `lives — so the reviewer writes nothing and every review reports UNMEASURED`,
    );
  }
  return out;
}

describe("AC-4: the deny is the measured spelling, and the measurement is recorded", () => {
  test("the shipped constant is the one spelling that passes both requirements", () => {
    expect(writeDenyViolations(AI_REVIEW_WORKSPACE_WRITE_DENY)).toEqual([]);
    expect(AI_REVIEW_WORKSPACE_WRITE_DENY).toBe("Edit(./**)");
  });

  test("the decider can refuse, and refuses each of the other three for its own reason", () => {
    // Non-vacuity, plus one reason per row: a decider that refused
    // everything would satisfy the case above's complement without
    // distinguishing anything.
    expect(writeDenyViolations("Edit(**)").join(" ")).toContain("--add-dir");
    expect(writeDenyViolations("Edit(*)").join(" ")).toContain("does not block a write inside the checkout");
    expect(writeDenyViolations("Edit(/home/runner/work/x/x/**)").join(" ")).toContain("--add-dir");
    expect(writeDenyViolations("Edit(src/**)").join(" ")).toContain("never been measured");
  });

  test("the table beside the constant says the same thing this decider does", () => {
    // Two positions holding one measurement is #621's shape. They are not
    // two deciders — the source table decides nothing — but they are two
    // statements, and nothing was comparing them.
    const rows = [...SOURCE.matchAll(/^ \* \| `([^`]+)` \| (BLOCKED|WROTE) \| (BLOCKED|WROTE) \|$/gm)];
    expect(rows.length, "the measurement table is no longer beside the constant").toBe(
      Object.keys(MEASURED).length,
    );
    for (const [, pattern, checkout, addDir] of rows) {
      expect(MEASURED[pattern], `the source table has a row this test does not: ${pattern}`).toEqual({
        checkout: checkout as "BLOCKED",
        addDir: addDir as "WROTE",
      });
    }
  });
});

describe("AC-6: the cheapest wrong fix is applied and observed being refused", () => {
  test("respelling the deny as Edit(**) is refused by the real decider", async () => {
    const needle = `export const AI_REVIEW_WORKSPACE_WRITE_DENY = ${JSON.stringify(
      AI_REVIEW_WORKSPACE_WRITE_DENY,
    )};`;
    const count = SOURCE.split(needle).length - 1;
    if (count !== 1) {
      throw new Error(`could not build the mutant: the declaration appears ${count} times`);
    }
    const path = join(scratchDir("ai-review-deny-mutant-"), "ai-review-step.ts");
    writeFileSync(
      path,
      SOURCE.replace(needle, `export const AI_REVIEW_WORKSPACE_WRITE_DENY = "Edit(**)";`),
    );
    const mutant = (await import(path)) as { AI_REVIEW_WORKSPACE_WRITE_DENY: string };

    // The input on which mutant and original differ, named rather than
    // assumed: the constant's own value.
    expect(mutant.AI_REVIEW_WORKSPACE_WRITE_DENY).toBe("Edit(**)");
    expect(mutant.AI_REVIEW_WORKSPACE_WRITE_DENY).not.toBe(AI_REVIEW_WORKSPACE_WRITE_DENY);

    const violations = writeDenyViolations(mutant.AI_REVIEW_WORKSPACE_WRITE_DENY);
    expect(violations.length, "the wrong fix was accepted").toBeGreaterThan(0);
    expect(violations.join(" ")).toContain("the findings payload");
    // And the real source is clean, in the same case. "The mutant is
    // refused" alone passes over a decider that refuses everything.
    expect(writeDenyViolations(AI_REVIEW_WORKSPACE_WRITE_DENY)).toEqual([]);
  });
});

// ── AC-7: the committed file is generated, not hand-edited ───────────────

describe("AC-7: the committed workflow came out of the generator", () => {
  test("the committed restore step is byte-identical to what the generator emits", () => {
    const lines = buildRestoreScript().trimEnd().split("\n");
    const indented = lines.map(l => (l ? `          ${l}` : "")).join("\n");
    expect(
      COMMITTED,
      "the committed workflow's restore step is not the generator's output — it was hand-edited, " +
        "or the file was not regenerated after the generator changed",
    ).toContain(indented);
  });

  test("the generated job's step ids are unique, so the order assertions mean something", () => {
    const ids = stepIds(COMMITTED).filter(Boolean);
    // Non-emptiness FIRST. `new Set([]).size === [].length` is 0 === 0, so
    // the uniqueness claim below holds vacuously over a reader that returned
    // nothing — which is what the battery's M9 row does, and it measured 2
    // against a predicted 3 until this line existed.
    expect(ids.length, "the step-id reader returned nothing, so uniqueness is vacuous").toBeGreaterThan(4);
    expect(new Set(ids).size, `duplicate step ids: ${ids.join(", ")}`).toBe(ids.length);
  });
});
