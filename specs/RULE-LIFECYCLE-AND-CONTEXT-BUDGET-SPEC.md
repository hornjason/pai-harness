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
- [ ] SC-1931: Baseline rule bodies contain no repo-specific identifier — no issue number, date, file path or incident from a single project
- [ ] SC-1932: Every mined rule carries a `paths:` list scoped to the code it governs

### Budget

- [ ] SC-1933: Scaffold computes max-concurrent-load per file and reports the maximum with the file producing it
- [ ] SC-1934: Max-concurrent-load over budget is a FAIL naming the overlapping rules, with glob-narrowing as the first fix command
- [ ] SC-1935: Total rule count is not capped — only concurrent load is
- [ ] SC-1936: A mined rule whose globs match every file in the repo is reported as unscoped
- [ ] SC-1937: Glob expansion per rule stays within 1,000 expanded patterns and 4 MiB

### Promotion and lifecycle

- [ ] SC-1938: A scaffold run with zero human interaction produces a populated, scoped rule set
- [ ] SC-1939: Promotion ranks on the mechanical evidence score — a candidate with no evidence never outranks one with evidence
- [ ] SC-1940: Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` and it is never re-promoted
- [ ] SC-1941: A rule whose cited `file:line` no longer resolves is auto-retired, not warned about
- [ ] SC-1942: Eval-gated retention is disabled until its delta measurement has a mutation test proving it goes red

### Sources

- [ ] SC-1943: Makefile targets, `package.json` scripts and CI workflow files are scanned for constraints alongside markdown
- [ ] SC-1944: `CODE-MAP.md` is excluded from constraint sources
- [ ] SC-1945: A consumer scaffolded with zero mined rules is reported as such, not as a complete rule set

### Idempotency

- [ ] SC-1946: Running scaffold twice over the golden fixture produces byte-identical rules directories
- [ ] SC-1947: Constraint extraction runs as part of scaffold and re-scaffold, not only as a separate command
- [ ] SC-1948: Hand-edited rule files are preserved across all of the above and reported, not silently regenerated

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
