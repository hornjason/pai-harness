/**
 * A nominated prior branch has to say how far BEHIND the base it is (#185)
 *
 * `commitCount` counts forward from the merge base only, so a branch 64 ahead
 * and 4 behind reads identically to one sitting on the tip. Measured live on
 * 2026-10-11: detection for issue 254 nominated `run/254-wf19f7def7-rescue`,
 * 1 ahead and 8 behind main, and ship.js turned that into the push target
 * `HEAD:run/254-wf19f7def7-rescue` — a guaranteed non-fast-forward rejection.
 * Nothing in the PriorBranch shape could have told it otherwise.
 *
 * The fixtures are real git repositories, because the thing under test is what
 * git is asked, not how the answer is parsed.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): the stale
 * branch and the current branch are two branches in the SAME repository read
 * by the same call. A detector hardwired to `isBehind: true` fails the current
 * case; one hardwired to `false` fails the stale case; one that returns null
 * for everything fails both. The null contract is asserted over a third
 * fixture where the base genuinely does not resolve, so "unknown" cannot be
 * bought by never looking.
 *
 * What was broken to prove it, run and counted rather than asserted, over the
 * six prior-branch suites (59 tests): collapsing `isBehind` to
 * `behindCount === null ? null : false` turns 2 red — the stale fixture, and
 * the assertion that the two candidates no longer read identically. The
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
  const root = mkdtempSync(join(tmpdir(), "rungate-prior-currency-"));
  const work = join(root, "work");
  git(["init", "-q", "-b", defaultBranch, work], root);
  git(["config", "user.email", "test@example.com"], work);
  git(["config", "user.name", "Test"], work);
  git(["config", "commit.gpgsign", "false"], work);
  commit(work, "README.md", "fixture", "2020-01-01T00:00:00Z");
  return { root, work };
}

describe("prior-branch: how far behind the base a candidate is (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    ({ root, work } = initRepo("main"));

    // 8802 branches off the tip, then main moves on twice. One ahead, two
    // behind — the shape that used to be indistinguishable from current.
    git(["checkout", "-q", "-b", "8802-stale"], work);
    commit(work, "stale.txt", "work", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
    commit(work, "m1.txt", "one", "2021-02-01T00:00:00Z");
    commit(work, "m2.txt", "two", "2021-03-01T00:00:00Z");

    // 8801 branches off the CURRENT tip. One ahead, zero behind.
    git(["checkout", "-q", "-b", "8801-current"], work);
    commit(work, "current.txt", "work", "2021-04-01T00:00:00Z");
    git(["checkout", "-q", "main"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a branch two commits behind the base reports behindCount two and isBehind true", async () => {
    const result = await detectPriorBranch({ issueNumber: 8802, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8802-stale");
    expect(result!.behindCount).toBe(2);
    expect(result!.isBehind).toBe(true);
    // The forward count is unchanged: this is exactly the information that was
    // missing, not a replacement for what was there.
    expect(result!.commitCount).toBe(1);
  });

  test("a branch on the base tip reports behindCount zero and isBehind false", async () => {
    const result = await detectPriorBranch({ issueNumber: 8801, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("8801-current");
    expect(result!.behindCount).toBe(0);
    expect(result!.isBehind).toBe(false);
    expect(result!.commitCount).toBe(1);
  });

  test("the two candidates do not read identically", async () => {
    // The whole defect in one assertion: before #185 both of these were
    // `{ commitCount: 1 }` and nothing else.
    const stale = await detectPriorBranch({ issueNumber: 8802, projectRoot: work, runTests: false });
    const current = await detectPriorBranch({ issueNumber: 8801, projectRoot: work, runTests: false });
    expect(stale!.commitCount).toBe(current!.commitCount);
    expect(stale!.isBehind).not.toBe(current!.isBehind);
    expect(stale!.behindCount).not.toBe(current!.behindCount);
  });
});

describe("prior-branch: an unanswerable behind-count is not zero (#185)", () => {
  let root = "";
  let work = "";

  beforeAll(() => {
    // Default branch `trunk`, so the detector's `main` base does not resolve.
    ({ root, work } = initRepo("trunk"));
    git(["checkout", "-q", "-b", "8803-no-main"], work);
    commit(work, "x.txt", "x", "2021-01-01T00:00:00Z");
    git(["checkout", "-q", "trunk"], work);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a failed count reports unknown rather than zero, for both directions", async () => {
    const result = await detectPriorBranch({ issueNumber: 8803, projectRoot: work, runTests: false });
    expect(result).not.toBeNull();
    // `0` reads as "level with the base". That is a different claim from
    // "git could not tell us" — the same contract commitCount carries (#164).
    expect(result!.behindCount).toBeNull();
    expect(result!.behindCount).not.toBe(0);
    expect(result!.isBehind).toBeNull();
    expect(result!.isBehind).not.toBe(false);
    expect(result!.commitCount).toBeNull();
  });
});

describe("prior-branch: the currency fields are in the source (#185)", () => {
  const source = readFileSync(join(REPO_ROOT, "lib", "prior-branch.ts"), "utf-8");

  test("behindCount and isBehind are declared and computed, not just returned", () => {
    const references = source.match(/behindCount|isBehind/g) || [];
    expect(references.length).toBeGreaterThanOrEqual(4);
  });

  test("the count comes from one symmetric rev-list, not a second forward one", () => {
    const code = source
      .split("\n")
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).toContain("--left-right");
  });
});
