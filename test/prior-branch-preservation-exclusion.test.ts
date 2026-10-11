/**
 * Rescue refs and worktree refs are not prior work (#185)
 *
 * Two namespaces in this repo carry an issue number without being a branch
 * anyone should resume:
 *
 *   - `rungate-preserved/*` is created by scripts/preserve-worktree-work.ts
 *     when a worktree is about to be removed with uncommitted or unreachable
 *     work on it. It exists so `git gc` cannot eat the commit. It is a RESCUE,
 *     written at the moment something went wrong, and its name is built from
 *     the worktree directory — which carries the issue number.
 *   - `worktree-*` is a harness scratch branch.
 *
 * Nominating either one hands the resume path the snapshot of a failed run
 * instead of the branch the run was meant to produce, and because both are
 * written LAST they win the recency tie-break against the real branch every
 * time.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the
 * excluded refs and a real branch for the SAME issue live in one fixture, and
 * the excluded ones are deliberately the newest. A filter that excludes
 * nothing fails the nomination and the null case; a filter narrowed to
 * everything fails "the real branch is still nominated". Neither can be green.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectPriorBranch } from "../lib/prior-branch";

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

function branchWithCommit(work: string, branch: string, date: string) {
  git(["checkout", "-q", "-b", branch, "main"], work);
  writeFileSync(join(work, `${branch.replace(/\//g, "_")}.txt`), branch);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", `work on ${branch}`], work, date);
  git(["checkout", "-q", "main"], work);
}

describe("prior-branch: rescue and worktree refs are never nominated (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rungate-prior-preserved-"));
    work = join(root, "work");
    git(["init", "-q", "-b", "main", work], root);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "Test"], work);
    git(["config", "commit.gpgsign", "false"], work);
    writeFileSync(join(work, "README.md"), "fixture\n");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "base"], work, "2020-01-01T00:00:00Z");

    // Issue 8820: the real branch, plus both excluded shapes. The excluded
    // ones are NEWER, so recency alone would pick them.
    branchWithCommit(work, "8820-real-work", "2021-01-01T00:00:00Z");
    branchWithCommit(work, "worktree-8820-scratch", "2022-01-01T00:00:00Z");
    // Exactly the name scripts/preserve-worktree-work.ts builds:
    // `rungate-preserved/${basename(dir)}-${sha}`.
    branchWithCommit(work, "rungate-preserved/worktree-8820-scratch-a1b2c3d", "2023-01-01T00:00:00Z");

    // Issue 8821: nothing BUT excluded shapes.
    branchWithCommit(work, "worktree-8821-scratch", "2022-02-01T00:00:00Z");
    branchWithCommit(work, "rungate-preserved/wf_8821abc-deadbee", "2023-02-01T00:00:00Z");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the fixture really holds both excluded refs and they really are newest", () => {
    const refs = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], work)
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
    expect(refs).toContain("rungate-preserved/worktree-8820-scratch-a1b2c3d");
    expect(refs).toContain("worktree-8820-scratch");
    expect(refs).toContain("8820-real-work");
  });

  test("the real branch is still nominated even though both excluded refs are newer", async () => {
    const result = await detectPriorBranch({ issueNumber: 8820, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8820-real-work");
    expect(result!.refName).toBe("refs/heads/8820-real-work");
  });

  test("an issue whose only refs are a rescue branch and a worktree branch yields no nomination", async () => {
    const result = await detectPriorBranch({ issueNumber: 8821, projectRoot: work, runTests: false });
    expect(result).toBeNull();
  });

  test("a rescue ref is excluded by its namespace, not by the worktree name inside it", async () => {
    // `rungate-preserved/wf_8821abc-deadbee` contains no `worktree-` segment,
    // so the pre-existing `worktree-` filter cannot be what rejects it.
    const refs = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], work);
    expect(refs).toContain("rungate-preserved/wf_8821abc-deadbee");
    const result = await detectPriorBranch({ issueNumber: 8821, projectRoot: work, runTests: false });
    expect(result).toBeNull();
  });
});
