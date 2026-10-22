# ai-review negative control (#1169)

A reviewer that returns CLEAN on everything is indistinguishable from one that
works. This is the instrument that tells them apart.

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
