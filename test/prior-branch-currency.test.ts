/**
 * A prior branch is reported with its CURRENCY, not just its size (#185)
 *
 * `detectPriorBranch` answered `commitCount` and nothing else, so a candidate
 * 64 commits ahead of main and 4 behind it read identically to one sitting on
 * the base's tip. Resuming the stale one is the expensive mistake: the run
 * merges main in, or it does not and the PR carries a conflict nobody asked
 * for. Either way the decision was taken without the fact.
 *
 * `behindCount` follows `commitCount`'s existing rule (#164): a number is a
 * claim, and when no base resolves the claim is not available, so the value is
 * `null` rather than `0`. `0` would say "this branch is current".
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the stale
 * and the current branch are measured in the SAME fixture against the SAME
 * base. A detector hardwired to 0 fails the stale case; one hardwired to a
 * non-zero number fails the current case; one that cannot read the base at all
 * fails both and the null case passes for the wrong reason, which is why the
 * null case also asserts the base genuinely does not resolve.
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

function commit(work: string, name: string, date: string) {
  writeFileSync(join(work, `${name}.txt`), name);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", name], work, date);
}

function makeRepo(defaultBranch: string) {
  const root = mkdtempSync(join(tmpdir(), "rungate-prior-currency-"));
  const work = join(root, "work");
  git(["init", "-q", "-b", defaultBranch, work], root);
  git(["config", "user.email", "test@example.com"], work);
  git(["config", "user.name", "Test"], work);
  git(["config", "commit.gpgsign", "false"], work);
  commit(work, "base", "2020-01-01T00:00:00Z");
  return { root, work };
}

describe("prior-branch: how far behind the base the candidate is (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    ({ root, work } = makeRepo("main"));

    // Forked from the base BEFORE main moved: 1 ahead, 2 behind.
    git(["checkout", "-q", "-b", "8802-stale"], work);
    commit(work, "stale-work", "2021-01-01T00:00:00Z");

    git(["checkout", "-q", "main"], work);
    commit(work, "main-moved-1", "2021-02-01T00:00:00Z");
    commit(work, "main-moved-2", "2021-03-01T00:00:00Z");

    // Forked from the base AFTER main moved: 1 ahead, 0 behind.
    git(["checkout", "-q", "-b", "8801-current"], work);
    commit(work, "current-work", "2021-04-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a branch two commits behind the base reports behindCount 2 and isBehind true", async () => {
    const result = await detectPriorBranch({ issueNumber: 8802, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8802-stale");
    expect(result!.behindCount).toBe(2);
    expect(result!.isBehind).toBe(true);
  });

  test("a current branch reports behindCount 0 and isBehind false", async () => {
    const result = await detectPriorBranch({ issueNumber: 8801, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8801-current");
    expect(result!.behindCount).toBe(0);
    expect(result!.isBehind).toBe(false);
  });

  test("the two candidates no longer read identically despite the same commitCount", async () => {
    // This is the defect in one assertion: before #185 the only number either
    // branch carried was `commitCount`, and it is the same for both.
    const stale = await detectPriorBranch({ issueNumber: 8802, projectRoot: work, runTests: false });
    const current = await detectPriorBranch({ issueNumber: 8801, projectRoot: work, runTests: false });
    expect(stale!.commitCount).toBe(current!.commitCount);
    expect(stale!.behindCount).not.toBe(current!.behindCount);
  });

  test("ahead is still counted from the base, not from the fork point alone", async () => {
    const stale = await detectPriorBranch({ issueNumber: 8802, projectRoot: work, runTests: false });
    expect(stale!.commitCount).toBe(1);
  });
});

describe("prior-branch: an unanswerable behind count is not zero (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    // Default branch `trunk`, so the detector's `main` base does not resolve.
    ({ root, work } = makeRepo("trunk"));
    git(["checkout", "-q", "-b", "8803-no-main"], work);
    commit(work, "work", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "trunk"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the fixture really has no resolvable base, so the null is earned", () => {
    const resolved = spawnSync("git", ["rev-parse", "--verify", "main"], { cwd: work, encoding: "utf-8" });
    expect(resolved.status).not.toBe(0);
  });

  test("behindCount is null, matching commitCount's rule, and isBehind is false", async () => {
    const result = await detectPriorBranch({ issueNumber: 8803, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.commitCount).toBeNull();
    // `0` reads as "this branch is current". "git could not tell us" is a
    // different claim, and the resume decision wants to know which it has.
    expect(result!.behindCount).toBeNull();
    expect(result!.behindCount).not.toBe(0);
    // No measurement is not evidence of staleness either.
    expect(result!.isBehind).toBe(false);
  });
});
