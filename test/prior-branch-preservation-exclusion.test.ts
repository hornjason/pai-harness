/**
 * A preserved worktree is not prior work to resume (#185)
 *
 * scripts/preserve-worktree-work.ts exists to give REFUSED work a name so it
 * survives worktree cleanup. Its own commit message says so: the branch this
 * repository carries for issue 254 reads "rescued output of run wf_19f7def7-1bf
 * — NOT reviewed, do not merge". Detection nominated it anyway, because the
 * only thing it looked at was whether the number 254 appeared in the name, and
 * ship.js then made it the push target.
 *
 * Preservation and agent-worktree refs are harness bookkeeping. They are
 * created by the harness, for the harness, and nothing downstream of detection
 * should ever push to one.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): every
 * excluded ref sits in the SAME fixture as a real branch for the same issue,
 * and the real one is deliberately the OLDEST, so recency alone would pick a
 * scratch ref. A filter narrowed to nothing fails "the real branch is still
 * nominated"; a filter that excludes nothing fails all three exclusion cases
 * AND the ordering case, because the rescue branch is the newest ref present.
 *
 * What was broken to prove it, run and counted rather than asserted, over the
 * five detection suites (45 tests):
 *
 * | Mutation | Red |
 * |---|---|
 * | `isHarnessScratchRef` short-circuited to `return false` | 5 — every exclusion case, the ordering case, and the predicate's own coverage test |
 * | `isHarnessScratchRef` short-circuited to `return true` | 16 — detection nominates nothing at all, which is the shape that would have passed every exclusion test on its own |
 *
 * Neither is left in the tree; both were run and reverted.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectPriorBranch, isHarnessScratchRef } from "../lib/prior-branch";

function git(args: string[], cwd: string, date?: string) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** A branch off main carrying one commit, left behind and not checked out. */
function branchWithWork(work: string, branch: string, date: string) {
  git(["checkout", "-q", "-b", branch, "main"], work);
  writeFileSync(join(work, `${branch.replace(/[/]/g, "_")}.txt`), branch);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", `work on ${branch}`], work, date);
  git(["checkout", "-q", "main"], work);
}

describe("prior-branch: harness scratch refs are never nominated (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rungate-prior-preserve-"));
    work = join(root, "work");
    git(["init", "-q", "-b", "main", work], root);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "Test"], work);
    git(["config", "commit.gpgsign", "false"], work);
    writeFileSync(join(work, "README.md"), "fixture\n");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "base"], work, "2020-01-01T00:00:00Z");

    // Issue 9901: a real branch, deliberately the OLDEST of the four, plus one
    // ref of every kind the harness leaves lying around for the same issue.
    branchWithWork(work, "9901-real-work", "2021-01-01T00:00:00Z");
    // scripts/preserve-worktree-work.ts, detached-HEAD naming scheme.
    branchWithWork(work, "rungate-preserved/worktree-9901-abc1234", "2022-01-01T00:00:00Z");
    // An agent worktree's own branch, which preservation commits onto directly.
    branchWithWork(work, "worktree-agent-9901deadbeef", "2022-06-01T00:00:00Z");
    // The rescue branch this repository actually carries for #254, by shape.
    branchWithWork(work, "run/9901-wf19f7def7-rescue", "2023-01-01T00:00:00Z");

    // Issue 9902 has NOTHING but scratch refs. There is no prior work here.
    branchWithWork(work, "run/9902-wfcafef00d-rescue", "2023-02-01T00:00:00Z");
    branchWithWork(work, "rungate-preserved/worktree-9902-ff00ff0", "2023-03-01T00:00:00Z");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the real branch is still nominated even though every scratch ref is newer", async () => {
    const result = await detectPriorBranch({ issueNumber: 9901, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("9901-real-work");
  });

  test("an issue whose only refs are a rescue branch and a worktree branch yields no nomination", async () => {
    const result = await detectPriorBranch({ issueNumber: 9902, projectRoot: work, runTests: false });
    expect(result).toBeNull();
  });

  test("the rescue preservation branch is not nominated under any name", async () => {
    const nine01 = await detectPriorBranch({ issueNumber: 9901, projectRoot: work, runTests: false });
    const nine02 = await detectPriorBranch({ issueNumber: 9902, projectRoot: work, runTests: false });
    for (const result of [nine01, nine02]) {
      if (result) expect(result.branch).not.toContain("rescue");
    }
  });

  test("the preserved-worktree branch is not nominated under any name", async () => {
    const nine01 = await detectPriorBranch({ issueNumber: 9901, projectRoot: work, runTests: false });
    const nine02 = await detectPriorBranch({ issueNumber: 9902, projectRoot: work, runTests: false });
    for (const result of [nine01, nine02]) {
      if (result) {
        expect(result.branch).not.toContain("rungate-preserved/");
        expect(result.branch).not.toContain("worktree-");
      }
    }
  });
});

describe("prior-branch: the scratch-ref predicate itself (#185)", () => {
  test("every naming scheme the harness creates is covered", () => {
    // scripts/preserve-worktree-work.ts, lib/worktree-isolation.ts, and the
    // run-scoped rescue namespace, in that order.
    expect(isHarnessScratchRef("rungate-preserved/agent-a82622b-404379c")).toBe(true);
    expect(isHarnessScratchRef("worktree-agent-a82622b50baca5118")).toBe(true);
    expect(isHarnessScratchRef("worktree-wf_216bff9a-c13-14")).toBe(true);
    expect(isHarnessScratchRef("run/254-wf19f7def7-rescue")).toBe(true);
  });

  test("an ordinary issue branch is not scratch", () => {
    // The over-broad filter this rules out: one that swallows the branch names
    // ship.js itself creates would leave detection permanently empty, and
    // every exclusion test above would still pass.
    expect(isHarnessScratchRef("185-deep-modules")).toBe(false);
    expect(isHarnessScratchRef("254-pr-when-container-configured")).toBe(false);
    expect(isHarnessScratchRef("docs-209-standing")).toBe(false);
  });
});
