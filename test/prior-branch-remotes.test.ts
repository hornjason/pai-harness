/**
 * detectPriorBranch only adopts refs from THIS repository (#164)
 *
 * `git branch -a --list` lists every configured remote, and the caller then
 * stripped the `remotes/<name>/` prefix off whatever it matched. On run
 * wf_b5f65252-24f that adopted `161-162-pattern-consistency-gaps` — a branch
 * in asaCommandCenter, reachable only because this checkout has a second
 * remote — as issue 161's prior work. ship.js took the stripped name as the
 * push target and the PR head. The merge failed, and it failed for the wrong
 * reason: the name was unresolvable, not rejected.
 *
 * Three things are asserted here, each against a real repository built in a
 * temp dir rather than against the source text:
 *
 *   - candidates come from refs/heads and refs/remotes/origin, nothing else
 *   - the returned refName is a ref `git rev-parse` resolves, for an
 *     origin-only branch as well as a local one
 *   - a rev-list that FAILS is an unknown count, not "zero commits ahead"
 *
 * The positive controls matter as much as the negatives: narrowing the filter
 * until it matches nothing would satisfy "the foreign branch is not adopted"
 * while breaking the feature, so every negative case here is paired with a
 * same-fixture case that must still find a branch
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { detectPriorBranch } from "../lib/prior-branch";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

interface Fixture {
  /** A working clone with `origin`, plus a second remote called `other`. */
  work: string;
}

/**
 * Build a repo with two remotes.
 *
 * `originBranches` land on origin only, `otherBranches` on the second remote
 * only, `localBranches` exist as local heads. Nothing is on more than one.
 */
function makeFixture(opts: {
  root: string;
  defaultBranch?: string;
  originBranches?: string[];
  otherBranches?: string[];
  localBranches?: string[];
}): Fixture {
  const { root } = opts;
  const def = opts.defaultBranch ?? "main";
  const originBare = join(root, "origin.git");
  const otherBare = join(root, "other.git");
  const seed = join(root, "seed");
  const work = join(root, "work");

  git(["init", "--bare", "-b", def, originBare], root);
  git(["init", "--bare", "-b", def, otherBare], root);

  git(["init", "-b", def, seed], root);
  git(["commit", "--allow-empty", "-m", "seed"], seed);
  git(["remote", "add", "origin", originBare], seed);
  git(["remote", "add", "other", otherBare], seed);
  git(["push", "origin", def], seed);
  git(["push", "other", def], seed);

  for (const b of opts.originBranches ?? []) {
    git(["branch", b, def], seed);
    git(["push", "origin", b], seed);
    git(["branch", "-D", b], seed);
  }
  for (const b of opts.otherBranches ?? []) {
    git(["branch", b, def], seed);
    git(["push", "other", b], seed);
    git(["branch", "-D", b], seed);
  }

  git(["clone", originBare, work], root);
  git(["remote", "add", "other", otherBare], work);
  git(["fetch", "other"], work);
  for (const b of opts.localBranches ?? []) git(["branch", b, def], work);

  return { work };
}

function revParseExitCode(ref: string, cwd: string): number {
  return spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd,
    encoding: "utf-8",
  }).status ?? 1;
}

describe("#164: candidates are scoped to this repository", () => {
  let root: string;
  let fx: Fixture;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "prior-branch-remotes-"));
    fx = makeFixture({
      root,
      originBranches: ["9001-origin-only"],
      otherBranches: ["9002-foreign-repo"],
      localBranches: ["9003-local-work"],
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("AC-3: a branch that exists only on a second remote is not adopted", async () => {
    const result = await detectPriorBranch({
      issueNumber: 9002,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result).toBeNull();
  });

  test("AC-3: an origin-only branch for an issue is still adopted", async () => {
    // Positive control for the case above: a filter narrowed to nothing would
    // pass that test and fail this one.
    const result = await detectPriorBranch({
      issueNumber: 9001,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result?.branch).toBe("9001-origin-only");
  });

  test("AC-2: refName for an origin-only branch resolves with git rev-parse", async () => {
    const result = await detectPriorBranch({
      issueNumber: 9001,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result).not.toBeNull();
    // The bug: `origin/x` became `x`, which rev-parse cannot resolve. branch
    // stays the bare name (ship.js pushes `HEAD:<branch>`); refName is the
    // resolvable one.
    expect(result!.branch).toBe("9001-origin-only");
    expect(result!.refName).toBe("refs/remotes/origin/9001-origin-only");
    expect(revParseExitCode(result!.refName, fx.work)).toBe(0);
  });

  test("AC-2: refName for a local branch resolves with git rev-parse", async () => {
    const result = await detectPriorBranch({
      issueNumber: 9003,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("9003-local-work");
    expect(result!.refName).toBe("refs/heads/9003-local-work");
    expect(revParseExitCode(result!.refName, fx.work)).toBe(0);
  });

  test("AC-4: a resolvable branch reports a numeric commit count", async () => {
    const result = await detectPriorBranch({
      issueNumber: 9001,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result!.commitCount).toBe(0);
  });
});

describe("#164: an unusable commit count is unknown, not zero", () => {
  let root: string;
  let fx: Fixture;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "prior-branch-norev-"));
    // No `main` in this repo, so `git rev-list main..<ref>` exits non-zero.
    fx = makeFixture({
      root,
      defaultBranch: "trunk",
      originBranches: ["9004-no-main"],
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("AC-4: a failing rev-list yields a null commit count, not 0", async () => {
    const result = await detectPriorBranch({
      issueNumber: 9004,
      projectRoot: fx.work,
      runTests: false,
    });
    expect(result).not.toBeNull();
    // `0` here is a lie the caller cannot detect: it reads as "the branch
    // exists and is fully merged", which is how a prior branch with real work
    // on it gets treated as empty.
    expect(result!.commitCount).toBeNull();
  });
});

describe("#164: the enumeration itself is scoped", () => {
  test("AC-1: the candidate list is built from for-each-ref over heads and origin", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "prior-branch.ts"), "utf-8");
    expect(src).toContain("for-each-ref");
    expect(src).toContain("refs/heads/");
    expect(src).toContain("refs/remotes/origin/");
    // The repo-wide listing is gone, not merely unused.
    expect(src).not.toMatch(/'branch',\s*'-a'/);
    expect(src).not.toMatch(/remotes\\\/\[\^\/\]\+\\\//);
  });
});

describe("#164: ship.js merges the resolvable ref", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("AC-5: the merge step is handed refName, not the stripped branch name", () => {
    // The step read `git merge <branch> --no-edit`, where <branch> was the
    // bare name detection had already stripped a remote prefix off.
    expect(shipSource).toContain("git merge <refName> --no-edit");
    expect(shipSource).not.toContain("git merge <branch> --no-edit");
  });

  test("AC-5: detection's refName is threaded into the workflow's prior-branch state", () => {
    expect(shipSource).toMatch(/refName:\s*priorResult\.priorRefName/);
    expect(shipSource).toMatch(/priorRefName/);
  });

  test("AC-5: pushTarget still uses the bare branch name", () => {
    // refName is for reading refs locally. The remote write is still
    // `HEAD:<bare name>` — pushing to `refs/remotes/origin/x` is not a thing.
    expect(shipSource).toMatch(/const pushTarget = branchToReuse \? `HEAD:\$\{branchToReuse\}`/);
  });

  test("AC-5: ship.js still parses after the edit", () => {
    const src = shipSource.replace(/^export /gm, "");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction("args", src)).not.toThrow();
  });
});
