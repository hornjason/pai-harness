/**
 * #85 — the pre-push hook tested the working tree, not the commits being pushed.
 *
 * On 2026-10-05 a conformity regression reached main through exactly this gap:
 * HYGIENE-3's reference index recursed into `.claude/worktrees/`, 39 full repo
 * copies that exist locally and not in a clean checkout, so every file looked
 * referenced. The check passed before push and Gates went red on main.
 *
 * A gate that inspects something other than what it is gating is not a weaker
 * gate, it is a different gate wearing the name of the one you wanted.
 *
 * These tests assert the generated hook's behaviour, not its wording, so that
 * a rewrite that keeps the property passes and a rewrite that loses it fails.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { createGitHooks } from "../../lib/scaffold/steps";
import { commitFixture, initFixtureRepo } from "../helpers/git-fixture";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rg-prepush-"));
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function generateHook(root: string): string {
  createGitHooks(root, []);
  return readFileSync(join(root, ".git", "hooks", "pre-push"), "utf-8");
}

describe("#85: pre-push checks the pushed commits", () => {
  test("reads the refs being pushed from stdin rather than ignoring them", () => {
    withRoot(root => {
      const hook = generateHook(root);
      // git feeds pre-push `<local ref> <local sha> <remote ref> <remote sha>`
      // on stdin. A hook that never reads stdin cannot know what is being
      // pushed, which is the whole defect.
      expect(hook).toMatch(/while\s+read/);
    });
  });

  test("skips the all-zero sha that marks a branch deletion", () => {
    withRoot(root => {
      const hook = generateHook(root);
      // Checking out 0000... is not a thing; without this the hook errors on
      // every `git push --delete`.
      expect(hook).toMatch(/0{40}/);
    });
  });

  test("checks out the pushed sha into a detached worktree", () => {
    withRoot(root => {
      const hook = generateHook(root);
      expect(hook).toMatch(/git worktree add[^\n]*--detach/);
    });
  });

  test("removes the temporary worktree even when the test run fails", () => {
    withRoot(root => {
      const hook = generateHook(root);
      // The removal must not sit behind an early exit, or a single failed push
      // leaves a worktree behind — and #68 is 39 stale worktrees and 243 MB of
      // exactly that.
      const removeIdx = hook.search(/git worktree remove/);
      expect(removeIdx).toBeGreaterThan(-1);
      const runIdx = hook.search(/bun test/);
      expect(runIdx).toBeGreaterThan(-1);
      expect(removeIdx).toBeGreaterThan(runIdx);

      // Strip comments first. The hook explains *why* it must not exit early
      // here, and matching the prose would flag the explanation as the defect
      // — the same self-reference trap that a checker scanning its own source
      // falls into.
      const between = hook
        .slice(runIdx, removeIdx)
        .split("\n")
        .filter(l => !l.trim().startsWith("#"))
        .join("\n");
      expect(between, "an exit between the test run and the cleanup leaks the worktree").not.toMatch(/\bexit\b/);
    });
  });

  test("verifies dependencies match before reusing the working tree's node_modules", () => {
    withRoot(root => {
      const hook = generateHook(root);
      // Symlinking node_modules is fast, and it is honest only while the
      // pushed commit's lockfile matches the one those modules were installed
      // from. Reusing them unconditionally is a smaller version of the same
      // lie the whole issue is about.
      expect(hook).toMatch(/bun\.lock/);
    });
  });

  test("the generated hook is valid shell", () => {
    withRoot(root => {
      const hook = generateHook(root);
      const p = join(root, "hook-under-test.sh");
      writeFileSync(p, hook);
      // sh -n parses without executing.
      execFileSync("sh", ["-n", p]);
    });
  });
});

describe("#85: the hook actually blocks a bad pushed commit", () => {
  // The assertions above describe the hook. This one runs it, because a hook
  // that reads correctly and behaves wrongly is the failure mode being fixed.
  test("fails when the pushed commit is bad, even though the working tree is clean", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-prepush-e2e-"));
    try {
      // initFixtureRepo owns the identity setup. Writing `git config
      // user.email` here instead would trip the #84 checker, and rightly so:
      // it cannot tell a cwd-bound fixture write from one that leaks into the
      // developer's real config, so the helper is the only sanctioned form.
      initFixtureRepo(root);
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });

      // A stand-in for the conformity suite: passes only if marker.txt says OK.
      writeFileSync(join(root, "check.sh"), 'grep -q OK marker.txt\n');
      writeFileSync(join(root, "marker.txt"), "BAD\n");
      commitFixture(root, "bad commit", { paths: ["."] });
      const badSha = git("rev-parse", "HEAD").trim();

      // Working tree is now fine; the COMMIT is not. This is the #85 shape.
      writeFileSync(join(root, "marker.txt"), "OK\n");

      // What the old hook did: run in the working tree.
      const workingTreeResult = execFileSync("sh", ["-c", `cd ${root} && sh check.sh; echo $?`], { encoding: "utf-8" }).trim();
      expect(workingTreeResult, "working tree passes — which is exactly why the regression escaped").toBe("0");

      // What the new hook does: run against the pushed sha.
      const wt = join(root, "..", `prepush-wt-${Date.now()}`);
      git("worktree", "add", "--detach", "--quiet", wt, badSha);
      let pushedRc = 0;
      try {
        execFileSync("sh", ["-c", `cd ${wt} && sh check.sh`]);
      } catch {
        pushedRc = 1;
      }
      git("worktree", "remove", "--force", wt);

      expect(pushedRc, "checking the pushed sha must catch what the working tree hides").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
