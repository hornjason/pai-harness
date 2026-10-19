---
doc-type: spec
status: draft
owner: jason
created: 2026-10-02
updated: 2026-10-02
governs: Doc-hygiene architecture — spec discovery via governs-field, mechanical drift detection, signal-based enforcement
testable: true
compliance: strict
---

# Doc Hygiene Architecture

## Context

Doc-hygiene currently stamps frontmatter (HYGIENE-1 through HYGIENE-10 in `lib/conformity.ts`) but does NOT verify specs match implementation or detect spec drift. `Skill("doc-hygiene")` is referenced at two mandatory positions in HARNESS-STANDARD.md (ITERATION line 326, FEEDBACK line 444) and required by close-gate (HARNESS-GATES.md:110), but no skill implementation exists. Every ship cycle has been non-compliant.

Council session (2026-10-02) produced 12 decisions across 3 rounds with architect, engineer, and security members. This spec codifies those decisions.

## Design Decisions (from Council)

| # | Decision | Rationale |
|---|----------|-----------|
| DEC-001 | Fix logSignal() silent-drop bug at lib/gate-enforcement.ts:221 | existsSync guard silently discards signals when file doesn't exist. appendFileSync creates the file if absent |
| DEC-002 | governs-field in spec frontmatter is the primary discovery mechanism | Persistent read-time source. Not workflow-state.json (session-scoped write-time data) |
| DEC-003 | lib/spec-registry.ts as shared module from day one | Three consumers already parse governs-field independently — centralize the contract |
| DEC-004 | lib/doc-hygiene.ts for content-alignment, extract drift-detection at 300 lines | One module until complexity demands extraction |
| DEC-005 | New checks start as WARN per Decision #9 (spec-policies.json) | Promote to FAIL only after >80% precision over 10+ cycles |
| DEC-006 | No LLM-based semantic comparison (Layer 3) | Layers 0-2 are deterministic, fast, tamper-resistant. Unanimous rejection |
| DEC-007 | Route doc-hygiene signal through GateEnforcement.hook.ts | Pragmatic — close-gate infrastructure doesn't exist yet |
| DEC-008 | Minimal rungate.json config: specDirs only (default ['specs']) | Extend only when second consumer proves the need |
| DEC-009 | #299 spec-alignment is SUBSET of doc-hygiene | Same detection engine, different enforcement boundaries |
| DEC-010 | Skill('doc-hygiene') as thin facade with 5-second fast-exit | git diff since last signal — skip if no governed files changed |
| DEC-011 | Replace manual SPEC_HASHES with auto-generated drift-hashes.json | Deferred to Phase 1 |
| DEC-012 | WARN-to-FAIL promotion must be mechanical | Log findings to signals.jsonl, compliance report surfaces candidates |

## Detection Layers

| Layer | What | Speed | How |
|-------|------|-------|-----|
| L0 | Dead-reference lint | Sub-second | governs: targets resolve to real files |
| L1 | Term/decision-ID extraction | Seconds | D-NNN IDs in ACs exist in governing spec |
| L2 | Hash-based change tracking | Seconds | drift-hashes.json manifest, updated via CLI |
| L3 | LLM semantic comparison | N/A | **Rejected** — non-deterministic, costly, injection surface |

## Success Criteria

### Phase 0 — Enforcement infrastructure (#24)

- [x] SC-504: lib/gate-enforcement.ts must NOT contain [existsSync(signalsFile)]
- [x] SC-505: lib/spec-registry.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned]
- [x] SC-506: lib/spec-registry.ts contains [governs, frontmatter, specs/, invertedIndex]
- [x] SC-507: test/spec-registry.test.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned, mock]
- [x] SC-508: hooks/GateEnforcement.hook.ts contains [doc-hygiene, signals, signal]
- [x] SC-509: lib/doc-hygiene.ts contains [runContentAlignment, checkDocHygiene]

### Phase 1 — Content alignment checks (follow-up)

- [x] SC-510: lib/doc-hygiene.ts contains [CONTENT-1, governs, resolve, existsSync]
- [x] SC-511: lib/doc-hygiene.ts contains [CONTENT-2, hash, drift, manifest]
- [x] SC-512: .claude/rungate/compliance.json contains [docHygiene, specDirs]
- [x] SC-513: test/doc-hygiene.test.ts contains [CONTENT-1, CONTENT-2, WARN, governs]

### Phase 2 — Integration + promotion tracking (follow-up)

- [x] SC-514: lib/doc-hygiene.ts contains [git, diff, changed, skip]
- [x] SC-515: lib/compliance-report.ts contains [promotion, precision, WARN, FAIL, 80]

### Phase 3 — A stamp adds, it never replaces (#299)

`DocHygiene.hook.ts` rebuilt every `.md`'s frontmatter from its four required
keys and discarded the rest:

```ts
const fmLines = REQUIRED.map(k => `${k}: ${stamped[k]}`).join('\n');
newContent = content.replace(FRONTMATTER_RE, `---\n${fmLines}\n---`);
```

Editing `.claude/rules/key-files.md` dropped its `description:` — the field
Claude Code's rule loading surfaces a rule by — and all eight rules files
carried it. The damage was one file per edit, only to files somebody had
touched, and nothing went red: **a rules file that has stopped being surfaced
to agents is indistinguishable from one that is surfaced and ignored.**

Underneath it, a second failure. The parser was `line.split(":")`, which
cannot represent a YAML block value, so `harness-managed.md`'s `paths:` list —
the list declaring which files the scaffold owns — would have been flattened
even by a merge written over that parser's output.

Three rules now hold, and the third is the one that keeps the other two:

1. **Add, never replace.** A key already present keeps the value somebody gave
   it, block values included. New keys are appended after everything existing,
   so a diff reads as additions.
2. **Refuse what you cannot read.** A block in a shape the parser does not
   understand is returned unchanged. Rewriting a block you cannot read is
   exactly what this was.
3. **The hook and the library are held in step by an executed parity case.**
   The hook lives in `~/.pai/hooks/`, outside this repo, so it cannot import
   `lib/frontmatter.ts` and the logic is duplicated. The parity test runs both
   over one input and compares bytes; without it the fix decays back into the
   bug the first time one side is edited.

The hook cases are driven where the hook exists and report a named, printed
skip where it does not — a consumer who has never installed PAI must not be
refused for a file they do not have. The convention-parity cases need nothing
but this repo and always run; they are what would have gone red the moment the
hook shipped.

- [x] SC-729: lib/frontmatter.ts contains [stampFrontmatter] — stamping merges into the existing block instead of rebuilding it, so a field the formatter does not own survives a write
- [x] SC-730: lib/frontmatter.ts contains [could not be parsed] — a block in an unrecognised shape is returned unchanged rather than rewritten into something smaller
- [x] SC-731: test/rules-frontmatter.test.ts contains [every rules file declares a description] — the convention the hook violated is asserted over the real files, and this check needs nothing outside this repo so it runs in CI
- [x] SC-732: test/rules-frontmatter.test.ts contains [it agrees with lib/frontmatter.ts on the same input] — the hook is executed and its output compared byte-for-byte with the library, because the two cannot share code and nothing else stops them drifting

#### What was broken to prove it (#299)

Run and counted over `test/rules-frontmatter.test.ts` (22 tests). None is left
in the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `stampFrontmatter` overwrites keys already present | 2 of 22 |
| the parser guesses at an unindented non-key line instead of refusing | 2 of 22 |
| the trailing newline absorbed back into the last entry's block | 2 of 22 |
| the HOOK's merge reverted to the original rebuild-from-REQUIRED | 3 of 22 — strip, flatten, and the library parity case |

### HYGIENE-6 reports its own coverage (#508)

HYGIENE-6 is advisory about the review BACKLOG, and should stay that way —
119 pending candidates on this repo, and asserting them to zero would block
every push until someone triaged all of them. It was also advisory about
whether the scan happened at all, which was never intended: the body ended in
`expect(true).toBe(true)`, so the only red it could produce was a **timeout**,
and that is the red it produced four times in full runs while passing
standalone every time.

Two things were wrong underneath it, and the first is why the second stayed
invisible for so long.

**The staleness scan spawned one `git log` per document** — the exact code
#323 removed from `runDocHygiene`, in a file #323 did not touch. 91 serial
subprocesses against one repository, nothing wrong with any single one, and
load-sensitive by construction: a busy machine or another suite holding the
index pushes it past bun's 5000ms default. Measured on an idle machine with a
warm cache, three runs each:

| | before | after |
|---|---|---|
| `computeStaleness` over 91 documents | 4169 / 4521 / 3969 ms | 240 / 197 / 189 ms |

Equivalence was checked rather than assumed, because a detector that got
quicker by finding less would pass every timing test: both paths were run
over the same 91 documents and compared date-for-date — **91 agree, 0
differ**. `lastCommitDates` now lives in `lib/git-dates.ts` and is re-exported
from `lib/conformity.ts`, which imports `bun:test` at module scope and so
cannot be imported by a CLI.

**The extractor never said how much it read.** `scan` reported what the walk
could SEE; nothing reported what the read then took, and `0 candidates` over
91 documents is the same line of output as `0 candidates` over 4.
`ScanCoverage` is the reading — `planned`, `read`, and `unread` naming each
file with the errno that stopped it. A planned file that cannot be read is
recorded rather than thrown (one transient file must not take an advisory
backlog report down) and recorded rather than dropped (a partial scan must
not be indistinguishable from a complete one).

Fixing that surfaced a third: `planDocScan`'s flat root scan asked the `.md`
suffix and never asked the filesystem, while the recursive walk beside it
asks `statSync` before it decides. A **directory** named `NOTES.md` at the
project root was planned as a document and handed to `readFileSync`, which
throws EISDIR — a plan naming a file it could never read.

- [x] SC-1964: test/extract-constraints-coverage.test.ts contains [a planned document that cannot be read is named, and the rest are still read] — the file moves between the walk and the read, and the two survivors are still read, so one bad document does not abandon the scan
- [x] SC-1965: test/extract-constraints-coverage.test.ts contains [the counts are the scan's own and move with it] — two fixtures of different sizes, because a constant satisfies a single-fixture count as readily as a measurement does
- [x] SC-1966: test/extract-constraints-coverage.test.ts contains [a directory whose name ends in .md is not planned as a document] — both halves, since dropping every root-level document is the cheapest wrong fix available
- [x] SC-1967: test/extract-constraints-coverage.test.ts contains [on this repository every planned document is read] — the live tree, which is the reading HYGIENE-6 itself now asserts

#### What was broken to prove it (#508)

Run and counted over `test/extract-constraints-coverage.test.ts` +
`test/doc-scan-targets.test.ts` (34 tests, baseline 34 pass / 0 fail measured
before each row). None is left in the tree; all were run and reverted.

| Mutation | Red | Predicted |
|---|---|---|
| a planned file that cannot be read is dropped instead of recorded | 1 of 34 | 1 |
| `coverage.read` reports every planned file as read | 1 of 34 | 1 |
| the flat root scan stops asking the filesystem (`statSync().isFile()` removed) | 1 of 34 | 1 |

Before believing any of those counts, the input on which mutant and original
differ, per `.claude/rules/checks-must-be-able-to-fail.md`: the three-document
fixture with its middle document removed after the plan is taken — original
`read: 2, unread: ["docs/DOC-1.md"]`, first mutant `unread: []`, second mutant
`read: 3`. For the third, a project carrying a DIRECTORY named `NOTES.md` —
original plans 2 files, mutant plans 3.

**The second row is a 1 that deserves its own sentence.** Only SC-1964 can see
a coverage number that lies, because it is the only case whose tree has
anything unreadable in it — everywhere else `read` and `planned` are
legitimately equal and no assertion could tell a measurement from a constant.
That is #492's shape (*a battery whose fixtures all meet a precondition
measures nothing past it*) with the precondition met by exactly one fixture,
which is the minimum that is not zero. It is recorded rather than padded: a
second case of the same shape at a different size would raise the number
without widening the question.

The wiring is observed rather than asserted — `bun test
test/scaffold-conformity.test.ts -t HYGIENE-6` prints
`HYGIENE-6 coverage: read 93 of 93 planned documents from 7 directories
(routing)` and completes in 232ms, against the 5001ms timeout that was the
check's only possible red before.

### A document the routing table calls a spec states something (#579)

`.claude/rules/specs-routing.md` is generated one row per file in `specs/`,
and every row promises a reader that the document on the other end GOVERNS
something. Nothing checked that it states a requirement.

`specs/PROJECT-STATE.md` was a **rendered `PROJECT-STATE.md` snapshot from
2026-09-22 with spec frontmatter pasted on top** — a "Current phase" line, a
stale priorities list, and `| Status | SC | What |` tables citing criteria it
did not declare. It reported `Suite: 984 tests` against a suite of 11,961,
and it sat in the routing table as the governing spec for project state
management for two months. An agent sent there got no requirements at all.

**A gap in a routing table is visible; this is not.** The reader believes they
have arrived. Same harm as `.claude/rules/config-access.md`'s *Silent Default
Substitution*, with a document as the victim — an empty answer and a correct
answer are the same shape to the consumer.

#### Why the exemption is frontmatter, not an allowlist

Some documents here legitimately state no criteria: `BOOTSTRAP-DATA-FLOW-SPEC.md`
is a redirect stub, and the five `bootstrap-data-flow/` siblings consolidate
their criteria in `success-criteria.md`. An allowlist would cover them, and
two things are wrong with one.

DRIFT-3 refuses any entry ADDED to `.claude/conformity-allowlists.json`
relative to `origin/main`, because an agent must not pass a gate by editing
the gate. Shipping DRIFT-4 with its nine violators pre-listed is exactly that
move, and the ratchet is right to refuse it.

The better reason: **an allowlist is invisible to the person being harmed.**
The reader harmed by a criteria-free spec is the one who followed the routing
table to it, and a JSON file in `.claude/` is not on that path. A declaration
in the document's own frontmatter is — and `lib/generators/agents-md.ts` now
renders it, so the row reads `STATES NO CRITERIA — …` and the warning reaches
the reader before they click rather than after 300 lines.

#### Two defects found while fixing it, both in the same class

**DRIFT-2 credited a spec for a test naming a different file.** It asked
`allContent.includes(specFileName)`, and for a top-level spec that name is a
bare basename. `specs/PROJECT-STATE.md` and the generated root
`PROJECT-STATE.md` share one; **ten test files mention the root one.** This
was aimed straight at #579's own prescribed fix — `testable: true` plus "a
test naming it, which `test/update-project-state.test.ts` can do in one line"
— which would have turned DRIFT-2 green on the strength of
`test/organize-project.test.ts` discussing a status file. The fifth shape,
pointed at the issue that was meant to close it.

Measured rather than assumed: requiring the `specs/`-qualified path from every
test orphans **15 of 22** testable specs, so the rule is narrowed to names
that are genuinely ambiguous — of which this tree has exactly one.

**`testable:` was read as `=== "true"`, so every other spelling meant false.**
`specs/DA-COMPLIANCE-SPEC.md` carried `testable: no`, which happened to mean
what its author intended; `testable: yes` would have dropped a spec out of the
conformity surface while its frontmatter, the routing table and every reader
said it was in. `lib/scanner.ts` also wrote the literal `"yes"` into the group
row for every `specs/` subdirectory — a word that means false to the code and
true to a reader, in the table this issue is about. It is derived from the
members now.

- [x] SC-1985: test/spec-requirements.test.ts contains [a spec with no criteria and no declaration is refused, and the live tree has none] — the synthetic half first, because the live half goes green the moment this lands and a case that can only fail on today's tree stops being able to fail
- [x] SC-1986: test/spec-requirements.test.ts contains [the declaration is refused when it is a mute rather than a statement] — `criteria: none` with no reason is the exemption-list failure mode reproduced in frontmatter, with the positive control that a declared stub passes
- [x] SC-1987: test/spec-requirements.test.ts contains [a spec that declares none and states some is refused too] — both directions, so a declaration cannot outlive the gap and keep warning readers away from a document that now has what they came for
- [x] SC-1988: test/spec-requirements.test.ts contains [criteria are counted on any checkbox, not on the SC- prefix] — the first census counted `- [ ] SC-` and reported BOOTSTRAP-TEST-PLAN.md's 41 `TP-` criteria as nothing, which would have demanded a false declaration on a correct spec
- [x] SC-1989: test/spec-requirements.test.ts contains [a bare spec name that also names another file does not credit the spec] — with the other direction asserted, because requiring qualification everywhere orphans 15 of 22
- [x] SC-1990: test/spec-requirements.test.ts contains [the ambiguity is measured against the tree, not listed] — a hard-coded list of colliding names is a second decider that agrees until a new collision arrives
- [x] SC-1991: test/spec-requirements.test.ts contains [testable: carries a value every reader agrees on] — `yes` means false to the code and true to a human, and nothing said so
- [x] SC-1992: test/spec-requirements.test.ts contains [a row sending a reader to a criteria-free spec says so in the row] — the whole argument for frontmatter over an allowlist, with the positive control that a generator marking every row tells a reader nothing

#### What was broken to prove it (SC-1985..SC-1992)

Run and counted over `test/spec-requirements.test.ts` +
`test/scaffold-conformity.test.ts` (baseline 1059 pass / 0 fail). None is
left in the tree; all were run and reverted.

| Mutation | Red | Predicted |
|---|---|---|
| `requirementViolations` short-circuited to `return []` | **3** | 4 |
| the mute-declaration branch (`criteria: none` with no reason) removed | 1 | 1 |
| the declared-none-but-states-some branch removed | 1 | 1 |
| criteria counted only on `- [ ] SC-` | 3 | 3 |
| `specIsReferenced` ignores ambiguity and always matches bare | 1 | 1 |
| `ambiguousSpecNames` returns the empty set | 1 | 1 |
| `testableViolations` short-circuited to `return []` | 1 | 1 |
| `lib/scanner.ts` never reads the declaration | 1 | 1 |
| the generator drops the marker from the row | 1 | 1 |

**The first row missed LOW, and the reason is worth more than the number.**
DRIFT-4 was predicted to go red and did not: on a clean tree there are no
violations, so `return []` and the real function give the same answer and
nothing in the live arm can tell them apart. That is #492's shape — a check
whose only population meets the precondition — and it is the normal condition
of any ratchet sitting at zero.

It is not a collapsed pair, and the discriminator is row four: narrowing
`CRITERION_LINE` creates a live violator, and DRIFT-4 goes red there. The
check can fail against the tree; it needs something to fail about. That is
also why SC-1985 carries a synthetic half as well as the live one — the live
half goes green the moment this issue lands and could never fail again.

#### Two defects this work introduced, and the ratchets caught both

The first draft of SC-1992 keyed the routing-table assertion on a `testable:
true` spec that sits on DRIFT-2's `untestedSpecs` ratchet. DRIFT-2 credits a
spec when any test file's text contains its name, so **naming it here as a
FIXTURE made it read as tested**, and the ratchet correctly demanded it be
delisted — which would have certified an untested spec on the strength of one
line in a test about something else. The case is keyed on a `testable: false`
spec now, and the comment explaining the choice does not spell the name
either, because the first rewrite of the comment put the string straight back
and turned DRIFT-2 red a second time.

The second: that same assertion matched the whole table line, and one spec's
`governs` field cites another spec's filename, so it matched two rows. It
keys on the row's first cell now — `lib/spec-listing.ts`'s *"a mention is not
a listing"*, arriving in the table that module exists to police.

### Line-number citations in documentation (#541)

#514 converted one document's seven line citations to the anchor form and
measured, while doing it, that **three of the four unguarded ones were already
wrong** — each pointing at a plausible-looking line in the right file. The
three that stayed true were the three a test executed. The rest of the tree was
left as it was.

**Measured on this branch's base, with the command beside the number**, because
a count with no command is not reproducible and the tree underneath it moves:

```
bun -e 'const {markdownDocuments,repoFileIndex,documentCensus}=await import("./lib/line-citation.ts");
const i=repoFileIndex("."),c={};let t=0;for(const d of markdownDocuments(".")){const x=documentCensus(".",i,d,false);
t+=x.broken+x.unmeasured;for(const r of x.readings)if(r.reading==="BROKEN")c[r.cause]=(c[r.cause]??0)+1;}
console.log(t,JSON.stringify(c))'
```

**231 line citations across 23 markdown documents**, of which 81 could not be
resolved at all. The issue's own figure was 134 across ten documents, taken
five weeks earlier against `specs/` and `docs/adr/` only; the population had
grown and the scope here is every markdown document in the tree.

Two readings govern the design, and both refuse a comfortable default:

- **A line citation is never VALID.** `LineReading` has two arms. One that
  resolves reads `UNMEASURED` — the file and the line exist, and whether it is
  the line the sentence describes is not decidable from here. A 75% staleness
  rate in the unguarded half of one document is the argument against an
  optimistic default; a green tick, `0` and `null` are all indistinguishable
  from a correct answer, and a refusal naming the reading is not.
- **A citation that cannot be resolved has a named cause.** `NO_SUCH_FILE`,
  `UNQUALIFIED_PATH`, `AMBIGUOUS_PATH`, `PAST_END_OF_FILE`,
  `OUTSIDE_REPOSITORY`. Four different repairs, so four different readings;
  "this citation is broken" is not actionable.

**A ratchet, not a hard gate, and the split is the reason.** An anchor carries
its own text, so whether it still names a site is DECIDABLE — that half is a
hard gate over every document in the tree, where before this it ran over one.
A line number is not decidable, so that half is a both-ways known-violations
ratchet in `.claude/line-citation-ratchet.json`, which banks **three** numbers
per document rather than one. One total cannot see progress: qualifying
`ship.js` to `workflows/ship.js` deletes nothing and adds nothing, and
converting a citation to the anchor form looks, to a total, exactly like
deleting it. The arithmetic cannot forbid a deletion — a paragraph is allowed
to go away — so what three numbers buy is that the two cases move DIFFERENTLY
in the diff. The file says so in its own `meaning` block, because a ratchet
nobody can interpret becomes a number nobody lowers.

Eleven bare basenames were qualified in `specs/HARNESS-GATES.md` and
`specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`, taking the broken population from
81 to 71. **Ten became UNMEASURED and one got worse in a useful way**: writing
`gates/run-gate.ts` in front of a citation to line 291 turned an
`UNQUALIFIED_PATH` into a `PAST_END_OF_FILE`, because that file has 163 lines.
A citation that was merely unresolvable is now demonstrably wrong, and it is
banked with a note saying so rather than repaired, because nobody knows what
line 291 described.

- [x] SC-2230: test/line-citation-ratchet.test.ts contains [a path naming no file in the tree is BROKEN for not existing] — named, not merely refused, because "something is wrong with this citation" and "this file is not in the repository" are different repairs
- [x] SC-2231: test/line-citation-ratchet.test.ts contains [a bare basename is BROKEN even when exactly one file matches] — the tempting case to wave through: a basename is not a path, it is a guess that resolves until a second file with that name lands
- [x] SC-2232: test/line-citation-ratchet.test.ts contains [a basename matching two files is AMBIGUOUS, a different cause] — synthetic, because the live tree has no surviving example and so cannot witness the distinction
- [x] SC-2233: test/line-citation-ratchet.test.ts contains [a line past the end of the file is BROKEN] — with the in-tree control that a line inside the file is not, or a guard refusing every resolvable citation would satisfy the row while saying nothing about the end of the file
- [x] SC-2234: test/line-citation-ratchet.test.ts contains [a citation that leaves the repository is refused for leaving] — refused for LEAVING and not for being absent, plus the symlink input nothing lexical can reach, whose target is outside the walked tree so the case cannot be satisfied by a route that bypasses the feature
- [x] SC-2235: test/line-citation-ratchet.test.ts contains [a citation that resolves reads UNMEASURED, and there is no third reading] — exhaustive over the live tree, so an arm meaning "fine" appearing later is caught rather than inferred
- [x] SC-2236: test/line-citation-ratchet.test.ts contains [a document the ratchet says has citations and has none THROWS] — a checker finding zero citations in every document is in perfect agreement, and zero strings are trivially all fine
- [x] SC-2237: test/line-citation-ratchet.test.ts contains [the refusal escapes citationRatchetViolations rather than folding in] — folded into the violation list the refusal is one more sentence in a report, and an empty violation list is what a clean tree looks like
- [x] SC-2238: test/line-citation-ratchet.test.ts contains [the pattern reads a citation and does not read the historical prose form] — both halves, since a pattern matching nothing passes every row above it and a pattern matching prose refuses a paragraph whose point is that the line is gone
- [x] SC-2239: test/line-citation-ratchet.test.ts contains [over the banked number fails, and so does under it] — the under direction is the one people forget, and a stale entry is an entry nobody will ever remove
- [x] SC-2240: test/line-citation-ratchet.test.ts contains [a document absent from the ratchet is allowed no citations at all] — the migration window is exactly when the next line citation gets written
- [x] SC-2241: test/line-citation-ratchet.test.ts contains [broken and unmeasured are banked apart, so qualifying a path is progress] — the same document, the same citation count, the path qualified: a single total cannot see it happen
- [x] SC-2242: test/line-citation-ratchet.test.ts contains [an anchor citation is banked too, so a conversion is legible] — a conversion lowers one number and raises another, a deletion lowers one and raises nothing
- [x] SC-2243: test/line-citation-ratchet.test.ts contains [an anchor that no longer resolves is a hard failure, not a banked one] — enforce the half the repository can decide and report the other half as UNMEASURED; a single policy over both would have to be the weaker one
- [x] SC-2244: test/line-citation-ratchet.test.ts contains [a banked document that no longer exists is a failure] — the ratchet refuses in both directions at the document level too
- [x] SC-2245: test/line-citation-ratchet.test.ts contains [the whole tree agrees with the ratchet, and the census is not empty] — the control runs first: a walk that found no documents, or a pattern that matched nothing, would satisfy every comparison by finding nothing to compare
- [x] SC-2246: test/line-citation-ratchet.test.ts contains [the ratchet says what an entry means and what clears one] — including the one instruction not inferable from the numbers, that a count lowered by deleting the citation is not progress

#### What was broken to prove it (SC-2230..SC-2246)

Run and counted over `test/line-citation-ratchet.test.ts` +
`test/source-anchor-citations.test.ts` (27 tests). Every count predicted before
the battery ran, and **the baseline row was read before any mutation row** — an
instrument that has stopped reporting takes the baseline down with it, and that
is the row nobody mutates anything to produce.

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 27 pass, 0 fail | **27 pass, 0 fail** | — |
| `citationRatchetViolations` short-circuited to `return []` | 7 | **7 of 27** | a document carrying 4 line citations against an entry banking 3: the original returns one violation naming 4, the mutant returns nothing |
| the under-direction removed (`found <= banked` continues) | 3 | **3 of 27** | the same document carrying 2 against an entry banking 3: the original says lower it or delete the entry, the mutant says nothing |
| the no-citations refusal removed from `documentCensus` | 2 | **2 of 27** | a document banked at 3 unmeasured that contains none: the original throws, the mutant returns a zero census |
| the refusal CAUGHT inside `citationRatchetViolations` and pushed as a string | 1 | **1 of 27** | the same document: the original throws out of the function, the mutant returns a one-element violation list, which is what a report full of sentences looks like |
| `UNQUALIFIED_PATH` collapsed into `NO_SUCH_FILE` | 1 | **1 of 27** | a bare `ship.js` citation in a tree holding `workflows/ship.js` — one cause says qualify the path, the other says the file is gone |
| `AMBIGUOUS_PATH` collapsed into `UNQUALIFIED_PATH` | 1 | **1 of 27** | a bare `steps.ts` citation in a tree holding two files of that name |
| the `PAST_END_OF_FILE` reading removed | 2 | **2 of 27** | a citation to line 400 of a three-line file. The second red is the LIVE TREE: `gates/run-gate.ts` line 291 becomes UNMEASURED, moving two banked numbers |
| `UNMEASURED` renamed to `VALID` in the resolving arm | 6 | **6 of 27** | any resolvable citation. The census counts by reading, so a renamed arm empties `unmeasured` everywhere and four ratchet cases go with the two that name it |
| the anchor hard gate dropped from the violations list | 1 | **1 of 27** | a document citing an anchor whose text was deleted from the file |
| the zero-tolerance for an unbanked document removed | 1 | **1 of 27** | a document carrying one citation with no entry at all |
| the banked-but-not-scanned loop removed | 1 | **1 of 27** | an entry naming a document that is not in the tree |
| the anchor-span strip removed from `lineCitations` | 1 | **1 of 27** | an anchor whose quoted TEXT contains the old form — the original counts nothing, the mutant counts the good form as an instance of the bad one and makes the repair raise the banked number |
| **the cheapest wrong fix**: one banked total per document instead of three numbers | 2 | **2 of 27** | the qualified-path document, where broken falls and unmeasured rises by one each: the original reports both movements, the total reports nothing |

**The last row is the one the rest of the table exists to support.** The
cheapest repair here is *bank the number and move on* — one count per document,
green today, no classification. It works, and the two cases that do not survive
it are SC-2241 and SC-2242, which are precisely the cases about progress being
recordable. They go red **non-vacuously**: they assert which numbers moved, and
a total has no numbers to move. The second-cheapest wrong fix, *only check the
document that already works*, is caught by SC-2240 and SC-2245 — a document
absent from the ratchet is allowed no citations, and the corpus floor refuses a
walk that found nothing.

**Two rows deserve reading rather than counting.** The `VALID` row at 6 is high
because the census counts BY READING, so renaming one arm empties `unmeasured`
for the whole tree; every extra red is squarely about the mutated behaviour and
the file still parses, which is the discriminator between a load-bearing
binding and a crashing mutant. The `PAST_END_OF_FILE` row at 2 is the one that
proves the live-tree case is not decorative: without a single genuinely wrong
citation in this repository it would have been 1, and SC-2245 would have been
asserting agreement between two things that could not disagree.

None of the thirteen mutations is left in the tree; all were run and reverted
from a `cp` backup — never `git checkout --` — and `lib/line-citation.ts` was
confirmed byte-identical to the measured source afterwards by `shasum -a 256 -c`.

## Constraints

- All new content-alignment checks MUST start as WARN, not FAIL (spec-policies.json Decision #9)
- Skill('doc-hygiene') MUST exit in <5 seconds on cache hit (no governed files changed)
- governs-field is the ONLY spec discovery mechanism — do not add alternative discovery paths
- No LLM-based detection (DEC-006) — all checks must be deterministic
- Signal logging MUST include check-id, file, and finding-type metadata for promotion tracking

## Anti-Criteria

- [ ] SC-A1: No LLM/AI model calls in lib/doc-hygiene.ts or lib/spec-registry.ts (behavioral)
- [ ] SC-A2: No FAIL-level content checks without 10+ cycle precision data (behavioral)
