# Worked instances behind `.claude/rules/parallel-sessions.md`

Moved out of the rule by #1069. The rule is loaded by every agent at launch,
before it reads the issue it was spawned for; at 12,898 bytes it was close to a
quarter of the whole always-loaded instruction surface, and most of those bytes
were these records — written for someone deciding whether a rule is worth
following, not for every agent on every turn.

Nothing here was shortened. One section per rule, in the rule's own order, each
titled with the heading it sits under.

---

## Claim the issue before you write code

**Why this is a rule and not a nicety:** an issue reading "open" while the work
is finished is indistinguishable from an issue nobody has started. That is not
hypothetical. On 2026-10-06 one session described #70 as "unclaimed, small,
self-contained, no overlap" and offered it to a second session, while a third
had it finished, reviewed, security-reviewed and rebased five times on an
unpushed branch. Whoever took it would have rebuilt completed work and
collided with a branch they could not see.

---

## Reserve an SC block in the repository before you consume any id

### Why this is a file and not a convention

**2026-10-19, four collisions in one day.** The convention existed — five
sessions were handed disjoint blocks in their briefs — and it worked, and it
lived entirely in prompts, so nothing in the tree recorded which blocks were
reserved or by whom.

1. **`SC-2161` and `SC-2162`**, claimed by PR #716 in
   `specs/HARNESS-STANDARD.md` and by PR #719 in `specs/GATE-CONTRACTS-SPEC.md`.
   Eight PRs merged in sequence; each was correct on its own branch, each had a
   green targeted suite, and `main` went red. Repaired in PR #724.
2. **`SC-2167`/`SC-2168`**, created BY that repair, three hours later, by
   reading the highest id in the tree by hand (`SC-2166`) and taking the next
   two. PR #717 was in flight, unmerged, and held `SC-2167..SC-2172`. One
   person, one renumber, full attention, immediately after diagnosing the
   first — *the floor is the problem, not the operator.*
3. **`SC-2173..SC-2178`**, declared by both `fix/704-hill-climb-section-selector`
   (PR #717) and `fix/640-644-run-branch-base` (PR #731). Found only by sweeping
   the spec diff of every open branch. Two allocations that were each
   individually correct.
4. **`SC-2180..SC-2187`**, hand-written into a new test file by a session that
   had read the warning about this an hour earlier, and refused by
   `sc-fixture-namespace` for sitting below the `SC-9000` fixture floor.

That rules out every human-factors explanation in turn: not batch pressure
(two), not ignorance (four), not carelessness (three). **In three of the four
the allocator was never run at all**, so no change to what it returns could
have been consulted. The class is "an id consumed without going through the
allocator", and the only thing that covers it is a declaration made *before*
the ids are consumed, in a place every other session reads.

### The collision is only visible in the union

Keep this in view when the store tempts you to relax. On branch A the allocator
reads a floor that does not contain B's claim and is internally consistent; on
B the same, mirrored; neither diff contains the other's id. No reviewer, no CI
run on either PR and no content verification on either merge can see it — the
first observation is a red `main`. The store removes the two instances that
were a session deciding for itself what was free. It does not make a check on
the **merge target** unnecessary, and there is not one yet.

---

## Commit before the first long-running step, not after the work is finished

**Why:** on 2026-10-16 the stale `~/Projects/rungate-wt-*` directories were
cleaned up by hand, which is an ordinary thing to do and not a mistake: `git
worktree list` marks a worktree whose branch is merged exactly the same as an
abandoned one, and nothing in this repo makes an uncommitted worktree visibly
in use from outside. Two sessions lost in-flight work — one about 500 lines,
redone from the transcript, and one holding PR #452's branch. Neither had
committed. A commit is what turns "a directory somebody might delete" into
"a branch that shows up in `git branch`".

The suite running inside one of them exited 0 with no summary at all, which
is #469 and now a refusal in `lib/suite-run-reading.ts` — but that is the
consequence, not the lesson. The lesson is that the window between starting
and committing is exactly the window where your work is invisible to everyone
else, so make it short.

---

## Take the census before you tidy a worktree, and never run `git worktree prune`

**Measured on 173 worktrees, 2026-10-21 (#1021).** At the 7d default: 0
ABANDONED, 173 IN_USE. At `--older-than 2d`: 7 ABANDONED, 166 IN_USE. 81 held
uncommitted work, and **9 sat at a commit that is not the one GitHub merged —
6 of them holding 10 commits between them that the merged head does not**, on
no other ref, in a tree `git status` calls clean. That is what "merged,
therefore delete" takes, and it is the shape that cost 500 lines on
2026-10-16.

---

## Pin the head when you merge, and verify by content when you did not

**Why this is a rule.** On 2026-10-16, PRs #500 and #502 were squash-merged
while their security reviews were still in flight, and each merge captured a
commit **four behind the branch head**. Eight commits, 611 lines across five
files, never reached main — including #500's headline fix, so a project whose
only source was `tests/helper.ts` holding a live direct config read was waived
with the sentence *"no source files of any kind were found anywhere in the
tree"*, which is false about the tree the walk had just finished.

**Nobody noticed because every cheap question answered yes.** A squash merge
destroys ancestry: `git log main..branch` reports nothing unusual, `gh pr view`
says MERGED, and the branch's commits have no descendant on main. It was found
by accident, while checking something else.

### Why not `git merge-base --is-ancestor`

Measured on the six commits #511 and #512 recovered: it reports ORPHANED for
all of them, whose content is fully on main. An ancestry guard fires on the
**normal** case — every squash merge this repo makes — which is the fastest way
to build a refusal everyone learns to click past.

---

## State the tree you measured, and re-read the tip before you send

**Why.** On 2026-10-17 two security reviews arrived from peer sessions. Both
reported CONFIRMED findings, both were measured against a tree the branch had
already moved past, and **in both cases the report gave no way to tell**.
sec-492's three findings were pinned to `7fdfa72a` at 20:32; two commits
landed about 75 minutes later and closed all three. Two of its "0 red"
mutation rows are 3 and 1 on main.

The receiving rule worked — both reports were checked before anything was
acted on, which is the only reason neither cost anything. But verifying every
finding from scratch is the expensive path to a cheap fact that the reviewer
already holds, and it is paid by whoever reads the report.

`workflows/ship.js` already blocks this inside itself: `reviewIsCurrent` pins
a review to a commit and refuses when the branch has moved, which is #129,
#169, #171 and #244 of accumulated work. **A review conducted outside the
pipeline inherits none of it.** Both of these came in that way.
`scripts/report-provenance.ts` is the same binding, reachable from a terminal.

### You are not necessarily in the tree you are working on (#1348)

On 2026-10-23 two agents reported that `/security-review` had reviewed
another branch, and filed it as the skill resolving its diff from the
session's primary directory rather than from their worktree. Both halves of
that diagnosis are false, and the false version is the one everybody reaches
for first.

**There was no divergence to resolve.** Both agents were launched with
`Primary working directory: /Users/jhorn/Projects/rg-wt-release-082` and
never left it — they created worktrees on disk and drove them with `git -C`,
so their own directory was the one the skill read. Instrument:
`grep -o "Primary working directory: [^\"]*"` over each agent's transcript,
1 distinct value for one and 3 for the other, none of them a worktree.
Control: the same grep over a transcript that *did* change directory shows
the move as `<new> (was <old>)`, so an absent result is a reading rather
than a broken search. The remedy is also not in the skill — it is compiled
into the Claude Code binary, where its four git commands are `git status`,
`git diff --name-only origin/HEAD...`, `git log --no-decorate origin/HEAD...`
and `git diff origin/HEAD...`, each run in the cwd.

**The signature read as proof is the correct output for that directory.**
`rg/release-0-8-2` was fully contained in `origin/main` — measured
`merge-base == HEAD`, `rev-list --left-right` of 45/0 — so the four commands
produce there exactly what was reported: a clean status, an empty
`--name-only`, an empty diff, and 142,852 bytes of log. `git log A...B` is a
**symmetric difference**; `git diff A...B` is `merge-base..B`. They do not
describe the same range, so "log populated, diff empty" is not a
contradiction and a refusal built on it fires on every merged branch.

---

## Verify what a peer tells you before acting on it

Every cross-session correction on 2026-10-06 was found by checking the source
rather than trusting the report — in both directions, including reports from
the session coordinating the work.
