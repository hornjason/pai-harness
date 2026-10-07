/**
 * detectPriorBranch only adopts refs this repository can resolve (#164)
 *
 * `git branch -a --list` lists every configured remote, and the old code
 * stripped `remotes/<any>/` off whatever came back. On wf_b5f65252-24f that
 * adopted `161-162-pattern-consistency-gaps` — a branch in asaCommandCenter,
 * reachable here only because this checkout has an `asacc` remote. ship.js
 * then used the stripped name as the push target and the PR head; the merge
 * failed for the incidental reason that `161-162-...` resolves to nothing.
 *
 * The fixtures below are real git repositories with two remotes, because the
 * bug lives in what git is asked, not in how the answer is parsed.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the
 * exclusion tests here are paired with inclusion tests over the SAME fixture.
 * A filter narrowed to nothing passes every exclusion test and fails
 * "adopts an origin-only branch" and "refName resolves ... for a local
 * branch"; a filter that excludes nothing fails the two "not adopted" tests.
 * Neither mistake can be green.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectPriorBranch } from "../lib/prior-branch";

const REPO_ROOT = join(import.meta.dir, "..");

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

/** Commit on a new branch, push it to one remote, then drop the local copy. */
function remoteOnlyBranch(work: string, branch: string, remote: string, date: string) {
  git(["checkout", "-q", "-b", branch], work);
  writeFileSync(join(work, `${branch}.txt`), branch);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", `work on ${branch}`], work, date);
  git(["push", "-q", remote, branch], work);
  git(["checkout", "-q", "-"], work);
  git(["branch", "-q", "-D", branch], work);
}

/**
 * A repository with an `origin` and a second remote named `other`.
 *
 * `defaultBranch` is a parameter because AC-4 needs a repo where the hardcoded
 * `main..` base does not resolve — that is the only way `git rev-list` fails
 * without breaking the repo in some way the detector would notice first.
 */
function makeFixture(defaultBranch: string) {
  const root = mkdtempSync(join(tmpdir(), "rungate-prior-remotes-"));
  const originBare = join(root, "origin.git");
  const otherBare = join(root, "other.git");
  const work = join(root, "work");

  git(["init", "-q", "--bare", "-b", defaultBranch, originBare], root);
  git(["init", "-q", "--bare", "-b", defaultBranch, otherBare], root);
  git(["init", "-q", "-b", defaultBranch, work], root);
  git(["config", "user.email", "test@example.com"], work);
  git(["config", "user.name", "Test"], work);
  git(["config", "commit.gpgsign", "false"], work);

  writeFileSync(join(work, "README.md"), "fixture\n");
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "base"], work, "2020-01-01T00:00:00Z");
  git(["remote", "add", "origin", originBare], work);
  git(["remote", "add", "other", otherBare], work);
  git(["push", "-q", "origin", defaultBranch], work);
  git(["push", "-q", "other", defaultBranch], work);

  return { root, work };
}

describe("prior-branch: candidates are scoped to this repository (#164)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    ({ root, work } = makeFixture("main"));

    // Same issue number on both remotes. The non-origin copy is deliberately
    // NEWER, so recency alone would pick it: only the namespace filter keeps
    // it out.
    remoteOnlyBranch(work, "7700-origin-side", "origin", "2021-01-01T00:00:00Z");
    remoteOnlyBranch(work, "7700-other-side", "other", "2022-01-01T00:00:00Z");

    // An issue that exists ONLY on the foreign remote — the wf_b5f65252-24f case.
    remoteOnlyBranch(work, "7711-other-only", "other", "2022-06-01T00:00:00Z");

    // A purely local branch, never pushed anywhere.
    git(["checkout", "-q", "-b", "7722-local-only"], work);
    writeFileSync(join(work, "local.txt"), "local");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "local work"], work, "2021-06-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);

    git(["fetch", "-q", "--all"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("adopts an origin-only branch and skips the same issue on another remote", async () => {
    const result = await detectPriorBranch({ issueNumber: 7700, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("7700-origin-side");
  });

  test("a branch that exists only on a non-origin remote is not adopted", async () => {
    const result = await detectPriorBranch({ issueNumber: 7711, projectRoot: work, runTests: false });
    expect(result).toBeNull();
  });

  test("refName resolves with git rev-parse for an origin-only branch", async () => {
    const result = await detectPriorBranch({ issueNumber: 7700, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    const resolved = spawnSync("git", ["rev-parse", "--verify", result!.refName], {
      cwd: work,
      encoding: "utf-8",
    });
    expect(resolved.status).toBe(0);
    // The bare name is what ship.js pushes to (`HEAD:<branch>`); it must stay
    // bare even though refName is namespaced.
    expect(result!.refName).toBe("refs/remotes/origin/7700-origin-side");
    expect(result!.branch).toBe("7700-origin-side");
  });

  test("refName resolves with git rev-parse for a local branch", async () => {
    const result = await detectPriorBranch({ issueNumber: 7722, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("7722-local-only");
    expect(result!.refName).toBe("refs/heads/7722-local-only");
    const resolved = spawnSync("git", ["rev-parse", "--verify", result!.refName], {
      cwd: work,
      encoding: "utf-8",
    });
    expect(resolved.status).toBe(0);
  });

  test("a successful rev-list reports the real commit count", async () => {
    const result = await detectPriorBranch({ issueNumber: 7700, projectRoot: work, runTests: false });
    expect(result!.commitCount).toBe(1);
  });
});

describe("prior-branch: an unanswerable commit count is not zero (#164)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    // Default branch `trunk`, so the detector's `main..` base does not resolve
    // and `git rev-list` exits non-zero.
    ({ root, work } = makeFixture("trunk"));
    git(["checkout", "-q", "-b", "7733-no-main"], work);
    writeFileSync(join(work, "x.txt"), "x");
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "work"], work, "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "trunk"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a failed rev-list reports an unknown commit count rather than zero", async () => {
    const result = await detectPriorBranch({ issueNumber: 7733, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    // `0` reads as "the branch is fully merged, there is nothing to resume".
    // That is a different claim from "git could not tell us".
    expect(result!.commitCount).toBeNull();
    expect(result!.commitCount).not.toBe(0);
  });
});

describe("prior-branch: the enumeration itself (#164)", () => {
  const source = readFileSync(join(REPO_ROOT, "lib", "prior-branch.ts"), "utf-8");

  test("no git branch -a call is left behind", () => {
    expect(source).not.toContain("'branch', '-a'");
    expect(source).not.toContain('"branch", "-a"');
  });

  test("candidates come from refs/heads and refs/remotes/origin only", () => {
    const code = source
      .split("\n")
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).toContain("for-each-ref");
    expect(code).toContain("refs/heads");
    expect(code).toContain("refs/remotes/origin");
  });
});

describe("prior-branch: ship.js consumes the resolvable ref (#164)", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the merge step is handed refName, not the bare branch name", () => {
    // The old prompt said `git merge <branch> --no-edit`, where <branch> was
    // the remote-stripped name. For an origin-only branch that resolves to
    // nothing.
    expect(shipSource).toContain("git merge <refName> --no-edit");
    expect(shipSource).not.toContain("git merge <branch> --no-edit");
  });

  test("the refusal to merge onto the default branch survives", () => {
    expect(shipSource).toContain("SKIPPED MERGE: checkout is on $branch");
  });

  test("the push target stays the bare branch name", () => {
    // refName is for resolving; `HEAD:refs/remotes/origin/x` is not a push
    // target anyone wants.
    expect(shipSource).toContain("`HEAD:${branchToReuse}`");
  });

  test("ship.js still parses as a workflow script", () => {
    const src = shipSource.replace(/^export /gm, "");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction("args", src)).not.toThrow();
  });
});
