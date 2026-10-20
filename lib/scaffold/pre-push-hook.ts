/**
 * The generated `.git/hooks/pre-push`, as one binding (#397).
 *
 * It lived as a template literal inside `createGitHooks`, where nothing could
 * run it. The hook is a shell script with an exit code, so
 * `.claude/rules/checks-must-be-able-to-fail.md`'s worked pattern applies
 * directly: route every refusal through one exit-code constant and drive the
 * script against planted fixture repositories. That is what
 * `test/pre-push-hook.test.ts` does, and it is why this is a module rather
 * than a string in the middle of a 2,400-line generator.
 *
 * ## What was wrong
 *
 * The hook could not PASS in any consumer whose `bun.lock` is gitignored, and
 * it failed closed with "Conformity tests failed against the commits being
 * pushed" — which is not what happened. Found on agentgrit on 2026-10-14
 * with conformity at 43 pass, 0 fail in the working tree and the push
 * rejected.
 *
 * The lockfile comparison read `$tmp/bun.lock`, which comes from the git
 * checkout. A gitignored lockfile is never in the checkout, so the `cmp`
 * branch could not be taken and every push fell through to
 * `bun install --frozen-lockfile` with no lockfile to freeze against. For a
 * consumer with a `file:` or `link:` dependency on a sibling directory it
 * then failed a second, independent way: a relative path does not resolve
 * from `/tmp`.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is about guards that cannot
 * fail. This is the inverse and the damage is the same shape, because the
 * message is wrong either way — a developer reading "conformity failed" goes
 * and looks at conformity, which is green.
 *
 * ## What was wrong the second time (#728)
 *
 * It asked `--show-toplevel` where the dependencies are. That answers "where
 * is this working tree", and in a LINKED worktree that is not where
 * `node_modules` lives — it is gitignored, so it exists only in the main
 * checkout. `ln -s` does not look at its target, so the link succeeded, the
 * suite could not resolve its imports, and every worktree push was refused as
 * UNMEASURED. The refusal was right and is unchanged; what it could not say
 * is that the cause was the worktree, so three agent sessions in agentgrit
 * reached for `--no-verify` instead.
 *
 * The same wrong root made the lockfile arm vacuous — it compared the pushed
 * commit's lockfile with its own copy in the temp checkout. `MODULES_ROOT`
 * answers the right question, and `link_modules` refuses by name rather than
 * leaving a dangling link.
 *
 * ## The three outcomes, and why UNMEASURED blocks
 *
 * | what happened | exit | message |
 * |---|---|---|
 * | conformity ran and failed | refuse | the conformity message |
 * | the suite could not be run at all | refuse | UNMEASURED, naming the cause |
 * | conformity ran and passed | 0 | — |
 *
 * UNMEASURED blocks, and that is a decision rather than an accident of
 * control flow. A pre-push gate that waves a commit through when it could not
 * check is the fail-open this repo keeps finding; `SKIP` is indistinguishable
 * from success and `UNMEASURED` is not
 * (`.claude/rules/config-access.md`). What makes it tolerable is that it says
 * which of the two happened and names `--no-verify` itself, so the developer
 * is not hunting a green suite for a failure that never occurred.
 */

/** The ONE exit code every refusal routes through. Asserted to appear once. */
export const PRE_PUSH_REFUSE_EXIT = 1;

export const PRE_PUSH_MANAGED_MARKER = "# Managed by rungate — conformity check before push";

/**
 * The conformity suite the hook runs. One literal, so the test that plants a
 * passing and a failing fixture writes the same path the hook reads.
 */
export const PRE_PUSH_SUITE = "test/scaffold-conformity.test.ts";

export function prePushHookScript(): string {
  return `#!/bin/sh
${PRE_PUSH_MANAGED_MARKER}
#
# Three outcomes, not two: conformity FAILED, conformity could not be RUN,
# and conformity passed. The first two used to share a message and a status
# variable, so an install that could not happen was reported as a test that
# did not pass (#397).
REFUSE=${PRE_PUSH_REFUSE_EXIT}
ZERO=0000000000000000000000000000000000000000
TOPLEVEL=$(git rev-parse --show-toplevel) || exit $REFUSE
# Where this repository's installed dependencies are, which is NOT "where is
# this working tree" (#728). node_modules is gitignored, so a LINKED worktree
# has none and never will. --git-common-dir answers the main checkout's .git
# from any worktree and plain .git in the main checkout itself, so the
# non-worktree case is unchanged.
MODULES_ROOT=$(cd "$TOPLEVEL" && cd "$(git rev-parse --git-common-dir)/.." && pwd) || exit $REFUSE
conformity=0
unmeasured=0
why=""

# Link the main checkout's modules into the temp checkout, or say why not.
#
# 'ln -s' does not look at its target: a link to a path that does not exist
# succeeds, and the suite then dies on an import error that names no cause.
# That is what a worktree push did before #728 — "the conformity suite did not
# load" over a repository whose dependencies were installed the whole time.
link_modules() {
  if [ ! -d "$MODULES_ROOT/node_modules" ]; then
    unmeasured=1
    why="no node_modules at $MODULES_ROOT/node_modules — run bun install there"
    return 0
  fi
  ln -s "$MODULES_ROOT/node_modules" "$1/node_modules" 2>/dev/null
}

while read -r _lref lsha _rref _rsha; do
  # Branch deletion: there is no commit to check out.
  [ "$lsha" = "$ZERO" ] && continue

  tmp=$(mktemp -d) || exit $REFUSE
  if ! git worktree add --detach --quiet "$tmp" "$lsha"; then
    unmeasured=1
    why="the pushed commit $lsha could not be checked out"
    rm -rf "$tmp"
    break
  fi

  # Which node_modules the pushed commit expects.
  #
  # The old test was \`[ -f "$tmp/bun.lock" ] && cmp -s ...\`, which treats "the
  # checkout has no lockfile" as "the dependencies differ" and installs. But a
  # lockfile absent from the checkout is a lockfile git does not track — it is
  # gitignored, or the project has none — and then there is nothing in this
  # push that can change the dependency graph. The main checkout's modules
  # are the right ones by definition, and installing is both slower and less
  # accurate.
  #
  # The lockfile read here is the one beside the modules being linked, for
  # the same reason (#728). Rooted at the working tree, a worktree push
  # compared the PUSHED commit's lockfile against its own copy in the temp
  # checkout — equal whenever you push what you committed, so the arm that
  # exists to check the installed modules match the pushed ones never looked
  # at the installed modules at all.
  if [ ! -f "$tmp/bun.lock" ]; then
    link_modules "$tmp"
  elif [ -f "$MODULES_ROOT/bun.lock" ] && cmp -s "$MODULES_ROOT/bun.lock" "$tmp/bun.lock"; then
    link_modules "$tmp"
  else
    echo "pre-push: dependencies differ from the working tree — installing from the pushed lockfile" >&2
    if ! ( cd "$tmp" && bun install --frozen-lockfile ) >&2; then
      # NOT a conformity result. A relative \`file:\`/\`link:\` dependency does
      # not resolve from a temp directory, and a lockfile that cannot be
      # frozen is an environment fault in this hook's own sandbox.
      unmeasured=1
      why="dependencies could not be installed in the temporary checkout"
    fi
  fi

  if [ "$unmeasured" -eq 0 ]; then
    out=$( cd "$tmp" && bun test ${PRE_PUSH_SUITE} 2>&1 )
    rc=$?
    echo "$out" >&2

    # A suite that FAILED and a suite that never RAN both exit non-zero: a
    # missing file, an unresolvable import, and a red assertion are one exit
    # code. Two things in bun's summary tell them apart, and both are needed.
    #
    # Counted tests. The summary prints \`N pass\` / \`N fail\`; a file that is
    # not there prints neither. Zero counted tests is UNMEASURED even when the
    # exit code is 0, because a suite passing vacuously is exactly what
    # .claude/rules/checks-must-be-able-to-fail.md exists to catch.
    #
    # Counted ERRORS. A module that will not resolve is reported as \`1 fail\`
    # AND \`1 error\` — measured on bun 1.3.14 — so the counted-tests test
    # alone calls it a conformity failure, which is the wrong half of the
    # distinction this hook exists to draw. A red assertion prints no error
    # line at all. An unhandled error between tests means the suite did not
    # run as written, whatever the fail count says.
    if echo "$out" | grep -qE '^[[:space:]]*[1-9][0-9]* error'; then
      unmeasured=1
      why="the conformity suite did not load (an unhandled error, usually an import that will not resolve)"
    elif echo "$out" | grep -qE '^[[:space:]]*[1-9][0-9]* (pass|fail)'; then
      [ "$rc" -ne 0 ] && conformity=1
    else
      unmeasured=1
      why="the conformity suite ran no tests (the file is not in the pushed commit, or it declares none)"
    fi
  fi

  # Always clean up. An early exit here would leak a worktree on every failed
  # push, which is how #68 reached 39 stale worktrees and 243 MB.
  git worktree remove --force "$tmp" 2>/dev/null
  rm -rf "$tmp"

  [ "$conformity" -ne 0 ] && break
  [ "$unmeasured" -ne 0 ] && break
done

if [ "$unmeasured" -ne 0 ]; then
  echo "ERROR: pre-push did NOT run the conformity suite — $why." >&2
  echo "       This is UNMEASURED, not a test failure: your conformity tests may be green." >&2
  echo "       Fix the cause, or push with --no-verify once you have run" >&2
  echo "       \\\`bun test ${PRE_PUSH_SUITE}\\\` in the real tree yourself." >&2
  exit $REFUSE
fi
if [ "$conformity" -ne 0 ]; then
  echo "ERROR: Conformity tests failed against the commits being pushed — fix before pushing" >&2
  exit $REFUSE
fi
exit 0
`;
}
