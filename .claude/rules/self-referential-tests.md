---
description: Tests that assert a property about this repository itself — what trips them, and the exact file and line to edit when one goes red
doc-type: reference
status: active
owner: jason
updated: 2026-10-21
---

## The shape

Some tests here do not test a unit of code. They assert a property about **this
repository**: a census of citations, a list of files on disk, a count of ticked
criteria, two documents agreeing. They go red when your change is correct, in a
file you never opened, because the tree moved.

Measured 2026-10-19: three of eight PRs from one swarm were red, all three like
this, none a flake. Every fixer ran its targeted suite, saw green, and pushed.

**Read this before you add a file, add a doc, add an anchor, or rename
anything.**

## First, the one that will mislead you

**`DRIFT-3` forbids the escape hatch.** `.claude/conformity-allowlists.json`
looks like the place to record "this new file is fine". Adding an entry to it
**fails the suite** — `lib/conformity.ts` diffs the file against `origin/main`
and refuses any array that grew.

So for the orphan and untested-spec checks the only legal fix is to make
something genuinely reference the new file. Reaching for the allowlist makes it
worse, and it is the first thing a stuck agent reaches for.

One consequence worth knowing: DRIFT-3 compares against `origin/main`, so a
branch that is behind can fail on somebody else's merged entry. Rebase before
you debug.

## Tier 1 — tripped by adding ANY ordinary file

These are the ones most likely to hit a PR that has nothing to do with them, and
every one fails with a bare `expect(...).toEqual([])` and no guidance.

| Check | Fires when | Fix |
|---|---|---|
| `HYGIENE-3` orphaned files | a new top-level file in `specs/`, `scripts/` or `prompts/` is referenced nowhere | make something reference it — **not** the allowlist |
| `HYGIENE-4` spec routing | a new `specs/*.md` | add a row to `.claude/rules/specs-routing.md` |
| `SC-1891` | same population, second binding over `AGENTS.md` + `.claude/rules/*` | same row |
| `DRIFT-2` untested specs | a new `testable: true` spec no test names | name the spec in a test |
| `CLOSURE-1` / `CLOSURE-8` | a published file imports **or `readFileSync`s** something outside `files[]` | add it to `package.json` `files[]` |

`CLOSURE-8` is the one people miss: a `join(import.meta.dir, "..")` read is the
same property as an import, expressed in different syntax.

## Tier 2 — a hand-maintained list or number you must update

The constant is in the test file itself unless stated otherwise.

| Tripped by | Edit |
|---|---|
| a new `test/consumer-*.ts` | `SCANNED_FILES`, `test/consumer-no-rebuild-delegation.test.ts` |
| a doc gaining or losing a `path:NNN` citation | `.claude/line-citation-ratchet.json` → `documents` |
| a computed (non-literal) anchor cutting `ship.js` | spell the anchor as a string literal — **no exemption list by design** |
| a fixed-character `.slice(at, at + N)` in `test/` | use `structuralCut` from `lib/source-slice.ts` — no exemption list |
| a new direct `.claude/rungate.json` path read | `.claude/config-access-ratchet.json` (absent file = zero allowed) |
| ticking an SC with no coverage claim — i.e. running `sync-sc-status` | `BANKED`, `test/ticked-sc-cover.test.ts` |
| ticking a `(behavioral)` SC — same event | `BEHAVIORAL_TICKED_RATCHET`, `test/behavioral-sc-ratchet.test.ts` |
| ticking or unticking ANY SC, whether or not a test claims it | `UNCLAIMED_RATCHET` **and** `CLAIMED_UNBINDABLE`, `test/sc-binding-split.test.ts` — both are equalities, so they refuse a fall as well as a rise |
| an unqualified `SC-N` mention in a test | `CENSUS`, `test/sc-id-namespace.test.ts` |
| a consumer's NAME in `lib/`,`gates/`,`scripts/` | **remove the name** — `CONSUMERS` in `test/anti.test.ts` only shrinks, so delist a file you cleaned and never add one |
| a gate check test with no assertion | `WARN_TIER_CHECKS`, `lib/gate-check-audit.ts` — reason must exceed 80 chars |
| a new gate check test | `config/check-registry.json` |
| a new matcher handler | `config/matcher-registry.json` |
| a new file in `gates/` | `GATE_FILES`, `test/gate-contracts.test.ts` + per-gate SCs in the spec |
| a writer of a tracked file that does not commit it | `KNOWN_UNDECLARED_WRITES`, `scripts/contract-parity.ts` |
| a new file the scaffold owns | `OWNED_FILES`, `lib/scaffold/owned-files.ts` **and** the table in `.claude/rules/harness-managed.md` — both, or `test/scaffold-ownership.test.ts` fails the one-sided edit |
| a new hook | the hook file's `SC-` comment, `.claude/rungate/hooks.json`, the table in `specs/HOOK-ARCHITECTURE-SPEC.md`, **and** `.claude/settings.json` |
| a `test.todo` naming an SC | it will be refused — bind it or do not name the id |
| a new `specs/` doc with no `- [ ]` criteria | add an explicit "states none" declaration, and say so in the routing row too |
| a prompt telling an agent to read a doc | the doc must exist, or the read must be qualified |
| a new MCP tool named in a `workflows/*.js` prompt | grant it in `.claude/rungate/roles.json` |
| a raw day stamp in `lib`,`scripts`,`gates`,`hooks`,`bin`,`test`,`workflows` | attach a justification comment |
| a fixed in-repo scratch dir in a test | use `mkdtemp` |
| committing a file `.gitignore` also matches | one or the other, not both |

## Tier 3 — agreements that trip on housekeeping

- `SUCCESS.md`'s standing line must equal `package.json` `version` **and** the
  live npm version. A bump without a publish is red.
- `.bun-version` must equal the version CI declares.
- `AGENTS.md`'s Commands row, `.github/workflows/ci.yml` and
  `.claude/rungate/config.json`'s `test.command` must all name the same string.
- The `#666` measurement table must be **byte-identical** in
  `reference/check-failure-worked-instances.md` and
  `specs/HARNESS-STANDARD.md`. A reformat of either is red. It moved out of
  `.claude/rules/` in #1009; both bindings read `RECORD_FILES`, so the path
  lives in one place per test and not in this sentence.
- The auto-loaded instruction surface — `CLAUDE.md`, `AGENTS.md` and every
  un-scoped `.claude/rules/*.md` — must stay under `SURFACE_BUDGET_BYTES` in
  `scripts/check-instruction-surface.ts`, and the budget must stay within 35%
  of what it measures. Adding a rule can redden it.
- Every reference in `AGENTS.md` must resolve on disk.
- Every `.claude/rules/*.md` needs a `description` over 20 characters.

## What to run before you push

The standing rule against bare full suites holds — concurrent full runs have
killed this machine. Run your targeted paths, **plus the census tests your
change can trip** — and derive that second half rather than remembering it:

```bash
bun scripts/census-routing.ts          # the `bun test …` line for YOUR diff
bun scripts/census-routing.ts --all    # every row, and what it routes to
```

It reads the diff, not the file list, and that is the whole of #990: **an edit
to a spec and a tick inside one are the same path and different events.** A
criterion went `- [ ]` to `- [x]`, every targeted suite was green locally, and
CI went red in a census file the change does not touch and the list here did
not name. A router that sees only `git diff --name-only` cannot tell those two
apart, so this one carries the added and removed lines.

| what you did | what to run |
|---|---|
| added or renamed a file | `test/scaffold-conformity.test.ts` `test/package-closure.test.ts` |
| added a doc, or edited one containing file:line citations | `test/line-citation-ratchet.test.ts` `test/agents-md-refs.test.ts` |
| added or edited CLAUDE.md, AGENTS.md or a .claude/rules/ doc | `test/rule-provenance.test.ts` `test/instruction-surface-budget.test.ts` `test/harness-fixed-point.test.ts` |
| added a test file | `test/sc-id-namespace.test.ts` `test/scratch-paths-unique.test.ts` |
| touched specs/ | `test/agents-md-spec-listing.test.ts` `test/spec-requirements.test.ts` |
| ticked or unticked an SC (ran sync-sc-status) | `test/sc-binding-split.test.ts` `test/ticked-sc-cover.test.ts` `test/behavioral-sc-ratchet.test.ts` |
| touched gates/, hooks/ or the scaffold | `test/gate-contracts.test.ts` `test/scaffold-ownership.test.ts` `test/hook-traceability.test.ts` |

**That table is rendered from `CENSUS_TRIGGERS` in `scripts/census-routing.ts`
and compared byte-for-byte by that script's own test file**, in both
directions: a row the router does not have is red, and a census test named
here that no row routes to is red. So it is not a list anybody has to remember
to update — which is the only honest answer to "what keeps prose correct when
the census set moves". Add a row to the router and this table goes red until
it carries it.

Bounded and cheap. The point is not to run everything; it is that the file you
changed is never the only file with an opinion about your change.

**What this does not do: enforce.** It prints a command, and an agent who
reads neither the rule nor the script is unaffected by both. The mechanical
version is a check that refuses a diff whose census tests were not in the same
run's measured set, and that needs a notion of "what this session ran" which
does not exist here. Nor is it the same thing as
`scripts/select-affected-tests.ts`: that selects by import graph, and a census
test imports none of the things that move it. Measured with
`specs/HARNESS-STANDARD.md` as the only changed file, that selector reaches
`ticked-sc-cover` as a sweep and misses the other two outright. The two are
complements — one routes by what the diff DID, the other by what it IMPORTS.

## If you are writing one of these

Say what to do in the failure message. `SC-1466` is the best in the tree —
*"…or add it to `WARN_TIER_CHECKS` in `lib/gate-check-audit.ts` with why"* —
and it is the difference between a check and an obstacle. A bare
`expect(violations).toEqual([])` makes the next agent re-derive the whole
mechanism.

**Use `remedyMessage` from `lib/check-remedy.ts`** (#813). It composes the
violation list, the remedy, and a pointer back to this file:

```ts
expect(
  unlisted,
  remedyMessage({ root, check: "HYGIENE-4", violations: unlisted, fix: "add a row to …" }),
).toEqual([]);
```

Two things about it are deliberate. The `fix` has no default, because a
default would let a check look as though it had a remedy when it had none.
And the pointer to this file is DERIVED — emitted only when this file exists
under the project root — because `lib/conformity.ts` is published and this
document has no template copy, so a hardcoded path would send every consumer
to something they do not have.

Every Tier 1 check above now carries one, and `test/check-remedy.test.ts`
holds the population: delete a remedy and that test goes red naming the check
that lost it. Adding a Tier 1 check means adding its row there too.

Before #813 none of them did, and the number is worth keeping: two references
to this file from the whole executable tree, both prose inside a docblock,
against 321 for `checks-must-be-able-to-fail`. A document the stuck agent
cannot reach from the thing that stopped them is not reaching anyone.

Related: `.claude/rules/checks-must-be-able-to-fail.md`,
`.claude/rules/claiming-sc-coverage.md`,
`.claude/rules/harness-managed.md`.

## This file tripped one of its own checks on the first run

Worth leaving in, because it is the cheapest possible demonstration that the
list above is not theoretical.

The draft closed by citing a rules file named for exemption-list
self-reference. No such file exists — the idea does, in `harness-managed.md`
and in the no-exemption-list rows above, but not under that name.
`test/rule-provenance.test.ts` caught it immediately: *"every
`.claude/rules/*.md` the repo routes to exists"*. One file added, zero code
touched, and a test in a file nobody had opened went red.

**Then the obvious repair failed too, for a reason worth knowing.** Rewriting
the paragraph to explain that the path does not exist left the path *in the
prose*, and the scanner counted it again — a checker that greps for a filename
cannot tell a citation from a sentence about a citation. Same shape as
`claiming-sc-coverage.md`'s central problem, met from the other side. The only
fix is not to write the literal path at all, which is why the name is spelled
out in words above.

The check is good: it names the citing file and the missing path, which is
more than most of Tier 1 does.

**Then CI caught a third one, and this is the one that matters.** The draft
cited ten `file.ts:NNN` line positions, so `#541`'s citation ratchet refused
it — *"`.claude/rules/self-referential-tests.md` is not in
`.claude/line-citation-ratchet.json` and carries 10 line citations. A document
absent from the ratchet is allowed none."*

Two things to take from it. First, **I did not run the test this very file
tells you to run**: "added or edited a doc → `test/line-citation-ratchet.test.ts`"
is a row above, written before the push, and the local run skipped it. Writing
the rule is not the same as following it, which is the argument for the census
block in the swarm brief rather than a document.

Second, **the right fix was not to bank an entry in the ratchet.** The ratchet
exists because line numbers rot, and a rule file is read months after it is
written. Every citation here now names a stable symbol — `SCANNED_FILES` in
`test/consumer-no-rebuild-delegation.test.ts` — instead of a line that will be
wrong by the time someone needs it. The cheap fix was one JSON entry; the
correct one made the document better and the ratchet entry unnecessary.

And the failure message is genuinely good — it names the file, the count, the
ratchet, and the policy. It belongs with `SC-1466` as a model, not with Tier 1.
