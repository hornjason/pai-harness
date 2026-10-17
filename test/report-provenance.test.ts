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
