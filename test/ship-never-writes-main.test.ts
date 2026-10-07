/**
 * The ship workflow does not write to the default branch (#136)
 *
 * SC-539..SC-543 (HARNESS-STANDARD.md)
 *
 * A run finished `SHIPPED` with its code on `main` as a direct, non-merge
 * commit — no pull request, no pre-merge CI. Two faults stacked:
 *
 *   1. The step was MEANT to merge to main. `git merge <worktreeBranch>` into
 *      whatever branch PROJECT_ROOT happened to be on, in the Verify phase,
 *      before the PR step ran at all.
 *   2. The push target was unspecified — bare `git push`. It failed, and the
 *      agent recovered by choosing `git push origin HEAD:main`. The exact ref
 *      written to the default branch was picked by a language model.
 *
 * These assertions are about ship.js's source because a workflow script is
 * not importable — the sandbox gives it no module loading (#69). The branch
 * NAME validation they depend on is executed, not grepped, in
 * test/workflow-security-integration.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/**
 * Every `git push` the script can emit, as written.
 *
 * Comment lines are skipped — this file and ship.js both have to be able to
 * say the words "bare `git push`" while describing the bug, and a sweep that
 * cannot tell prose from an instruction would be satisfied by deleting a
 * comment.
 */
function pushCommands(source: string): string[] {
  return source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .flatMap(line => [...line.matchAll(/git push[^\n`&|;]*/g)].map(m => m[0].trim()));
}

describe("#136: no push leaves its target to the agent", () => {
  test("there are pushes to check — an empty sweep is not a pass", () => {
    expect(pushCommands(shipSource).length).toBeGreaterThan(0);
  });

  test("every push names an explicit ref", () => {
    // A bare `git push` resolves against whatever upstream the checkout has,
    // which on a shared checkout is the default branch. `HEAD:<branch>` and
    // `-u origin <pushTarget>` both say where the write goes.
    const bare = pushCommands(shipSource).filter(
      cmd => !/\bHEAD:/.test(cmd) && !/-u origin \$\{pushTarget\}/.test(cmd),
    );
    expect(bare).toEqual([]);
  });

  test("no push names main or master as a target", () => {
    const toDefault = pushCommands(shipSource).filter(cmd => /\b(main|master)\b/.test(cmd));
    expect(toDefault).toEqual([]);
  });
});

describe("#136: the auto-merge is gone, not relocated", () => {
  test("nothing merges the work branch into the checkout's branch", () => {
    // The step that did this read:
    //   1. Merge: cd ${PROJECT_ROOT} && git merge ${worktreeBranch} --no-edit
    //   2. Push:  cd ${PROJECT_ROOT} && git push
    expect(shipSource).not.toMatch(/git merge \$\{worktreeBranch\}/);
    expect(shipSource).not.toContain("label: 'merge-and-push'");
  });

  test("the prior-branch merge refuses to run on the default branch", () => {
    // That merge has no push after it, so it only dirties a local checkout —
    // but a shared checkout left with merged, unpushed commits is the exact
    // invisibility .claude/rules/parallel-sessions.md exists to prevent.
    expect(shipSource).toContain("SKIPPED MERGE: checkout is on $branch");
  });

  test("the commit step refuses to commit on the default branch", () => {
    expect(shipSource).toContain(
      'case "$branch" in main|master) echo "REFUSING: on $branch',
    );
  });
});

describe("#136: the PR head comes from the run, not from a checkout", () => {
  test("the PR is opened for shipBranch", () => {
    // Reading `git branch --show-current` in PROJECT_ROOT only gave the right
    // answer BECAUSE the auto-merge had just moved the work there. With the
    // merge gone it would name the checkout's branch — usually main — and
    // open a PR from the default branch into itself.
    expect(shipSource).toMatch(/--head \$\{shipBranch\}/);
    expect(shipSource).not.toMatch(/--head "\$BRANCH"/);
  });

  test("shipBranch prefers the reused remote branch over the local name", () => {
    // pushTarget is `HEAD:<prior branch>`, so the remote name and the local
    // worktree branch name are not always the same. Taking commitResult.branch
    // alone opens a PR for a branch that does not exist on the remote.
    expect(shipSource).toMatch(/const shipBranch = branchToReuse \|\| commitResult\.branch/);
  });

  test("an unusable branch name aborts the run instead of reaching a shell", () => {
    expect(shipSource).toMatch(/if \(!isSafeBranchName\(shipBranch\)\)/);
  });

  test("a work branch reported as main or master aborts the run", () => {
    expect(shipSource).toMatch(/shipBranch === 'main' \|\| shipBranch === 'master'/);
  });
});
