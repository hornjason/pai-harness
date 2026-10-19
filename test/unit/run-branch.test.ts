/**
 * #640 — the run branch: left checked out, and never deleted.
 *
 * The criterion that decides whether any of this is usable is the third:
 * **containment is compared by BLOBS PER PATH, never by ancestry.** Every
 * branch this repo creates is squash-merged, and a squash merge destroys
 * ancestry — measured on the six commits #511 and #512 recovered, `git
 * merge-base --is-ancestor` reported ORPHANED for all six, whose content
 * was fully on main. A cleanup built on ancestry refuses to delete every
 * branch it ever created.
 *
 * So the fixture pair criterion 6 asks for is CONSTRUCTED here rather than
 * taken from the tree: the two branches the issue originally named
 * (`rungate/run-621`, `rungate/run-627`) are already gone, deleted by
 * something other than this fix, and a criterion satisfied by branches that
 * no longer exist is satisfied by no code at all.
 *
 * Every fixture is a fresh repository under `mkdtemp`. Nothing here reads,
 * writes or branches the real checkout — `.claude/rules/parallel-sessions.md`
 * and the fact that another session's run is live on the primary right now.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  branchContainment,
  checkoutDrift,
  checkoutDriftRefusal,
  containmentRefusal,
  leftoverRunBranch,
  runBranchName,
} from "../../lib/run-branch";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const scratch = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `run-branch-${tag}-`));
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

/**
 * A repository with `main`, and a run branch carrying one commit.
 *
 * `land` decides which of the two halves of criterion 6 this is:
 *
 *   "squash"   — the branch's work is SQUASH-merged onto main, so the
 *                content is present and the ancestry is gone. This is the
 *                case `merge-base --is-ancestor` gets wrong, and the one
 *                the cleanup has to call contained.
 *   "none"     — the branch holds a path main does not have. Must refuse.
 */
function repoWithRunBranch(tag: string, issue: number, land: "squash" | "none") {
  const root = scratch(tag);
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "base\n");
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");

  const branch = runBranchName(issue);
  git(root, "switch", "-q", "-c", branch);
  write(root, "lib/feature.ts", "export const feature = 1;\n");
  commit(root, `wip(#${issue}): wave 1 of 1`);
  const tip = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-q", "main");
  if (land === "squash") {
    git(root, "merge", "-q", "--squash", branch);
    commit(root, `fix(#${issue}): the squash merge, which destroys ancestry`);
  }
  return { root, branch, base, tip };
}

describe("#640: containment is a blob comparison, and ancestry is the wrong question", () => {
  /**
   * The whole premise, asserted rather than assumed.
   *
   * Without this the squash case would be a fixture that reaches its
   * assertion without the feature (#500): if `--is-ancestor` happened to
   * say yes, the blob comparison would not be the thing doing the work and
   * nothing in the file would show it.
   */
  test("the premise: git's own ancestry check calls a squash-merged branch ORPHANED", () => {
    const { root, branch } = repoWithRunBranch("premise", 601, "squash");
    const r = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", branch, "main"]);
    expect(r.status, "if this is 0, the fixture is not a squash merge and this file measures nothing")
      .not.toBe(0);
  });

  test("a squash-merged run branch is CONTAINED — the case ancestry gets wrong", () => {
    const { root, branch } = repoWithRunBranch("squashed", 602, "squash");
    const r = branchContainment(root, branch, "main");
    expect(r.reading).toBe("CONTAINED");
    if (r.reading !== "CONTAINED") throw new Error("unreachable");
    // A comparison over zero paths is the thing that reads exactly like a
    // clean one. CONTAINED with nothing compared is not a reading.
    expect(r.comparedPaths, "a CONTAINED over zero paths witnessed nothing").toBeGreaterThan(0);
    expect(containmentRefusal(r)).toBeNull();
  });

  test("a run branch holding a path the base lacks is NOT_CONTAINED, and names it", () => {
    const { root, branch } = repoWithRunBranch("unlanded", 603, "none");
    const r = branchContainment(root, branch, "main");
    expect(r.reading).toBe("NOT_CONTAINED");
    if (r.reading !== "NOT_CONTAINED") throw new Error("unreachable");
    expect(r.divergent.map(d => d.path)).toEqual(["lib/feature.ts"]);
    expect(r.divergent[0].base, "the base holds nothing there, and that is the finding").toBe("ABSENT");
    expect(containmentRefusal(r)).toContain("lib/feature.ts");
    expect(containmentRefusal(r)).toContain("destroy that work");
  });

  /**
   * The mode half of the blob reading, which a content-only comparison
   * cannot see. In this repo a hook that loses its exec bit is silently
   * inert, so a merge that drops a `chmod +x` is a real loss with identical
   * bytes on both sides.
   */
  test("identical bytes at a different MODE are not contained", () => {
    const root = scratch("mode");
    git(root, "init", "-q", "-b", "main");
    write(root, "hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    commit(root, "base");

    git(root, "switch", "-q", "-c", "rungate/run-604");
    chmodSync(join(root, "hooks/pre-commit"), 0o755);
    commit(root, "make the hook executable");

    git(root, "switch", "-q", "main");
    const r = branchContainment(root, "rungate/run-604", "main");
    expect(r.reading, "same bytes, different mode — a blob-only comparison calls this contained")
      .toBe("NOT_CONTAINED");
    if (r.reading !== "NOT_CONTAINED") throw new Error("unreachable");
    expect(r.divergent[0].branch).toContain("100755");
    expect(r.divergent[0].base).toContain("100644");
  });

  test("a path the branch DELETED and the base still holds is not contained", () => {
    const root = scratch("deleted");
    git(root, "init", "-q", "-b", "main");
    write(root, "lib/old.ts", "export const old = 1;\n");
    commit(root, "base");

    git(root, "switch", "-q", "-c", "rungate/run-605");
    rmSync(join(root, "lib/old.ts"));
    commit(root, "drop it");

    git(root, "switch", "-q", "main");
    const r = branchContainment(root, "rungate/run-605", "main");
    expect(r.reading).toBe("NOT_CONTAINED");
    if (r.reading !== "NOT_CONTAINED") throw new Error("unreachable");
    expect(r.divergent[0]).toMatchObject({ path: "lib/old.ts", branch: "ABSENT" });
  });

  test("a base that moved on under an unrelated path does not make the branch divergent", () => {
    // The scope is what the BRANCH changed. Comparing whole trees would call
    // every branch divergent the moment anybody committed anything, which is
    // the same unusable refusal as ancestry, arriving from the other side.
    const { root, branch } = repoWithRunBranch("moved-on", 606, "squash");
    write(root, "docs/unrelated.md", "written after the squash\n");
    commit(root, "something else entirely");

    const r = branchContainment(root, branch, "main");
    expect(r.reading).toBe("CONTAINED");
  });

  test("a base that EDITED the branch's file afterwards refuses — the safe direction", () => {
    // A false NOT_CONTAINED costs a stale ref somebody deletes by hand. The
    // other direction destroys unmerged work, so this is the one to be
    // wrong in, and it is asserted rather than left to the reader.
    const { root, branch } = repoWithRunBranch("edited-after", 607, "squash");
    write(root, "lib/feature.ts", "export const feature = 2;  // changed later\n");
    commit(root, "a later change to the same file");

    const r = branchContainment(root, branch, "main");
    expect(r.reading).toBe("NOT_CONTAINED");
  });

  test("an unreadable repo, an absent ref and an empty argument are UNMEASURED", () => {
    const { root, branch } = repoWithRunBranch("unmeasured", 608, "squash");
    for (const [name, reading] of [
      ["no repo", branchContainment("", branch, "main")],
      ["a directory that is not a repository", branchContainment(scratch("norepo"), branch, "main")],
      ["a branch that does not exist", branchContainment(root, "rungate/run-999999", "main")],
      ["no base ref", branchContainment(root, branch, "")],
    ] as const) {
      expect(reading.reading, name).toBe("UNMEASURED");
      expect(containmentRefusal(reading), name).toBeTruthy();
    }
  });

  test("unrelated histories are UNMEASURED, not an empty diff", () => {
    // No merge base means no scope, and an empty scope compares clean. This
    // is the shape where a reading that could not be taken is byte-identical
    // to a branch with nothing on it.
    const root = scratch("unrelated");
    git(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "a\n");
    commit(root, "main");
    git(root, "checkout", "-q", "--orphan", "rungate/run-609");
    git(root, "rm", "-rq", "--cached", ".");
    rmSync(join(root, "a.txt"));
    write(root, "b.txt", "b\n");
    commit(root, "an unrelated history");
    git(root, "switch", "-q", "main");

    const r = branchContainment(root, "rungate/run-609", "main");
    expect(r.reading).toBe("UNMEASURED");
    if (r.reading !== "UNMEASURED") throw new Error("unreachable");
    expect(r.refusal).toContain("no merge base");
  });
});

describe("#640: the shared checkout is where the run found it", () => {
  test("the same branch at both ends is UNCHANGED and says nothing", () => {
    const d = checkoutDrift("main", "main");
    expect(d.reading).toBe("UNCHANGED");
    expect(checkoutDriftRefusal(d)).toBeNull();
  });

  test("a run that left the checkout on its own ref names both branches", () => {
    const d = checkoutDrift("main", "rungate/run-640");
    expect(d.reading).toBe("MOVED");
    const refusal = checkoutDriftRefusal(d);
    expect(refusal).toContain("rungate/run-640");
    expect(refusal, "the branch it should have gone back to is half the message").toContain("main");
  });

  test("an unread end is UNMEASURED, not unchanged", () => {
    // Two empty strings compare equal, which is how a comparison that never
    // happened passes. Each side is named separately so the message says
    // WHICH reading is missing.
    expect(checkoutDrift("", "").reading).toBe("UNMEASURED");
    expect(checkoutDrift("main", "").reading).toBe("UNMEASURED");
    expect(checkoutDrift("", "main").reading).toBe("UNMEASURED");
    expect(checkoutDrift("main", "   ").reading).toBe("UNMEASURED");
    expect(checkoutDriftRefusal(checkoutDrift("main", ""))).toContain("the end");
    expect(checkoutDriftRefusal(checkoutDrift("", "main"))).toContain("the start");
  });
});

describe("#640: a leftover run branch is reported, not silently reused", () => {
  test("no branch of that name is ABSENT", () => {
    const root = scratch("no-leftover");
    git(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "a\n");
    commit(root, "base");
    expect(leftoverRunBranch(root, 610, "main").reading).toBe("ABSENT");
  });

  test("a leftover whose work already landed says so, and does not refuse", () => {
    const { root } = repoWithRunBranch("leftover-contained", 611, "squash");
    const r = leftoverRunBranch(root, 611, "main");
    expect(r.reading).toBe("LEFTOVER_CONTAINED");
    if (r.reading !== "LEFTOVER_CONTAINED") throw new Error("unreachable");
    expect(r.notice).toContain("already exists");
    expect(r.notice).toContain("not work in progress");
  });

  test("a leftover holding work names the paths and warns the run will commit onto it", () => {
    const { root } = repoWithRunBranch("leftover-work", 612, "none");
    const r = leftoverRunBranch(root, 612, "main");
    expect(r.reading).toBe("LEFTOVER_UNCONTAINED");
    if (r.reading !== "LEFTOVER_UNCONTAINED") throw new Error("unreachable");
    expect(r.divergent.map(d => d.path)).toEqual(["lib/feature.ts"]);
    expect(r.notice).toContain("This run will commit onto it");
  });

  test("a repository it cannot ask is UNMEASURED, not ABSENT", () => {
    const r = leftoverRunBranch(scratch("leftover-norepo"), 613, "main");
    expect(r.reading).toBe("UNMEASURED");
    if (r.reading !== "UNMEASURED") throw new Error("unreachable");
    expect(r.notice).toContain("unknown is not absent");
  });
});

describe("#640: the CLI deletes a contained branch and refuses an uncontained one", () => {
  const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-run-branch.ts");
  const run = (args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8", maxBuffer: 16e6 });
  const branches = (root: string) =>
    git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);

  /**
   * Criterion 6, as one case over the constructed pair.
   *
   * One repository, two run branches, differing in exactly one thing:
   * whether the work landed. Running the same command against both and
   * comparing the two outcomes is what makes this a measurement of
   * containment rather than two separate assertions that happen to agree
   * (#585).
   */
  test("the constructed pair: the squash-merged one is deleted, the other refused by name", () => {
    const root = scratch("pair");
    git(root, "init", "-q", "-b", "main");
    write(root, "README.md", "base\n");
    commit(root, "base");

    for (const [issue, land] of [[621, "squash"], [627, "none"]] as const) {
      git(root, "switch", "-q", "-c", runBranchName(issue), "main");
      write(root, `lib/${issue}.ts`, `export const n = ${issue};\n`);
      commit(root, `wip(#${issue}): wave 1 of 1`);
      git(root, "switch", "-q", "main");
      if (land === "squash") {
        git(root, "merge", "-q", "--squash", runBranchName(issue));
        commit(root, `fix(#${issue}): squashed, so ancestry is gone`);
      }
    }
    expect(branches(root).sort()).toEqual(["main", "rungate/run-621", "rungate/run-627"]);

    const contained = run(["--mode", "delete", "--repo", root, "--issue", "621", "--base", "main"]);
    expect(contained.status, contained.stderr).toBe(0);
    expect(JSON.parse(contained.stdout).deleted).toBe(true);

    const uncontained = run(["--mode", "delete", "--repo", root, "--issue", "627", "--base", "main"]);
    expect(uncontained.status, "an uncontained branch must not be deleted").not.toBe(0);
    expect(uncontained.stderr).toContain("REFUSED");
    expect(uncontained.stderr, "the refusal has to name the path, or nobody can act on it")
      .toContain("lib/627.ts");

    // The outcome of the pair, read off the repository rather than off the
    // two exit codes: one gone, one still there.
    expect(branches(root).sort()).toEqual(["main", "rungate/run-627"]);
  });

  test("drift exits non-zero and names both branches", () => {
    const moved = run(["--mode", "drift", "--before", "main", "--after", "rungate/run-640"]);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain("rungate/run-640");
    const same = run(["--mode", "drift", "--before", "main", "--after", "main"]);
    expect(same.status, same.stderr).toBe(0);
    expect(JSON.parse(same.stdout).reading).toBe("UNCHANGED");
  });

  test("an unread drift end refuses rather than comparing two empty strings", () => {
    const r = run(["--mode", "drift", "--before", "main", "--after", ""]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown is not unchanged");
  });

  test("leftover reports and exits ZERO — an interrupted run is usually resumable", () => {
    const { root } = repoWithRunBranch("cli-leftover", 614, "none");
    const r = run(["--mode", "leftover", "--repo", root, "--issue", "614", "--base", "main"]);
    expect(r.status, "a gate that stopped every re-run is one that gets switched off").toBe(0);
    expect(JSON.parse(r.stdout).reading).toBe("LEFTOVER_UNCONTAINED");
    expect(r.stderr).toContain("This run will commit onto it");
    // And the branch is still there: `leftover` reads, it does not remove.
    expect(branches(root)).toContain("rungate/run-614");
  });

  test("the arguments each mode needs are required, and named per mode", () => {
    expect(run([]).stderr).toContain("--mode is required");
    expect(run(["--mode", "sweep"]).stderr).toContain("--mode must be one of");
    expect(run(["--mode", "drift", "--before", "main"]).stderr).toContain("--after is required");
    expect(run(["--mode", "delete", "--repo", "/tmp"]).stderr).toContain("--issue is required");
    // --repo is meaningless to drift, so drift must not demand it.
    expect(run(["--mode", "drift", "--before", "a", "--after", "a"]).status).toBe(0);
  });

  test("every refusal travels through one exit constant", () => {
    // One site to mutate, so a case can prove the non-zero exit is what it
    // observed. A later branch inlining `process.exit(1)` would bypass the
    // mutation and the case would go green having witnessed nothing.
    const src = require("fs").readFileSync(SCRIPT, "utf-8") as string;
    expect(src.match(/export const REFUSE_EXIT = 1;/g) ?? []).toHaveLength(1);
    expect(src.match(/process\.exit\(\s*[0-9]/g) ?? []).toHaveLength(0);
  });

  test("the fixtures never name a path inside this repository", () => {
    // Asserted, not promised. Every repo above is built under mkdtemp, and
    // another session's run is live on the real primary right now.
    for (const d of made) {
      expect(d.startsWith(tmpdir()), `${d} is not under the temp directory`).toBe(true);
      expect(existsSync(join(d, ".git", "worktrees"))).toBe(false);
    }
  });
});
