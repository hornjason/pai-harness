---
doc-type: research
governs: The false positive and false negative rate of `classifyCommitSubject` in `lib/failure-intake.ts`, and what a narrowing or widening of it would cost
created: 2026-10-21
status: active
owner: jason
updated: 2026-10-21
---

# The commit-subject classifier's error rates, measured

**Both rates, with their denominators:**

| | Count | Denominator | Rate |
|---|---|---|---|
| **False positives** — mined, not an incident | **6** | 302 mined candidates | **2.0%** |
| **False negatives** — an incident, not mined | **92** | 198 skipped subjects | **46.5%** |
| the same false negatives against every incident | 92 | 388 incidents in the window | 23.7% |

The miner sees **296 of the 388** incidents in the window.

Every number here is recomputed on every test run by
`test/commit-classifier-rates.test.ts`, which runs the real
`classifyCommitSubject` over the frozen labels in
`test/fixtures/commit-classifier-corpus.json`. Narrow or widen the classifier
and these numbers move, and the cases say by how much. Nothing in this
document is a figure somebody typed.

## The corpus, and why it flatters the classifier

A census, not a sample: **all 500 commits** `git log --no-merges -n500` returns
on this repository's `main`, pinned to the head it was taken at. Every row was
read and labelled by hand as `incident` or `not-incident` with a category, and
the test refuses a row with no label — a census with a default is not a census.

**This is the corpus the classifier was tuned on, and that is the most
important sentence in this document.** `lib/failure-intake.ts` was written
against this repository's commit convention; its own docblock quotes four
subjects from this `main` as the evidence that a commit subject is a rule
candidate at all. Measuring it here asks whether it reads the sentences it was
shaped around, and the answer is yes.

So:

- **The 2.0% false-positive rate is a fact about this repository's commit
  hygiene, not a property of the classifier.** A repository whose `fix:`
  commits say *"fix build"* or *"fix typo"* would score differently, and
  nothing here can say by how much.
- **The classifier's error rate on any other repository is UNMEASURED.**

### What measuring the general rate would require

Stated so the gap is a specification rather than an excuse:

1. **Commit histories from repositories that did not shape the regex** — at
   minimum several, spanning the conventional-commits-strict, loosely
   conventional, and no-convention styles, since the escape structure below is
   entirely a function of which style the repository writes in.
2. **A labelling rubric applied by someone who did not write the classifier**,
   with at least two raters and a reported agreement figure. This corpus has
   one labeller and no adjudication, so its boundary cases are one judgement.
3. **A labelling input richer than the subject line.** Both the classifier and
   the labeller here read only the subject, so a commit whose subject
   misdescribes its diff is scored consistently wrong by both and the error is
   invisible to this instrument.

None of those is available offline from inside this tree, which is why this
document reports what it can and names what it cannot.

## The false positives: all six, and what they are not

```
 25  fix(#924): every assertion in anti.test.ts says what to write instead (#954)
 28  fix(#915): wire #722's workflow census into a consumer check, override-aware (#928)
201  fix(#274): exercise the five tier-gated subsystems a consumer run uses, on a consumer fixture (#595)
257  fix(#485): seed SUCCESS.md, and refuse one that is still a template (#502)
316  fix(#189): dispatch decomposed sub-issues in dependency waves (#419)
457  fix(#72): #65 Phase 2: Scaffold generates tsconfig.json for consumer projects
```

Five are features and one is test work, each shipped under `fix:`. **Not one is
trivial.**

That matters, because #988's motivating false positive is
`fix(#1): the typo in the README heading (#2)` and its proposed narrowing is
diff size or touched paths. Two measurements against that:

- **The trivial-`fix:` shape has zero instances in 500 commits.** The escape is
  real — the classifier does mine that subject, and
  `test/failure-intake-promotion.test.ts` asserts it — but the population is
  empty here. An escape and a rate are different facts.
- **Narrowing by diff size would catch none of the six without discarding real
  incidents.** Measured churn (insertions + deletions, rename-aware):

  | | n | median | min |
  |---|---|---|---|
  | mined true positives | 296 | 566 | 18 |
  | the six false positives | 6 | **850** | 198 |

  The false positives are *larger* than the true positives. A "reject small
  diffs" rule at any threshold catching all six would reject **295 of 296**
  real incidents; even a threshold at the smallest false positive (198 lines)
  discards 31 genuine ones and catches one. Diff size is not the lever.

The common factor in all six is a subject that announces a *capability* rather
than a *failure* — "generates", "dispatch", "wire … into", "exercise". If a
narrowing is wanted, that is where the signal is, and it is a property of the
sentence rather than of the diff.

## The false negatives: the escape #988 did not anticipate

#988 scopes the false-negative question to `feat:`/`refactor:`/`perf:`. The
measured composition of the 92:

| Leading token | Count |
|---|---|
| **no prefix at all — a plain sentence** | **62** |
| **`#N:` — this repository's later convention** | **23** |
| `feat:` | 5 |
| `test:` | 1 |
| `chore:` | 1 |

**Five of ninety-two.** Eighty-five of the ninety-two — 92% — carry no
conventional prefix, so no widening over conventional types reaches any of
them. Representative examples, all on `main`, all as rule-shaped as anything in
the mined set:

```
The re-scaffold command destroyed the rule it was told to preserve (#370) (#373)
Stop the syntax witness failing open on unparseable input (#89 review 2) (#100)
Four ways of not knowing, all spelled PASS (#341) (#357)
#323: the flake series reported CONSISTENT over ten killed runs (#792)
#853: the ai-review drift reading measures content, not index state (#855)
```

And the widening, costed: accepting every conventional type recovers **7** real
incidents and admits **92** new false positives, 43 of them `docs:`. That is a
worse classifier by both measures simultaneously — which is what #988 suspected
and could not prove.

## What this says about the next change

Stated as a finding, not as a change — #988 asks for measurement before either
move, and nothing in `lib/failure-intake.ts` was altered.

1. **The false-positive problem is small and misdiagnosed.** 2.0%, and the
   proposed lever does not move it.
2. **The false-negative problem is large and mislocated.** 46.5% of skipped
   subjects, and the named population accounts for 5 of them. The reachable
   population is the free-form and `#N:` subjects, which is a different kind of
   detector entirely — the prefix carries no information there, so the decision
   would have to come from the sentence.
3. **The ranking consequence is the one to weigh.** Every mined candidate
   carries a sha, a date and issue numbers, so it outranks doc prose. Six wrong
   candidates competing for a budget of 16 is a real cost; ninety-two invisible
   right ones is a larger one.

## WHAT THIS DOES NOT COVER

Each of these is asserted as a case in `test/commit-classifier-rates.test.ts`
rather than left here as prose.

- **The generalisation.** The corpus is the tuning corpus. UNMEASURED, with the
  requirements above.
- **Diff content.** Subject lines only, for both the classifier and the
  labeller, so a commit that misdescribes itself is invisible.
- **Inter-rater agreement.** One labeller, no adjudication. The rows are
  committed with their categories so a disagreement lands on a row rather than
  on a rate.
- **Durability of the window.** `-n500` means something different next week.
  The corpus pins the window to one head, which also means these rates stop
  describing the repository once 500 more commits land.
- **Revert commits.** The window contains none, so the `revert-commit` half of
  the classifier has a denominator of zero here and no rate at all.
