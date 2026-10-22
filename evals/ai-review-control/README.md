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

Nothing in a staged subject says which one it is, or that it is a subject at
all. A banner reading "planted defect below" turns a recall measurement into a
reading-comprehension one.

Both premises are **run**, not asserted. `test/review-negative-control.test.ts`
executes all three candidates over a table of commands and requires the planted
one to disagree with its baseline on exactly the two `&>` rows, and the clean
one to disagree on none.

## Running it

```bash
bun evals/ai-review-control/run.ts list
bun evals/ai-review-control/run.ts stage suite-lock-redirect/planted /tmp/subj
git -C /tmp/subj diff                      # the diff a reviewer reads
# …point a reviewer at it, collect the findings payload it writes…
bun evals/ai-review-control/run.ts score suite-lock-redirect/planted \
    /tmp/findings.json --reviewer rungate@0.8.0
```

`--reviewer` is required and not defaulted. CI adjudicates with a pinned
published package (`.github/workflows/ai-review.yml`, `bunx rungate@<pin>`,
deliberate per #1013) while the tree runs ahead of it, so a reading that cannot
say which of those it watched is a number about nothing. An unnamed reading is
UNMEASURED.

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
