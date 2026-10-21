---
description: This project ships DIRECTLY as of 2026-10-19 — do not route work through the ship workflow
generated-sha: 6f9e7b6a130c2178
---
## Direct-ship mode, since 2026-10-19

**This project is in direct-ship mode as of 2026-10-19: stabilising RunGate and clearing the backlogs, until we get RunGate under control.**

Shipping an issue without the ship workflow is the current, declared policy of
this project. Do not call `Skill("ship")` and do not invoke
`Workflow({ scriptPath: "workflows/ship.js" })`. If another document tells you
to, that document is out of date and this one is not: the mode is declared in
`.claude/rungate/config.json` under `ship`, and this file is generated from it, so a
re-scaffold restates it rather than reverting it.

You do not need to escalate to ask whether the bypass is legitimate. The date
and the reason above are the answer.

## What to do instead

"Do not use the harness" is not an instruction you can follow. This is:

1. **Claim the issue on the tracker first** — `gh issue edit <N> --add-assignee @me`.
   An unclaimed issue is indistinguishable from an unstarted one.
2. **Work from a worktree cut off `origin/main`**, never from the project's
   primary checkout — another session is usually in it.
3. **Write the regression test first, and prove it can fail** before writing
   the fix. See `.claude/rules/checks-must-be-able-to-fail.md`.
4. **Run targeted tests**, not the whole suite — name the files your change
   touches.
5. **Open a PR and enable auto-merge.** Review happens there, where it is
   durable and where CI already runs.
6. **Let the PR close the issue. Do not run `gh issue close` yourself.** Put
   `Fixes #<N>` in the PR BODY, naming the issue you claimed in step 1, and
   the merge closes it. A hand-typed close is attributed to nobody, so
   `issue-audit.yml` records the issue as closed with no ship record — the
   lane's own output becomes the audit's finding (#925).

## This is temporary, and reversible in one line

Set `ship.mode` back to `"harness"` in `.claude/rungate/config.json` and re-scaffold.
Nothing about the harness has been removed — `Skill("ship")` and
`workflows/ship.js` are unchanged and still work.

## When the harness IS in use: check the launch base first

Kept here through the direct-ship period because it is the harness rule that
is hardest to rediscover. It applies to a `Skill("ship")` run, which this
project is not doing right now — see the mode above.

```bash
bun scripts/check-launch-base.ts --project-root "$PROJECT_ROOT"
```

**Why, in one fact: `opts.cwd` does not pin worktree creation.**
`workflows/ship.js:1235` has set `opts.cwd = PROJECT_ROOT` for every
worktree-isolated spawn since 2026-09-23, with no bypass. The agent runtime
resolves `isolation: 'worktree'` against the SESSION's current directory and
applies `opts.cwd` to the spawned agent afterwards, so the pin cannot
prevent the worktree being cut from the wrong place. Rungate passes the
explicit argument and is overridden (#644).

Two things go wrong, and the quiet one is worse:

- cwd is not a git repository — the run dies at the first isolated spawn
  with `WorktreeIsolationError: … not in a git repository`, a message about
  the session's directory that names neither it nor the session, and
  recommends `WorktreeCreate` hooks that are irrelevant.
- cwd IS a git repository, in another project or on another branch —
  **nothing fails.** The run cuts its worktrees from somebody else's tree
  and succeeds onto the wrong base. Run `wf_5e3ed885-98c` landed a
  remediation agent in one consumer's repository while working an issue in
  another (#218), and it was found because the PR behaved oddly.

The second is why "same repository" is not enough: a shared primary parked
on `rungate/run-<issue>` (#640) is the same repository, a different tree.
The check reports `DIFFERENT_CHECKOUT` for exactly that, and
`SAME_CHECKOUT` is the only reading that clears — `UNMEASURED` refuses with
the rest, because a reading that could not be taken is not one that passed.

**This is now executed, and it is the run's first step.** It used to be a
documented step with nothing behind it: `workflows/ship.js` contained zero
references to the script, and an instruction nobody executes is not a rule
(`.claude/rules/config-access.md` says this about ADRs; it was true of this
line too).

`workflows/ship.js` runs it as the first step of the Goal phase, before the
issue is read and before any role agent — so before the first
worktree-isolated spawn, which is the decision being guarded. `SAME_CHECKOUT`
proceeds; every other reading ends the run at `LAUNCH_BASE_FAILED` through
`terminalFailure`, naming the reading. A reply that reported nothing is
`UNMEASURED` and refuses with the rest. ship.js decides none of this itself:
`lib/launch-base.ts` holds the one binding and ship.js restates its reading
(#644).

Running the command yourself before launching is still worth it — it is the
same reading, one agent spawn earlier, and it tells you to `cd` before the
run has spent anything.
