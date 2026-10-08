import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * #174 — `code-pushed` and `code-committed` measured the wrong repository.
 *
 * Both checks in gates/workflow.test.ts ran their git command in
 * `sf("projectRoot")`. Marcus runs with `isolation: worktree`, so the run's
 * commits live on `agents.marcus.branch` inside `.claude/worktrees/<runId>`
 * while projectRoot stays on main — clean, and level with its upstream. That
 * is the resting state of a main checkout, so both checks reported success
 * about a branch and a working tree they never looked at. `code-pushed` had a
 * second false PASS underneath the first: `if (!result.ok) return` turned
 * "this branch has no upstream, nobody has ever pushed it" into the same
 * verdict as "everything is pushed".
 *
 * Every case here plants one half of that scenario — an unpushed commit on the
 * issue branch, or uncommitted files in the issue worktree, with projectRoot
 * clean in both — and watches the named check go red. Each red case is paired
 * with a green one, because a check that fails on everything satisfies a red
 * case for free (.claude/rules/checks-must-be-able-to-fail.md). The
 * `projectRoot clean` fixture is shared by both halves and is what the old
 * code was measuring, so "measures the artefact" and "measures projectRoot"
 * produce opposite verdicts on the same tree.
 *
 * Real git repositories with a real bare remote and a real `git worktree add`,
 * not mocks: a check that runs the wrong git command keeps passing against a
 * mock, which is the defect being fixed here.
 *
 * The checks are EXECUTED — `bun test gates/workflow.test.ts -t <name>`
 * against a planted work dir — rather than asserted on source text. Every
 * mutation that survived a first pass in session 34 was a source-text
 * assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");

/** The branch the run's commits live on, as ship.js would name it. */
const ISSUE_BRANCH = "174-worktree-isolation";

let DIR = "";
let ORIGIN = "";
let PROJECT = "";
let WORKTREE = "";
let WORK = "";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

beforeEach(() => {
  // realpath because macOS hands out /var/folders/... through a symlink, and a
  // git worktree registered under one spelling of its path is not found under
  // the other.
  DIR = realpathSync(mkdtempSync(join(tmpdir(), "gate-code-pushed-")));
  ORIGIN = join(DIR, "origin.git");
  PROJECT = join(DIR, "project");
  WORKTREE = join(DIR, "worktrees", "wf-174");
  WORK = join(DIR, "work");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(PROJECT, "src"), { recursive: true });
  mkdirSync(join(PROJECT, ".claude"), { recursive: true });

  git(["init", "--bare", "-b", "main", ORIGIN], DIR);
  git(["init", "-b", "main", PROJECT], DIR);
  git(["config", "user.email", "marcus@example.test"], PROJECT);
  git(["config", "user.name", "Marcus Webb"], PROJECT);
  git(["config", "commit.gpgsign", "false"], PROJECT);

  writeFileSync(join(PROJECT, "src", "index.ts"), "export const a = 1;\n");
  // codeCommittedPaths is what the code-committed check measures; scoping it to
  // src/ keeps the planted rungate.json itself out of the count.
  writeFileSync(
    join(PROJECT, ".claude", "rungate.json"),
    JSON.stringify({ codeCommittedPaths: ["src"] }, null, 2),
  );
  git(["add", "src"], PROJECT);
  git(["commit", "-m", "initial"], PROJECT);
  git(["remote", "add", "origin", ORIGIN], PROJECT);
  git(["push", "-u", "origin", "main"], PROJECT);

  // The issue's worktree, the same shape ship.js creates under
  // .claude/worktrees/. projectRoot is left on main, clean and level with
  // origin/main, for every case below.
  git(["worktree", "add", "-b", ISSUE_BRANCH, WORKTREE, "main"], PROJECT);
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

/** The smallest workflow-state.json the two checks read fields out of. */
function plantState(marcus: Record<string, unknown> | undefined): void {
  const state = {
    schemaVersion: 2,
    issue: 174,
    slug: "pai-harness-174",
    phase: "SHIP",
    projectRoot: PROJECT,
    issueGoal: "the ship gate measures the issue's branch, not whatever projectRoot has checked out",
    sizing: { predicted: "S", ceremonyTier: "LIGHT" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the code-pushed check resolves its branch from the run artefact",
        threshold: { op: "==", value: 0, unit: "commits ahead" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...(marcus ? { agents: { marcus } } : {}),
  };
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

/**
 * Run one named check out of gates/workflow.test.ts against the planted work
 * dir and report whether it went red.
 *
 * `ran` is not a formality. A filter that matches nothing leaves bun reporting
 * zero failures, which is indistinguishable from the check passing — the exact
 * shape this file exists to catch.
 */
function runCheck(name: string): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", GATE_SUITE, "-t", name], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, TEST_WORK_DIR: WORK },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const passed = count("pass");
  const failed = count("fail");
  // Exactly one, not at least one: a filter that widens to two checks would
  // otherwise let a green one mask a red one, or vice versa.
  return { ran: passed + failed === 1, red: failed === 1, output };
}

function expectRed(name: string, why: string) {
  const r = runCheck(name);
  expect(r.ran, `"${name}" never ran — the filter matched nothing:\n${r.output}`).toBe(true);
  expect(r.red, `${why}\n${r.output}`).toBe(true);
}

function expectGreen(name: string, why: string) {
  const r = runCheck(name);
  expect(r.ran, `"${name}" never ran — the filter matched nothing:\n${r.output}`).toBe(true);
  expect(r.red, `${why}\n${r.output}`).toBe(false);
}

function commitInWorktree(relPath: string, body: string, message: string): void {
  writeFileSync(join(WORKTREE, relPath), body);
  git(["add", relPath], WORKTREE);
  git(["commit", "-m", message], WORKTREE);
}

// ═══ code-pushed ══════════════════════════════════════════════════════
describe("#174 code-pushed measures the branch the run committed on", () => {
  test(
    "code-pushed fails on an unpushed commit on the issue branch, projectRoot clean at its upstream",
    () => {
      // THE PLANTED DEFECT. The branch is pushed once — so it HAS an upstream
      // and the no-upstream branch below is not what makes this red — and then
      // a remediation round commits on top without pushing. projectRoot is
      // untouched: on main, clean, zero commits ahead of origin/main. The old
      // check ran `git rev-list --count @{upstream}..HEAD` right there and
      // reported "0 commits ahead" about a branch it never named.
      git(["push", "-u", "origin", ISSUE_BRANCH], WORKTREE);
      commitInWorktree("src/fix.ts", "export const fix = true;\n", "fix(#174): remediation round");
      plantState({ spawned: true, verdict: "PASS", branch: ISSUE_BRANCH, worktreePath: WORKTREE });
      expectRed(
        "code-pushed",
        "an unpushed commit on agents.marcus.branch did not fail code-pushed",
      );
    },
    120000,
  );

  test(
    "code-pushed passes when the issue branch is level with its upstream",
    () => {
      // The positive control. Without it, a check that fails unconditionally
      // satisfies the case above.
      commitInWorktree("src/fix.ts", "export const fix = true;\n", "fix(#174): the fix");
      git(["push", "-u", "origin", ISSUE_BRANCH], WORKTREE);
      plantState({ spawned: true, verdict: "PASS", branch: ISSUE_BRANCH, worktreePath: WORKTREE });
      expectGreen("code-pushed", "a fully pushed issue branch failed code-pushed");
    },
    120000,
  );

  test(
    "code-pushed refuses a branch whose push state cannot be determined",
    () => {
      // The fail-open half: a branch that was never pushed has no @{upstream},
      // so `git rev-list` exits non-zero. `if (!result.ok) return` read that as
      // success — the one condition this check exists to catch.
      commitInWorktree("src/fix.ts", "export const fix = true;\n", "fix(#174): never pushed");
      plantState({ spawned: true, verdict: "PASS", branch: ISSUE_BRANCH, worktreePath: WORKTREE });
      expectRed("code-pushed", "a branch with no upstream passed code-pushed by early return");
    },
    120000,
  );

  test(
    "code-pushed refuses a branch name a shell could reinterpret",
    () => {
      // agents.marcus.branch reaches a shell command line. A value that is not
      // a branch name is refused rather than cleaned, the same rule
      // scripts/record-build-commit.ts applies to the same field.
      git(["push", "-u", "origin", ISSUE_BRANCH], WORKTREE);
      plantState({ branch: "main; touch /tmp/pwned-174", worktreePath: WORKTREE });
      expectRed("code-pushed", "a branch name containing a shell separator was accepted");
    },
    120000,
  );

  test(
    "the same tree passes when the artefact names no worktree — the old measurement",
    () => {
      // Proof the red cases above come from reading the artefact and not from
      // the fixture being broken in general: identical repository state, with
      // agents.marcus absent so the check falls back to projectRoot, and
      // projectRoot is clean and level. This is exactly the verdict every real
      // run got.
      git(["push", "-u", "origin", ISSUE_BRANCH], WORKTREE);
      commitInWorktree("src/fix.ts", "export const fix = true;\n", "fix(#174): remediation round");
      plantState(undefined);
      expectGreen("code-pushed", "projectRoot on main, clean and level with origin/main, failed code-pushed");
    },
    120000,
  );
});

// ═══ code-committed ═══════════════════════════════════════════════════
describe("#174 code-committed measures the worktree the run built in", () => {
  test(
    "code-committed fails on uncommitted files in the issue worktree, projectRoot clean",
    () => {
      // THE PLANTED DEFECT, one check over: Marcus's edits are in the
      // worktree, `git status --porcelain` ran in projectRoot, and projectRoot
      // has nothing uncommitted because nothing was ever written there.
      writeFileSync(join(WORKTREE, "src", "uncommitted.ts"), "export const dropped = true;\n");
      plantState({ spawned: true, verdict: "PASS", branch: ISSUE_BRANCH, worktreePath: WORKTREE });
      expectRed(
        "code-committed",
        "an uncommitted file in agents.marcus.worktreePath did not fail code-committed",
      );
    },
    120000,
  );

  test(
    "code-committed passes when the issue worktree is clean",
    () => {
      // The positive control for the case above.
      commitInWorktree("src/fix.ts", "export const fix = true;\n", "fix(#174): the fix");
      plantState({ spawned: true, verdict: "PASS", branch: ISSUE_BRANCH, worktreePath: WORKTREE });
      expectGreen("code-committed", "a clean issue worktree failed code-committed");
    },
    120000,
  );

  test(
    "the same uncommitted file passes when the artefact names no worktree — the old measurement",
    () => {
      writeFileSync(join(WORKTREE, "src", "uncommitted.ts"), "export const dropped = true;\n");
      plantState(undefined);
      expectGreen("code-committed", "projectRoot with no uncommitted files failed code-committed");
    },
    120000,
  );
});
