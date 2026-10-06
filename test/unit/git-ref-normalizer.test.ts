/**
 * Evidence commands must name `origin/main`, never bare `main` (#118).
 *
 * #103's AC-4 required `hooks/TestSuiteGuard.hook.ts` to be unchanged. The
 * evidence command was:
 *
 *   git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?
 *
 * It returned 1. The verify agent reported, in detail and with conviction, that
 * a 5-line block had been added at lines 30-34 and should be reverted. That
 * block is in `origin/main` and has been since #67. Against `origin/main` the
 * same command exits 0.
 *
 * The false FAIL triggered a verify-gate re-implementation — a second Marcus
 * spawned to fix a file that was already correct — and cost roughly 300k tokens
 * before the run ended.
 *
 * WHY BARE `main` IS NOT A REF YOU CAN TRUST HERE
 *
 * Agent worktrees come from a shared clone whose local `main` is whatever it
 * was when that ref was last updated locally — not when `origin/main` last
 * moved. Sessions work on branches and rarely check out `main`, so the local
 * ref drifts arbitrarily far behind and every agent inherits the drift. The
 * same command on the same commit can pass in one worktree and fail in another.
 * An evidence command that is not reproducible is not evidence.
 *
 * WHY THIS IS A STATIC REWRITE AND NOT AN AUTO-FIX
 *
 * `lib/evidence-prevalidator.ts` already auto-fixes commands, but only ones
 * whose dry-run FAILS. A stale-`main` command frequently succeeds at
 * prevalidation — local `main` is only sometimes behind — and then fails at
 * Verify. Keying the repair on exit code would leave exactly the #103 case
 * unrepaired. The defect is in the text of the command, so the repair has to be
 * too.
 */

import { describe, test, expect } from "bun:test";
import { normalizeGitRefs } from "../../lib/git-ref-normalizer";

const rewritten = (cmd: string) => normalizeGitRefs(cmd).command;
const changed = (cmd: string) => normalizeGitRefs(cmd).changed;

describe("bare main used as a git ref is rewritten", () => {
  test("the exact #103 command", () => {
    expect(rewritten("git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?"))
      .toBe("git diff --exit-code origin/main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?");
  });

  for (const [before, after] of [
    ["git diff main..HEAD", "git diff origin/main..HEAD"],
    ["git diff main...HEAD", "git diff origin/main...HEAD"],
    ["git log main..HEAD --oneline", "git log origin/main..HEAD --oneline"],
    ["git merge-base main HEAD", "git merge-base origin/main HEAD"],
    ["git rev-parse main", "git rev-parse origin/main"],
    ["git diff --stat main", "git diff --stat origin/main"],
    ["git diff --name-only main HEAD", "git diff --name-only origin/main HEAD"],
  ] as Array<[string, string]>) {
    test(`rewrites: ${before}`, () => {
      expect(rewritten(before)).toBe(after);
      expect(changed(before)).toBe(true);
    });
  }

  test("rewrites master the same way", () => {
    // Consumer projects may still use master. Leaving it bare reproduces the
    // bug under a different name.
    expect(rewritten("git diff master..HEAD")).toBe("git diff origin/master..HEAD");
  });

  test("handles more than one ref in one command", () => {
    expect(rewritten("git log main..HEAD && git diff main"))
      .toBe("git log origin/main..HEAD && git diff origin/main");
  });
});

describe("things that merely contain the word main are left alone", () => {
  // Every one of these would be a silent corruption of a working command, which
  // is worse than the bug being fixed: the repair would create false failures
  // instead of removing them.
  for (const cmd of [
    "git diff origin/main -- x.ts",
    "git diff upstream/main..HEAD",
    "grep -rn 'main' src/",
    "bun test test/main.test.ts",
    "git diff -- src/main.ts",
    "git diff HEAD~1 -- lib/main-loop.ts",
    "rg --files-with-matches maintenance lib/",
    "git log --author=maintainer",
    "echo domain",
  ]) {
    test(`leaves alone: ${cmd}`, () => {
      expect(rewritten(cmd), "a non-ref occurrence of 'main' was rewritten").toBe(cmd);
      expect(changed(cmd)).toBe(false);
    });
  }

  test("a path after -- is never a ref, even when it is literally 'main'", () => {
    // `--` ends the ref list; everything after is a pathspec. A file named
    // `main` is unusual but legal, and rewriting it would point git at a
    // directory that does not exist.
    expect(rewritten("git diff main -- main")).toBe("git diff origin/main -- main");
  });
});

describe("the rewrite is safe to apply repeatedly", () => {
  test("running it twice changes nothing the second time", () => {
    // The prevalidator may run more than once per AC across retries. A
    // non-idempotent rewrite would produce origin/origin/main.
    const once = rewritten("git diff main..HEAD");
    expect(rewritten(once)).toBe(once);
    expect(changed(once)).toBe(false);
  });

  test("already-correct commands report no change", () => {
    expect(changed("git diff origin/main -- a.ts")).toBe(false);
  });
});

describe("non-git commands are not touched", () => {
  test("a bun test command passes through", () => {
    expect(rewritten("bun test test/unit/x.test.ts")).toBe("bun test test/unit/x.test.ts");
  });

  test("an empty command does not throw", () => {
    expect(rewritten("")).toBe("");
  });
});
