/**
 * #429 — a branch made off `origin/main` auto-publishes to main.
 *
 * Covers SC-1492, SC-1493, SC-1494 (HARNESS-STANDARD.md).
 *
 * `git checkout -b <name> origin/main` — the ordinary way to start work in
 * this repo — sets the new branch's upstream to `refs/heads/main`, not to a
 * ref of its own name. `verifiedPush` pushed to exactly whatever
 * `branch.<b>.merge` said, so the ship gate's auto-push sent a feature
 * branch's HEAD straight to `main` and recorded it as a verified success —
 * which it was, to the wrong ref.
 *
 * On 2026-10-15 that put four `wip:` commits on `origin/main` from a session
 * that never ran `git push`, and fourteen branches in this repo are still
 * configured that way.
 *
 * The inheritance is not simulated here. Every case below runs a real
 * `git checkout -b <name> origin/main` against a real bare remote and lets
 * git configure the upstream, because the defect IS git's default and a
 * hand-written `branch.x.merge` would be a test of the assertion rather than
 * of the behaviour.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { classifyPush, leftWorkLocal, verifiedPush, type Reading } from "../lib/verified-push";

let TMP = "";

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "rungate-429-"));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe", env: ENV });
}

function configure(dir: string) {
  git(dir, ["config", "user.email", "fixtures@rungate.invalid"]);
  git(dir, ["config", "user.name", "rungate fixtures"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

/**
 * A bare remote with `main`, plus a clone sitting on a NEW branch created the
 * way this repo creates them, carrying one unpushed commit.
 *
 * `startPoint` is the whole experiment: `origin/main` reproduces the
 * inheritance, and the same call with the branch's own pushed ref is the
 * control.
 */
function fixture(name: string, branch: string, startPoint: string) {
  const origin = join(TMP, `${name}.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe", env: ENV });

  const seed = join(TMP, `${name}-seed`);
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "pipe", env: ENV });
  configure(seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-u", "origin", "main"]);
  if (startPoint !== "origin/main") {
    // Publish the branch under its own name first, so the control's upstream
    // is its own ref rather than main's.
    git(seed, ["push", "origin", `main:${branch}`]);
  }

  const work = join(TMP, `${name}-work`);
  execFileSync("git", ["clone", origin, work], { stdio: "pipe", env: ENV });
  configure(work);
  git(work, ["checkout", "-b", branch, startPoint]);
  writeFileSync(join(work, "work.txt"), `${name}\n`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "local work"]);

  return { work, origin, mainSha: () => remoteSha(origin, "refs/heads/main") };
}

function remoteSha(repo: string, ref: string): string | null {
  const out = execFileSync("git", ["ls-remote", "--", repo, ref], { encoding: "utf-8", stdio: "pipe", env: ENV });
  return out.split("\t")[0]?.trim() || null;
}

const reading = (output: string): Reading => ({ ok: true, output });

function readings(branch: string, mergeRef: string) {
  return {
    branch: reading(branch),
    remoteName: reading("origin"),
    remoteRef: reading(mergeRef),
    ahead: reading("1"),
    localSha: reading("a".repeat(40)),
    push: null,
    remote: null,
  };
}

describe("SC-1492: a push whose target ref is not the branch's own name is refused", () => {
  test("the inheritance this guards against is real, not hypothesised", () => {
    // If this ever stops being true the guard is dead weight and should go.
    // It is asserted rather than described because it is the premise of
    // every case below, and it is a git default that could change.
    const { work } = fixture("premise", "feature-premise", "origin/main");
    expect(git(work, ["config", "--get", "branch.feature-premise.merge"]).trim()).toBe("refs/heads/main");
    expect(git(work, ["config", "--get", "branch.feature-premise.remote"]).trim()).toBe("origin");
  });

  test("verifiedPush does not move the remote's main", () => {
    const f = fixture("mismatch", "feature-a", "origin/main");
    const before = f.mainSha();
    const outcome = verifiedPush(f.work, { env: ENV });

    expect(outcome.kind).toBe("ref-mismatch");
    // The assertion that matters. Everything else could be satisfied by a
    // function that returns the right string and pushes anyway.
    expect(f.mainSha(), "the auto-push wrote the remote's main from a feature branch").toBe(before);
  });

  test("the refusal names both the branch and the ref it would have written", () => {
    const f = fixture("named", "feature-b", "origin/main");
    const outcome = verifiedPush(f.work, { env: ENV });
    expect(outcome.detail).toContain("feature-b");
    expect(outcome.detail).toContain("refs/heads/main");
  });

  test("the refusal counts as work left local, so it is never read as a completed push", () => {
    // `no-upstream` and `rejected` are already in that set. A new kind that
    // forgot to join it would report a blocked push as a finished one, which
    // is the class of defect this whole module exists to close (#213).
    expect(leftWorkLocal(classifyPush(readings("feature", "refs/heads/main")))).toBe(true);
  });
});

describe("SC-1493: the control — a branch tracking its own ref still pushes", () => {
  test("a correctly-tracking branch reaches the remote", () => {
    const f = fixture("control", "feature-c", "origin/feature-c");
    expect(git(f.work, ["config", "--get", "branch.feature-c.merge"]).trim()).toBe("refs/heads/feature-c");

    const outcome = verifiedPush(f.work, { env: ENV });
    expect(outcome.kind, `a well-configured branch must still push: ${outcome.detail}`).toBe("pushed");
    expect(remoteSha(f.origin, "refs/heads/feature-c")).toBe(git(f.work, ["rev-parse", "HEAD"]).trim());
  });

  test("main pushing to main is not a mismatch", () => {
    // The comparison is short-name equality, so the one branch whose upstream
    // legitimately IS `refs/heads/main` must not be caught by it.
    expect(classifyPush(readings("main", "refs/heads/main")).kind).not.toBe("ref-mismatch");
  });
});

describe("SC-1494: the comparison is on short names, in both directions", () => {
  test.each([
    ["feature", "refs/heads/main", true],
    ["feature", "refs/heads/feature", false],
    ["fix/405", "refs/heads/fix/405", false],
    ["fix/405", "refs/heads/405", true],
    ["main", "refs/heads/main", false],
    // The live config this issue found: a branch tracking an unrelated ref.
    ["fix/remove-hardcoded-quinn-rules", "refs/heads/ship-1344", true],
  ])("%s tracking %s → mismatch=%p", (branch, ref, mismatch) => {
    expect(classifyPush(readings(branch, ref)).kind === "ref-mismatch").toBe(mismatch);
  });

  test("a ref that is not under refs/heads/ is a mismatch, not a parse to nothing", () => {
    // `refs/heads/` is stripped by prefix, so a ref shaped differently must
    // fall through to the refusal rather than compare equal by accident.
    expect(classifyPush(readings("feature", "refs/tags/feature")).kind).toBe("ref-mismatch");
  });
});
