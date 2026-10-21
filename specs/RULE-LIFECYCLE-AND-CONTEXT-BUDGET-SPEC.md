---
doc-type: spec
status: draft
owner: jason
created: 2026-10-17
updated: 2026-10-17
governs: Agent rule lifecycle — baseline vs mined tiers, path-scoped loading, concurrent-load budget, automatic promotion and retirement
testable: true
compliance: strict
---

# Rule lifecycle and context budget

## Context

When rungate initializes or re-initializes a repository, that repository should
end up in the best possible starting state for an agent — automatically,
idempotently, and without a human triaging a backlog.

It does not. Measured against DailyBriefDashboard on 2026-10-16:

| | Reality |
|---|---|
| Candidates produced | **1,010**, all `pending`, across 114 markdown files |
| Candidates promoted | **0** |
| Does scaffold extract? | **No** — the only caller is conformity HYGIENE-6, with `apply: false` |
| What `--apply` would do | write all 1,010 into `AGENTS.md`, unranked and uncapped |
| Non-markdown sources mined | **none** — Makefile, package.json, CI workflows, git history all unread |
| DDB-specific rules in `.claude/rules/` | **zero** |

The constraints are being found — `CLAUDE.md` contributes 40 candidates,
`ARCHITECTURE.md` 60, `PRINCIPLES.md` 40. The pipeline stops after generating
them.

### What this costs

On 2026-10-16 an agent removed `force: true` from DailyBriefDashboard's
`src/lib/context-orchestrator.ts` — a flag #1245 set deliberately so content
generation gets guaranteed-fresh signals — and wrote in the commit message that
the call site had "opted out of the cooldown." Nothing in DDB's repository
recorded the decision, so nothing contradicted the agent. A human caught it.

That is the failure this spec exists to prevent, and it is the inverse of
`SUCCESS.md`'s thesis: *"trust the result without re-measuring it by hand."* An
agent operating without a repository's own constraints produces work that must
be re-measured by hand, every time.

### The baseline template carries another repository's data

DailyBriefDashboard's `.claude/rules/checks-must-be-able-to-fail.md` carries
`generated-sha: 760e110af6d1d700` — the harness generated it — and its body
opens with *"the single most common defect in **this codebase's** own
tooling"*, followed by five incidents that happened in rungate's workflow
sandbox. DDB is a Bun dashboard with Playwright specs and scrapers. It has no
prompt-immutability gate and no module-loading sandbox.

Three of eight shared rules files are byte-identical across the two
repositories. For `agent-principles.md` and `ship-workflow.md` that is correct.
For `checks-must-be-able-to-fail.md` it is the defect.

### There is no human-authored tier

Four rungate rules files lack a `generated-sha` and are preserved by provenance
(#370) as though hand-edited. `git log` shows all four were written by
ship-pipeline runs (#479, #445, #436, #360, #214, #342, #296, #88). They are
**agent-authored**. The "preserved" category is not a human tier — it is
unmanaged, unranked, unscoped mined content that accumulated by accident.

## How rule loading works

Verified against Claude Code documentation and reproduced in this repository on
2026-10-16. `.claude/rules/` is a native convention: every `.md` is discovered
recursively, with no `@import` required. Exactly one frontmatter key governs
loading.

| Frontmatter | When it loads |
|---|---|
| no `paths:` | at launch, same priority as `CLAUDE.md` |
| `paths: [globs]` | on demand, when Read/Write/Edit touches a matching file |

`paths` is the **only** key Claude Code reads. `description`, `doc-type`,
`owner` and `generated-sha` are ignored without error, and the whole
frontmatter block is stripped before the rule enters context — so rungate
bookkeeping in frontmatter costs no tokens.

Reproduced: `harness-managed.md` (globs `.github/workflows/ci.yml`,
`.claude/agents/**`, `CODE-MAP.md`) did not load, because none were touched.
`specs-routing.md` (globs `specs/** lib/** gates/** hooks/** scripts/**`) did
load, after `lib/conformity.ts` and `scripts/extract-constraints.ts` were read.

Glob limits are one budget of 1,000 expanded patterns and 4 MiB per rule. Brace
groups multiply: `{a,b}/{c,d}/*.{ts,tsx}` is eight patterns.

## The design

### Two tiers, and only two

| Tier | Mechanism | Re-scaffold | Lifecycle |
|---|---|---|---|
| **Baseline** | no `paths:` — always loaded | regenerated from template | none; curated, must stay small |
| **Mined** | `paths:` scoped to the code it governs | recomputed from evidence | scored, promoted, retired |

`tier` cannot be enforced through frontmatter, because Claude Code ignores
unknown keys. **`paths` is the only load-time lever.** `tier` is rungate
bookkeeping; the glob does the work.

### The budget is max-concurrent-load, not a count

The cap does not apply to how many rules exist. It applies to how many can load
at once:

> For every file in the repository, count the rules whose globs match it. Take
> the maximum.

This is statically computable at scaffold time from the file list and the
globs. It is deterministic, needs no agent run, and it can fail — which the
`>20 rules` WARN in SC-176 cannot meaningfully do. A warning is how 1,010
candidates accumulated; this spec does not add another.

Total rule count is explicitly uncapped. An over-budget repository is fixed
first by narrowing a glob, not by deleting a good rule. Eviction applies only
to the always-loaded baseline set and to mined rules whose globs cannot narrow
further.

### Promotion is automatic; the human role is veto

A gate requiring a human to approve 1,010 candidates is a backlog with extra
steps, and it defeats the purpose — the repository is supposed to carry the
knowledge so it is not in one person's head.

Candidates rank on evidence the repository already holds: whether the cited
`file:line` still resolves, whether the candidate derives from a dated incident,
how recently the governed code changed, how often the directive has been
violated in graded runs, and whether it states a prohibition rather than
restating code.

Promotions land as a git diff on `.claude/rules/`. Rejecting one writes its
content hash to `reference/rejected-constraints.md` and it never resurfaces
(SC-137).

The inversion is the point: **today silence means nothing happens; after,
silence means the system runs.** Attention is spent only to stop something.

The failure modes are asymmetric and the costly one is already realised.
Over-promotion is bounded — capped concurrent load, a reviewable diff,
automatic retirement, a permanent veto. Under-promotion is the status quo, and
its cost is the `force: true` incident above.

### Behavioural eval is a retention signal, not a promotion gate

`lib/canary.ts`, `lib/instruction-effectiveness.ts`, `lib/hill-climb.ts` and
`lib/behavioral-cache.ts` exist, but none has been shown to produce a delta
measurement that can fail for the right reason. An eval returning "no delta"
because the harness broke is indistinguishable from one returning "no delta"
because the rule is useless — the exact shape
`.claude/rules/checks-must-be-able-to-fail.md` is about.

The eval therefore does not gate promotion. It informs retirement, and only
once a mutation test shows its measurement goes red when the measured behaviour
changes.

### Cold start

Ranked by evidence density, all deterministic:

1. `CLAUDE.md` — DDB's is 261 lines with 48 constraint-shaped lines, every one
   non-inferable and already written by a human.
2. ADRs — 35 active in DDB; decisions with recorded rationale.
3. Git history — reverts and fix-on-ship commits (arrives with #545).
4. Existing doc candidates, ranked, with the majority discarded to
   `rejected-constraints.md`.

`CODE-MAP.md` is deliberately excluded: it is derived from the code, so by
construction it holds only what an agent can infer by reading. Rules exist for
what cannot be inferred.

Non-markdown sources must be added — Makefile targets, `package.json` scripts
and CI workflow files all encode hard constraints and none is scanned today.

### Migration of hand-written content

A consumer's `CLAUDE.md` should shrink as constraints move to path-scoped
rules. That migration must be explicit and reviewable, never silent. Provenance
protects a user's edits; it does not protect against the harness relocating
their content.

## Specs this supersedes

`specs/bootstrap-data-flow/` specifies the opposite of this design on two
points. Both are amended by this spec:

- `problem-statement.md:227` — "Phase 1.5 — EXTRACT (separate command, **not
  auto-run**)". Extraction runs on every scaffold and re-scaffold, including
  existing repositories.
- `problem-statement.md:22` — Hard Constraints in `AGENTS.md` as the only
  surviving user-owned content. The target becomes `.claude/rules/*.md`.

SC-176 (`Hard Constraints >20 rules produces WARN`) is superseded by SC-1933
below: the budget is concurrent load, and it FAILs rather than warns.

The constraint SCs in `specs/bootstrap-data-flow/success-criteria.md` must be
re-audited before anything is built on them. SC-13 reads `[x]` — "Extracted
candidates presented for user confirmation before writing to AGENTS.md" — and
no review command exists; the only presentation is JSON on stdout and a WARN
count. Re-verify SC-12, 13, 22, 23, 137, 154 and 156 against what the code
does. See `.claude/rules/claiming-sc-coverage.md`.

## Success Criteria

### Tiers and ownership

- [ ] SC-1930: Baseline rules carry no `paths:` key in frontmatter
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-1931: Baseline rule bodies contain no repo-specific identifier — no issue number, date, file path or incident from a single project
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-1932: Every mined rule carries a `paths:` list scoped to the code it governs
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Budget

Implemented by #544, in `scripts/check-instruction-surface.ts` and driven by
`test/instruction-surface-budget.test.ts`.

The reading is in **bytes, not in rules**. A count cannot tell a one-line rule
from a nine-kilobyte one, and the thing being budgeted is context.

It extends #1009's launch measurement rather than sitting beside it. The launch
surface is the peak's floor — the reading for a file no glob matches — so
`peak <= budget` implies `launch <= budget` and `SURFACE_BUDGET_BYTES` stays
the single declaring position. A second constant for concurrent load would be
two deciders for one question, and a mutation of either would leave the other
holding the case up.

**`paths:` was a budget escape hatch, and it had been used.** #1009 excluded
every path-scoped rule at `bytes: 0`, correctly for the question it asked and
with the consequence that no number governed a scoped rule at all. Measured on
2026-10-21, before the fix: launch 56,640 bytes, and
`.claude/rules/harness-managed.md` — scoped, therefore uncounted — a further
9,484. Editing any file under `.claude/agents/**` put the reading at 66,124
against a 64,000-byte budget that reported the repository clean. Repaired by
the remedy this spec prescribes: the worked records moved to
`reference/harness-managed-worked-instances.md`, nothing deleted, peak 62,671.

- [x] SC-1933: Scaffold computes max-concurrent-load per file and reports the maximum with the file producing it
- [x] SC-1934: Max-concurrent-load over budget is a FAIL naming the overlapping rules, with glob-narrowing as the first fix command
- [x] SC-1935: Total rule count is not capped — only concurrent load is
- [x] SC-1936: A mined rule whose globs match every file in the repo is reported as unscoped
- [x] SC-1937: Glob expansion per rule stays within 1,000 expanded patterns and 4 MiB

### The always-loaded surface has a declared size (#1009)

The budget above is max-concurrent-load, which is the right shape for the
mined tier and says nothing about the baseline. The baseline is what every
agent pays unconditionally, and on 2026-10-21 it was measured at **176,020
bytes — roughly 44,000 tokens** of `CLAUDE.md` + `AGENTS.md` + nine un-scoped
rules, with `checks-must-be-able-to-fail.md` alone contributing 119,308 of it.
`harness-managed.md` and `specs-routing.md` carry `paths:` and are excluded:
they load on demand, so a count that includes them overstates the launch
surface by 13,728 bytes.

#1009 moved the measurement records out to `reference/` and left the rules,
taking the surface to **55,764 bytes (~13,900 tokens)**. The records were
moved, not deleted — they are the only evidence several of this repository's
checks were ever proved able to fail, and deleting them is the cheapest wrong
fix, named on the issue before the work started.

The enforcement lives in `scripts/check-instruction-surface.ts`
(`SURFACE_BUDGET_BYTES`, one declaring position) and
`test/instruction-surface-budget.test.ts`.

- [x] SC-2440: Every refusal in the surface check exits through one exported
      constant, declared once, with no relative imports, so a mutant can
      neutralise it
- [x] SC-2441: A surface reading that could not be taken — zero rule files, or
      a missing `CLAUDE.md` — FAILS as UNMEASURED rather than scoring as a
      small surface
- [x] SC-2442: A surface over the declared budget is a refusal whose message
      carries the current measurement, the largest contributors, and moving
      records to `reference/` as the remedy
- [x] SC-2443: The measured population is derived from the tree, so a rule
      file nobody listed — including one in a nested directory — is counted
- [x] SC-2444: A rule carrying `paths:` is excluded from the launch surface,
      and the same body without `paths:` is refused, so the exclusion is
      load-bearing
- [x] SC-2445: The measurement is of the rule body, because Claude Code strips
      frontmatter before a rule enters context
- [x] SC-2446: This repository's own surface measures under
      `SURFACE_BUDGET_BYTES`, over a population too large to be vacuous
- [x] SC-2447: The budget stays within 35% of what it measures, so it cannot
      be inflated to a number that never binds

### Promotion and lifecycle

- [ ] SC-1938: A scaffold run with zero human interaction produces a populated, scoped rule set
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [x] SC-1939: Promotion ranks on the mechanical evidence score — a candidate with no evidence never outranks one with evidence
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-1940: Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` and it is never re-promoted
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that reference/rejected-constraints.md exists, while the criterion coordinates a further claim (it is never re-promoted) — the file is mentioned, not what the criterion is about) -->
- [x] SC-1941: A rule whose cited `file:line` no longer resolves is auto-retired, not warned about

Implemented by #544 in `lib/rule-retirement.ts`, run by
`scripts/extract-constraints.ts` before promotion and driven by
`test/rule-retirement.test.ts`.

Retirement is the only step in this lifecycle that REMOVES, and the only one
that makes the rest safe: a ladder that only adds degrades the thing it feeds.
It reads both citation forms the miners emit — `git:<sha>` from
`lib/failure-intake.ts`, `path:line` from `scripts/extract-constraints.ts` —
and reuses `lib/line-citation.ts` for the second rather than reimplementing
the resolution it already does.

**The correctness question has a direction, and it is the shallow clone.**
`git cat-file -e` answers "no" for every commit before a shallow cut,
including every commit that is fine upstream, and `actions/checkout@v4` with
no `fetch-depth` puts a CI runner in that state by default. So there are three
readings and not two — RESOLVES, GONE, UNMEASURED — and UNMEASURED never
retires anything. A pass that read a shallow clone's "no" as GONE would retire
the entire mined tier on its first CI run, and the diff would look like the
system working. Same for a citation form the parser does not recognise: kept,
and reported as unread.

Retirement happens at the generator. A retired candidate is not emitted on the
next run, so the rule stops being written. Nothing deletes a `.claude/rules/*.md`
file, and a hand-edited one is preserved by #370 and is not the generator's to
retire.
- [ ] SC-1942: Eval-gated retention is disabled until its delta measurement has a mutation test proving it goes red
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Sources

- [ ] SC-1943: Makefile targets, `package.json` scripts and CI workflow files are scanned for constraints alongside markdown
<!-- REVIEW: unmatched (rewriting as file-exists would assert only that package.json exists, while the criterion coordinates a further claim (CI workflow files are scanned for constraints alongside markdown) — the file is mentioned, not what the criterion is about) -->
- [ ] SC-1944: `CODE-MAP.md` is excluded from constraint sources
<!-- REVIEW: unmatched (rewriting as file-exists would drop the file `CODE-MAP.md` the criterion names) -->
- [ ] SC-1945: A consumer scaffolded with zero mined rules is reported as such, not as a complete rule set
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

### Idempotency

- [ ] SC-1946: Running scaffold twice over the golden fixture produces byte-identical rules directories
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-1947: Constraint extraction runs as part of scaffold and re-scaffold, not only as a separate command
<!-- REVIEW: unmatched (no registry pattern was close enough) -->
- [ ] SC-1948: Hand-edited rule files are preserved across all of the above and reported, not silently regenerated
<!-- REVIEW: unmatched (no registry pattern was close enough) -->

## Proving it

Two acceptance runs, both required.

**Blank slate.** Scaffold `test/fixtures/golden-project/`, diff every output
file at content level — `specs/BOOTSTRAP-TEST-PLAN.md:63` (TD-1) already names
this the primary oracle, because *"a file-exists test passes with an empty
file; a golden-diff test doesn't."* Then scaffold again and byte-compare.

**Re-run on DailyBriefDashboard.** An existing repository with 1,010
candidates, 261 lines of `CLAUDE.md` and zero mined rules. It must pull the
right templates, produce a scoped mined set, stay inside the concurrent-load
budget, and clobber nothing.

Per `.claude/rules/checks-must-be-able-to-fail.md`, record what was broken to
make each guard go red. The eviction and concurrent-load checks are the ones
most likely to pass because of what they never look at: short-circuiting the
evictor or the overlap counter to `return []` must turn the budget tests red,
and the count must be recorded here.

### The concurrent-load battery (#544, 2026-10-21)

Seven mutations against `test/instruction-surface-budget.test.ts`, baseline
**40 pass / 0 fail**. Each count is of tests reddened, with the mutation named
rather than described.

| Mutation | Red | What it reddened |
|---|---|---|
| `SURFACE_BUDGET_BYTES` 64,000 → 10,000,000 | 5 (**1 attributable**) | SC-2447 — the budget may not sit more than 35% above what it measures |
| the peak never updates (`if (hits.length > 0 && bytes > peakBytes)` → `if (false)`) | 8 | both SC-1933 readings, all three SC-1934 refusals, both SC-1935 cases, and SC-2444's paired case |
| scoped rules never collected (`if (!isPathScoped(text)) continue` → `continue`) | 10 | the eight above, plus SC-1936 and SC-1937 |
| the unscoped detector never fires (`m.matchCount === files.length` → `false`) | 1 | SC-1936 — a glob matching every file |
| the glob-overrun detector never fires | 1 | SC-1937 — 1,296 patterns from one line |
| the walk floor made unreachable (`files.length < floor` → `< 0`) | 1 | SC-1933 — a walk that loses the tree is UNMEASURED |
| `rulePaths` → `return []` | 12 | all of the above plus both parser cases |

**The budget mutation's 5 decompose into 1 and 4, and the 4 are not
attributable.** Those four fixtures size their filler from
`SURFACE_BUDGET_BYTES` — `filler(SURFACE_BUDGET_BYTES * 2)` becomes a 20 MB
rule at the mutated value, which trips the 4 MiB per-rule limit (SC-1937) and
refuses *before* the budget comparison is reached. Verified by reading the
mutant's stderr rather than its exit code:

```
RULE SIZE: <the 20 MB fixture rule> is 20000010 bytes,
over Claude Code's per-rule limit of 4194304 (#544, SC-1937).
```

This is #1009's own confound, inherited: a fixture sized from the constant
cannot tell one budget from another. Two cases in the battery are immune and
are the ones the binding rests on — SC-2447, which compares the constant
against the measured tree, and SC-1934's *the comparison is against the budget
it is given*, which runs one fixture of literal size against two literal
budgets and gets opposite verdicts.

`rulePaths` returning `[]` was not only a mutation. The first implementation
used `\Z` in a regex, which JavaScript reads as a literal `Z`; every rule
parsed to zero globs and the peak equalled the launch surface on every tree.
It went red on the fixtures above before it reached review.

### The retirement battery (#544, SC-1941, 2026-10-21)

Eight mutations against `test/rule-retirement.test.ts` and
`test/failure-intake-promotion.test.ts` together, baseline **43 pass / 0
fail**. Fixtures are real git repositories built on disk — including a real
`--depth 1` clone — never hand-written candidate lists, because #545 names
that requirement and it is the same requirement here.

| Mutation | Red | What it reddened |
|---|---|---|
| the resolver never says GONE | 5 | the sha pair, both retirement cases, the summary, and the converted escape |
| a shallow clone treated as answerable | 3 | the shallow resolver case, the shallow pass, and the UNMEASURED promotion |
| a BROKEN `path:line` kept | 1 | the `path:line` pair |
| an unrecognised citation form retired | 1 | the parser-gap case |
| retired candidates also kept (warn, not retire) | 4 | both retirement cases, the summary, the converted escape |
| the unmeasured reasons dropped | 3 | the shallow pass, the non-repository pass, the UNMEASURED promotion |
| `upstream` folded from the first element only | **0 → 1** | see below |
| the upstream discriminator not authoritative | 1 | the silent-UNMEASURED case |

**The seventh came back 0 red and the test was wrong, not the mutation.** The
`upstream is a LIST` case asserted only `.reading`, and the verdict survived
the mutation through the authoritative-discriminator check immediately below
it while the REASON was silently dropped — two projections of one computation
disagreeing, which is the shape this module's own docblock warns about. Naming
the input the two folds differ on (a MEASURED upstream followed by an
UNMEASURED one carrying a named reason) and asserting the reason list took it
to 1 red.

## SUCCESS.md

This spec moves no existing numbered claim. Claim 5 is closest, but its named
check is a full non-LIGHT consumer run, which this does not perform, and
`SUCCESS.md:378` forbids borrowing urgency. It is governed instead by the
proposed sixth claim:

> 6. **A repo the harness manages carries its own non-inferable constraints.**
>    Check: every consumer receives the harness baseline, **and** a mined tier
>    derived from that repo's own history and evidence. Falsified when a
>    consumer's rule set is entirely baseline, when a baseline rule cites
>    evidence from a different repo, or when an agent change contradicts a
>    recorded prior decision in that repo.

All three falsifiers are true for DailyBriefDashboard today, so the claim opens
at **No**.

## Tracking

- #544 — this spec's implementation: tiers, path-scoping, budget, promotion
- #545 — failure intake: transcripts, reverts, CI failures as candidate sources
