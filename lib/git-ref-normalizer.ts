/**
 * Rewrite bare `main` / `master` git refs in evidence commands to `origin/...`.
 *
 * WHY
 *
 * Agent worktrees come from a shared clone whose local `main` ref is whatever
 * it was when that ref was last updated locally — not when `origin/main` last
 * moved. Sessions work on branches and rarely check out `main`, so the local
 * ref drifts arbitrarily far behind and every agent inherits the drift. The
 * same evidence command, on the same commit, can pass in one worktree and fail
 * in another. An evidence command that is not reproducible is not evidence.
 *
 * #118: `git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts` returned 1
 * against a file that had not been touched since #67. The verify agent reported
 * a specific 5-line diff and recommended reverting it. Against `origin/main`
 * the same command exits 0. The false FAIL spawned a second Marcus to "fix" a
 * correct file and cost roughly 300k tokens before the run ended.
 *
 * WHY A STATIC REWRITE RATHER THAN AN AUTO-FIX
 *
 * `evidence-prevalidator.ts` auto-fixes commands whose dry-run fails. That is
 * the wrong trigger here: local `main` is only *sometimes* behind, so a
 * stale-`main` command often passes prevalidation and fails later at Verify —
 * which is exactly the #103 case. The defect is in the text of the command, so
 * the repair is applied to the text, unconditionally.
 *
 * WHY THE CONSERVATIVE MATCH
 *
 * Over-rewriting is worse than the bug. Turning `src/main.ts` into
 * `src/origin/main.ts`, or `grep main` into `grep origin/main`, would
 * manufacture false failures instead of removing them. So this only rewrites
 * `main`/`master` in the ref position of a known git subcommand, and never
 * after `--`, which ends the ref list and begins pathspecs.
 */

/** Branch names that are conventionally the integration branch. */
const DEFAULT_BRANCHES = ["main", "master"];

/**
 * Git subcommands whose arguments are refs. Deliberately a short allowlist:
 * a command not on it is left untouched rather than guessed at.
 */
const REF_TAKING = ["diff", "log", "merge-base", "rev-parse", "rev-list", "describe", "shortlog"];

export interface NormalizeResult {
  /** The command, with bare default-branch refs qualified to origin/. */
  command: string;
  /** True when at least one ref was rewritten. */
  changed: boolean;
}

/**
 * Rewrite the ref-bearing segment of each `git <refcmd> ...` in a command.
 *
 * Operates per git invocation so that a compound command
 * (`git log main..HEAD && git diff main`) has every invocation covered, and so
 * that a non-git command in the same chain is never considered.
 */
export function normalizeGitRefs(command: string): NormalizeResult {
  if (!command) return { command, changed: false };

  let changed = false;
  const branches = DEFAULT_BRANCHES.join("|");

  // Match a git invocation up to the end of its ref list: either the `--`
  // pathspec separator, a shell operator that ends the command, or end of
  // string. Only that span is eligible for rewriting.
  const invocation = new RegExp(
    String.raw`\bgit\s+(?:-C\s+\S+\s+)?(${REF_TAKING.join("|")})\b([^|&;]*?)(?=\s--\s|\s*[|&;]|$)`,
    "g",
  );

  const out = command.replace(invocation, (whole, sub: string, args: string) => {
    // A bare default branch is a ref only when it stands alone as a word, or
    // heads a range (`main..HEAD`, `main...HEAD`).
    //
    // The two lookarounds do different jobs and both are load-bearing:
    //
    //   (?<![\w/.-])  nothing path-like or remote-like precedes it. Blocks
    //                 `origin/main`, `upstream/main` and `src/main` — and is
    //                 what makes a second pass a no-op instead of producing
    //                 `origin/origin/main`.
    //   (?![\w/-])    not the head of a longer word or path: `maintenance`,
    //                 `main/sub`.
    //   (?!\.\w)      not a filename: `main.ts` is blocked, but `main..HEAD`
    //                 is NOT, because the character after the first dot is
    //                 another dot rather than a word character. A single
    //                 `(?![\w/.-])` collapsed these two cases together and
    //                 silently refused to fix the range form, which is the
    //                 most common shape an evidence command actually uses.
    const rewritten = args.replace(
      new RegExp(String.raw`(?<![\w/.-])(${branches})(?![\w/-])(?!\.\w)`, "g"),
      (m) => { changed = true; return `origin/${m}`; },
    );
    return `git ${whole.slice(4).replace(args, rewritten)}`;
  });

  return { command: out, changed };
}

/**
 * Convenience predicate for tests and gates: does this command reference a
 * default branch without qualifying it to a remote?
 */
export function hasBareDefaultBranchRef(command: string): boolean {
  return normalizeGitRefs(command).changed;
}
