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
 *
 * #652: ship.js emits TWO commit prompts, and both carry a main/master
 * refusal. "the commit step refuses to commit on the default branch" below
 * searches the WHOLE source for a prefix both of them share, so the match it
 * gets is the wave commit prompt's — the first one in the file — and the
 * end-of-run step's refusal is not what satisfies it. That is
 * .claude/rules/checks-must-be-able-to-fail.md's "search the slice, not the
 * document": a claim scoped to one region of a string, asserted against the
 * whole string, is satisfied by a match anywhere in it.
 *
 * The case added below cuts the wave commit prompt out first and asserts on
 * the cut, so there is one assertion per prompt rather than one assertion
 * answering for both. Measured over this file (12 tests), each mutation
 * applied to `workflows/ship.js` alone and reverted:
 *
 *   | Mutation                                        | Pred | Red     |
 *   |-------------------------------------------------|------|---------|
 *   | baseline — unmutated                            | 0    | 0 of 12 |
 *   | the refusal deleted from the WAVE commit prompt  | 1    | 1 of 12 |
 *   | the refusal deleted from the END-OF-RUN prompt   | 0    | 0 of 12 |
 *
 * The second row is the new case and ONLY the new case — "the wave commit
 * prompt refuses main and master". The pre-existing whole-document assertion
 * stays green there, because the end-of-run prompt still carries the prefix
 * it looks for, which is the whole of #652 stated as a count.
 *
 * The third row is a 0, so per that rule the input on which mutant and
 * original differ is named rather than assumed: the mutant is ship.js with
 * line 5643 deleted, so `ship never commits to the default branch` occurs 0
 * times in it and exactly once in the real source. The mutation was applied;
 * the 0 is the finding it looks like. Nothing in this file reads the
 * end-of-run prompt's own refusal, and the assertion that claims to is
 * reading the wave prompt's. Closing that is not this case's job — this case
 * adds the question nobody was asking about the wave prompt, and leaves the
 * existing one exactly as it was so the two can be told apart.
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
    // `-C <dir>` is optional and part of the match: #1056 moved every push in
    // these prompts from `cd <dir> && git push` to `git -C <dir> push`, and a
    // pattern anchored on the bare two words would have swept ZERO pushes
    // while reporting the file clean.
    .flatMap(line => [...line.matchAll(/git (?:-C \S+ )?push[^\n`&|;]*/g)].map(m => m[0].trim()));
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

/**
 * #652: the wave commit prompt, cut out of ship.js by itself.
 *
 * The two anchors are the prompt's opening sentence and the options object
 * that closes the `timedAgent` call, both of which name the wave by its loop
 * variable, so neither can match the end-of-run commit prompt. Each must
 * appear exactly once: an anchor that matched twice would cut a region
 * nobody chose, and an anchor that moved would cut nothing — and an empty
 * slice contains nothing, which is indistinguishable from a clean result.
 * So this throws rather than returning "".
 */
const WAVE_PROMPT_OPEN = "Commit wave ${waveIndex + 1}'s collected output";
const WAVE_PROMPT_CLOSE = "{ label: `commit-wave-${waveIndex + 1}`";

function waveCommitPrompt(source: string): string {
  for (const anchor of [WAVE_PROMPT_OPEN, WAVE_PROMPT_CLOSE]) {
    const hits = source.split(anchor).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not cut the wave commit prompt: ${JSON.stringify(anchor)} appears ${hits} times`,
      );
    }
  }
  const start = source.indexOf(WAVE_PROMPT_OPEN);
  const end = source.indexOf(WAVE_PROMPT_CLOSE);
  if (end <= start) {
    throw new Error("could not cut the wave commit prompt: the anchors are out of order");
  }
  return source.slice(start, end);
}

/**
 * The end-of-run commit prompt, named by the options object that closes it
 * rather than by its refusal line. Identifying it by its refusal would make
 * the exclusion case below go red when that refusal moves, which is the one
 * thing this prompt's own assertions are for — and it is the mutation whose
 * count the docblock records as 0.
 */
const END_OF_RUN_CLOSE = "{ label: 'commit', phase: 'Commit'";

describe("#652: the wave commit prompt carries its own default-branch refusal", () => {
  test("the wave commit prompt is cut out, and the cut is not empty", () => {
    const prompt = waveCommitPrompt(shipSource);
    expect(prompt.length).toBeGreaterThan(0);
    // The cut has to EXCLUDE the other prompt, or the case below is the
    // whole-document search again wearing a slice's name. Presence is
    // established before the comparison: `not.toContain` against a string
    // that no longer exists anywhere reads as a distinction (#518).
    expect(shipSource).toContain(END_OF_RUN_CLOSE);
    expect(prompt).not.toContain(END_OF_RUN_CLOSE);
  });

  test("the wave commit prompt refuses main and master", () => {
    // Asserted against the cut, not against shipSource. The end-of-run
    // prompt's refusal shares this line's prefix, so a whole-document search
    // for it stays green over a wave prompt that no longer refuses anything —
    // which is what the pre-existing assertion above does.
    expect(waveCommitPrompt(shipSource)).toContain(
      'case "$branch" in main|master) echo "REFUSING: on $branch"; exit 1;; esac',
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
