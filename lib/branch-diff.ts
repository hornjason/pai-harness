/**
 * What THIS branch changed since the scope gate ran (#531).
 *
 * Three gate checks — `prove-evidence-type`, `contextual-skip-validation`
 * and the ship-round repeat — decide what a run must prove from a list of
 * changed files. All three built that list with
 *
 *     git diff --name-only ${scopeSha}..HEAD
 *
 * Two dots compares two commits DIRECTLY. When `scopeSha` is not an ancestor
 * of `HEAD`, the output also carries everything on the other side of the
 * fork, and the gate attributes all of it to this branch.
 *
 * Measured on run `wf_e230fddc-a71`, whose `gates.scope.commitSha` was
 * `247afba4`:
 *
 * ```
 * git merge-base --is-ancestor 247afba4 HEAD              -> false
 * git diff --name-only 247afba4..HEAD      | wc -l        -> 78
 * git diff --name-only 247afba4...HEAD     | wc -l        ->  3
 * ```
 *
 * The branch touched three files. The gate saw seventy-eight and refused
 * twice over files that do not exist on it — a `Dockerfile` it has never
 * contained, and seven `.tsx` files it has never contained.
 *
 * Three dots diffs HEAD against the MERGE BASE, which is the question every
 * one of these checks is actually asking: what did this branch do.
 *
 * ## Why the sha was wrong to begin with, and why three dots is not enough
 *
 * `247afba4` was the tip of the branch the MAIN CHECKOUT happened to be
 * sitting on, while the run was shipping a worktree. `writeGateResult`
 * recorded `gitSha(state.projectRoot)`. The state names `treeUnderTest`
 * correctly, so the right value was available and the writer read HEAD from
 * somewhere else — which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * "a consumer reads a name, a producer writes a different name" in the
 * smallest possible form. Both halves are fixed: the recorder reads the tree
 * under test, and the readers compare branch-relative. Three dots alone
 * still mis-attributes when the recorded sha came from the wrong tree, and
 * the right sha alone still mis-attributes across a fork.
 *
 * ## An unusable diff is UNMEASURED, and says so
 *
 * The three call sites read `if (!diff.ok || !diff.output) return`, which
 * collapses "git could not answer" into "nothing changed" — and the first of
 * those is the state a check should be loudest about, because every file
 * gate below it then passes for want of input. The reading keeps them apart:
 * `files: null` is "could not measure", `files: []` is "measured, nothing
 * changed" (`.claude/rules/config-access.md`, Silent Default Substitution).
 *
 * **The call sites still RETURN on `null`, and that is deliberate rather
 * than an oversight.** An unreachable scope sha is an ORDINARY outcome, not
 * an anomaly: a rebase during the run — which this project does on nearly
 * every PR — leaves `gates.scope.commitSha` pointing at a commit no longer
 * in the branch's history, and `A...HEAD` then fails. Refusing on it would
 * red every rebased run, so the reading is printed as `WARN: … UNMEASURED`
 * and the check declines to decide. The difference from before is that the
 * decline is now visible in the gate log instead of being spelled
 * `// no changed files`.
 */

/** What one reading of the branch diff says. */
export interface BranchDiffReading {
  /**
   * The files this branch changed, or `null` when git could not answer.
   * `[]` means it answered and the answer was none, which is a measurement.
   */
  files: string[] | null;
  /** Why `files` is null. */
  reason?: string;
}

/**
 * An argv-form git runner, injected so the reading can be driven without git.
 *
 * Argv and not a command string: `scopeSha` comes out of
 * `workflow-state.json`, which the run's own agents write, and the old call
 * sites interpolated it straight into a shell. The sha is validated below as
 * well — both, because the validation is the thing a later edit is most
 * likely to widen.
 */
export type DiffRunner = (args: string[]) => { ok: boolean; output: string };

/** A git object name and nothing else. */
const SHA = /^[0-9a-f]{7,64}$/;

/**
 * The argv. One place, so the dot count has one binding to mutate.
 *
 * `-z` for the same reason `scripts/verify-merge-content.ts` uses it:
 * `git diff --name-only` C-QUOTES any path holding a non-ASCII byte, a
 * quote, a tab or a newline — `"caf\303\251.tsx"`, quotes included. Every
 * consumer of this list is a regex on the filename, and
 * `/\.(tsx|jsx|css)$/i` does not match a string ending in `"`. So a UI file
 * with an accent in its name walks past `local-ui-validated` and
 * `quinn-on-ui-change` without matching anything, which is #531's own defect
 * — a changed-file list that is wrong about what changed — arriving through
 * the encoding instead of through the dot count. `-z` emits raw bytes,
 * NUL-separated, and nothing is ever re-parsed.
 */
export function branchDiffArgs(scopeSha: string): string[] {
  // THREE dots. See the docstring: two dots is the whole of #531.
  return ["diff", "--name-only", "-z", `${scopeSha}...HEAD`];
}

/**
 * The files this branch changed since `scopeSha`, branch-relative.
 *
 * `checkName` is carried so the UNMEASURED line names the check that could
 * not measure rather than the helper that noticed.
 */
export function readBranchDiff(
  scopeSha: unknown,
  run: DiffRunner,
  checkName: string,
): BranchDiffReading {
  if (typeof scopeSha !== "string" || !SHA.test(scopeSha)) {
    return {
      files: null,
      reason:
        `${checkName}: gates.scope.commitSha is ${JSON.stringify(scopeSha)}, which is not a git ` +
        `object name, so the changed-file list could not be built (#531).`,
    };
  }
  const r = run(branchDiffArgs(scopeSha));
  if (!r.ok) {
    return {
      files: null,
      reason:
        `${checkName}: \`git ${branchDiffArgs(scopeSha).join(" ")}\` failed, so the changed-file ` +
        `list is UNMEASURED. This is not "nothing changed" — every file-matched gate below reads ` +
        `this list, and an empty one waves all of them through (#531).`,
    };
  }
  // NUL, not newline, and no `trim` on the paths themselves — a filename may
  // legally contain a newline, and trimming one would rewrite it.
  return { files: r.output.split("\0").filter(Boolean) };
}
