/**
 * A prior branch whose work is already on the base is reported as merged (#185)
 *
 * `detectPriorBranch` nominated any ref carrying the issue number, and the
 * resume path then re-opened work that had already landed. The ancestor case
 * is the easy half; the one that actually happens in this repo is the SQUASH
 * merge, where the branch is an ancestor of nothing and `rev-list main..ref`
 * still reports every commit it ever had. The content is on main; the commits
 * are not.
 *
 * The detection is a TREE comparison — is the tree this branch produced
 * already somewhere in the base's history — and deliberately not `git cherry`:
 * cherry compares patch ids one commit at a time, which answers a different
 * question (were these patches applied individually) and is quadratic in the
 * branch length. The last test asserts the invocation is absent from the
 * source rather than trusting this paragraph.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the merged,
 * the squash-merged and the unmerged branch live in the SAME fixture and are
 * measured by the same call. A detector hardwired to `true` fails the
 * unmerged case; one hardwired to `false` fails the other two; one that only
 * does the ancestor half fails the squash case, which is the half that was
 * missing.
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

function commit(work: string, name: string, date: string) {
  writeFileSync(join(work, `${name}.txt`), name);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", name], work, date);
}

describe("prior-branch: work already contained in the base (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rungate-prior-merged-"));
    work = join(root, "work");
    git(["init", "-q", "-b", "main", work], root);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "Test"], work);
    git(["config", "commit.gpgsign", "false"], work);
    commit(work, "base", "2020-01-01T00:00:00Z");

    // (1) A branch merged with a real merge commit, after which main moved on.
    git(["checkout", "-q", "-b", "8810-merged"], work);
    commit(work, "merged-work", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
    git(["merge", "-q", "--no-ff", "--no-edit", "8810-merged"], work, "2021-01-02T00:00:00Z");
    commit(work, "main-after-merge", "2021-01-03T00:00:00Z");

    // (2) A branch SQUASH-merged into main, after which main moved on again.
    // The branch is an ancestor of nothing, and `main..` still lists its
    // commit, so only a tree comparison can see that the work landed.
    git(["checkout", "-q", "-b", "8811-squashed"], work);
    commit(work, "squashed-work", "2021-02-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
    git(["merge", "-q", "--squash", "8811-squashed"], work);
    git(["commit", "-q", "-m", "squash merge of 8811"], work, "2021-02-02T00:00:00Z");
    commit(work, "main-after-squash", "2021-02-03T00:00:00Z");

    // (3) A branch that genuinely has not landed.
    git(["checkout", "-q", "-b", "8812-open"], work);
    commit(work, "open-work", "2021-03-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the fixture's squash really is a squash — the branch is an ancestor of nothing", () => {
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", "8811-squashed", "main"], {
      cwd: work,
      encoding: "utf-8",
    });
    expect(ancestor.status).not.toBe(0);
    // ...and the commit is still listed as unmerged by the count the detector
    // already reported, which is why `commitCount` alone could never see it.
    const count = spawnSync("git", ["rev-list", "--count", "main..8811-squashed"], {
      cwd: work,
      encoding: "utf-8",
    });
    expect(count.stdout.trim()).toBe("1");
  });

  test("a branch merged with a merge commit is reported merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8810, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8810-merged");
    expect(result!.mergedIntoBase).toBe(true);
  });

  test("a branch squash-merged into the base is reported merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8811, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8811-squashed");
    expect(result!.mergedIntoBase).toBe(true);
    // The count still says there is something to resume. The two facts
    // disagree, and that disagreement is the whole point of the new one.
    expect(result!.commitCount).toBe(1);
  });

  test("a branch that has not landed is not reported merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8812, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8812-open");
    expect(result!.mergedIntoBase).toBe(false);
  });
});

describe("prior-branch: no base means no merge claim (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rungate-prior-merged-nobase-"));
    work = join(root, "work");
    git(["init", "-q", "-b", "trunk", work], root);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "Test"], work);
    git(["config", "commit.gpgsign", "false"], work);
    commit(work, "base", "2020-01-01T00:00:00Z");
    git(["checkout", "-q", "-b", "8813-no-main"], work);
    commit(work, "work", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "trunk"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("an unresolvable base reports not-merged rather than merged", async () => {
    const result = await detectPriorBranch({ issueNumber: 8813, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    // "I could not check" must not become "it already landed" — that would
    // discard the branch. The conservative direction is to keep it.
    expect(result!.mergedIntoBase).toBe(false);
  });
});

describe("prior-branch: the merge detector's invocation (#185)", () => {
  const source = readFileSync(join(REPO_ROOT, "lib", "prior-branch.ts"), "utf-8");
  const code = source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  test("the detection source invokes no git cherry", () => {
    expect(code).not.toContain("'cherry'");
    expect(code).not.toContain('"cherry"');
    expect(code).not.toContain("cherry-mark");
  });

  test("the detection is a tree comparison", () => {
    // Asserted so that a later rewrite back onto patch ids has to change this
    // line deliberately rather than by accident.
    expect(code).toContain("^{tree}");
  });
});
