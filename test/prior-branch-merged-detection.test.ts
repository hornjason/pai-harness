/**
 * A candidate whose content is already in the base is not prior work (#185)
 *
 * The branch this repository nominated for issue 254 was one commit ahead of
 * main and eight behind it, and no field in PriorBranch said so. "Already
 * merged" is the second half of the same blindness: a branch whose work landed
 * in main — especially via the squash merges this repo merges PRs with — still
 * reports `commitCount: 1` and still looks like something to resume.
 *
 * `git cherry` is the obvious tool and the wrong one: it compares patch-ids,
 * and a squash merge produces a single commit whose patch-id matches none of
 * the originals. So the question is asked of the TREE — merge the candidate
 * into the base in memory and see whether the base's tree moves. If it does
 * not, the base already contains everything the candidate has, however it got
 * there.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the
 * squash-merged, the ordinarily merged and the genuinely open branch all live in ONE
 * fixture repository and are read by the same call. A detector hardwired to
 * `true` fails the open case; one hardwired to `false` fails both merged
 * cases; one that answers `null` everywhere fails all three, and the null
 * contract is pinned separately over a repo whose base does not resolve.
 *
 * What was broken to prove it, run and counted rather than asserted, over the
 * five detection suites (45 tests): short-circuiting `mergedIntoBase` to
 * `return false` turns 3 red — both merged fixtures and the unanswerable case,
 * which is the one that stops "always false" from reading as caution. The
 * mutation is not left in the tree; it was run and reverted.
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

function commit(work: string, file: string, body: string, date: string) {
  writeFileSync(join(work, file), body);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", `${file}: ${body}`], work, date);
}

function initRepo(defaultBranch: string) {
  const root = mkdtempSync(join(tmpdir(), "rungate-prior-merged-"));
  const work = join(root, "work");
  git(["init", "-q", "-b", defaultBranch, work], root);
  git(["config", "user.email", "test@example.com"], work);
  git(["config", "user.name", "Test"], work);
  git(["config", "commit.gpgsign", "false"], work);
  commit(work, "README.md", "fixture", "2020-01-01T00:00:00Z");
  return { root, work };
}

describe("prior-branch: already-merged candidates, by tree (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    ({ root, work } = initRepo("main"));

    // 8811 is squash-merged — the shape `git cherry` cannot see, because the
    // squash commit's patch-id matches neither of the two it replaced.
    git(["checkout", "-q", "-b", "8811-squashed"], work);
    commit(work, "squashed-a.txt", "a", "2021-01-01T00:00:00Z");
    commit(work, "squashed-b.txt", "b", "2021-01-02T00:00:00Z");
    git(["checkout", "-q", "main"], work);
    git(["merge", "--squash", "-q", "8811-squashed"], work);
    git(["commit", "-q", "-m", "squashed 8811"], work, "2021-01-03T00:00:00Z");
    // Main keeps moving afterwards, so "merged" cannot be read off the trees
    // being equal — only off the MERGE adding nothing.
    commit(work, "after.txt", "later", "2021-01-04T00:00:00Z");

    // 8812 is real, unmerged work branched from the current tip.
    git(["checkout", "-q", "-b", "8812-open"], work);
    commit(work, "open.txt", "unmerged", "2021-02-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);

    // 8813 is merged the ordinary way, with a merge commit.
    git(["checkout", "-q", "-b", "8813-truemerge"], work);
    commit(work, "truemerge.txt", "c", "2021-03-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
    git(["merge", "--no-ff", "-q", "-m", "merge 8813", "8813-truemerge"], work, "2021-03-02T00:00:00Z");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a squash-merged branch is reported as merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8811, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8811-squashed");
    expect(result!.isMerged).toBe(true);
    // It still looks like live work to the forward count — which is the bug.
    expect(result!.commitCount).toBe(2);
  });

  test("a branch merged with a merge commit is reported as merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8813, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.isMerged).toBe(true);
  });

  test("a branch holding work the base does not have is not reported as merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8812, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8812-open");
    expect(result!.isMerged).toBe(false);
  });
});

describe("prior-branch: an unanswerable merge question is not false (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    ({ root, work } = initRepo("trunk"));
    git(["checkout", "-q", "-b", "8814-no-main"], work);
    commit(work, "x.txt", "x", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "trunk"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("with no base to compare against, isMerged is null rather than false", async () => {
    const result = await detectPriorBranch({ issueNumber: 8814, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.isMerged).toBeNull();
    expect(result!.isMerged).not.toBe(false);
  });
});

describe("prior-branch: the merged question is asked of the tree (#185)", () => {
  const source = readFileSync(join(REPO_ROOT, "lib", "prior-branch.ts"), "utf-8");
  const code = source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  test("no git cherry call is reachable from detection", () => {
    expect(code).not.toMatch(/['"]cherry['"]/);
    expect(code).not.toContain("cherry-mark");
    expect(code).not.toContain("git cherry");
  });

  test("the comparison is a merge-tree against the base", () => {
    expect(code).toContain("merge-tree");
    expect(code).toContain("--write-tree");
  });
});
