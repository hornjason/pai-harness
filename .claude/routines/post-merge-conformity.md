# Post-Merge Conformity Check

## Trigger

- **Type:** GitHub event
- **Event:** pull_request
- **Action filter:** closed (merged = true)
- **Repository:** hornjason/pai-harness

When a pull_request is merged into main, this routine runs scaffold conformity
checks to catch any spec violations introduced by the merge.

## Prompt

After the pull request has been merged, run the full scaffold-conformity test
suite to verify the codebase still passes all spec criteria:

1. Check out the repository at the merge commit.
2. Run `bun install` to ensure dependencies are current.
3. Run `bun test test/scaffold-conformity.test.ts` to execute conformity checks.
4. If any conformity checks fail, open a GitHub issue titled
   "Conformity regression after PR #{{pull_request.number}}" with:
   - The list of failing SCs
   - The PR that introduced the regression
   - Suggested fix commands from the conformity findings report
5. If all checks pass, log success and exit.

## Repos

- hornjason/pai-harness

## Why

The existing TaskCompleted hook (#579) only runs conformity at session end,
which is unreliable — agents can exit without triggering it. A post-merge
routine ensures every merged PR is validated regardless of how the session ended.
This replaces the session-end-only conformity path with a guaranteed check.
