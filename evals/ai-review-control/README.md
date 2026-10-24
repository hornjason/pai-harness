---
doc-type: reference
status: active
owner: jason
updated: 2026-10-22
---

# ai-review negative control (#1169) and finding outcomes (#1225)

A reviewer that returns CLEAN on everything is indistinguishable from one that
works. This is the instrument that tells them apart.

Two halves, measuring two different things:

| | module | question |
|---|---|---|
| recall and precision, on staged subjects | `control.ts`, `run.ts` | did the reviewer find a defect known to be there, and stay quiet about one that is not? |
| what became of the findings it wrote | `outcomes.ts`, `outcomes-run.ts` | of the findings that reached a person, how many were worth writing? |
| how much the withheld set moves between runs | `variance-capture.ts` | does the deployed adjudicator disagree with itself? — see **Single-adjudicator variance** below |

`outcomes.ts` is pure and knows nothing about `gh` or `git`; `outcomes-run.ts`
is the half that turns a repository into a corpus. See **Finding outcomes**
below.

It is not an agent-behaviour eval like the `marcus-*` / `quinn-*` cases next
door, and it does not run under `claude plugin eval`. Those cases grade how an
agent worked; this one grades **whether a reviewer found a defect that is known
to be there, and stayed quiet about one that is not**.

## The subjects

Each subject directory holds one `baseline.ts` and one candidate per case, plus
a `subject.json` declaring what the answer is.

`suite-lock-redirect` is a compacted, self-contained copy of the full-suite
detector in `lib/test-suite-lock.ts`. A copy on purpose: a subject whose source
is the live module moves every time the module does, and a control that moves
is not a control.

| case | kind | what it is |
|---|---|---|
| `suite-lock-redirect/planted` | planted | the redirect pattern loses its `&` alternative, so `&>` and `&>>` stop being recognised. `bun test &>/tmp/out` is then read as a *targeted* run and an unscoped full suite goes unguarded — the permissive direction, which is what makes it a defect rather than an annoyance. The doc comment one line above still claims `&>>` is covered, so the file contradicts itself inside the diff. |
| `suite-lock-redirect/clean` | clean | a behaviour-preserving refactor of the same baseline: two locals renamed, the operand test extracted to a named function. |
| `worktree-state-write/planted` | planted | the new arm lets a **linked worktree** through to the ok path, so the project-state generator runs with `projectRoot` set to the worktree. `CLAUDE.md` says an agent running in a worktree must never write `project-state.json`, `PROJECT-STATE.md` or `SUCCESS.md` (#296). |
| `worktree-state-write/clean` | clean | the same change to the same arm without the break: a linked worktree gets its own outcome name instead of being lumped in with a subdirectory, and is still refused. |

`worktree-state-write` is a compacted copy of the decision half of
`lib/project-state-root.ts`, with its three filesystem readings lifted into a
parameter so the subject is pure.

**It measures something `suite-lock-redirect` cannot (#1507, CRC-A4).** The
redirect plant is a defect in any reading — a guard goes permissive and the
file contradicts its own comment. This one is not: a linked worktree *is* a
real checkout of the same repository carrying the same tracked generator, and
the planted arm says so in its own comment. It is wrong only because this
repository wrote the rule down. A reviewer that has never read `CLAUDE.md`
has nothing to find, which is the whole point — `CLAUDE.md` and `.claude/`
are in `AI_REVIEW_UNTRUSTED_PATHS` and are restored from the pull request's
base before the reviewer starts, so the conventions it is scored against are
the base's and a branch cannot legalise its own plant.

The two candidates are byte-identical outside the arm. That is asserted, not
arranged: a reviewer able to separate them on diff shape, size, or a second
defect would produce a reading about diff shape, and `clean` would be
measuring precision against the wrong variable.

Nothing in a staged subject says which one it is, or that it is a subject at
all. A banner reading "planted defect below" turns a recall measurement into a
reading-comprehension one.

Every premise is **run**, not asserted. `test/review-negative-control.test.ts`
executes the three `suite-lock-redirect` candidates over a table of commands
and requires the planted one to disagree with its baseline on exactly the two
`&>` rows, and the clean one to disagree on none. It does the same for
`worktree-state-write` over a table of root readings — one permission
disagreement, on the linked-worktree row and nowhere else — and adds the two
premises a convention break needs and a behavioural plant does not: that the
sentence the plant contradicts is really in `CLAUDE.md`, read from the
repository rather than quoted in the manifest, and that the candidates agree
line for line outside the arm. Each of those is backed by a mutation row in
that file's header.

## Running it locally

```bash
bun evals/ai-review-control/run.ts list
bun evals/ai-review-control/run.ts stage suite-lock-redirect/planted /tmp/subj
git -C /tmp/subj diff                      # the diff a reviewer reads
# point a reviewer at it — see "Putting a subject in front of the deployed
# reviewer" below for the only route that works on this repository
bun evals/ai-review-control/run.ts score suite-lock-redirect/planted \
    /tmp/findings.json --reviewer rungate@0.8.0
```

`--reviewer` is required and not defaulted. CI adjudicates with a pinned
published package (`.github/workflows/ai-review.yml`, `bunx rungate@<pin>`,
deliberate per #1013) while the tree runs ahead of it, so a reading that cannot
say which of those it watched is a number about nothing. An unnamed reading is
UNMEASURED.

## Putting a subject in front of the deployed reviewer (#1509)

The line between `stage` and `score` was an ellipsis for the whole life of this
directory, and the reason was a decision nobody had made rather than a script
nobody had written. **The deployed reviewer is not pointable at a scratch
directory.** It runs as the `ai-review` job on a pull request, writes its
payload to a path under the runner's temp directory, and uploads it nowhere.

### The route, and what was rejected

| route | verdict |
|---|---|
| **Leave the subject where it lives** and open a pull request touching `evals/**/subjects/**` | **rejected.** `REVIEW.md`'s *Do not flag* list names that path — a finding there is a declared false positive by construction, so the reading would measure whether the reviewer obeyed the exclusion. Editing the exclusion to get a reading measures the edit, not the reviewer. |
| **Open a pull request against `main`** staging the candidate at its `reviewPath` | **rejected.** The base would hold the real module, so the diff would be *production module → compacted copy* and not *baseline → candidate*. A different diff is a different measurement. |
| **A pair of measurement branches**, base holding the subject's `baseline` at its `reviewPath` and head holding the candidate | **chosen.** The pull request's diff is then byte-identical to what `stage` writes locally, the file sits under `lib/`, where the reviewer does look, and nothing in the tree says it is a subject. |

The pull request is **draft**, its title begins `MEASUREMENT — DO NOT MERGE:`,
auto-merge is never armed, no label is ever applied, and it is **closed** with
a comment saying what it measured. It carries the staged candidate and nothing
else. Both branches are deleted afterwards.

```bash
# 1. the base: the subject's baseline at its own reviewPath
git switch -c measurement/<n>-baseline origin/main
cp evals/ai-review-control/subjects/<subject>/baseline.ts <reviewPath>
git commit -am "MEASUREMENT base (#<n>)" && git push -u origin HEAD

# 2. the head: the candidate, and nothing else
git switch -c measurement/<n>-<case>
cp evals/ai-review-control/subjects/<subject>/<case>.ts <reviewPath>
git commit -am "MEASUREMENT candidate (#<n>)" && git push -u origin HEAD

# 3. the draft pull request. NEVER --fill from a closing keyword, never
#    `gh pr merge`, never `gh pr edit --add-label`.
gh pr create --draft --base measurement/<n>-baseline \
  --title "MEASUREMENT — DO NOT MERGE: <subject>/<case> (#<n>)" --body "…"
```

### Capturing what the reviewer wrote

The only durable copy of a round's findings is the **ledger comment**
(`lib/ai-review-rounds.ts`), and `capture` lifts one round out of it. Fetching
the comment is the caller's job for the reason `rounds` already gives — a
measurement that can only run against one forge is not one a consumer can take.

```bash
PR=<the draft measurement pull request>
gh api "repos/hornjason/pai-harness/issues/$PR/comments" --paginate --jq \
  '[.[] | select(.user.login == "github-actions[bot]"
                 and (.body | contains("<!-- rungate:ai-review-ledger:v1 -->")))]
   | first // {body: null} | {body: .body}' > /tmp/ledger.json

bun evals/ai-review-control/run.ts capture /tmp/ledger.json \
    --round 1 --draw 1 --out /tmp/findings.json

bun evals/ai-review-control/run.ts score worktree-state-write/planted \
    /tmp/findings.json --reviewer "<the pinned package, or the tree's sha>"
```

`--draw` is required when the ledger holds more than one entry under a round
number, and `capture` refuses rather than taking the first: those entries are
separate draws of a sampled instrument, and reporting one as "the" behaviour is
the thing N exists to prevent. A round recorded as `findings: null` is refused
too — writing `{"findings": []}` for it would convert "nobody can say what the
reviewer found" into "the reviewer found nothing".

### What the ledger does NOT carry, and what that costs

#1509 proposed the ledger as the cheapest capture path on the grounds that it
"already carries `findings` per round in the shape `score` wants". **Measured,
it does not**, and the gap is two named fields. The writer's projection is
`[ .findings[] | {severity, file, line, summary} ]` plus a `text` anchor, and
the round entry around it is `{at, sha, merge, run, attempt, identity, round,
turns, findings}`.

| the payload contract requires | the ledger holds | what `score` reads |
|---|---|---|
| `verdict`: `PASS` or `BLOCK` | nothing — no round entry has ever carried one | `VERDICT_ABSENT`, on **every** round |
| `failure_scenario` on each blocking finding | projected away | `BLOCKING_FINDING_INCOMPLETE`, on **every** blocking finding |
| `severity`, `file`, `line`, `summary` | all four | — |

The second row decides what this path can measure. `DETECTED` requires a
blocking finding at the declared location, and a blocking finding read out of
the ledger is always incomplete — so **a ledger capture can reach `QUIET`,
`FIRED` and `MISSED`, and cannot reach `DETECTED`.** Recall is the half the
control exists for, and through this path it is structurally unreachable.

Both available repairs are refused in `capture.ts`, by name:

- **Synthesising the verdict** from the findings makes clean subjects readable
  and makes `CONTRADICTION` — the #1178 shape, roughly a third of runs —
  impossible to observe, because the word compared would be derived from the
  thing it is compared against. Two deciders that cannot disagree.
- **Synthesising `failure_scenario`** is writing the content of a finding on
  the reviewer's behalf, which is the one thing a control may never do.

The fix is for the ledger writer in `lib/scaffold/ai-review-step.ts` to record
the verdict and `failure_scenario`, and it is **#1511**. That is outside this
directory, and until it lands the ledger route gives the raw findings a human
can read beside the subject's declared answer, and an `UNMEASURED` from
`score`.

## The first readings, 2026-10-24

Stored in `baselines/review-control-readings.json`, taken through the protocol
above on draft pull request **#1510**, which was never merged, never labelled,
never auto-merged, and is closed. Reviewer: the `ai-review` job on
`hornjason/pai-harness`, adjudicated by `bunx rungate@0.8.2
ai-review-findings`.

**N = 2 per case**, each a separate attempt of one workflow run, on a
byte-identical tree. The reviewer is a sampled instrument (#1290, CRC-B3) and
one reading is one draw.

| case | N | `score` outcome, every draw | what the reviewer actually wrote, every draw |
|---|---|---|---|
| `worktree-state-write/planted` | 2 | `UNMEASURED` (`BLOCKING_FINDING_INCOMPLETE` ×2, `VERDICT_ABSENT`) | `high` at line **46** of the staged `lib/project-state-root.ts` — *"a linked worktree now falls through the `repoRoot !== projectRoot` guard into the ok path"* — **inside the declared plant range [42, 47]**, plus the confound below. 31 and 39 turns. |
| `worktree-state-write/clean` | 2 | `UNMEASURED` (`BLOCKING_FINDING_INCOMPLETE`, `VERDICT_ABSENT`) | **nothing at the arm**, both draws. The confound below and nothing else. 33 turns both draws. |
| `suite-lock-redirect/planted` | 0 | — | not measured, see below |
| `suite-lock-redirect/clean` | 0 | — | not measured, see below |

**The outcome set did not vary across draws**, which is a reading and not a
promise: four draws, two trees, no disagreement, against the 2 of 2 attempts
that disagreed on #1504. Two draws is not a variance estimate.

### Substantively, and through the instrument, are different answers

Through `score` all four readings are `UNMEASURED`, for the ledger-projection
reason above and for no reason about the reviewer. Read beside the subject's
declared answer, the raw findings say the reviewer **located the convention
break at the declared line, twice, and stayed silent about the arm in the
clean variant, twice** — which is what CRC-A4's promotion condition asks for
and is not a substitute for a reading the instrument can take.

**It is therefore not grounds to tick CRC-A4.** `.claude/rules/claiming-sc-coverage.md`
is explicit, and the whole of #1169 is that a reading nobody can take and a
reading that came back clean print the same.

### The confound, named rather than netted off

A `critical` finding at line **39** of the staged file appears in **all four
draws**, including both clean ones: the module has been replaced with a
compacted stub that no longer exports what its callers import. That is true of
the baseline, the planted candidate and the clean candidate alike — it is a
property of staging a compacted subject at a live production path, not of the
arm under measurement.

It costs the clean half its reading. A blocking finding on a clean subject is
`FIRED` by the control's rule, and the control has no way to tell a precision
failure about the subject from a true observation about the staging. A subject
whose `reviewPath` named a module the tree does not already have would not
have it, and that is the change to consider before the next reading.

### Why `suite-lock-redirect` was not measured

Its `reviewPath`, `lib/test-suite-lock.ts`, is named by five conformity
criteria — SC-648, SC-649, SC-759, SC-760 and SC-625 — which require content
the compacted subject copy does not carry. Staging it makes the pre-push
conformity gate refuse the measurement branch, and `--no-verify` is not an
option here. Measured: **5 of 1410** conformity cases red with the subject
staged, **0 of 1410** with it absent. That is a true refusal by a gate doing
its job, so the subject is unmeasurable by this route until its `reviewPath`
moves off a module the repository asserts the contents of.

## The five readings

| outcome | subject | meaning | verdict |
|---|---|---|---|
| `DETECTED` | planted | a blocking finding at the declared file and line range | green |
| `MISSED` | planted | no such finding — recall, measured | red |
| `QUIET` | clean | no blocking finding | green |
| `FIRED` | clean | a blocking finding — precision, measured | red |
| `UNMEASURED` | either | the payload could not be read, or the reading does not name its reviewer | **red** |

`UNMEASURED` is a distinct outcome from `QUIET` and it fails. "The reviewer
found nothing" and "nobody can say what the reviewer found" are different
facts, and the whole of #1169 is that today they print the same.

Advisory findings are counted and never fatal — they are the cheap tail. The
line that costs something is the blocking one, and `AI_REVIEW_SEVERITIES`
already declares which severities cross it.

## Precision over recall, inverting the source post

The Anthropic code-review post states its priority as catching real bugs first
and cutting review rounds second. That is right when a human absorbs the noise,
because a person waves off a nit in seconds. Nobody waves anything off here: a
false blocking finding costs a remedy commit, a CI round, a review round and an
agent's whole context. `MISSED` and `FIRED` are failures of equal weight, both
numbers are reported, and nothing optimises for recall.

## An empty run is not a pass

`summariseReviewControl([])` is red, and so is a run that measured only plants
or only clean subjects. Zero failures over zero subjects is an assertion that
holds vacuously, and it is the shape this instrument would decay into first —
quietly, the day a subject stops loading.

## Finding outcomes (#1225)

The control above measures recall. Recall alone cannot grade a filter: a filter
that drops a third of the noise and a filter that drops a third of the real
bugs produce the same reading, which is fewer findings. Anthropic's second
instrument is the check on that:

> We measure noise by watching what people do with the comments. […] We sort
> every comment the reviewer leaves by how the person on the PR responded: they
> fixed it, said it was wrong, said the behavior was intentional, or decided it
> didn't matter.

### Three of those four are verbal, and nothing here records them

"Said it was wrong", "said it was intentional" and "decided it didn't matter"
are things a responder *says*. Anthropic can sort by them because every finding
there has to be answered — "you either fix it or resolve the thread with a
reason" — so the reason exists as data. Here it does not: **195 of 566 closed
findings carry zero comments**, and the closing comments that do exist follow no
parseable convention. A classifier over that prose would be inventing three of
the four numbers.

So this module derives what the evidence carries and refuses the rest by name.

| outcome | derived from | measured? |
|---|---|---|
| `FIXED` | a commit on `origin/main` citing the finding, dated after it, that changed files | yes — the diff |
| `SUPERSEDED` | no such commit; the close names a finding whose chain reaches one | yes — the reference graph |
| `NO_ACTION` | closed, neither of the above | yes, **as a union** |
| `WRONG` / `INTENTIONAL` / `DIDNT_MATTER` | the responder's stated reason | only when `declared` is set |
| `SUPPRESSED` | a filter withheld the candidate | the filter says so |
| `OPEN` | unanswered — not an outcome | — |

`NO_ACTION` is the union of the three verbal categories and is never reported as
one of them. `noiseRate` is `null` rather than `0` while nothing declares a
disposition: "no noise" and "nobody recorded whether there was noise" are
different facts. `declared` exists so that the day a close records its reason,
the split becomes real without a code change.

### An id is a string, and a repeated one is a refusal (#1253)

`ReviewFinding.id` is a **string**, because the corpus this module was written
against is not the only one it will see: rg-1187's finding arbiter holds
candidates that were never filed, and an unfiled candidate has no issue number
to be keyed on. Key those on `CandidateRecord.key` (`${batch}/${index}`,
#1263) — **not** on `symptomHash`, which #1272 established is a similarity
identity rather than a row identity: it hashes the sorted symptom key SET, so
one reading written two ways hashes alike, while the dedupe matches on the key
INTERSECTION, so two genuine duplicates can hash apart. `outcomes-run.ts`
emits `String(issue.number)` and the backfill is unchanged by the widening.

`key` is `null` until the caller names a batch, deliberately. An unnamed batch
therefore keys every row alike and the duplicate refusal below fires — which
is the correct outcome, and the refusal now says so rather than printing an
empty id.

Ids must be **unique**, and a corpus that repeats one is `usable: false` rather
than a number. This was a live defect in the merged module, measured on the
three-row corpus in `test/review-outcome-taxonomy.test.ts`: two rows sharing an
id meant the second overwrote the first in the citation map, so a finding with
a real fixing commit read `NO_ACTION`, landed in `cost`, and the run reported
`usable: true` with nothing saying why the number was wrong. That is the one
direction this instrument must never fail in — it manufactures noise out of a
finding that was fixed, and `compareReviewOutcomes` would score the
manufactured version as a regression that did not happen.

### Backfill over this repo, 2026-10-22

```bash
bun evals/ai-review-control/outcomes-run.ts --repo hornjason/pai-harness
```

Population: **603 issues** (`#23`..`#1229`) scored against **1209 commits** on
`origin/main`. Pull requests are excluded — the tracker is the finding surface
here, and the inline-comment surface Anthropic measures holds **3 comments
repo-wide**. Citation filter: a citing commit counts only if dated at or after
the filing and it changed at least one file; **28 citations were dropped** under
it.

| outcome | count |
|---|---|
| `FIXED` | 399 |
| `SUPERSEDED` | 100 |
| `NO_ACTION` | 72 |
| `WRONG` / `INTENTIONAL` / `DIDNT_MATTER` | 0 — **UNMEASURED**, nothing emits a disposition |
| `OPEN` | 32 |

`closed=571`, `cost=172`, `costRate=0.301`, `noiseRate=WITHHELD`.

### Why it cannot be read as a licence to suppress

`compareReviewOutcomes` is the only comparison exported and it is deliberately
asymmetric: **any fall in `fixed` is `REGRESSION`, whatever happened to the cost
side** — including a filter that silenced the reviewer completely and drove the
cost to zero. There is no scalar here that improves when a true finding is
deleted, because any scalar that traded the two sides is one a filter could win
by going quiet. Populations must match, so a filter measured over a smaller
sweep than its baseline reads `UNMEASURED` rather than "improved".

It is built to grade **PR #1206** (#1187, the verifier quorum and category
filter) and **#1168** (round cap, diff-only re-review, no-repeats). It builds
neither mechanism.

### The plants

`REVIEW_OUTCOME_PLANTS` holds four real findings whose outcome was established
independently, one per measurable outcome, and the run exits non-zero if the
sweep disagrees with any of them. A sweep that cannot see its own
known-positives is not distinguishable from a blind one.

They have already earned it twice. `#23` caught a citation rule that scanned
commit **bodies** for closing keywords: it moved 21 findings into `FIXED`, and
both sampled were prose — `gh closes #23 in unprotected/x` is a test command
being described. `#547` caught a one-step supersede walk that scored every link
after the first as `NO_ACTION`, overstating the noise bucket by 26 rows out of
98. Both errors ran in the direction that flatters the reviewer.

A truncated history is refused rather than warned about, and the refusal asks
whether a root of `origin/main` is a graft rather than reading
`--is-shallow-repository` — that flag stays `true` after a deepen that reached
the root, and refusing on it would make the instrument unrunnable in the
repository it was built for. `test/review-outcome-taxonomy.test.ts` proves the
refusal against a real depth-1 clone.

### The harmful-change count is UNMEASURED

Anthropic's clean-PR instrument counts findings "that would have led someone to
make a harmful change". Deriving that mechanically needs a remedy you can
**apply**: write the suggestion over the clean candidate, re-run the command
table, count the rows that flip. `AI_REVIEW_FINDING_FIELDS` has no such field —
a finding carries a severity, a file, a line, a summary and a failure scenario,
all prose except the location.

So the number is unmeasured, and `FIRED` is the strongest thing the payload
supports. `test/review-negative-control.test.ts` holds a tripwire on the field
list: the day the contract grows a remedy field it goes red, and the fix is to
build the counter.

### Two clean subjects, not one (#1225)

`suite-lock-redirect/clean-loop` joins `clean`. One clean subject cannot carry a
rate — a single `QUIET` reading and a reviewer that is quiet about everything
are the same number. It is a different *kind* of refactor on purpose: `clean`
renames locals and extracts a predicate, while `clean-loop` rewrites the control
flow into a `while` with an explicit cursor and replaces the trailing `some`
with an early return. A reviewer can stay quiet on `clean` by finding nothing
textual to object to; the lookahead arithmetic in `clean-loop` is the shape it
is most likely to flag on suspicion.

## Single-adjudicator variance

`variance-capture.ts` runs one batch through the **deployed** filing
adjudicator M times and records the withheld set each time. The stored
reading is `baselines/single-adjudicator-variance.json`, loaded by
`loadVarianceCapture` in `baselines.ts`, which refuses a capture whose commit
moved mid-run.

**Read the caveat before the number.** The answer is zero, and it is zero *by
construction*. `hooks/VerifyPhaseLock.hook.ts` → `filingGate` →
`adjudicateFiling` runs two pure stages — `classifyCategory` (regex) and
`duplicateCollisions` (set arithmetic over `symptomKeys`) — with no clock, no
randomness, no network and no model. A repeated run cannot disagree with
itself, so the capture is a control establishing that the deterministic half
contributes none of the variance. It is **not** evidence that a quorum has
nothing to fix: a quorum is a variance control for an *agent* verifier, and
`arbitrate` — the five-stage path that takes votes — has no caller outside
`lib/` and `test/`.

The reading that looks most like success here is the signature of the failure
mode, which is why the artefact carries `permanentlyUnmeasured` as a
first-class field and why both the capture and its loader refuse rather than
score.
