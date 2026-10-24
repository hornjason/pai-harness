import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { actionRef } from "../lib/workflow-actions";
import { declaredBunVersion, setupBunWith } from "../lib/bun-version";
import { CLAUDE_CODE_ACTION } from "../lib/claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../lib/google-auth-action";
import {
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_BASE_REMOTE_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_CHANGED_FILES_BASENAME,
  AI_REVIEW_CHANGED_FILES_PATH_VAR,
  AI_REVIEW_CHANGED_FILES_STEP_ID,
  AI_REVIEW_CHANGED_FILES_STEP_NAME,
  AI_REVIEW_CHANGED_FILES_TITLE,
  AI_REVIEW_FINDINGS_COMMAND,
  AI_REVIEW_FINDINGS_DIR_OUTPUT,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_PREPARE_STEP_ID,
  AI_REVIEW_RESTORE_STEP_ID,
  buildChangedFilesScript,
  buildReviewRunScript,
  buildReviewRunStep,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";

/**
 * Covers #1356 — nothing supplied the changed-file list the adjudicator
 * accepts, so the scope reading was `NOT_SUPPLIED` on every run that has ever
 * executed and the demotion has never fired.
 *
 * ## What this issue is NOT, and the split is deliberate
 *
 * **Phase 1, here: the generated job writes the list and hands it over.**
 * Every property that can be witnessed from this tree is witnessed here — the
 * step's position, where it writes, what it does when `git diff` fails, and
 * that the path reaching the adjudicator is the same constant the writer
 * used.
 *
 * **Phase 2, not here: the end-to-end case.** The generated step runs
 * `bunx rungate@<generating version>`, and npm serves `0.8.2` from the
 * `v0.8.2` tag. The adjudicator in that release reads `argv[0]` and nothing
 * else (measured: `git show v0.8.2:lib/scaffold/ai-review-findings.ts`), so a
 * second positional is a no-op there — which is what makes shipping this
 * safe, and also what makes the end-to-end case unobservable until a release
 * carries the reading half. A step asserting it today would go green having
 * observed nothing, which is the whole defect class this module is about.
 *
 * So this file does not claim the gate fires in production. It claims the
 * input now exists, is taken from the right tree, and is handed over
 * correctly.
 *
 * ## Why the list must come from the RESTORED tree
 *
 * The reviewer can write to the checkout — that is why the drift step exists.
 * A diff taken after the review is a diff the subject of the review had an
 * opportunity to edit. `test/ai-review-finding-scope.test.ts` AC-10 holds the
 * adjudicator to never computing it; CF-1 here holds the JOB to taking it
 * before the reviewer runs.
 */

const SCRATCH: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(d);
  return d;
}
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

const REPO_ROOT = join(import.meta.dir, "..");
const STEP = buildChangedFilesScript();

const VERTEX = {
  config: {
    project: "fixture-project",
    region: "global",
    workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/g",
  },
  reason: "fixture",
} as VertexCiDecision;

const JOB = buildReviewRunStep(
  VERTEX,
  {
    checkout: actionRef("actions/checkout"),
    auth: actionRef(GOOGLE_AUTH_ACTION),
    review: actionRef(CLAUDE_CODE_ACTION),
    setupBun: actionRef("oven-sh/setup-bun"),
    setupBunWith: setupBunWith(declaredBunVersion(REPO_ROOT), "    "),
    uploadArtifact: actionRef("actions/upload-artifact"),
  },
  "0.0.0-fixture",
);

const JOB_YAML = `name: fixture\non:\n  pull_request:\njobs:\n  ${AI_REVIEW_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n${JOB}`;

/**
 * The step ids of the generated job, IN FILE ORDER, read off the parsed YAML.
 *
 * Never by `indexOf` over the text. The step scripts quote each other's ids
 * in comments and error messages, so a character offset finds a MENTION and
 * reports it as a position — #297, and the comment this step's own script
 * carries about its ordering would have been the first thing to fool it.
 */
function stepIds(yaml: string): string[] {
  const doc = Bun.YAML.parse(yaml) as Record<string, any>;
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`could not read the ${AI_REVIEW_JOB} job's steps out of the workflow`);
  }
  return steps.map((s: any) => String(s?.id ?? ""));
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

interface Fixture {
  work: string;
  dest: string;
  base: string;
}

/**
 * A checkout shaped the way `actions/checkout` leaves one on a
 * `pull_request`: HEAD is the MERGE ref, so main is already in it, and the
 * base is a ref this job fetched at `--depth=1`.
 *
 * Shallow on BOTH sides is the fixture's whole point. There is no merge base
 * to compute, so a `base...HEAD` three-dot diff would fail here exactly as it
 * fails on a runner — which is why the step uses the two-dot form, and why
 * this fixture must not be a full clone that would hide the difference.
 */
function checkout(): Fixture {
  const root = scratchDir("ai-review-cf-");
  const work = join(root, "repo");
  const runnerTemp = join(root, "_temp");
  mkdirSync(work, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", work, ...a], { env: GIT_ENV() });
    if (r.exitCode !== 0) {
      throw new Error(`git ${a.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { env: GIT_ENV() });
  write("lib/untouched.ts", "export const a = 1;\n");
  write("README.md", "BASE\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("branch", "-f", "base-tip");

  write("lib/touched.ts", "export const b = 2;\n");
  write("README.md", "HEAD\n");
  git("add", "-A");
  git("commit", "-qm", "head");
  git("checkout", "-q", "--detach", "HEAD");

  return { work, dest: join(runnerTemp, AI_REVIEW_CHANGED_FILES_BASENAME), base: "base-tip" };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runStep(f: Fixture, env: Record<string, string> = {}): Run {
  const path = join(scratchDir("ai-review-cf-script-"), "step.sh");
  writeFileSync(path, STEP);
  // `bash -e`, because that is what a `run:` block is. A step that aborts
  // early under `-e` and one that finished are the same exit code.
  const r = Bun.spawnSync(["bash", "-e", path], {
    cwd: f.work,
    env: {
      ...GIT_ENV(),
      [AI_REVIEW_CHANGED_FILES_PATH_VAR]: f.dest,
      [AI_REVIEW_BASE_REMOTE_VAR]: f.base,
      ...env,
    },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

describe("#1356 / CF: the generated job supplies the changed-file list", () => {
  test("CF-1: the step runs AFTER the restore and BEFORE the reviewer", () => {
    // Both the generator's output and the COMMITTED workflow, because this
    // repository runs the committed one and a generator nobody re-scaffolded
    // from is a fix that has not shipped.
    for (const [label, yaml] of [
      ["the generator's own output", JOB_YAML],
      ["the committed workflow", readFileSync(join(REPO_ROOT, ".github/workflows/ai-review.yml"), "utf-8")],
    ] as const) {
      const ids = stepIds(yaml);
      const at = (id: string) => {
        const i = ids.indexOf(id);
        expect(i, `${label} has no step with id ${id}`).toBeGreaterThan(-1);
        return i;
      };
      const changed = at(AI_REVIEW_CHANGED_FILES_STEP_ID);

      expect(
        changed,
        `${label}: the list is taken before the untrusted paths are restored, so it ` +
          `describes the branch's own copy of them`,
      ).toBeGreaterThan(at(AI_REVIEW_RESTORE_STEP_ID));
      expect(
        changed,
        `${label}: the list is taken AFTER the reviewer, which holds Write on the ` +
          `checkout — so the subject of the review chooses the diff it is scoped by`,
      ).toBeLessThan(at(AI_REVIEW_ACTION_STEP_ID));
    }
  });

  test("CF-2: the step writes outside the checkout, under the prepare step's directory", () => {
    // Same argument as the findings payload: anything in the branch can plant
    // a file in `GITHUB_WORKSPACE`, and a planted changed-file list chooses
    // which findings get demoted.
    expect(JOB).toContain(
      `${AI_REVIEW_CHANGED_FILES_PATH_VAR}: ` +
        `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.${AI_REVIEW_FINDINGS_DIR_OUTPUT} }}` +
        `/${AI_REVIEW_CHANGED_FILES_BASENAME}`,
    );
    expect(
      STEP,
      "the step names the workspace, so it can write the list into the tree under review",
    ).not.toContain("GITHUB_WORKSPACE");
  });

  test("CF-3: a real diff produces the paths the pull request changed, one per line", () => {
    const f = checkout();
    const r = runStep(f);
    expect(r.code, `the step refused: ${r.stderr}`).toBe(0);
    expect(existsSync(f.dest), "the step wrote no list on the success path").toBe(true);

    const lines = readFileSync(f.dest, "utf-8").split("\n").filter(l => l.length > 0);
    expect(lines.sort()).toEqual(["README.md", "lib/touched.ts"]);
    expect(
      lines,
      "a file neither side touched is in the list, so every finding about it would " +
        "keep blocking",
    ).not.toContain("lib/untouched.ts");
  });

  test("CF-4: a FAILED diff writes nothing at all, not an empty file", () => {
    // The issue's own words. `CHANGED_FILES_UNREADABLE` and
    // `CHANGED_FILES_EMPTY` are different facts with different fixes, and an
    // empty file destroys which one happened — it also reads as a pull
    // request that touches nothing, which demotes every blocking finding and
    // reports a green check for a review that found something.
    const f = checkout();
    const r = runStep(f, { [AI_REVIEW_BASE_REMOTE_VAR]: "refs/heads/no-such-base" });

    expect(
      existsSync(f.dest),
      "a failed diff left a file behind — an empty list is read as a pull request " +
        "that changed nothing, which demotes every finding",
    ).toBe(false);
    expect(r.stderr, "the failure was silent").toContain(AI_REVIEW_CHANGED_FILES_TITLE);
  });

  test("CF-4b: an unset base is the same fact, and is not a crash", () => {
    const f = checkout();
    const r = runStep(f, { [AI_REVIEW_BASE_REMOTE_VAR]: "" });
    expect(existsSync(f.dest)).toBe(false);
    expect(r.stderr).toContain(AI_REVIEW_CHANGED_FILES_TITLE);
  });

  test("CF-5: the step never fails the job — the adjudicator decides", () => {
    // Deliberate, and the reason is `.claude/rules/config-access.md`: a step
    // that exits non-zero here produces a RED check whose message is about a
    // `git diff`, while the adjudicator's refusal names the reading
    // (`CHANGED_FILES_UNREADABLE`) and routes through the one exit constant a
    // mutation can zero. Two refusals for one fact would be two deciders.
    const f = checkout();
    expect(runStep(f, { [AI_REVIEW_BASE_REMOTE_VAR]: "refs/heads/no-such-base" }).code).toBe(0);
    expect(runStep(f, { [AI_REVIEW_CHANGED_FILES_PATH_VAR]: "" }).code).toBe(0);
  });

  test("CF-6: the adjudicator is handed the list as its SECOND positional", () => {
    const script = buildReviewRunScript("9.9.9");
    const call = script
      .split("\n")
      .find(l => l.includes(AI_REVIEW_FINDINGS_COMMAND) && l.includes("adjudication="));
    expect(call, "the adjudicator invocation moved and this row stopped reading it").toBeDefined();

    // Order, not mere presence. A list passed BEFORE the payload is read as
    // the payload, and the run would adjudicate the wrong file.
    const payloadAt = call!.indexOf(`\${${AI_REVIEW_FINDINGS_PATH_VAR}}`);
    const listAt = call!.indexOf(`\${${AI_REVIEW_CHANGED_FILES_PATH_VAR}`);
    expect(payloadAt, "the adjudicator is not handed the payload").toBeGreaterThan(-1);
    expect(listAt, "the adjudicator is not handed the changed-file list").toBeGreaterThan(-1);
    expect(listAt, "the list is passed before the payload, so it IS the payload").toBeGreaterThan(
      payloadAt,
    );

    // Quoted, and defaulted. An unquoted expansion word-splits a path with a
    // space in it into two positionals, which `argumentsBeyondTheContract`
    // then refuses — turning a runner's temp directory name into a red
    // required check. An unset variable with no `:-` would vanish entirely
    // under the same expansion, which is a DIFFERENT argv, not a shorter one.
    expect(call, "the changed-file list reaches the adjudicator unquoted").toContain(
      `"\${${AI_REVIEW_CHANGED_FILES_PATH_VAR}:-}"`,
    );
  });

  test("CF-7: the path is one constant, not a literal retyped at each end", () => {
    // The writer, the env binding and the adjudicator call must agree, and a
    // retyped basename is the way they stop agreeing silently: the step
    // writes one file and the adjudicator reads another, which reports
    // CHANGED_FILES_UNREADABLE for ever and looks like a broken runner.
    for (const s of [STEP, JOB, buildReviewRunScript("9.9.9")]) {
      expect(s).toContain(AI_REVIEW_CHANGED_FILES_PATH_VAR);
    }

    // The generated job carries the basename TWICE on purpose — the writer
    // step and the report step each need their own `env:`, because a step's
    // environment does not carry to a later step (#826, measured from a
    // runner's own echo). What must not happen is a second SPELLING, so the
    // census is over the generator's source: the constant's declaration, and
    // nothing else.
    const source = readFileSync(join(REPO_ROOT, "lib/scaffold/ai-review-step.ts"), "utf-8");
    expect(
      source.split(`"${AI_REVIEW_CHANGED_FILES_BASENAME}"`).length - 1,
      "the basename is written as a literal somewhere other than its own constant, " +
        "so the writer and the reader can drift apart silently",
    ).toBe(1);
    expect(
      JOB.split(AI_REVIEW_CHANGED_FILES_BASENAME).length - 1,
      "the two env bindings for the list are no longer both present",
    ).toBe(2);
    expect(AI_REVIEW_CHANGED_FILES_STEP_NAME.length).toBeGreaterThan(0);
  });

  test("CF-8: git runs isolated, and quoted paths are refused at the source", () => {
    // `normaliseRepoPath` refuses git's C-quoted form rather than guessing at
    // it, so the list has to be produced unquoted or every non-ASCII path
    // becomes undecidable — which keeps blocking, loudly, on a repository
    // whose filenames are not the reader's fault.
    expect(STEP).toContain("core.quotePath=false");
    expect(STEP, "the step runs git without the isolation every other step uses").toContain(
      "GIT_CONFIG_GLOBAL=/dev/null",
    );
    expect(STEP).toContain("safe.directory");
  });

  test("CF-9: a path git would C-quote reaches the list unquoted", () => {
    // The control for CF-8. Asserting the flag is in the string proves the
    // flag is in the string; this asserts what the flag is FOR, against a
    // filename git quotes by default.
    const f = checkout();
    const name = "lib/café.ts";
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", f.work, ...a], { env: GIT_ENV() });
    writeFileSync(join(f.work, name), "export const c = 3;\n");
    git("add", "-A");
    git("commit", "-qm", "accented");

    expect(runStep(f).code).toBe(0);
    const lines = readFileSync(f.dest, "utf-8").split("\n").filter(l => l.length > 0);
    expect(lines, "git C-quoted the path, which the adjudicator refuses to decode").toContain(name);
  });
});
