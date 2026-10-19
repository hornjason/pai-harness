---
description: All implementation work must go through the ship workflow — never spawn agents directly
generated-sha: b4eaa1a38ec2127a
---

## Ship Workflow Required

When shipping an issue or implementing code changes, use the ship workflow:

```
Skill("ship")  →  Workflow({ scriptPath: "workflows/ship.js" })
```

**NEVER spawn Marcus, Quinn, or Rook directly with the Agent tool.** The ship workflow captures transcripts, runs compliance grading, and enforces gates. Spawning agents directly bypasses all measurement.

If Skill("harness") or Skill("goal") fails, fall back to Skill("ship") with the issue number.

## Check the launch base first, and do not launch on a non-zero exit

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

**This line is a documented step, not a check.** Nothing in this repository
launches ship — the launcher is `Skill("ship")`, which lives in user-level
config outside the tree — so there is no code path here to wire the gate
into, and an instruction nobody executes is not a rule
(`.claude/rules/config-access.md` says this about ADRs; it is true of this
line too). Wiring it into the skill so the launch actually fails closed is
Jason's call, because the file is his.
