/**
 * Covers SC-1926..SC-1929 (HARNESS-STANDARD.md), #553.
 *
 * Two security reviews arrived from peer sessions on 2026-10-17. Both
 * reported CONFIRMED findings, both were measured against a tree the branch
 * had already moved past, and in both cases the report gave no way to tell:
 * sec-492's findings were pinned to a tree two later commits had already
 * fixed, and two of its "0 red" mutation rows are 3 and 1 on main.
 *
 * The fixtures are real repositories with a real second commit, because the
 * thing under test is "the branch moved under me" and that is a fact about
 * git rather than about a string comparison.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  STALE_EXIT,
  WRONG_TREE,
  branchAt,
  defaultRef,
  provenanceBlock,
  provenanceReading,
} from "../lib/report-provenance";

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const CLI = join(REPO_ROOT, "scripts", "report-provenance.ts");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 }).trim();
}

/** A repository with one commit on `main`. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-553-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "one"]);
  return root;
}

function commit(root: string, text: string): string {
  writeFileSync(join(root, "a.ts"), text);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "more"]);
  return git(root, ["rev-parse", "HEAD"]);
}

describe("#553: a report states the tree it measured", () => {
  test("SC-1926: a branch that moved does not read like one that did not", () => {
    const root = repo();
    const measured = git(root, ["rev-parse", "HEAD"]);

    // Before: the report describes the tip.
    const fresh = provenanceReading(root, measured);
    expect(fresh.current, "an unmoved branch was called stale").toBe(true);
    expect(provenanceBlock(fresh)).toContain(measured);

    // The branch moves, exactly as it did under sec-492 — and the reading
    // is the ONLY thing that changed, since the report text would not have.
    const moved = commit(root, "export const a = 2;\n");
    const stale = provenanceReading(root, measured);
    expect(stale.current, "a branch that moved still read as current").toBe(false);
    expect(stale.tip).toBe(moved);
    // Both operands, or the reader cannot tell which tree to go and look at.
    expect(stale.reason).toContain(measured);
    expect(stale.reason).toContain(moved);

    // And in the BLOCK, which is the artefact that actually travels. The
    // reading can be perfect and the pasted three lines still omit the tip,
    // which is the omission this whole issue is about — measured at 0 red
    // before this assertion existed.
    const block = provenanceBlock(stale);
    expect(block, "the block does not name the tree that was measured").toContain(measured);
    expect(block, "the block does not name the tip the branch moved to").toContain(moved);
    expect(block, "the block does not name the ref it compared against").toContain(stale.ref!);
  });

  test("SC-1927: a currency it could not establish is never a pass", () => {
    // Silence reads as current, so every unanswerable case has to be loud.
    // A directory that is not a repository at all:
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "rg-553-bare-")));
    roots.push(bare);
    const nothing = provenanceReading(bare);
    expect(nothing.current).toBe(false);
    expect(nothing.reason).toContain("UNMEASURED");
    expect(defaultRef(bare)).toBeNull();

    // A detached HEAD has no branch to age against, which is the state every
    // `git archive` export and every `--detach` worktree is in.
    const root = repo();
    commit(root, "export const a = 3;\n");
    git(root, ["checkout", "-q", "--detach", "HEAD~1"]);
    expect(defaultRef(root), "a detached HEAD invented a branch").toBeNull();
    expect(provenanceReading(root).current).toBe(false);

    // A ref that does not exist is UNMEASURED, not stale: "I could not look"
    // and "I looked and it moved" are different things to write in a report.
    git(root, ["checkout", "-q", "main"]);
    const noRef = provenanceReading(root, undefined, "origin/not-a-branch");
    expect(noRef.current).toBe(false);
    expect(noRef.reason).toContain("UNMEASURED");
    expect(noRef.tip).toBeNull();

    // …and the positive control, or every case above is satisfied by a
    // function that always refuses.
    expect(provenanceReading(root, undefined, "main").current).toBe(true);
  });

  test("SC-1928: origin is preferred over the local branch, because that is what a peer can see", () => {
    const root = repo();
    const origin = realpathSync(mkdtempSync(join(tmpdir(), "rg-553-origin-")));
    roots.push(origin);
    git(origin, ["init", "-q", "--bare", "-b", "main"]);
    git(root, ["remote", "add", "origin", origin]);
    git(root, ["push", "-q", "origin", "main"]);
    expect(defaultRef(root), "a pushed branch was aged against the local ref").toBe("origin/main");

    // An unpushed local commit is ahead of origin, and the report is aged
    // against what the reader can fetch — which is the honest comparison and
    // is also what makes "I have not pushed" visible.
    const local = commit(root, "export const a = 4;\n");
    const reading = provenanceReading(root, local);
    expect(reading.ref).toBe("origin/main");
    expect(reading.current, "an unpushed commit was reported as the tip of origin").toBe(false);

    // With no remote at all, the local branch is the honest answer rather
    // than an error — unpushed work is still work somebody reviews.
    const solo = repo();
    expect(defaultRef(solo)).toBe("main");
    expect(provenanceReading(solo).current).toBe(true);
  });

  test("SC-1929: the CLI exits non-zero on a stale reading", () => {
    // The library is what decides, and every case above stays green if the
    // script prints the block and exits 0 regardless — the one line that
    // makes a reviewer stop and re-measure.
    const root = repo();
    const measured = git(root, ["rev-parse", "HEAD"]);
    commit(root, "export const a = 5;\n");

    const run = (args: string[]) =>
      Bun.spawnSync(["bun", CLI, "--project", root, ...args], { stdout: "pipe", stderr: "pipe" });

    const stale = run(["--measured", measured]);
    expect(stale.exitCode, "a stale report exited 0").toBe(STALE_EXIT);
    expect(STALE_EXIT).not.toBe(0);
    const staleOut = new TextDecoder().decode(stale.stdout);
    expect(staleOut).toContain("NOT CURRENT");
    expect(staleOut, "the block does not name the tree that was measured").toContain(measured);

    const current = run([]);
    expect(current.exitCode, "a current report was refused").toBe(0);
    expect(new TextDecoder().decode(current.stdout)).toContain("Currency: CURRENT");
  });
});

/** A second worktree of `root`, on its own branch — what a swarm agent works in. */
function worktree(root: string, branch: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "rg-1348-wt-")));
  rmSync(path, { recursive: true, force: true });
  git(root, ["worktree", "add", "-q", "-b", branch, path]);
  roots.push(path);
  return path;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("#1348: a reading names the directory it was taken in", () => {
  test("SC-2500: the block names the directory and branch, not only two SHAs", () => {
    const root = repo();
    const reading = provenanceReading(root);

    expect(reading.root).toBe(root);
    expect(reading.branch).toBe("main");

    // The SHAs alone do not say WHERE they were read. Two agents on
    // 2026-10-23 each had to establish that by hand from a block that
    // carried three lines of commits and no directory.
    const block = provenanceBlock(reading);
    expect(block, "the block does not name the directory it measured").toContain(
      `Measured in: ${root} (branch main)`,
    );

    // A detached HEAD has no branch, and saying so beats inventing one.
    git(root, ["checkout", "-q", "--detach", "HEAD"]);
    expect(branchAt(root), "a detached HEAD invented a branch").toBeNull();
    expect(provenanceBlock(provenanceReading(root))).toContain(`(branch none)`);
  });

  test("SC-2501: a reading taken outside the tree under review is UNMEASURED, not current", () => {
    const root = repo();
    commit(root, "export const a = 6;\n");
    const wt = worktree(root, "rg/under-review");

    // This is the defect exactly. The agent's working directory is `root`;
    // the work under review is in `wt`, reached only with `git -C`. Nothing
    // in the reading disagrees, so it is a confident CURRENT about a
    // directory nobody asked about.
    const silent = provenanceReading(root);
    expect(silent.current, "the unguarded reading no longer reproduces the defect").toBe(true);
    expect(silent.branch).toBe("main");

    const wrong = provenanceReading(root, undefined, undefined, "rg/under-review");
    expect(wrong.current, "a reading taken in the wrong tree read as current").toBe(false);
    expect(wrong.reason).toContain(WRONG_TREE);
    expect(wrong.reason, "the refusal does not name the directory it read").toContain(root);
    expect(wrong.reason, "the refusal does not name the branch under review").toContain(
      "rg/under-review",
    );
    expect(wrong.reason, "the refusal does not name the branch it was on").toContain("main");

    // CONTROL. Without this row every assertion above is satisfied by
    // "refuse whenever an expectation is passed", which measures nothing and
    // would be refused on the branch it was meant to clear.
    const right = provenanceReading(wt, undefined, undefined, "rg/under-review");
    expect(right.current, "a reading taken in the tree under review was refused").toBe(true);
    expect(right.branch).toBe("rg/under-review");
  });

  test("SC-2502: the CLI exits non-zero when it measured another tree", () => {
    const root = repo();
    const wt = worktree(root, "rg/cli-under-review");
    const run = (project: string, args: string[]) =>
      Bun.spawnSync(["bun", CLI, "--project", project, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

    // The library can decide perfectly and every case above stays green if
    // the script prints the block and exits 0 — SC-1929's lesson, re-run for
    // the flag that did not exist when it was written.
    const refused = run(root, ["--expect-branch", "rg/cli-under-review"]);
    expect(refused.exitCode, "the CLI measured another tree and exited 0").toBe(STALE_EXIT);
    const out = decode(refused.stdout);
    expect(out).toContain(WRONG_TREE);
    expect(out, "the block does not name the directory the CLI read").toContain(root);

    // CONTROL, for the same reason as SC-2501's.
    const ok = run(wt, ["--expect-branch", "rg/cli-under-review"]);
    expect(ok.exitCode, "the CLI refused the tree under review").toBe(0);
    expect(decode(ok.stdout), "the control did not reach a currency verdict").toContain(
      "Currency: CURRENT",
    );
  });
});
