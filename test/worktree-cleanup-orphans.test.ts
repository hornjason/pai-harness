/**
 * #431 — 149 worktrees, none removable, and the printed totals did not sum.
 *
 * Covers SC-1501, SC-1502, SC-1503 (HARNESS-STANDARD.md).
 *
 * `StaleTTLCleanup` reported `0 removed, 144 kept` at every session start
 * against 149 worktrees, the oldest 13.7 days old. Measured: 72 dirty, 71
 * clean-but-unmerged, 1 clean-and-merged, 4 detached, 1 missing.
 *
 * The 71 were the problem, and the rule keeping them was the wrong
 * question. **`git worktree remove` deletes a checkout, not a branch** — the
 * ref survives, its commits survive, `git checkout` brings it all back. What
 * can be lost is work existing in exactly one place: uncommitted changes,
 * and commits that never reached origin. So the real property is "is every
 * commit here also somewhere else", and the old code asked it SECOND, after
 * an `unmerged → keep` arm that returned first — the stronger check was dead
 * code for every branch that needed it.
 *
 * Asking it first both protects more (an unpushed branch merged into a
 * local-only main was removable before) and permits more (a fully-pushed
 * fan-out branch is just a stale directory).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cleanupWorktrees,
  lockKeepReason,
  lockedWorktreePaths,
  removalKeepReason,
  type OriginState,
} from "../lib/worktree-cleanup";

let TMP = "";
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "rungate-431-"));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe", env: ENV });
}

const ON_ORIGIN: OriginState = { kind: "on-origin" };
const AHEAD: OriginState = { kind: "ahead", count: 2 };
const UNKNOWN: OriginState = { kind: "unknown" };
const NO_ORIGIN: OriginState = { kind: "no-origin" };

describe("SC-1501: unmerged is not a reason on its own, unpushed is", () => {
  test("a clean unmerged branch whose commits are on origin is removable", () => {
    // The 71. Before this, `unmerged → keep` returned before the origin
    // check could run, so they accumulated for weeks.
    expect(removalKeepReason("wt", "fan-out-9", false, ON_ORIGIN)).toBeNull();
  });

  test("a merged branch whose commits are on origin is still removable", () => {
    expect(removalKeepReason("wt", "done", true, ON_ORIGIN)).toBeNull();
  });

  test("unpushed commits keep the worktree, merged or not", () => {
    // Work existing in exactly one place. #228 and #232 are both about work
    // that was correct and became unreachable.
    for (const merged of [true, false]) {
      const reason = removalKeepReason("wt", "risky", merged, AHEAD);
      expect(reason, `merged=${merged} must still be kept`).toContain("not on origin");
      expect(reason).toContain("2 commit");
    }
  });

  test("an unanswerable origin keeps the worktree", () => {
    // "I could not tell" is not grounds for `worktree remove --force`.
    expect(removalKeepReason("wt", "b", true, UNKNOWN)).toContain("could not tell");
    expect(removalKeepReason("wt", "b", false, UNKNOWN)).toContain("could not tell");
  });

  test("with no origin at all, merged is the only remaining evidence", () => {
    // The regression this arm exists to prevent. `unpushedCommitCount`
    // returns 0 for a remote-less repo — "nowhere to have pushed to" — so
    // without this, a local-only checkout's unmerged work would look
    // exactly like a fully-pushed branch and be deleted.
    expect(removalKeepReason("wt", "local", false, NO_ORIGIN)).toContain("no origin remote");
    expect(removalKeepReason("wt", "local", true, NO_ORIGIN)).toBeNull();
  });

  test("every OriginState kind is decided, none fall through to removable", () => {
    // A kind added later that nobody handled would return undefined, which
    // is falsy, which means remove — the fail-open shape, pointed at
    // `worktree remove --force`.
    const kinds: OriginState[] = [ON_ORIGIN, AHEAD, UNKNOWN, NO_ORIGIN];
    for (const o of kinds) {
      const r = removalKeepReason("wt", "b", false, o);
      expect(r === null || typeof r === "string", `${o.kind} is undecided`).toBe(true);
    }
  });
});

describe("SC-1502: a locked worktree is a claim, and an unreadable lock list keeps everything", () => {
  test("git's own lock is read from the porcelain listing", () => {
    const repo = join(TMP, "locks");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe", env: ENV });
    git(repo, ["config", "user.email", "f@f"]);
    git(repo, ["config", "user.name", "f"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "seed"]);

    const wt = join(TMP, "locks-wt");
    git(repo, ["worktree", "add", "-b", "claimed", wt]);

    // Probed through realpathSync, because git reports resolved paths and
    // on macOS the temp dir is under a /var -> /private/var symlink. The
    // first version of this compared raw paths and the lock check was inert
    // on the platform it was written on.
    const resolved = realpathSync(wt);
    expect(lockedWorktreePaths(repo)?.has(resolved)).toBe(false);
    git(repo, ["worktree", "lock", wt]);
    expect(lockedWorktreePaths(repo)?.has(resolved), "a lock must be visible to the sweeper").toBe(true);

    git(repo, ["worktree", "unlock", wt]);
  });

  test("each arm of the lock decision, including the one no fixture can stage", () => {
    // All three lock mutations scored ZERO when this logic was inline: the
    // tests drove `lockedWorktreePaths` directly and nothing drove the
    // branch in `cleanupWorktrees` that consumes it. Including the revert
    // of the realpath comparison, which makes the check inert on macOS.
    expect(lockKeepReason("wt", "/any/path", null)).toContain("could not read");
    expect(lockKeepReason("wt", "/a", new Set(["/a"]))).toBe("wt (locked)");
    expect(lockKeepReason("wt", "/a", new Set(["/b"]))).toBeNull();
    // An empty set is "nothing is claimed", which must not behave like null.
    expect(lockKeepReason("wt", "/a", new Set())).toBeNull();
  });

  test("cleanupWorktrees consults the lock decider, end to end", async () => {
    // The decider being right is not the same as the sweeper asking it.
    // Short-circuiting the call site to `null` scored ZERO against the
    // direct-drive tests above — they prove the decision, not the wiring,
    // which is the same split that made the whole lock check inert.
    const origin = join(TMP, "e2e-lock.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe", env: ENV });
    const root = join(TMP, "e2e-lock");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe", env: ENV });
    git(root, ["config", "user.email", "f@f"]);
    git(root, ["config", "user.name", "f"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "seed"]);
    git(root, ["remote", "add", "origin", origin]);
    git(root, ["push", "-q", "-u", "origin", "main"]);

    const wt = join(root, ".claude", "worktrees", "held");
    git(root, ["worktree", "add", "-b", "wt-held", wt]);
    git(root, ["push", "-q", "origin", "wt-held"]);
    git(root, ["worktree", "lock", wt]);

    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.removed, "a locked worktree was removed").toEqual([]);
    expect(result.kept.join("\n"), "the lock was not the reason it survived").toContain("(locked)");

    git(root, ["worktree", "unlock", wt]);
  });

  test("a locked worktree that is otherwise removable is kept", () => {
    // End-to-end, and the only case that can catch a raw-path comparison:
    // git reports the resolved path and the sweeper builds an unresolved
    // one, so on macOS a raw `has()` never matches and every lock is
    // ignored.
    const origin = join(TMP, "lockable.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe", env: ENV });
    const root = join(TMP, "lockable");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe", env: ENV });
    git(root, ["config", "user.email", "f@f"]);
    git(root, ["config", "user.name", "f"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "seed"]);
    git(root, ["remote", "add", "origin", origin]);
    git(root, ["push", "-q", "-u", "origin", "main"]);

    const wt = join(root, ".claude", "worktrees", "claimed");
    git(root, ["worktree", "add", "-b", "wt-claimed", wt]);
    git(root, ["push", "-q", "origin", "wt-claimed"]);

    // Unlocked first: this fixture really is removable, or the locked case
    // below would prove nothing.
    expect(lockKeepReason("claimed", wt, lockedWorktreePaths(root))).toBeNull();
    expect(removalKeepReason("claimed", "wt-claimed", false, ON_ORIGIN)).toBeNull();

    git(root, ["worktree", "lock", wt]);
    expect(lockKeepReason("claimed", wt, lockedWorktreePaths(root)), "the lock was not seen")
      .toBe("claimed (locked)");
    git(root, ["worktree", "unlock", wt]);
  });

  test("a repo git cannot list returns null, not an empty set", () => {
    // An empty set means "nothing is claimed" and would license removal of
    // everything. The caller keeps everything on null.
    expect(lockedWorktreePaths(join(TMP, "not-a-repo-at-all"))).toBeNull();
  });
});

describe("SC-1503: the printed totals reconcile against the directory", () => {
  test("removed + kept + skipped + errors is the number of entries", async () => {
    // 149 worktrees reported as "144 kept" because entries skipped for age
    // were counted in neither bucket. A summary that cannot be reconciled
    // against what it looked at is how that stayed invisible.
    const root = join(TMP, "sum");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe", env: ENV });
    git(root, ["config", "user.email", "f@f"]);
    git(root, ["config", "user.name", "f"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "seed"]);

    const dir = join(root, ".claude", "worktrees");
    const names = ["one", "two", "three"];
    for (const n of names) git(root, ["worktree", "add", "-b", `wt-${n}`, join(dir, n)]);
    // Everything is brand new, so the age filter skips all of it — which is
    // exactly the bucket that used to vanish.
    const result = await cleanupWorktrees({ projectRoot: root, maxAgeMs: 24 * 60 * 60 * 1000 });

    const counted = result.removed.length + result.kept.length + result.skipped.length + result.errors.length;
    expect(counted, `${names.length} entries examined, ${counted} accounted for`).toBe(names.length);
    expect(result.skipped.length).toBe(names.length);
    expect(result.removed).toEqual([]);
  });

  test("with no age filter the same entries are judged, not skipped", async () => {
    // The control for the row above: the skip must come from the filter and
    // not from the entries being unreadable, or the sum would reconcile for
    // the wrong reason.
    const root = join(TMP, "sum2");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe", env: ENV });
    git(root, ["config", "user.email", "f@f"]);
    git(root, ["config", "user.name", "f"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "seed"]);
    const wt = join(root, ".claude", "worktrees", "judged");
    git(root, ["worktree", "add", "-b", "wt-judged", wt]);
    // A branch freshly cut from main IS merged into main, so it would be
    // removable and this control would pass for the wrong reason. One
    // commit makes it genuinely unmerged.
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-m", "diverge"]);

    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.skipped).toEqual([]);
    // No origin and not merged into main, so it is kept — and the reason
    // says which arm decided, not merely that something did.
    expect(result.kept.join("\n")).toContain("no origin remote");
  });

  test("a worktree with uncommitted changes is never removed", async () => {
    // The control that must hold beside every positive case.
    const root = join(TMP, "dirty");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe", env: ENV });
    git(root, ["config", "user.email", "f@f"]);
    git(root, ["config", "user.name", "f"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "seed"]);
    const wt = join(root, ".claude", "worktrees", "dirty");
    git(root, ["worktree", "add", "-b", "wt-dirty", wt]);
    writeFileSync(join(wt, "uncommitted.txt"), "precious\n");

    const result = await cleanupWorktrees({ projectRoot: root });
    expect(result.removed).toEqual([]);
    expect(result.kept.join("\n")).toContain("uncommitted changes");
  });
});
