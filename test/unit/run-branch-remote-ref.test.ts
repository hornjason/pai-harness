/**
 * #640 — the run branch resolved from LOCAL HEADS ONLY, which is a confident
 * answer about a commit the run may never have pushed.
 *
 * `leftoverRunBranch` asked `git for-each-ref refs/heads/<branch>` and nothing
 * else. No remote ref is consulted anywhere, there is no argument that accepts
 * one, and the output never said which ref it read. Measured on the real pair
 * on 2026-10-19: `rungate/run-631` is `4acc0a17` locally and `92eb88cf`
 * through origin — 2 commits one way, 6 the other. Both error directions are
 * live, and the second is the one that costs work:
 *
 *   - the local ref is BEHIND the push → the containment check reports
 *     CONTAINED and `--mode delete` destroys commits that exist only under the
 *     remote name;
 *   - the local ref is AHEAD → the check refuses and the refusal is
 *     attributed to the run, which is the wrong conclusion drawn from a true
 *     reading.
 *
 * **The cheapest wrong fix, named before the repair it is measured against:
 * make `for-each-ref` also match `refs/remotes/origin/<branch>` and take
 * whichever it finds.** The symptom goes away — a remote-only branch stops
 * reading ABSENT — and when BOTH exist it silently picks one of two commits,
 * which is the state the real pair is in. The diverged cases below survive it
 * REALLY and not vacuously: they construct a pair whose local ref is contained
 * and whose remote ref is not, so a resolver that picks the local one reports
 * CONTAINED and deletes a branch holding seven paths the base does not have.
 *
 * Every fixture is a fresh repository under `mkdtemp`. Nothing here reads,
 * writes or branches the real checkout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { leftoverRunBranch, runBranchName, runBranchRefs } from "../../lib/run-branch";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const scratch = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `run-branch-remote-${tag}-`));
  made.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message);
}

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-run-branch.ts");
const run = (args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8", maxBuffer: 16e6 });
const localBranches = (root: string) =>
  git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);

/**
 * The fixture the whole file turns on: one branch NAME, two commits.
 *
 * The local head's work is squash-merged onto main, so it is CONTAINED and a
 * resolver that reads it alone authorises a deletion. The remote-tracking ref
 * carries one further commit adding a path main has never held, so the thing
 * the deletion would destroy is real and nameable.
 *
 * That asymmetry is deliberate and is what makes every case here survive the
 * cheapest wrong fix rather than go green under it: a resolver that "takes
 * whichever it finds" and finds the local one first reports CONTAINED.
 */
function divergedPair(tag: string, issue: number) {
  const root = scratch(tag);
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "base\n");
  commit(root, "base");

  const branch = runBranchName(issue);
  git(root, "switch", "-q", "-c", branch);
  write(root, "lib/landed.ts", "export const landed = 1;\n");
  commit(root, `wip(#${issue}): wave 1, which lands`);
  const local = git(root, "rev-parse", "HEAD");

  // One more commit, reachable only through the remote-tracking ref. This is
  // what `git fetch` leaves behind for work another session pushed.
  write(root, "lib/pushed-only.ts", "export const pushedOnly = 1;\n");
  commit(root, `wip(#${issue}): wave 2, pushed but never pulled`);
  const remote = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", `refs/remotes/origin/${branch}`, remote);

  // The local head goes back to the first commit, and its work is squash-
  // merged onto main — so by itself it reads CONTAINED.
  git(root, "switch", "-q", branch);
  git(root, "reset", "-q", "--hard", local);
  git(root, "switch", "-q", "main");
  git(root, "merge", "-q", "--squash", branch);
  commit(root, `fix(#${issue}): the squash merge, which destroys ancestry`);

  return { root, branch, local, remote };
}

/** One branch name, one commit, agreeing on both refs. The control. */
function agreeingPair(tag: string, issue: number) {
  const root = scratch(tag);
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "base\n");
  commit(root, "base");

  const branch = runBranchName(issue);
  git(root, "switch", "-q", "-c", branch);
  write(root, "lib/landed.ts", "export const landed = 1;\n");
  commit(root, `wip(#${issue}): wave 1 of 1`);
  const sha = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", `refs/remotes/origin/${branch}`, sha);

  git(root, "switch", "-q", "main");
  git(root, "merge", "-q", "--squash", branch);
  commit(root, `fix(#${issue}): squashed, so ancestry is gone`);
  return { root, branch, sha };
}

describe("#640: the run branch is resolved from both refs, and a disagreement is a reading", () => {
  /**
   * The premise, asserted rather than assumed.
   *
   * Without this the diverged cases below are claims about a fixture that
   * might hold one commit under two names, and every assertion in them would
   * be satisfiable by a resolver that never looked at the remote at all.
   */
  test("the premise: one branch name resolves to two different commits", () => {
    const { root, branch, local, remote } = divergedPair("premise", 700);
    expect(local).not.toBe(remote);
    expect(git(root, "rev-parse", `refs/heads/${branch}`)).toBe(local);
    expect(git(root, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(remote);
  });

  test("SC-2170: the two refs are resolved and a disagreement is reported, never chosen", () => {
    const { root, branch, local, remote } = divergedPair("diverged", 701);
    const r = runBranchRefs(root, branch);
    expect(r.reading).toBe("DIVERGED");
    if (r.reading !== "DIVERGED") throw new Error("unreachable");
    // Both commits are NAMED. A reading that picked one would be the cheapest
    // wrong fix wearing the shape of this one.
    expect(r.local).toBe(local);
    expect(r.remote).toBe(remote);
    expect(r.refusal).toContain(local.slice(0, 12));
    expect(r.refusal).toContain(remote.slice(0, 12));
  });

  test("SC-2174: every reading names which ref it resolved, and a disagreement resolves none", () => {
    // The output's own complaint on #640: nothing in it said which ref the
    // answer was about. A reading that cannot be attributed to a ref is a
    // reading an operator cannot check.
    const only = agreeingPair("agreed-ref", 702);
    const agreed = runBranchRefs(only.root, only.branch);
    expect(agreed.reading).toBe("AGREED");
    expect(agreed.resolvedRef).toBe(`refs/heads/${only.branch}`);
    expect(agreed.resolvedSha).toBe(only.sha);

    const { root, branch } = divergedPair("diverged-ref", 703);
    const diverged = runBranchRefs(root, branch);
    // Not a default, and not the local one quietly: a disagreement resolves
    // NOTHING, so there is no ref for a later step to act on.
    expect(diverged.resolvedRef).toBeNull();
    expect(diverged.resolvedSha).toBeNull();
  });

  test("SC-2173: a branch that exists only on the remote is not ABSENT", () => {
    // The other error direction, and the one the cheapest wrong fix was
    // reached for: a run starting while its branch exists only under the
    // remote name used to read ABSENT — indistinguishable from a clean start.
    const root = scratch("remote-only");
    git(root, "init", "-q", "-b", "main");
    write(root, "README.md", "base\n");
    commit(root, "base");
    const branch = runBranchName(704);
    git(root, "switch", "-q", "-c", branch);
    write(root, "lib/pushed-only.ts", "export const pushedOnly = 1;\n");
    commit(root, "wip(#704): pushed by another session");
    const sha = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-q", "main");
    git(root, "branch", "-q", "-D", branch);
    git(root, "update-ref", `refs/remotes/origin/${branch}`, sha);

    const r = runBranchRefs(root, branch);
    expect(r.reading).toBe("REMOTE_ONLY");
    expect(r.resolvedRef).toBe(`refs/remotes/origin/${branch}`);
    expect(r.resolvedSha).toBe(sha);

    // And the run is told, rather than starting as if nothing were there.
    const leftover = leftoverRunBranch(root, 704, "main");
    expect(leftover.reading).toBe("LEFTOVER_UNCONTAINED");
    if (leftover.reading !== "LEFTOVER_UNCONTAINED") throw new Error("unreachable");
    expect(leftover.notice).toContain("refs/remotes/origin/");

    // `git branch -D` cannot remove a ref that is not a local head, so the
    // delete mode refuses by name instead of reporting a deletion that git
    // declined.
    const deleted = run(["--mode", "delete", "--repo", root, "--issue", "704", "--base", "main"]);
    expect(deleted.status, "a remote-only ref is not a local head to delete").not.toBe(0);
    expect(deleted.stderr).toContain("REMOTE_ONLY");
  });

  test("SC-2172: a leftover whose refs disagree is LEFTOVER_DIVERGED, naming both commits", () => {
    const { root, local, remote } = divergedPair("leftover-diverged", 705);
    const r = leftoverRunBranch(root, 705, "main");
    expect(r.reading).toBe("LEFTOVER_DIVERGED");
    if (r.reading !== "LEFTOVER_DIVERGED") throw new Error("unreachable");
    expect(r.notice).toContain(local.slice(0, 12));
    expect(r.notice).toContain(remote.slice(0, 12));
    // Reported, not refused: `leftover` is a notice and the run continues.
    const cli = run(["--mode", "leftover", "--repo", root, "--issue", "705", "--base", "main"]);
    expect(cli.status, "leftover reports and does not refuse").toBe(0);
    expect(JSON.parse(cli.stdout).reading).toBe("LEFTOVER_DIVERGED");
  });

  test("SC-2171: a diverged pair is refused by the delete mode, and the branch survives", () => {
    // The destructive decision, and the whole reason the resolution matters.
    // The LOCAL head here is squash-merged onto main — a resolver reading it
    // alone says CONTAINED and deletes, destroying `lib/pushed-only.ts`,
    // which exists on no other ref.
    const { root, branch, local, remote } = divergedPair("delete-diverged", 706);
    const r = run(["--mode", "delete", "--repo", root, "--issue", "706", "--base", "main"]);
    expect(r.status, "a branch resolving to two commits must not be deleted").not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stderr).toContain("DIVERGED");
    expect(r.stderr).toContain(local.slice(0, 12));
    expect(r.stderr).toContain(remote.slice(0, 12));
    expect(JSON.parse(r.stdout).deleted).toBe(false);
    expect(localBranches(root), "the branch was deleted anyway").toContain(branch);
    // And the thing the deletion would have destroyed is still reachable.
    expect(git(root, "cat-file", "-t", remote)).toBe("commit");
  });

  test("SC-2175: the control — an agreeing pair is still deleted when it is contained", () => {
    // Without this the refusal above is indistinguishable from a check that
    // refuses everything, which is a gate nobody can act on and everybody
    // learns to click past. The pair varies ONE thing against SC-2171: the
    // remote ref's commit.
    const { root, branch } = agreeingPair("agreed-delete", 707);
    const r = run(["--mode", "delete", "--repo", root, "--issue", "707", "--base", "main"]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.deleted).toBe(true);
    expect(out.resolvedRef).toBe(`refs/heads/${branch}`);
    expect(localBranches(root)).not.toContain(branch);
  });

  test("SC-2176: a repository the refs cannot be read from is UNMEASURED, not absent", () => {
    const r = runBranchRefs(scratch("norepo"), runBranchName(708));
    expect(r.reading).toBe("UNMEASURED");
    if (r.reading !== "UNMEASURED") throw new Error("unreachable");
    expect(r.refusal).toContain("unknown is not absent");
    // …and the leftover reading built on it says the same thing rather than
    // reporting a clean start.
    expect(leftoverRunBranch(scratch("norepo-leftover"), 708, "main").reading).toBe("UNMEASURED");
  });

  test("the fixtures never name a path inside this repository", () => {
    for (const d of made) {
      expect(d.startsWith(tmpdir()), `${d} is not under the temp directory`).toBe(true);
      expect(existsSync(join(d, ".git", "worktrees"))).toBe(false);
    }
  });
});
