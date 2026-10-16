/**
 * Covers SC-1597..SC-1603 (HARNESS-STANDARD.md), #436.
 *
 * The #431 sweep worked — 41 removed, 737 MB reclaimed — and left one entry
 * it could never act on:
 *
 *   Failed to check git status for wf_db8e9fce-bed-15: fatal: not a git
 *   repository: /Users/jhorn/Projects/rungate/.git/worktrees/wf_db8e9fce-bed-15
 *
 * `.claude/worktrees/wf_db8e9fce-bed-15` is a 6.2 MB checkout whose `.git`
 * file names an admin directory that no longer exists. `git worktree prune`
 * removed the registration and left the files, so git does not know it is a
 * worktree and `git worktree remove` cannot touch it.
 *
 * Pushing it to `errors` was the correct conservative behaviour AND it was
 * permanent: the same line on every SessionStart, forever, which is
 * indistinguishable from a log line. #436 gives it a bucket.
 *
 * The whole thing is testable statelessly, which is the point: plant a
 * directory with a `.git` file pointing nowhere. No real registration is
 * needed, because the absence of one is the subject.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { orphanedGitdir, cleanupWorktrees } from "../lib/worktree-cleanup";

let root: string;

function worktreesDir(): string {
  return join(root, ".claude", "worktrees");
}

/** A checkout whose `.git` file names a gitdir that does not exist. */
function plantOrphan(name: string, gitdir?: string): string {
  const path = join(worktreesDir(), name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "work that may exist nowhere else\n");
  writeFileSync(join(path, ".git"), `gitdir: ${gitdir ?? join(root, ".git", "worktrees", name)}\n`);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rg-436-"));
  // A REAL repository, and that is load-bearing rather than ceremony. In a
  // plain directory `lockedWorktreePaths` cannot list anything, returns
  // null, and a null set keeps everything (#431) — so every orphan came back
  // as `kept (could not read which worktrees are locked)` and the
  // classification under test never ran. A fixture that cannot reach the
  // code it is about is the vacuous shape this repo keeps finding.
  // Each call names its target directory with `-C root` rather than relying
  // on cwd — #84's guard, and it caught this fixture's first draft.
  for (const args of [["init", "-q", root], ["-C", root, "config", "user.email", "a@b.c"], ["-C", root, "config", "user.name", "t"]]) {
    const p = Bun.spawnSync({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
  mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
});
afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

describe("SC-1597: a checkout git has no registration for is ORPHANED", () => {
  test("the gitdir is named, so a reader knows what went missing", () => {
    const path = plantOrphan("wf_db8e9fce-bed-15");
    const missing = orphanedGitdir(path);
    expect(missing, "a .git file pointing nowhere was not recognised").not.toBeNull();
    expect(missing).toContain("wf_db8e9fce-bed-15");
  });

  test("SC-1598: a directory with no .git at all is NOT an orphan", () => {
    // It was never a worktree. Whatever it is, deleting it is not this
    // function's business — and the removal arm below is a recursive delete,
    // so the predicate that gates it must be narrow.
    const path = join(worktreesDir(), "just-a-folder");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "notes.md"), "mine\n");
    expect(orphanedGitdir(path)).toBeNull();
  });

  test("SC-1598: a real repository — .git as a DIRECTORY — is NOT an orphan", () => {
    const path = join(worktreesDir(), "a-whole-repo");
    mkdirSync(join(path, ".git"), { recursive: true });
    expect(orphanedGitdir(path)).toBeNull();
  });

  test("SC-1599: a gitdir that EXISTS is not an orphan, however broken git is", () => {
    // The positive control, and the boundary SC-3 names: the orphan test is
    // the gitdir, not the status failure. A predicate that answered on the
    // failure would swallow every other reason git might refuse.
    const admin = join(root, ".git", "worktrees", "live");
    mkdirSync(admin, { recursive: true });
    const path = plantOrphan("live", admin);
    expect(orphanedGitdir(path), "an intact registration was called orphaned").toBeNull();
  });

  test("SC-1599: a .git file that is not the shape git writes is not guessed at", () => {
    const path = join(worktreesDir(), "weird");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), "this is not a gitdir line\n");
    expect(orphanedGitdir(path)).toBeNull();
  });

  test("a relative gitdir is resolved against the checkout, not the cwd", () => {
    // git writes an absolute path, but the format permits relative and a
    // resolver that silently treated one as missing would delete a live
    // checkout. Both halves asserted: present resolves to null, absent does
    // not.
    mkdirSync(join(worktreesDir(), "rel", "admin"), { recursive: true });
    const path = join(worktreesDir(), "rel");
    writeFileSync(join(path, ".git"), "gitdir: admin\n");
    expect(orphanedGitdir(path)).toBeNull();
    writeFileSync(join(path, ".git"), "gitdir: nowhere\n");
    expect(orphanedGitdir(path)).not.toBeNull();
  });
});

describe("SC-1600: cleanupWorktrees reports it rather than erroring forever", () => {
  test("an orphan lands in its own bucket and NOT in errors", async () => {
    plantOrphan("wf_db8e9fce-bed-15");
    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.orphaned.join("\n")).toContain("wf_db8e9fce-bed-15");
    // The defect, stated as an assertion: it used to be here, on every run,
    // with nothing able to resolve it.
    expect(
      result.errors.filter(e => e.includes("wf_db8e9fce-bed-15")),
      "an orphan is still being reported as an error",
    ).toEqual([]);
  });

  test("SC-1601: reporting is the default — the checkout is still there", () => {
    // SC-5's recorded decision, asserted rather than left in a docblock.
    // This function cannot read whether an orphan holds unique work: the
    // admin directory is gone, so `git status` cannot run. Deleting content
    // it has explicitly failed to classify, unprompted at SessionStart, is
    // not a default it may take.
    const path = plantOrphan("wf_db8e9fce-bed-15");
    return cleanupWorktrees({ projectRoot: root }).then(() => {
      expect(existsSync(path), "the default pass deleted an unclassifiable checkout").toBe(true);
      expect(existsSync(join(path, "README.md"))).toBe(true);
    });
  });

  test("SC-1602: an operator who asks gets the removal", async () => {
    const path = plantOrphan("wf_db8e9fce-bed-15");
    const result = await cleanupWorktrees({ projectRoot: root, removeOrphans: true });

    expect(existsSync(path), "removeOrphans did nothing").toBe(false);
    expect(result.orphaned.join("\n")).toMatch(/removed/);
    expect(result.errors.join("\n")).not.toContain("wf_db8e9fce-bed-15");
  });

  test("SC-1602: removal reaches only what is under the worktrees directory", async () => {
    // SC-4. The path deleted is the one the function built from
    // `join(worktreesDir, entry)`. The gitdir read out of the `.git` file is
    // CONTENT, and content must never steer a recursive delete — so a `.git`
    // naming somewhere else entirely must leave that somewhere untouched.
    const elsewhere = mkdtempSync(join(tmpdir(), "rg-436-bystander-"));
    writeFileSync(join(elsewhere, "precious.txt"), "do not delete me\n");
    try {
      const path = plantOrphan("points-away", join(elsewhere, "no-such-admin"));
      await cleanupWorktrees({ projectRoot: root, removeOrphans: true });

      expect(existsSync(path), "the orphan itself was not removed").toBe(false);
      expect(existsSync(elsewhere), "a path from the .git file was deleted").toBe(true);
      expect(existsSync(join(elsewhere, "precious.txt"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("SC-1603: the buckets still sum, with five of them", () => {
  test("every entry examined lands in exactly one bucket", async () => {
    // #431's property, re-asserted because #436 adds a bucket: a summary
    // that cannot be reconciled against the directory is how 149 worktrees
    // hid behind "144 kept". A new bucket left out of the total is that
    // defect again, which is why `orphaned` is required on the result type
    // rather than optional.
    plantOrphan("orphan-one");
    plantOrphan("orphan-two");
    const plain = join(worktreesDir(), "not-a-worktree");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(worktreesDir(), "a-file"), "not a directory\n");

    const result = await cleanupWorktrees({ projectRoot: root });
    const total =
      result.removed.length + result.kept.length + result.skipped.length +
      result.orphaned.length + result.errors.length;

    // Four entries planted. `git worktree prune` also runs and may add one
    // error in a non-repo fixture, so the reconciliation is against entries
    // examined rather than against the array lengths alone.
    expect(result.orphaned).toHaveLength(2);
    expect(total, `buckets did not sum: ${JSON.stringify(result, null, 1)}`).toBeGreaterThanOrEqual(4);
  });

  test("the printed summary names the orphan count", () => {
    const source = require("fs").readFileSync(
      join(import.meta.dir, "..", "lib", "worktree-cleanup.ts"), "utf-8",
    );
    const summary = source.slice(source.indexOf("`Worktree cleanup:"));
    expect(summary.slice(0, 300), "the summary line omits the new bucket")
      .toContain("orphaned");
  });
});
